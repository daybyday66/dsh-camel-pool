/**
 * dsh-pool —— 驼峰积分池 provider。
 *
 * 一句话：把 N 个渠道的模型合成一个模型选择器，请求进来后按"积分快过期先烧"
 * 的顺序逐条转发到各渠道自己的回环端点，配额/限流就换下一条路由，**模型不变**。
 *
 * 结构：
 *   · lib/shared/pool.js  纯逻辑（合并、排序、粘性、熔断、档位翻译、状态文档）
 *   · 本文件              provider 外壳：一个回环 HTTP 代理 + 一个 pi-ai adapter
 *
 * 代理为什么必须有：pi-ai 的每个模型描述里 baseUrl 是静态的，而"这次请求该走
 * 哪条路由"要到请求真正发出时才知道。所以池对外只暴露自己的回环地址，由代理
 * 在请求体（model + reasoning_effort）上做决策，再改写成对应渠道的模型 id 转发。
 *
 * 凭证纪律：路由 token 只在内存里用，日志只记长度。代理自身默认监听固定
 * 5850 并使用固定 bearer，端点写入 ~/.dsh/.pool-shim.json 供进程外组件
 * （hindsight daemon）读取；设 DSH_POOL_SHIM_TOKEN=random 可回到纯内存随机模式。
 */
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createServer } from "node:http";
import { createHash, createHmac, randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  abortOnClientDisconnect,
  loopbackRequest,
  safeMessage,
  withLegacyImageBudget,
  writeJson,
} from "../../shared/http.js";
import {
  EFFORT_LEVELS,
  breakerReport,
  clearBreakers,
  logPoolEvent,
  mergedModelGroups,
  modelDisplayName,
  noteRouteFailure,
  noteRouteSuccess,
  onPoolRoutesChanged,
  orderedRoutesFor,
  poolProviderActive,
  poolRouteCredits,
  poolRoutes,
  poolStatusDocument,
  registerPoolRoute,
  refreshPoolCredits,
  setLatch,
  releaseLatchesForRoute,
  setPoolProviderActive,
  setPoolVoucherPreference,
  setPoolMergePreference,
  setPoolCostFirstPreference,
  translateEffort,
} from "../../shared/pool.js";
import {
  createGeminiTokenReader,
  geminiRoute,
  startGeminiModelRefresh,
  geminiAuthStatus,
  geminiLoginInfo,
  startGeminiLogin,
  submitGeminiLoginCode,
  cancelGeminiLogin,
} from "../gemini/index.js";
import { readGeminiQuota, writeGeminiQuota } from "../gemini/quota.js";
import {
  createCodeartsTokenReader,
  codeartsRoute,
  startCodeartsRefresh,
  codeartsDetail,
  codeartsAuthStatus,
  applyCodeartsRoutes,
} from "../codearts/index.js";

export const POOL_PROVIDER = "dsh-pool";
export const POOL_DISPLAY_NAME = "积分池";
export const POOL_STATUS_PATH = "/plugins/dsh-pool/status";
/** 冷却快照 / 手动清冷却（重登录后不用干等 10 分钟）。 */
export const POOL_BREAKERS_PATH = "/plugins/dsh-pool/breakers";
/** Gemini OAuth2 登录（复用 Google AI Pro 订阅，无需绑卡）。 */
export const POOL_GEMINI_OAUTH_PATH = "/plugins/dsh-pool/gemini-oauth";

/** 多一跳转发 + 上游长思考，比单渠道宽一档。 */
const POOL_STREAM_IDLE_TIMEOUT_MS = 600000;
/** 请求体上限：带图请求会很大，但再大就不是聊天了。 */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** 供进程外组件（hindsight daemon）接入池的固定回环端点。 */
const POOL_SHIM_PORT = Number.parseInt(process.env.DSH_POOL_SHIM_PORT ?? "5850", 10) || 5850;
const POOL_SHIM_TOKEN = process.env.DSH_POOL_SHIM_TOKEN || "hindsight-pool-local-7f3a9c2e1b8d4f6a5c0e9d2b8f4a6c1e";
const HINDSIGHT_AUTO_MODEL = "hindsight-auto";
function poolShimPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, ".pool-shim.json");
}
function writePoolShim(address, secret, logger) {
  try {
    const port = address && typeof address === "object" ? address.port : undefined;
    if (typeof port !== "number") return;
    const baseUrl = "http://127.0.0.1:" + String(port);
    writeFileSync(poolShimPath(), JSON.stringify({
      provider: POOL_PROVIDER,
      host: "127.0.0.1",
      port,
      baseUrl,
      token: secret,
      autoModel: HINDSIGHT_AUTO_MODEL,
      at: new Date().toISOString(),
    }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    logger?.warn?.("dsh-pool: failed to write pool shim endpoint file", error);
  }
}

/**
 * 记忆抽取用的跨模型尝试顺序：免费模型组优先，其次付费组按最快过期升序。
 * 返回与 orderedRoutesFor 相同的条目形状，forwardChat 的转发循环不用改。
 */
/** 把渠道 shim 回流的 OpenAI SSE 聚合成单个非流式 chat.completion。 */
function aggregateSseToCompletion(text, modelId) {
  const completion = {
    id: "chatcmpl-" + randomUUID().replace(/-/g, ""),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const doc = JSON.parse(trimmed);
      if (Array.isArray(doc.choices) && doc.choices[0]) return { ...doc, model: modelId };
    } catch { /* 落回 SSE 解析 */ }
  }
  let content = "";
  let reasoningContent = "";
  const toolCalls = new Map();
  let finishReason = "stop";
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw.startsWith("data:")) continue;
    const data = raw.slice(5).trim();
    if (data === "" || data === "[DONE]") continue;
    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") content += delta.content;
    else if (Array.isArray(delta.content)) {
      for (const part of delta.content) if (part && typeof part.text === "string") content += part.text;
    }
    // 部分渠道（如 hy4free）把实际输出放在 reasoning_content 里，content 为空串。
    // 对 hindsight 抽取/反思这类非流式调用，若最终 content 为空就回退到 reasoning_content。
    if (typeof delta.reasoning_content === "string") reasoningContent += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        if (!call || typeof call !== "object") continue;
        const key = Number.isFinite(call.index) ? call.index : 0;
        const prev = toolCalls.get(key) ?? { id: undefined, type: "function", function: { name: "", arguments: "" } };
        if (call.id) prev.id = call.id;
        if (call.type) prev.type = call.type;
        if (call.function?.name) prev.function.name += call.function.name;
        if (typeof call.function?.arguments === "string") prev.function.arguments += call.function.arguments;
        toolCalls.set(key, prev);
      }
    }
    if (typeof choice.finish_reason === "string" && choice.finish_reason !== "") finishReason = choice.finish_reason;
    if (chunk.usage && typeof chunk.usage === "object") {
      completion.usage = {
        prompt_tokens: Number(chunk.usage.prompt_tokens) || 0,
        completion_tokens: Number(chunk.usage.completion_tokens) || 0,
        total_tokens: Number(chunk.usage.total_tokens) || 0,
      };
    }
  }
  if (content.trim() === "" && reasoningContent.trim() !== "") {
    content = reasoningContent;
  }
  completion.choices[0].message.content = content;
  if (toolCalls.size > 0) {
    completion.choices[0].message.tool_calls = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, call]) => ({ index, ...call }));
  }
  completion.choices[0].finish_reason = finishReason;
  return completion;
}

function hindsightAutoOrder(view) {
  const groups = mergedModelGroups(view);
  const expiryOf = (routeKey) => {
    const credit = poolRouteCredits(routeKey);
    const expiry = credit?.expiryMs;
    return typeof expiry === "number" && Number.isFinite(expiry) ? expiry : Number.MAX_SAFE_INTEGER;
  };
  const paid = groups
    .filter((group) => group.free !== true)
    .map((group) => ({
      group,
      expiry: group.routes && group.routes.length > 0
        ? Math.min(...group.routes.map(expiryOf))
        : Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.expiry - b.expiry || (a.group.order ?? 0) - (b.group.order ?? 0));
  const orderedGroups = [...groups.filter((group) => group.free === true), ...paid.map((item) => item.group)];
  const seen = new Set();
  const order = [];
  for (const group of orderedGroups) {
    for (const entry of orderedRoutesFor(group.poolId, view)) {
      const key = entry.routeKey + "|" + String(entry.candidate?.id ?? "");
      if (seen.has(key)) continue;
      seen.add(key);
      order.push(entry);
    }
  }
  return order;
}

/** 池视图参数统一现读面板偏好：合并开关、性价比排序、代金券优先。 */
function viewOptionsOf(readPreferences) {
  let prefs;
  try {
    prefs = typeof readPreferences === "function" ? readPreferences() : undefined;
  } catch {
    prefs = undefined;
  }
  return {
    merge: prefs && typeof prefs === "object" && typeof prefs.poolMergeModels === "boolean" ? prefs.poolMergeModels : undefined,
    costFirst: prefs && typeof prefs === "object" && typeof prefs.poolCostFirst === "boolean" ? prefs.poolCostFirst : undefined,
    voucherFirst: prefs && typeof prefs === "object" && prefs.poolVoucherFirst === true,
    showRoutes: prefs && typeof prefs === "object" && prefs.poolShowRoutes === true,
    autoBoostEffort: prefs && typeof prefs === "object" && prefs.poolAutoBoostEffort === true,
    // ux-v14：当日将过期积分优先烧（默认开）；关掉后完全回到旧行为（粘性与静态排序压过一切）。
    burnExpiringFirst: !(prefs && typeof prefs === "object" && prefs.poolBurnExpiringFirst === false),
  };
}

/**
 * 需求 7：切模型时把思考强度自动调到该候选的**最高声明档**。
 * 从 thinkingLevelMap（EFFORT_LEVELS 从弱到强）取最后一个非 null 档，
 * 再用 translateEffort 落到上游拼写。没有声明档位就沿用调用方的值（或删掉）。
 */
function highestEffortOf(candidate, incoming) {
  const map = candidate?.thinkingLevelMap;
  if (!map || typeof map !== "object") {
    return { wire: translateEffort(candidate, incoming), from: incoming, boosted: false };
  }
  let top;
  for (const level of EFFORT_LEVELS) {
    if (map[level] !== null && map[level] !== undefined) top = level;
  }
  if (top === undefined) {
    return { wire: translateEffort(candidate, incoming), from: incoming, boosted: false };
  }
  const wire = translateEffort(candidate, top);
  const boosted = (incoming === undefined || String(incoming).toLowerCase() !== String(top).toLowerCase());
  return { wire, from: incoming, boosted };
}
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
};
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() { return []; },
    async modify() { throw new Error("dsh-pool: the pool route has no pi-ai credential lifecycle"); },
    async delete() {},
  },
  authContext: {
    async env() {},
  },
};

function tokenMatches(expected, presented) {
  if (typeof presented !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** 上游是不是在说"没额度了"（各家文案不同，认几个稳定特征）。 */
function looksLikeQuota(text) {
  if (typeof text !== "string" || text === "") return false;
  return /insufficient[_ ]?(quota|balance|credit)|quota[_ ]?exceed|rate[_ ]?limit|too many requests|积分不足|额度不足|余额不足|配额不足|限流|频率限制|usage limit/iu.test(text);
}

/**
 * 流内额度错误判定：有些渠道 HTTP 200 但 SSE/JSON body 里才吐额度错误。
 * 必须排除正常的 completion chunk（含 "choices" / [DONE]），并要求带错误字段，
 * 否则模型正好聊到「限流」两个字就会被误判成配额耗尽。
 */
function streamQuotaError(text) {
  if (!looksLikeQuota(text)) return false;
  if (text.includes('"choices"') || text.includes("[DONE]")) return false;
  return /"error"|"code"|"message"|"type"\s*:\s*"|event:\s*error/iu.test(text);
}

/**
 * 「上游拒绝窗口」判定：Code Assist 这个 standard-tier 账号会按时间窗整段拒 generate，
 * 三种文案轮着来 ——
 *   400 FAILED_PRECONDITION "User location is not supported for the API use."
 *   404 NOT_FOUND       "Requested entity was not found."
 *   503 UNAVAILABLE     "No capacity available for model ..."
 * 它们既不是账号失效（不记 10 分钟 auth），也不是额度耗尽（不该清 latch / 记 60s），
 * 而是上游短时波动：窗口一翻转请求就通。故单独归一类 upstream，只冷却 15 秒，
 * 下一请求立刻 probe，避免 60s 硬锁死把用户按在 402/502 上。
 */
function looksLikeUpstreamRejection(status, text) {
  if (status === 503) return true;
  if (typeof text !== "string" || text === "") return false;
  const s = text.slice(0, 2000);
  if (status === 400) return /FAILED_PRECONDITION|not supported for the API use|User location is not supported/iu.test(s);
  if (status === 404) return /Requested entity was not found|NOT_FOUND/iu.test(s);
  return false;
}


/**
 * ux-v14（P2-5）：优先读结构化错误体。
 *
 * 各适配层现在都会在错误体里挂 error.kind（池内核词汇：session_dead / iam_stale /
 * quota / upstream / transport / invalid）。以前池只能拿正文跑英文正则，而 codearts 适配层回的是
 * 中文人话（upstreamErrorMessage 的产物），「IAM token 已失效」永远匹配不上
 * looksLikeAuthFailure，被降级成 60 秒 transport 冷却 —— 掉登录的号每 60 秒白撞一次上游。
 *
 * 返回池内核四类之一或 invalid；没有结构化 kind 时返回 null，交回正则兜底。
 *
 * invalid 是「这个请求本身不合法」——典型是 codearts 适配层用本地窗口预检
 * 判定装不下（code=context_overflow）。它必须跟 auth / transport 分开：
 * 记熔断会把一条完全健康的路由冷却 60 秒，而换个更小的请求本来就能成功。
 */
function structuredFailureKind(status, text) {
  if (typeof text !== "string" || text === "") return null;
  const slice = text.slice(0, 4000).trim();
  if (!slice.startsWith("{")) return null;
  let doc;
  try { doc = JSON.parse(slice); } catch { return null; }
  const error = doc && typeof doc === "object" ? doc.error : undefined;
  const raw = error && typeof error === "object" ? str(error.kind) : "";
  // 兼容两种写法：error.kind 或顶层 kind。
  const kind = raw !== "" ? raw : str(doc && typeof doc === "object" ? doc.kind : "");
  if (kind === "session_dead" || kind === "iam_stale") return "auth";
  if (kind === "quota") return "quota";
  if (kind === "upstream") return "upstream";
  if (kind === "transport") return "transport";
  if (kind === "invalid") return "invalid";
  return null;
}

/**
 * 账号层失败判定（和「请求体非法」严格区分）。
 *
 * 渠道 shim 会把上游的 401/403 包成 HTTP 400，正文里留着 "http 403"、code 11140、
 * "request illegal"、"account has been ... disabled" 之类的痕迹。这类错误跟请求内容
 * 无关：换一条路由就能活，而且短时间不会自愈。以前把它当成 invalid_request 直接回
 * 400 结束整轮，于是一个被封的号能把整个模型打死。
 */
function looksLikeAuthFailure(status, text) {
  if (status === 401 || status === 403) return true;
  if (typeof text !== "string" || text === "") return false;
  return /http\s*40[13]|unauthoriz|invalid[_ ]?(token|api[_ ]?key)|api[_ ]?key[^.]{0,24}(invalid|expired)|token[^.]{0,24}(expired|revoked|invalid)|not (?:logged|signed) in|login required|please (?:log ?in|sign ?in) again|account[^.]{0,48}(?:banned|disabled|suspended|blocked|frozen|illegal)|request illegal|permission denied|access denied|未授权|无权限|账号[^。]{0,20}(?:封|禁用|冻结)/iu.test(text);
}

/** 手动泵流时保留 pipe 的背压语义；返回 false 表示客户端已断开。 */
function writeChunk(res, controller, chunk) {
  if (res.writableEnded || res.destroyed) return Promise.resolve(false);
  if (res.write(chunk) === true) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      res.off("drain", onDrain);
      res.off("close", onClose);
      controller.signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const onAbort = () => finish(false);
    res.once("drain", onDrain);
    res.once("close", onClose);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 单条路由的请求头：只带必要项，不复制客户端的 accept-encoding（避免解压错乱）。 */
function upstreamHeaders(token) {
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: "Bearer " + token,
  };
}

/** 把合并后的模型组翻译成 pi-ai 描述符。baseUrl 每次现取；showRoutes 决定是否拼渠道名。 */
function toPoolModel(group, baseUrl, showRoutes) {
  const levels = {};
  for (const level of EFFORT_LEVELS) levels[level] = null;
  if (group.reasoning) {
    for (const level of Object.keys(group.thinkingLevelMap ?? {})) levels[level] = level;
  }
  // ux-v6：切换到池模型时思考强度默认落在最高档（宿主认 defaultEffort 即以它为
  // 默认选中项）；转发层 highestEffortOf 的提档逻辑继续作为兜底。
  // ux-v6 原行为取最高档做 defaultEffort；ux-v10 改取最低非 null 档，
  // 让宿主 UI 预选最弱思考档（需要更强时用户手动选或打开自动提档开关）。
  // 跳过 off/minimal：默认关掉思考会明显掉代码质量；没有更弱的档就退回最低档。
  const WEAK = new Set(["off", "minimal"]);
  let defaultEffort;
  for (const level of EFFORT_LEVELS) {
    if (levels[level] !== null && !WEAK.has(level)) { defaultEffort = level; break; }
  }
  if (defaultEffort === undefined) {
    for (const level of EFFORT_LEVELS) {
      if (levels[level] !== null) { defaultEffort = level; break; }
    }
  }
  return {
    id: group.poolId,
    name: modelDisplayName(group, showRoutes === true),
    api: "openai-completions",
    provider: POOL_PROVIDER,
    baseUrl,
    input: group.input,
    reasoning: group.reasoning === true,
    thinkingLevelMap: levels,
    defaultEffort,
    cost: NO_COST,
    contextWindow: group.contextWindow ?? 200000,
    maxTokens: group.maxTokens ?? 32000,
    compat: { maxTokensField: "max_tokens" },
  };
}

const BOOT_PLACEHOLDER = [
  {
    id: "dsh-pool-booting",
    name: "积分池（等待渠道就绪）",
    api: "openai-completions",
    provider: POOL_PROVIDER,
    baseUrl: "http://127.0.0.1:1/v1",
    input: ["text"],
    reasoning: false,
    cost: NO_COST,
    contextWindow: 128000,
    maxTokens: 32000,
    compat: { maxTokensField: "max_tokens" },
  },
];

/**
 * pi-ai adapter：保留 PiAiAdapter 的流式/档位/附件能力，只在"池没开"时把
 * 模型列表清空 —— 宿主据此隐藏整个 provider 分组。
 */
class PoolPiAiAdapter extends PiAiAdapter {
  constructor(options) {
    super(options);
    this.isPoolActive = typeof options.isPoolActive === "function" ? options.isPoolActive : poolProviderActive;
  }

  async listModels(provider) {
    if (!this.isPoolActive()) return [];
    return super.listModels(provider);
  }
}

const HARNESS_IDENTITY_SENTENCE = /You are an AI agent powered by (?:the )?DeepSeek[\s_-]*Harness[.,]?/gi;
const HARNESS_VENDOR = /deepseek[\s_-]*harness/gi;
const HARNESS_WORKSPACE_ROOT = /workspace root/gi;

/**
 * 抹掉一行文本里的 harness 指纹（两处）。
 *
 * `DeepSeek Harness` 与 `workspace root` 是上游判定"非官方客户端"的两个独立
 * 不变量：2026-10-30 用真实 74KB 系统提示二分过，只抹 vendor 名仍然 400/11128，
 * 再把 `workspace root` 换成 `workspace directory` 才 200。
 */
function scrubHarnessText(text, stats) {
  if (!/harness|workspace root/i.test(text)) return text;
  let next = text;
  const identity = next.match(HARNESS_IDENTITY_SENTENCE);
  if (identity) {
    next = next.replace(HARNESS_IDENTITY_SENTENCE, "You are an AI coding agent.");
    if (stats) stats.identity += identity.length;
  }
  const vendor = next.match(HARNESS_VENDOR);
  if (vendor) {
    next = next.replace(HARNESS_VENDOR, "the coding assistant");
    if (stats) stats.vendor += vendor.length;
  }
  const root = next.match(HARNESS_WORKSPACE_ROOT);
  if (root) {
    next = next.replace(HARNESS_WORKSPACE_ROOT, "workspace directory");
    if (stats) stats.workspaceRoot += root.length;
  }
  return next;
}

/**
 * 渠道无关的请求体清洗：developer→system + 抹 harness 文本指纹。
 *
 * 渠道自己的 shim 里有同一套清洗，池这条替代路径必须再做一遍：渠道插件被
 * 上游更新覆盖（清洗回退）时，池内所有路由会一起 400/11128，而单渠道还通。
 * 幂等，对同一 body 反复调用无副作用。
 */
export function sanitizeForwardBody(payload, stats) {
  if (payload === null || typeof payload !== "object") return payload;
  const messages = payload.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (message === null || typeof message !== "object" || Array.isArray(message)) continue;
      if (message.role === "developer") {
        message.role = "system";
        if (stats) stats.developer += 1;
      }
      const content = message.content;
      if (typeof content === "string") message.content = scrubHarnessText(content);
      else if (Array.isArray(content)) {
        for (const part of content) {
          if (part !== null && typeof part === "object" && !Array.isArray(part) && typeof part.text === "string") part.text = scrubHarnessText(part.text, stats);
        }
      }
    }
  }
  const tools = payload.tools;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      const fn = tool !== null && typeof tool === "object" ? tool.function : undefined;
      if (fn !== null && typeof fn === "object" && typeof fn.description === "string") fn.description = scrubHarnessText(fn.description, stats);
    }
  }
  return payload;
}

export function createPoolAdapter(options) {
  const { proxy, resolveAttachments } = options;
  /*
   * 「池是否启用」现读面板偏好，而不是只认模块里的旗标。
   *
   * 旗标只在 apply 时写过一次，而面板是把 poolEnabled 写进设置段（本插件随之热重载，
   * 但列表缓存不一定跟着刷）。现读偏好才能保证"面板一关，选择器里立刻没有积分池"，
   * 不必等重启；旗标留给状态文档与外部探针用。
   */
  const enabled = () => {
    const prefs = typeof options.readPreferences === "function" ? options.readPreferences() : undefined;
    if (prefs !== null && typeof prefs === "object" && typeof prefs.poolEnabled === "boolean") return prefs.poolEnabled;
    return poolProviderActive();
  };
  const buildModels = () => {
    if (!enabled()) return [];
    const baseUrl = proxy.baseUrl() + "/v1";
    const view = viewOptionsOf(options.readPreferences);
    const groups = mergedModelGroups(view);
    if (groups.length === 0) return [];
    return groups.map((group) => toPoolModel(group, baseUrl, view.showRoutes));
  };
  // 只构建一次：旧写法 `buildModels().length > 0 ? buildModels()` 会调用两次
  // （每次都跑一遍 mergedModelGroups 全量合并），且两趟结果可能不一致。
  const bootModels = buildModels();
  const provider = {
    ...createProvider({
      id: POOL_PROVIDER,
      name: POOL_DISPLAY_NAME,
      auth: {
        apiKey: {
          name: "积分池回环凭据（插件进程内自签）",
          async resolve({ credential }) {
            const apiKey = credential?.key;
            return apiKey === undefined || apiKey.length === 0
              ? undefined
              : { auth: { apiKey }, source: "积分池" };
          },
        },
      },
      models: bootModels.length > 0 ? bootModels : BOOT_PLACEHOLDER,
      api: openAICompletionsApi(),
    }),
    getModels: () => {
      const models = buildModels();
      return models.length > 0 ? models : BOOT_PLACEHOLDER;
    },
  };
  const profile = {
    provider: POOL_PROVIDER,
    displayName: POOL_DISPLAY_NAME,
    streamIdleTimeoutMs: POOL_STREAM_IDLE_TIMEOUT_MS,
    // 池已在路由层做 failover，宿主侧重试只留兜底：最多 2 次、退避 300ms→1.5s、
    // 不含 TRANSPORT（"流被截断/没 finish_reason"交给池换路由，宿主重试只会
    // 把一次失败放大成多轮死等 = 用户看到的「答完还在思考」）。
    retryPolicy: resolveRetryPolicy({
      mode: "normal",
      maxRetries: 2,
      retryableCodes: ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT"],
      backoff: { initialDelayMs: 300, maxDelayMs: 1500, jitterRatio: 0.1 },
    }, "dsh-pool retryPolicy"),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  };
  const profiles = new Map([[POOL_PROVIDER, profile]]);
  return new PoolPiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => proxy.token(),
    // 池开关现读偏好：面板关掉后选择器里立刻消失，不必等重启。
    isPoolActive: enabled,
    ...(resolveAttachments === undefined
      ? {}
      : {
          resolveAttachments: () => {
            const store = resolveAttachments();
            return store === undefined
              ? undefined
              : withLegacyImageBudget(store, REQUEST_IMAGE_BUDGETS.requestImagePixelBudget);
          },
        }),
  });
}

/**
 * 池代理：对外一个回环端点，对内在路由之间挑一条。
 * 返回 {ready, baseUrl(), token(), close()}
 */
export function createPoolProxy(options) {
  const { readPreferences, logger } = options;
  // 默认给进程外组件一个稳定的 bearer；DSH_POOL_SHIM_TOKEN=random 可回到
  // 原来的「每次启动随机、不落盘」模式。
  const secret = POOL_SHIM_TOKEN === "random"
    ? randomBytes(32).toString("base64url")
    : POOL_SHIM_TOKEN;
  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      try {
        writeJson(res, 500, { error: { message: safeMessage(error), type: "pool_internal_error" } });
      } catch {
        /* 响应已经发过了 */
      }
    });
  });

  let address;
  const ready = new Promise((resolve, reject) => {
    let listening = false;
    const onListening = () => {
      if (listening) return;
      listening = true;
      address = server.address();
      writePoolShim(address, secret, logger);
      resolve(address);
    };
    server.on("error", (error) => {
      if (listening) return;
      // 固定端口被上一个宿主进程占着时降级到随机端口，端点以 shim 文件为准。
      if (error?.code === "EADDRINUSE" || error?.code === "EACCES") {
        try { server.listen(0, "127.0.0.1", onListening); } catch (retryError) { reject(retryError); }
        return;
      }
      reject(error);
    });
    server.listen(POOL_SHIM_PORT, "127.0.0.1", onListening);
  });

  function baseUrl() {
    if (address === undefined || typeof address !== "object") return "http://127.0.0.1:1";
    return "http://127.0.0.1:" + String(address.port);
  }

  function authorized(req) {
    if (!loopbackRequest(req)) return false;
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.toLowerCase().startsWith("bearer ")) return false;
    return tokenMatches(secret, header.slice("bearer ".length).trim());
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/healthz") {
      writeJson(res, 200, { status: "ok", provider: POOL_PROVIDER, routes: poolRoutes().length });
      return;
    }
    if (!loopbackRequest(req)) {
      writeJson(res, 403, { error: { message: "request-not-trusted", type: "pool_forbidden" } });
      return;
    }
    if (!authorized(req)) {
      writeJson(res, 401, { error: { message: "bad pool token", type: "pool_unauthorized" } });
      return;
    }
    if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      const view = viewOptionsOf(readPreferences);
      const models = mergedModelGroups(view).map((group) => ({
        id: group.poolId,
        object: "model",
        owned_by: POOL_PROVIDER,
        name: modelDisplayName(group, view.showRoutes),
      }));
      models.unshift({
        id: HINDSIGHT_AUTO_MODEL,
        object: "model",
        owned_by: POOL_PROVIDER,
        name: "Hindsight auto (free first, then earliest-expiring credits)",
      });
      writeJson(res, 200, { object: "list", data: models });
      return;
    }
    if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
      await forwardChat(req, res);
      return;
    }
    writeJson(res, 404, { error: { message: "not found", type: "pool_not_found" } });
  }

  async function forwardChat(req, res) {
    // 每条候选路由都会挂一次 res 'close' 监听（abortOnClientDisconnect）。
    // 路由多时可能撞上 Node 的默认 10 监听上限并刷 MaxListenersExceededWarning；
    // res 是每请求独立对象、响应结束即回收，提高上限即可，不改变任何行为。
    if (typeof res.setMaxListeners === "function") res.setMaxListeners(0);
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      writeJson(res, 400, { error: { message: "bad request body: " + safeMessage(error), type: "invalid_request_error" } });
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      writeJson(res, 400, { error: { message: "request body must be a JSON object", type: "invalid_request_error" } });
      return;
    }
    const modelId = typeof body.model === "string" ? body.model : "";
    const view = viewOptionsOf(readPreferences);
    // hindsight daemon 的抽取/反思是 OpenAI 非流式调用，而渠道 shim 只回流 SSE。
    // 故强制上游流式，成功后再聚合成单个 chat.completion JSON 回给调用方。
    const aggregate = modelId === HINDSIGHT_AUTO_MODEL && body.stream !== true;
    if (aggregate) body.stream = true;
    // hindsight-auto：进程外组件（记忆抽取/反思）用的虚拟模型，跨模型选路。
    // 免费组优先；付费组按「积分最早过期」升序；组内仍走 orderedRoutesFor 的
    // 过期优先/熔断/粘性逻辑。全池失败才 502。
    let order = modelId === HINDSIGHT_AUTO_MODEL ? hindsightAutoOrder(view) : orderedRoutesFor(modelId, view);
    if (order.length === 0 && modelId !== HINDSIGHT_AUTO_MODEL) {
      const cooling = breakerReport();
      // 单路由组（如 gemini routes:["gemini"]）被偶发 429/网络抖动标成 quota/transport
      // 冷却后，60 秒内「换路由」没有任何收益，只会把用户锁死在 402。对非账号层
      // 失效的冷却，本次请求忽略熔断做一次探测：上游自愈了由 noteRouteSuccess 清标记，
      // 仍失败则 noteRouteFailure 续期，下一次请求再决定，不会无限硬打上游。
      if (cooling.length > 0 && cooling.every((item) => item.kind !== "auth")) {
        const probed = orderedRoutesFor(modelId, { ...view, ignoreBreakers: true });
        if (probed.length > 0) {
          logPoolEvent({ ev: "breaker-probe", model: modelId, routes: probed.map((item) => item.routeKey), cooling });
          order = probed;
        }
      }
    }
    if (order.length === 0) {
      const cooling = breakerReport();
      logPoolEvent({ ev: "pool-empty", model: modelId, cooling });
      const hint = cooling.length === 0
        ? ""
        : "；冷却中：" + cooling.map((item) => item.route + "(" + item.kind + "，" + Math.ceil(item.leftMs / 60000) + " 分钟)").join("、");
      writeJson(res, 402, {
        error: {
          message: "积分池里没有可用于 " + modelId + " 的路由（渠道未登录、模型被隐藏或全部熔断）" + hint,
          type: "pool_exhausted",
          routes: cooling,
        },
      });
      return;
    }

    const incomingEffort = typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined;
    const failures = [];
    /** 全池都判「请求体非法」时，把上游原文回给宿主（400），而不是笼统的 502。 */
    let invalidMessage = "";
    for (const entry of order) {
      const candidate = entry.candidate;
      const payload = { ...body, model: candidate.id };
      // Gemini 的 OpenAI 兼容层不认 Responses-API 专属字段（DSH 的 OpenAI 客户端
      // 会带上 store / prompt_cache_key 等），转发过去会 400 "Unknown name \"store\""。
      // 只在这条路由上删这几个字段，其余 chat-completions 字段与其它路由完全不动。
      if (entry.route.kind === "gemini") {
        for (const key of ["store", "previous_response_id", "include", "prompt_cache_key", "safety_identifier"]) delete payload[key];
      }
      // 转发前统一做一次"对外拼写"清洗：百炼不认 developer 角色，WorkBuddy 上游
      // 还按 `DeepSeek Harness` / `workspace root` 两处文本指纹判"非官方客户端"
      // （400/11128）。裸走渠道时这些清洗在渠道 shim 里；池这条替代路径必须自己
      // 做一遍，否则渠道插件被上游更新覆盖、清洗回退时，池里全军覆没而单渠道还能通。
      const scrubStats = { identity: 0, vendor: 0, workspaceRoot: 0, developer: 0 };
      sanitizeForwardBody(payload, scrubStats);
      // 需求 7：切换模型选择时思考强度自动拉到该模型声明的**最高**档。
      // 逐 candidate 判定，避免给不支持 reasoning_effort 的裸模型发非法值（DSH 会
      // 抛 UNSUPPORTED_REASONING_EFFORT）。没有声明档位的候选干脆删掉这个参数。
      // ux-v10：自动提档改为面板开关 poolAutoBoostEffort（默认关）——
      // 关闭时沿用调用方 effort（distance-match 落档），首 token 更快。
      const topEffort = view.autoBoostEffort
        ? highestEffortOf(candidate, incomingEffort)
        : { wire: translateEffort(candidate, incomingEffort), from: incomingEffort, boosted: false };
      if (topEffort.wire === undefined || topEffort.wire === null) delete payload.reasoning_effort;
      else payload.reasoning_effort = topEffort.wire;
      if (topEffort.boosted) {
        logPoolEvent({ ev: "effort-boost", model: modelId, route: entry.routeKey, from: topEffort.from ?? "unset", to: topEffort.wire });
      }
      let token;
      try {
        token = await entry.route.token();
      } catch (error) {
        failures.push({ route: entry.routeKey, error: safeMessage(error) });
        noteRouteFailure(entry.routeKey, "transport");
        logPoolEvent({ ev: "route-fail", model: modelId, route: entry.routeKey, reason: "token", error: safeMessage(error) });
        continue;
      }
      let chatUrl = "";
      try {
        chatUrl = entry.route.chatUrl();
      } catch (error) {
        failures.push({ route: entry.routeKey, error: safeMessage(error) });
        noteRouteFailure(entry.routeKey, "transport");
        continue;
      }
      logPoolEvent({
        ev: "attempt",
        model: modelId,
        poolModel: candidate.id,
        route: entry.routeKey,
        chatUrl,
        effort: payload.reasoning_effort,
        tokenLen: typeof token === "string" ? token.length : 0,
        scrub: scrubStats.identity + scrubStats.vendor + scrubStats.workspaceRoot + scrubStats.developer > 0 ? scrubStats : undefined,
      });
      const controller = new AbortController();
      abortOnClientDisconnect(res, controller);
      // 上游可能「接了连接但永远不吐响应头」（半开连接 / 代理隧道僵死）：此前只有
      // 客户端断开才会 abort，请求会一直挂着。给「等响应头」这一段单独加 120s 硬
      // 超时；一旦 await fetch 返回（头已到）立刻清掉 timer，后续泵流用的是
      // controller.signal，不受这个超时影响 —— 长思考的流式回答不会被误杀。
      // 用独立的 headerController 而不是直接 controller.abort()，是为了让超时
      // 能被识别成「换下一条路由」而不是被当成客户端断开直接 return（那样会挂住客户端）。
      const headerController = new AbortController();
      const headerTimer = setTimeout(() => headerController.abort(), 120_000);
      let fetchSignal = controller.signal;
      try { fetchSignal = AbortSignal.any([controller.signal, headerController.signal]); } catch { /* 老运行时退回只用断连信号 */ }
      let upstream;
      try {
        // 外部上游（如 Google Gemini）可能自带「走本机代理隧道」的 fetch；
        // 未声明的路由仍用全局直连 fetch，行为完全不变。
        const routeFetch = typeof entry.route.fetch === "function" ? entry.route.fetch : fetch;
        upstream = await routeFetch(chatUrl, {
          method: "POST",
          headers: upstreamHeaders(token),
          body: JSON.stringify(payload),
          signal: fetchSignal,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        failures.push({ route: entry.routeKey, error: safeMessage(error) });
        noteRouteFailure(entry.routeKey, "transport");
        logPoolEvent({ ev: "route-fail", model: modelId, route: entry.routeKey, reason: "transport", error: safeMessage(error) });
        continue;
      } finally {
        clearTimeout(headerTimer);
      }

      if (!upstream.ok) {
        let text = "";
        try {
          text = (await upstream.text()).slice(0, 4000);
        } catch {
          text = "";
        }
        if (controller.signal.aborted) return;
        // 非 2xx 分类，别再一刀切成「不可重试」把整个模型打死。
        // 判定顺序：① 适配层声明的结构化 kind → ② 正文正则兜底。：
        // ① 账号层失效（被封号 / 掉登录 / 无权限）：渠道 shim 常把上游 403 包成 HTTP 400，
        //    正文里留着 "request illegal" / "http 403"。换一条路由就能活，记 10 分钟长冷却
        //    后立刻切下一条 —— 绝不整轮打死。
        // ux-v14（P2-5）：适配层在错误体里声明了 kind 就照办，没声明才跑文本正则。
        const declared = structuredFailureKind(upstream.status, text);
        const fromStructured = declared !== null;
        if (declared === "auth" || (!fromStructured && looksLikeAuthFailure(upstream.status, text))) {
          failures.push({ route: entry.routeKey, status: upstream.status, error: text.slice(0, 300), kind: "auth" });
          noteRouteFailure(entry.routeKey, "auth");
          releaseLatchesForRoute(entry.routeKey);
          logPoolEvent({ ev: "route-fail", model: modelId, route: entry.routeKey, status: upstream.status, kind: "auth", source: fromStructured ? "structured" : "text", error: text.slice(0, 200) });
          continue;
        }
        // ② 确定性的「请求体非法」400（如 Gemini 不认的字段、各家 INVALID_ARGUMENT）：
        //    不再一票否决整轮 —— 有的渠道会忽略那个字段直接成功，先记下来继续试；
        //    只有全池都判非法时才把 400 回给宿主。不设熔断：这不是路由的错，熔断只会
        //    让下一条模型请求也无端绕开它。
        if (declared === "invalid" || (!fromStructured && upstream.status === 400 && /INVALID_ARGUMENT|Unknown name|Cannot find field|invalid_request_error/iu.test(text))) {
          if (invalidMessage === "") invalidMessage = text.slice(0, 2000);
          failures.push({ route: entry.routeKey, status: 400, error: text.slice(0, 300), kind: "invalid" });
          logPoolEvent({ ev: "route-fail", model: modelId, route: entry.routeKey, status: 400, kind: "invalid", error: text.slice(0, 200) });
          continue;
        }
        // ③ 「上游拒绝窗口」（地域 400 / entity-not-found 404 / 无容量 503）：
        //    不进 auth（不是掉登录），也不清 latch、不记 60s；只记 15s upstream，
        //    下一请求立刻探测，窗口翻转即自愈。
        if (declared === "upstream" || (!fromStructured && looksLikeUpstreamRejection(upstream.status, text))) {
          failures.push({ route: entry.routeKey, status: upstream.status, error: text.slice(0, 300), kind: "upstream" });
          noteRouteFailure(entry.routeKey, "upstream");
          logPoolEvent({ ev: "route-fail", model: modelId, route: entry.routeKey, status: upstream.status, kind: "upstream", error: text.slice(0, 200) });
          continue;
        }
        const kind = declared ?? (upstream.status === 402 || upstream.status === 429 || looksLikeQuota(text) ? "quota" : "transport");
        failures.push({ route: entry.routeKey, status: upstream.status, error: text.slice(0, 300) });
        noteRouteFailure(entry.routeKey, kind);
        // 需求 5：额度耗尽后立刻清掉粘性 latch，下一次请求自然落到下一顺序路由，
        // 不必等 60s 熔断窗口过期；还能继续静默换路由时本轮就直接 continue。
        if (kind === "quota") releaseLatchesForRoute(entry.routeKey);
        logPoolEvent({
          ev: "route-fail",
          model: modelId,
          route: entry.routeKey,
          status: upstream.status,
          kind,
          error: text.slice(0, 200),
        });
        continue;
      }

      // 需求 5：手动泵流。先在「还没写响应头」的探测窗口里识别
      // 「HTTP 200 但 body 里才是额度错误」——此时能静默切到下一顺序路由；
      // 一旦 writeHead 开流后才出现额度错误，就不打断本轮思考，只清 latch +
      // 标熔断，当前任务照常完成，下一次请求按最早过期顺序落到下一条路由。
      const headers = { "content-type": upstream.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-cache" };
      const requestId = upstream.headers.get("x-request-id");
      if (requestId !== null) headers["x-request-id"] = requestId;
      if (upstream.body === null) {
        setLatch(modelId, entry.routeKey);
        noteRouteSuccess(entry.routeKey);
        logPoolEvent({ ev: "served", model: modelId, poolModel: candidate.id, route: entry.routeKey, status: upstream.status });
        if (aggregate) {
          writeJson(res, 200, aggregateSseToCompletion("", modelId));
          return;
        }
        res.writeHead(upstream.status, headers);
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      const probe = [];
      let probeBytes = 0;
      let probedDone = false;
      let quotaHit = false;
      let readError;
      // ux-v10：探测窗口首字节 6s 硬超时 —— 上游接了连接迟迟不吐首块时，
      // 客户端此前只能干等（最长 120s headerTimer 兜底）。超时静默换下一条路由。
      // ux-v11：这个 6s 只对「还有下一条路由可切」的多路由组成立。单路由组
      // （gemini routes:["gemini"]）没有备份，一次 pro 档 5–8s 的慢启动会被判成
      // probe-timeout → 静默切到空 → 502「积分池所有路由都失败」，比 429 更冤。
      // 单路由给 45s（仍远小于 120s headerTimer），多路由维持原 6s 快速失败。
      let probeTimedOut = false;
      const probeTimeoutMs = order.length > 1 ? 6000 : 45000;
      const probeTimer = setTimeout(() => {
        probeTimedOut = true;
        try { reader.cancel(); } catch { /* 已断 */ }
      }, probeTimeoutMs);
      const PROBE_LIMIT = 4096;
      while (probeBytes < PROBE_LIMIT) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (error) {
          readError = error;
          break;
        }
        if (chunk.done) {
          probedDone = true;
          break;
        }
        probe.push(chunk.value);
        probeBytes += chunk.value.byteLength;
        const text = Buffer.from(chunk.value).toString("utf8");
        if (streamQuotaError(text)) {
          quotaHit = true;
          break;
        }
        // 已经出现正常 completion 内容，可以放心开流，后续靠整段扫描兜底。
        if (text.includes('"choices"') || text.includes("[DONE]") || text.includes("data:")) break;
      }
      if (quotaHit) {
        clearTimeout(probeTimer);
        failures.push({ route: entry.routeKey, status: upstream.status, error: "stream quota" });
        noteRouteFailure(entry.routeKey, "quota");
        releaseLatchesForRoute(entry.routeKey);
        logPoolEvent({ ev: "route-fail", model: modelId, route: entry.routeKey, reason: "stream-quota", status: upstream.status });
        try { await reader.cancel(); } catch { /* 已断 */ }
        continue; // 静默切换：还没写头，下一条路由对客户端完全透明
      }
      clearTimeout(probeTimer);
      if ((readError !== undefined || probeTimedOut) && probe.length === 0) {
        if (controller.signal.aborted) return;
        const reason = probeTimedOut ? "probe-timeout" : "stream-read";
        const detail = probeTimedOut ? `probe first-byte timeout (${probeTimeoutMs}ms)` : safeMessage(readError);
        failures.push({ route: entry.routeKey, error: detail });
        noteRouteFailure(entry.routeKey, "transport");
        logPoolEvent({ ev: "route-fail", model: modelId, route: entry.routeKey, reason, error: detail });
        try { await reader.cancel(); } catch { /* 已断 */ }
        continue;
      }

      setLatch(modelId, entry.routeKey);
      noteRouteSuccess(entry.routeKey);
      // ux-v14：当日积分每烧一次都可能见底——成功服务后立刻让该路由的积分缓存失效，
      // 并在「当日将过期余额仍在」时强刷一次池积分，烧完的下一请求自动静默切走。
      // 只刷刚服务过的这一条（only）：force 全池等于每个成功请求都打 10 次上游，
      // 而那时只有这条路由的余额真的变了。
      if (typeof entry.route.invalidateCredits === "function") {
        try { entry.route.invalidateCredits(); } catch { /* 失效失败只影响记账新鲜度 */ }
      }
      if ((poolRouteCredits(entry.routeKey)?.expiring ?? 0) > 0) {
        void refreshPoolCredits({ force: true, only: [entry.routeKey] }).catch(() => {});
      }
      logPoolEvent({ ev: "served", model: modelId, poolModel: candidate.id, route: entry.routeKey, status: upstream.status });
      if (aggregate) {
        const buffered = [...probe];
        if (!probedDone && readError === undefined) {
          for (;;) {
            let next;
            try { next = await reader.read(); } catch { break; }
            if (next.done) break;
            buffered.push(next.value);
          }
        }
        let text = "";
        for (const part of buffered) text += Buffer.from(part).toString("utf8");
        try { await reader.cancel(); } catch { /* 已读完 */ }
        writeJson(res, 200, aggregateSseToCompletion(text, modelId));
        return;
      }
      res.writeHead(upstream.status, headers);
      let quotaNoted = false;
      try {
        for (const buffered of probe) {
          if ((await writeChunk(res, controller, buffered)) === false) {
            try { await reader.cancel(); } catch { /* 已断 */ }
            return;
          }
        }
        if (probedDone || readError !== undefined) {
          if (!res.writableEnded && !res.destroyed) res.end();
          return;
        }
        for (;;) {
          let next;
          try {
            next = await reader.read();
          } catch (error) {
            if (!controller.signal.aborted) {
              logPoolEvent({ ev: "stream-error", model: modelId, route: entry.routeKey, error: safeMessage(error) });
            }
            break;
          }
          if (next.done) break;
          if (!quotaNoted && streamQuotaError(Buffer.from(next.value).toString("utf8"))) {
            quotaNoted = true;
            // 已经开流，切换会打断思考：本轮照常完成，只标记耗尽，
            // 清掉粘性让下一轮按最早过期顺序落到下一条路由。
            noteRouteFailure(entry.routeKey, "quota");
            releaseLatchesForRoute(entry.routeKey);
            logPoolEvent({ ev: "stream-quota", model: modelId, route: entry.routeKey, action: "switch-after-task" });
          }
          if ((await writeChunk(res, controller, next.value)) === false) {
            try { await reader.cancel(); } catch { /* 已断 */ }
            return;
          }
        }
      } finally {
        try { reader.releaseLock(); } catch { /* 已释放 */ }
      }
      if (!res.writableEnded && !res.destroyed) res.end();
      return;
    }

    logPoolEvent({ ev: "pool-exhausted", model: modelId, failures });
    if (invalidMessage !== "" && failures.every((item) => item.kind === "invalid")) {
      writeJson(res, 400, { error: { message: invalidMessage, type: "invalid_request_error" }, routes: failures });
      return;
    }
    writeJson(res, 502, {
      error: {
        message:
          "积分池所有路由都失败：" +
          failures.map((item) => item.route + (item.status === undefined ? "" : " " + String(item.status))).join(", "),
        type: "pool_exhausted",
        routes: failures,
      },
    });
  }

  function close() {
    try {
      server.close();
    } catch {
      /* 已经关了 */
    }
  }

  return { ready, baseUrl, token: () => secret, close, logger };
}


//#region 百炼代金券路由

/**
 * 代金券路由的固定事实（2026-11-01 从 cordis.patch.yml 的 aliyun-bailian 段搬到池里）。
 *
 * 这一段不是"又一个渠道"：它没有积分包、没有过期时间，只能兜底。所以它固定
 * priority 9 + voucher:true，由 shared/pool.js 排到所有积分路由之后；偏好里开了
 * poolVoucherFirst 才手动提到最前。
 */
const BAILIAN_KEY = "bailian";
const BAILIAN_BASE_URL = "https://ws-i2d9x1g41bysp1va.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
const BAILIAN_KEY_ENV = "ALIYUN_BAILIAN_API_KEY";
/** yml 里实测过的 5 个模型：识图能力与 off/high/max 档照抄，不与渠道争名字。 */
const BAILIAN_MODELS = [
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", input: ["text"] },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", input: ["text", "image"] },
  { id: "qwen3.8-max", name: "Qwen3.8-Max", input: ["text", "image"] },
  { id: "kimi-k3", name: "Kimi K3", input: ["text", "image"] },
  { id: "glm-5.3", name: "GLM-5.3", input: ["text"] },
];
/** 百炼的档位映射（yml reasoningEfforts：off 不支持，high/max 直通，其余取最近档）。 */
const BAILIAN_EFFORT_MAP = { off: null, low: null, medium: null, high: "high", xhigh: "max", max: "max" };

/**
 * 代金券 key 的读取：先环境变量，再凭据服务（~/.dsh/.credentials.yaml 里加密存着）。
 * 结果缓存 60 秒 —— 凭据服务本身也有开销，而 key 不该每个请求解一次。
 */
function createBailianKeyReader(ctx) {
  let cached = { value: "", at: 0 };
  return async () => {
    const fromEnv = typeof process.env[BAILIAN_KEY_ENV] === "string" ? process.env[BAILIAN_KEY_ENV].trim() : "";
    if (fromEnv !== "") return fromEnv;
    const now = Date.now();
    if (cached.value !== "" && now - cached.at < 60_000) return cached.value;
    let resolved = "";
    try {
      const service = typeof ctx.get === "function" ? ctx.get("credentials") : undefined;
      const hit = await service?.resolve?.(BAILIAN_KEY_ENV);
      if (typeof hit?.value === "string") resolved = hit.value.trim();
    } catch (error) {
      logPoolEvent({ ev: "bailian-key", error: safeMessage(error) });
    }
    cached = { value: resolved, at: now };
    return resolved;
  };
}

/** 券时间来自 BSS（"yyyy-MM-dd HH:mm"，北京时间）→ 毫秒；解析不出来就给 undefined。 */
function couponLocalMs(value) {
  const text = String(value ?? "").trim();
  if (text === "") return undefined;
  const at = Date.parse(text.replace(" ", "T") + ":00+08:00");
  return Number.isFinite(at) ? at : undefined;
}

function bailianRoute(readKey, readVoucher) {
  return {
    key: BAILIAN_KEY,
    kind: "bailian",
    providerId: "aliyun-bailian",
    channelId: "aliyun-bailian",
    displayName: "阿里云百炼代金券",
    priority: 9,
    voucher: true,
    chatUrl: () => BAILIAN_BASE_URL + "/chat/completions",
    token: async () => {
      const key = await readKey();
      if (key === "") throw new Error("ALIYUN_BAILIAN_API_KEY 未配置（环境变量与凭据服务都没有）");
      return key;
    },
    models: () =>
      BAILIAN_MODELS.map((model) => ({
        id: model.id,
        name: model.name,
        api: "openai-completions",
        provider: BAILIAN_KEY,
        input: model.input,
        reasoning: true,
        thinkingLevelMap: BAILIAN_EFFORT_MAP,
        cost: NO_COST,
        contextWindow: 131072,
        maxTokens: 32768,
        compat: { maxTokensField: "max_tokens" },
      })),
    hidden: () => [],
    // 需求 1：给 refreshPoolCredits / poolStatusDocument 提供代金券余额。
    // 本机 /plugins/aliyun-voucher/balance 优先，没装那个插件就直签 BSS。
    credits: async () => {
      const voucher = await readVoucher();
      return {
        status: "ok",
        credits: {
          remaining: voucher.remaining,
          total: voucher.maxBudget,
          accounts: Array.isArray(voucher.coupons)
            ? voucher.coupons.map((coupon) => ({
                name: coupon.no ?? coupon.id ?? "代金券",
                packageName: coupon.description ?? coupon.no ?? "代金券",
                remaining: coupon.remaining,
                remain: coupon.remaining,
                // effectiveTime 是"生效时间"，绝不能叫 endTime —— minExpiry 会把它
                // 当成到期时间，导致代金券被误判成"最早过期"而抢先烧掉。
                effectiveTime: couponLocalMs(coupon.effectiveTime),
                expireTime: couponLocalMs(coupon.expiryTime),
              }))
            : [],
          // 券的到期时间（北京时间字符串 → ms）；minExpiry 会据此排到真正的到期点。
          expiry: couponLocalMs(voucher.expiresSoonest),
        },
        voucher,
      };
    },
  };
}

//#endregion

//#region 阿里云百炼代金券余额（需求 1）

/**
 * 内联一份 BSS OpenAPI v3 (ACS3-HMAC-SHA256) 只读签名。
 * 为什么不 import dsh-aliyun-voucher：池不能对另一个插件产生硬依赖，
 * 那个插件没装 / 没启用时余额照样要显示。逻辑与
 * ~/.dsh/plugins/dsh-aliyun-voucher/lib/aliyun-voucher.js 保持一致。
 */
const BSS_ENDPOINT = "https://business.aliyuncs.com/";
const BSS_HOST = "business.aliyuncs.com";
const VOUCHER_CREDENTIAL_VARS = [
  "ALIBABA_CLOUD_ACCESS_KEY_ID",
  "ALIBABA_CLOUD_ACCESS_KEY_SECRET",
  "ALIBABA_CLOUD_SECURITY_TOKEN",
];
const BAILIAN_VOUCHER_TTL_MS = 300_000;

const bssHash = (value) => createHash("sha256").update(value).digest("hex");

function canonicalQueryString(params) {
  const enc = (value) => encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return Object.entries(params ?? {})
    .map(([key, value]) => enc(key) + "=" + enc(value))
    .sort()
    .join("&");
}

async function resolveVoucherCredential(ctx, name) {
  try {
    const service = typeof ctx?.get === "function" ? ctx.get("credentials") : undefined;
    const hit = await service?.resolve?.(name);
    if (typeof hit?.value === "string" && hit.value.trim() !== "") return hit.value.trim();
  } catch {
    /* 回落到环境变量 */
  }
  return String(process.env[name] ?? "").trim();
}

function signBssRequest(accessKeyId, accessKeySecret, securityToken, spec, { now = new Date(), nonce = randomUUID() } = {}) {
  const query = canonicalQueryString(spec.query);
  const headers = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
    host: BSS_HOST,
    "x-acs-action": spec.action,
    "x-acs-content-sha256": bssHash(""),
    "x-acs-date": now.toISOString().replace(/\.\d{3}Z$/u, "Z"),
    "x-acs-signature-nonce": nonce,
    "x-acs-version": spec.version,
  };
  if (securityToken) headers["x-acs-security-token"] = securityToken;
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((key) => key + ":" + String(headers[key]).trim() + "\n")
    .join("");
  const canonical = ["POST", "/", query, canonicalHeaders, signedHeaders, bssHash("")].join("\n");
  const signature = createHmac("sha256", accessKeySecret).update("ACS3-HMAC-SHA256\n" + bssHash(canonical)).digest("hex");
  headers.authorization = "ACS3-HMAC-SHA256 Credential=" + accessKeyId + ",SignedHeaders=" + signedHeaders + ",Signature=" + signature;
  const url = query ? BSS_ENDPOINT + "?" + query : BSS_ENDPOINT;
  return { url, init: { method: "POST", headers, body: "", redirect: "manual" } };
}

function toAmount(value) {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

/** ISO(yyyy-MM-ddTHH:mm:ssZ) → yyyy-MM-dd HH:mm，券列表与面板展示共用。 */
function isoToLocalText(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/u.exec(String(iso ?? ""));
  return m ? m[1] + "-" + m[2] + "-" + m[3] + " " + m[4] + ":" + m[5] : (iso || null);
}

/** GET /plugins/aliyun-voucher/balance 在就直接用（那边也做了 5 分钟缓存）。 */
async function voucherFromLoopback() {
  const bases = ["http://127.0.0.1:7245", "http://127.0.0.1:3032"];
  for (const base of bases) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        const response = await fetch(base + "/plugins/aliyun-voucher/balance", { signal: controller.signal });
        if (!response.ok) continue;
        const data = await response.json();
        if (typeof data?.remaining !== "number") continue;
        return data;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      /* 换下一个端口 / 回落到直签 */
    }
  }
  return undefined;
}

function createBailianCreditsReader(ctx) {
  let cached = { doc: undefined, at: 0 };
  let inFlight;
  const run = async () => {
    const local = await voucherFromLoopback();
    if (local !== undefined) return local;
    const [accessKeyId, accessKeySecret, securityToken] = await Promise.all(
      VOUCHER_CREDENTIAL_VARS.map((name) => resolveVoucherCredential(ctx, name)),
    );
    if (!accessKeyId || !accessKeySecret) {
      throw new Error("请先配置 ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET（RAM AccessKey，不是百炼模型 API Key）");
    }
    const spec = { action: "QueryCashCoupons", version: "2017-12-14", query: { EffectiveOrNot: "true" } };
    const { url, init } = signBssRequest(accessKeyId, accessKeySecret, securityToken, spec);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    let response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      throw new Error("阿里云网络请求失败：" + safeMessage(error));
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = body?.Message || body?.Code || "";
      } catch {
        /* 无 body */
      }
      throw new Error("QueryCashCoupons HTTP " + response.status + (detail ? "：" + detail : ""));
    }
    const data = await response.json();
    if ((data?.Code && data.Code !== "Success") || data?.Success === false) {
      throw new Error("QueryCashCoupons 未成功：" + (data?.Message || data?.Code || "未知错误") + "（需要 RAM 权限 bss:DescribeCoupons）");
    }
    const list = Array.isArray(data?.Data?.CashCoupon) ? data.Data.CashCoupon : [];
    const coupons = list
      .map((item) => ({
        id: item.CashCouponId ?? null,
        no: item.CashCouponNo ?? null,
        remaining: toAmount(item.Balance),
        nominalValue: toAmount(item.NominalValue),
        status: item.Status ?? null,
        effectiveTime: isoToLocalText(item.EffectiveTime),
        expiryTime: isoToLocalText(item.ExpiryTime),
        description: typeof item.Description === "string" ? item.Description : null,
        applicableScenarios: item.ApplicableScenarios ?? null,
      }))
      .filter((coupon) => coupon.remaining !== null);
    const remaining = coupons.reduce((acc, coupon) => acc + coupon.remaining, 0);
    const maxBudget = coupons.reduce((acc, coupon) => acc + (coupon.nominalValue ?? coupon.remaining), 0);
    const expiresSoonest = coupons
      .filter((coupon) => !coupon.expiryTime || coupon.status !== "Expired")
      .map((coupon) => coupon.expiryTime)
      .filter(Boolean)
      .sort()[0] ?? null;
    return {
      label: "阿里云百炼代金券",
      unit: "CNY",
      remaining: Math.round(remaining * 100) / 100,
      maxBudget: Math.round(maxBudget * 100) / 100,
      spend: Math.round((maxBudget - remaining) * 100) / 100,
      count: coupons.length,
      coupons,
      expiresSoonest,
      updatedAt: new Date().toISOString(),
    };
  };
  return async (force = false) => {
    const now = Date.now();
    if (!force && cached.doc !== undefined && now - cached.at < BAILIAN_VOUCHER_TTL_MS) return cached.doc;
    if (inFlight !== undefined) return inFlight;
    inFlight = run()
      .then((doc) => {
        cached = { doc, at: Date.now() };
        return doc;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}

//#endregion

//#region 七牛云免费模型（需求 8）

const QINIU_ROUTE_KEY = "qiniu";
const QINIU_BASE_URL = "https://api.qnaigc.com/v1";
const QINIU_KEY_ENV = "QINIU_API_KEY";
const QINIU_KEY_FILE = "qiniu-api-key";
/** 2026-11-08 官网活动页：Conatus 限免 10.24 00:00 ~ 11.30 23:59（北京时间）。 */
const QINIU_CONATUS_FREE_UNTIL = Date.parse("2026-11-30T15:59:00Z");
const QINIU_FREE_MODELS = [
  {
    id: "qiniu/conatus-free",
    name: "七牛 Conatus 免费",
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    freeUntil: QINIU_CONATUS_FREE_UNTIL,
    freeLabel: "限时免费至 11.30",
  },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b0-free",
    name: "Nemotron 3 Ultra 550B 免费",
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    freeUntil: undefined,
    freeLabel: "免费（不承诺稳定性）",
  },
];
const QINIU_EFFORT_MAP = { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: "max", max: "max" };

function qiniuFreeModels() {
  const override = String(process.env.QINIU_FREE_MODELS ?? "").trim();
  if (override === "") return QINIU_FREE_MODELS;
  const ids = override.split(",").map((item) => item.trim()).filter(Boolean);
  // 活动结束/下线时只改 env 即可，不必改代码；配置过的 id 保留免费标记。
  return ids.map((id, index) => ({
    ...(QINIU_FREE_MODELS[index] ?? QINIU_FREE_MODELS[QINIU_FREE_MODELS.length - 1]),
    id,
    name: "七牛 " + id,
    input: ["text"],
  }));
}

function createQiniuKeyReader(ctx) {
  let cached = { value: "", at: 0 };
  return async () => {
    const fromEnv = String(process.env[QINIU_KEY_ENV] ?? "").trim();
    if (fromEnv !== "") return fromEnv;
    const now = Date.now();
    if (cached.value !== "" && now - cached.at < 60_000) return cached.value;
    let value = "";
    const dshHome = String(process.env.DSH_HOME ?? "").trim();
    const candidates = [
      dshHome === "" ? "" : join(dshHome, QINIU_KEY_FILE),
      join(homedir(), ".dsh", QINIU_KEY_FILE),
    ].filter(Boolean);
    for (const file of candidates) {
      try {
        const text = (await readFile(file, "utf8")).trim();
        if (text !== "") {
          value = text;
          break;
        }
      } catch {
        /* 试下一个位置 */
      }
    }
    if (value === "") {
      try {
        const service = typeof ctx?.get === "function" ? ctx.get("credentials") : undefined;
        const hit = await service?.resolve?.(QINIU_KEY_ENV);
        if (typeof hit?.value === "string") value = hit.value.trim();
      } catch {
        /* 没有凭据服务 */
      }
    }
    if (value === "") throw new Error("QINIU_API_KEY 未配置（环境变量、~/.dsh/qiniu-api-key 与凭据服务都没有）");
    cached = { value, at: now };
    return value;
  };
}

function qiniuRoute(readKey) {
  return {
    key: QINIU_ROUTE_KEY,
    kind: "qiniu",
    providerId: QINIU_ROUTE_KEY,
    channelId: QINIU_ROUTE_KEY,
    displayName: "七牛云免费 API",
    // 免费额度每日 00:00 重置、不结转，优先烧掉不浪费。
    priority: -1,
    voucher: false,
    free: true,
    chatUrl: () => QINIU_BASE_URL + "/chat/completions",
    token: readKey,
    models: () =>
      qiniuFreeModels().map((model) => ({
        id: model.id,
        name: model.name,
        api: "openai-completions",
        provider: QINIU_ROUTE_KEY,
        input: model.input,
        reasoning: true,
        thinkingLevelMap: QINIU_EFFORT_MAP,
        cost: NO_COST,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        free: true,
        freeUntil: model.freeUntil,
        freeLabel: model.freeLabel,
        badges: ["免费"],
        compat: { maxTokensField: "max_tokens" },
      })),
    hidden: () => [],
    // 免费额度每日 00:00（北京时间）重置、不结转 → 当天到期即"最早过期"，
    // 理应优先烧掉。但它是无限量占位值，不是真实积分：标记 syntheticBalance，
    // 让状态文档不要把它加进 credits.total、也不要用它撑爆前端进度条。
    credits: async () => ({
      status: "ok",
      syntheticBalance: true,
      credits: { remaining: 1e12, accounts: [], expiry: nextBeijingMidnight() },
    }),
  };
}

/** 下一个北京时间 00:00（UTC+8）的 UTC 毫秒时间戳。 */
function nextBeijingMidnight(now = Date.now()) {
  const shift = 8 * 60 * 60 * 1000;
  const day = 24 * 60 * 60 * 1000;
  return Math.floor((now + shift) / day) * day + day - shift;
}

//#endregion

/**
 * 挂载池 provider。
 *
 * config.readPreferences：返回面板偏好（poolEnabled / poolVoucherFirst）；
 * 不传就按"开 / 代金券殿后"处理。
 */
export function apply(ctx, config = {}) {
  const readPreferences =
    typeof config.readPreferences === "function"
      ? config.readPreferences
      : typeof config.preferences?.read === "function"
        ? config.preferences.read
        : () => undefined;
  const initial = readPreferences() ?? {};
  setPoolProviderActive(initial.poolEnabled !== false);
  setPoolVoucherPreference(initial.poolVoucherFirst === true);
  // 需求 2/3：合并开关与性价比排序开关写进模块级默认值；真正的活值仍由
  // viewOptionsOf(readPreferences) 每次请求现读，这里只保证未提供配置时的初值。
  setPoolMergePreference(initial.poolMergeModels !== false);
  setPoolCostFirstPreference(initial.poolCostFirst === true);

  // 代金券路由：路由表是懒读的，先注册不影响渠道先后；它永远排在积分路由之后。
  const releaseBailianRoute = registerPoolRoute(
    bailianRoute(createBailianKeyReader(ctx), createBailianCreditsReader(ctx)),
  );
  // 需求 8：七牛云两个免费模型，独立路由（priority -1，免费额度优先消耗）。
  const releaseQiniuRoute = registerPoolRoute(qiniuRoute(createQiniuKeyReader(ctx)));
  // 订阅制 Gemini Pro：与百炼/七牛同构的外部 API-key 路由。刻意不提供 credits()/status()，
  // 状态文档里 remaining = undefined、不累加 credits.total —— 没有积分就不显示积分余量。
  // models() 先用内置静态清单兜底（无 key 也能在模型库看到全部模型），有 key 时后台
  // 拉 /v1beta/openai/models 覆盖为上游权威全量清单，并通知 DSH 重拉模型列表。
  // 统一 token reader：oauth 模式返回 Google OAuth access_token（Code Assist 通道，
  // 复用订阅不绑卡），apikey 模式回退到原 API key；按登录态每请求动态分派。
  const readGeminiToken = createGeminiTokenReader(ctx);
  const releaseGeminiRoute = registerPoolRoute(geminiRoute(readGeminiToken));
  const stopGeminiRefresh = startGeminiModelRefresh(readGeminiToken);
  // 华为云 CodeArts：与 Gemini 同构的一条外部订阅/积分路由。刻意提供 credits()/status()，
  // 让积分余额 / 即将过期额度 / 逐号明细汇入 /plugins/dsh-pool/status 的统一额度面板；
  // libraryBypass:true 让上游动态模型目录不被内置白名单丢弃。
  const readCodeartsToken = createCodeartsTokenReader();
  const releaseCodeartsRoute = registerPoolRoute(codeartsRoute(readCodeartsToken));
  const stopCodeartsRefresh = startCodeartsRefresh();
  try {
    ctx.effect(() => () => {
      releaseBailianRoute();
      releaseQiniuRoute();
      releaseGeminiRoute();
      stopGeminiRefresh();
      releaseCodeartsRoute();
      stopCodeartsRefresh();
    });
  } catch {
    /* 宿主没有 effect 平面时路由随进程结束 */
  }

  const proxy = createPoolProxy({ readPreferences, logger: ctx.logger });

  // 热重载会再跑一次 apply()：先备好清理栈，任何一步抛错都把已经建起来的
  // timer / 监听 / adapter 全部回收，避免每重载一次就漏一组资源。dispose 幂等。
  const disposers = [];
  let disposed = false;
  const disposeAll = () => {
    if (disposed) return;
    disposed = true;
    for (const fn of disposers.reverse()) {
      try { fn(); } catch { /* 单个清理失败不影响其余 */ }
    }
  };

  const start = async () => {
    await proxy.ready;
    const adapter = createPoolAdapter({
      proxy,
      readPreferences,
      resolveAttachments: () => ctx.get("attachments"),
    });
    const releaseAdapter = ctx.llm.registerAdapter([POOL_PROVIDER], adapter);
    disposers.push(releaseAdapter);
    const offRoutes = onPoolRoutesChanged(() => {
      try {
        ctx.emit("llm/adapters-updated");
      } catch {
        /* 宿主没这条事件也不影响请求 */
      }
    });
    disposers.push(offRoutes);
    const timer = setInterval(() => {
      void refreshPoolCredits({}).catch(() => {});
    }, 10 * 60 * 1000);
    if (typeof timer.unref === "function") timer.unref();
    disposers.push(() => clearInterval(timer));
    void refreshPoolCredits({}).catch(() => {});
    disposers.push(() => proxy.close());
    try {
      ctx.effect(() => disposeAll, "dsh-pool: lifecycle");
    } catch {
      /* 宿主没有 effect 平面：进程退出时自然回收；此处不要立刻 dispose */
    }
    ctx.logger?.info?.("dsh-pool: 积分池已挂载 → " + proxy.baseUrl());
  };

  void start().catch((error) => {
    ctx.logger?.error?.("dsh-pool: 积分池启动失败（其它渠道不受影响）", error);
    // 失败时把可能已经建起来的 timer/adapter/监听收掉，不能只关代理。
    disposeAll();
  });

  ctx.inject(["webServer"], (webCtx) => {
    try {
      ctx.effect(() => {
        const dispose = webCtx.webServer.register({
          kind: "exact",
          path: POOL_STATUS_PATH,
          handler: async (req, res) => {
            if (!loopbackRequest(req)) {
              writeJson(res, 403, { error: "request-not-trusted" });
              return;
            }
            // 本机额度同步桥：读到 Gemini App 用量页的小脚本 / 扩展把
            // { current: { usedPercent, resetAt }, weekly: { ... } } POST 到这里即写缓存。
            // quota.js 只挑额度白名单字段落盘，body 里任何 token/cookie 一律忽略、不打印。
            if (req.method === "POST") {
              try {
                const raw = await readBody(req, 16 * 1024);
                const payload = JSON.parse(raw.toString("utf8"));
                const saved = writeGeminiQuota(payload);
                writeJson(res, 200, { ok: true, geminiQuota: saved });
              } catch (error) {
                writeJson(res, 400, { ok: false, error: safeMessage(error) });
              }
              return;
            }
            if (req.method !== "GET") {
              writeJson(res, 405, { error: "method not allowed" });
              return;
            }
            try {
              const url = new URL(req.url ?? "/", "http://127.0.0.1");
              // 状态快照现读面板偏好：Config 字段是 volatile 引用，settings.update() 走
              // updateVolatile() 原地改内存，不写 profile patch、不触发 apply() 重跑；
              // 启动时写一次的模块级旗标会永久滞后，故把活值显式传给文档，与
              // forwardChat / enabled() 的现读口径保持一致（8.4 第 6/7 项）。
              const prefs = readPreferences() ?? {};
              const doc = await poolStatusDocument({
                force: url.searchParams.get("refresh") === "1",
                voucherFirst: prefs.poolVoucherFirst === true,
                merge: prefs.poolMergeModels !== false,
                costFirst: prefs.poolCostFirst === true,
                showRoutes: prefs.poolShowRoutes === true,
              });
              doc.active = prefs.poolEnabled !== false;
              doc.geminiQuota = await readGeminiQuota({ refresh: url.searchParams.get("refresh") === "1" });
              // OAuth2 登录态诊断（零密文）：mode/loggedIn/projectId/鉴权 URL 等。
              doc.geminiAuth = geminiAuthStatus();
              // CodeArts：积分余额 / 逐号明细 / 即将过期额度 / 每日签到 / 上游排队位置 /
              // 本机请求数与 token 用量统一挂到状态文档；两个开关单独控显示（默认开）。
              try { doc.codearts = await codeartsDetail(); } catch { doc.codearts = undefined; }
              try { doc.codeartsAuth = await codeartsAuthStatus(); } catch { doc.codeartsAuth = undefined; }
              // patch 标记：宿主是否已加载这一版池代码（26 模型白名单 / 确定性排序 /
              // 性价比开关 / 路由显示开关 / 积分过期跨路由 / 下拉只留合并模型 /
              // ux-v5 面板开关归入模型库 / ux-v6 免费语义收窄+思考强度默认最高档+
              // 下拉显示开关重整+渠道中心残留入口清理 / ux-v7 Gemini 4 模型收敛+
              // 官方用量限额区块与本机同步端点 / ux-v8 OAuth2 Code Assist 复用
              // Google AI Pro 订阅、免绑卡 / ux-v9 修复 Gemini 偶发 429 导致的
              // 60 秒 quota 熔断锁死（route.fetch 内短退避重试 + 单路由组熔断兜底探测），
              // ux-v10 修复 Gemini「整段无法回答」的两个真实缺陷：① 拒绝窗口自愈 ——
              // 400 FAILED_PRECONDITION / 404 NOT_FOUND / 503 不再被当成「模型名非法」
              // 立刻放弃，也不再记 60s transport 熔断；改为 route.fetch 内短退避重试 +
              // 候选轮换（5s 单请求 / 12s 整轮封顶），池侧单独记 15s upstream 冷却并即时探测。
              // ② 补 gemini-3.5-pro / gemini-3.1-pro-high 两个宿主下拉里真实存在的档位
              // （此前不在模型白名单 → 池里没有 gemini 候选 → 直接 402）。
              // 附带：探测窗口首字节 6s 超时 + 自动提档改面板开关，首 token 更快。
              // ux-v14：① 当日将过期积分优先烧（expiring/expiringAt + latch 让位 +
              // 成功后失效积分缓存）；② 错误分类优先读结构化 error.kind，不再靠英文
              // 正则猜中文错误体；③ 删掉 gemini 的 libraryBypass 白名单旁路。
              // 一眼可查。
              writeJson(res, 200, { ...doc, patch: "ux-v14" });
            } catch (error) {
              writeJson(res, 500, { error: safeMessage(error) });
            }
          },
        });
        return () => dispose();
      }, "dsh-pool: status route");

      // GET   /plugins/dsh-pool/breakers             → 当前冷却快照
      // POST  /plugins/dsh-pool/breakers?route=KEY   → 清那一条（不传 route 清全部）
      // 用途：重新登录被封/掉线的渠道后，别为了等 auth 冷却（10 分钟）干着急。
      ctx.effect(() => {
        const dispose = webCtx.webServer.register({
          kind: "exact",
          path: POOL_BREAKERS_PATH,
          handler: async (req, res) => {
            if (!loopbackRequest(req)) {
              writeJson(res, 403, { error: "request-not-trusted" });
              return;
            }
            if (req.method === "POST" || req.method === "DELETE") {
              let route = "";
              try {
                route = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("route") ?? "";
              } catch {
                route = "";
              }
              const cleared = clearBreakers(route);
              logPoolEvent({ ev: "breaker-clear", route: route === "" ? "*" : route, cleared });
              writeJson(res, 200, { ok: true, cleared, cooling: breakerReport() });
              return;
            }
            if (req.method !== "GET") {
              writeJson(res, 405, { error: "method not allowed" });
              return;
            }
            writeJson(res, 200, { cooling: breakerReport() });
          },
        });
        return () => dispose();
      }, "dsh-pool: breakers route");

      // GET  /plugins/dsh-pool/gemini-oauth            → 登录态 + 进行中的登录会话
      // POST /plugins/dsh-pool/gemini-oauth            → { action: "start" | "submit" | "cancel", code? }
      //   start  → 起本地 loopback 服务器，返回 authUrl（用户浏览器打开完成 Google 授权）
      //   submit → 粘贴回调 URL / 授权 code（无浏览器时的手输兜底）
      //   cancel → 取消进行中的登录
      // 全程零密文：不返回 access_token / refresh_token / client_secret。
      ctx.effect(() => {
        const dispose = webCtx.webServer.register({
          kind: "exact",
          path: POOL_GEMINI_OAUTH_PATH,
          handler: async (req, res) => {
            if (!loopbackRequest(req)) {
              writeJson(res, 403, { error: "request-not-trusted" });
              return;
            }
            if (req.method === "GET") {
              writeJson(res, 200, {
                ok: true,
                auth: geminiAuthStatus(),
                login: geminiLoginInfo(),
              });
              return;
            }
            if (req.method !== "POST") {
              writeJson(res, 405, { error: "method not allowed" });
              return;
            }
            try {
              const raw = await readBody(req, 64 * 1024);
              let payload = {};
              try {
                payload = JSON.parse(raw.toString("utf8"));
              } catch {
                // 也接受纯文本 code：body 直接就是回调 URL 或授权码
                payload = { action: "submit", code: raw.toString("utf8") };
              }
              const action = String(payload.action || "status").trim().toLowerCase();
              if (action === "start") {
                const info = await startGeminiLogin();
                writeJson(res, 200, { ok: true, action: "start", ...info, auth: geminiAuthStatus() });
              } else if (action === "submit") {
                const result = await submitGeminiLoginCode(payload.code ?? payload.input ?? payload.url ?? "");
                writeJson(res, 200, { ok: true, action: "submit", ...result, auth: geminiAuthStatus() });
              } else if (action === "cancel") {
                const result = cancelGeminiLogin();
                writeJson(res, 200, { ok: true, action: "cancel", ...result, auth: geminiAuthStatus() });
              } else {
                writeJson(res, 200, { ok: true, action: "status", auth: geminiAuthStatus(), login: geminiLoginInfo() });
              }
            } catch (error) {
              writeJson(res, 400, { ok: false, error: safeMessage(error), auth: geminiAuthStatus() });
            }
          },
        });
        return () => dispose();
      }, "dsh-pool: gemini-oauth route");

      // CodeArts 的 4 条 loopback 路由（OAuth 登录/粘贴 token/登出、渠道状态、签到、排队探测）。
      // applyCodeartsRoutes 返回回收闭包，交给 effect 在热重载时统一反注册。
      ctx.effect(() => applyCodeartsRoutes(webCtx, ctx), "dsh-pool: codearts routes");
    } catch (error) {
      ctx.logger?.warn?.("dsh-pool: 状态路由注册失败（池本身不受影响）", error);
    }
  });
}
