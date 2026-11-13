/**
 * Gemini Pro（Google AI Pro 订阅）—— 积分池的 OpenAI 兼容路由。
 *
 * 支持两种认证模式，按 GEMINI_AUTH 或登录态每请求动态分派（登录后无需重启）：
 *
 *  A) oauth 模式（默认目标，复用 Google AI Pro 订阅，完全不绑卡）：
 *     上游 https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent
 *     · 认证：OAuth2 access_token（Google 账号登录换取，自动 refresh）
 *     · 转发：codeAssistFetch 把 OpenAI chat/completions 译成
 *       CAGenerateContentRequest，再把 Code Assist SSE 译回 OpenAI chunk
 *     · token() 返回 OAuth access_token；chatUrl()/fetch 走 Code Assist
 *     · /models 刷新在 oauth 模式跳过（该端点只认 API key）
 *
 *  B) apikey 模式（回退，需项目绑卡开通 free/paid tier）：
 *     上游 https://generativelanguage.googleapis.com/v1beta/openai/
 *     · 认证：Authorization: Bearer <GEMINI_API_KEY>
 *     · 转发：geminiFetch 直连 OpenAI 兼容层
 *
 * 模型库只放用户点名的 4 个：Gemini 4 Argon / 3.1 Pro Preview / 3.8 Flash /
 * 3.5 Flash Lite；oauth 模式由 codeassist.js 的 MODEL_MAP 映射到真实 Code Assist
 * 模型名。与百炼/七牛两条外部 API-key 路由同构：只在 apply() 里 registerPoolRoute。
 *
 * 凭证纪律：key / token 只在内存里用，绝不打印、不落盘、不写日志。
 * 「不显示积分余量」：本路由刻意不提供 credits() 也不提供 status()；官方订阅
 * 用量限额由 ./quota.js 单独在面板展示，不累加进 credits.total。
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { geminiFetch, geminiProxyInfo } from "./proxy.js";
import {
  geminiAuthMode,
  readOAuthAccessToken,
  geminiAuthStatus,
  startGeminiLogin,
  submitGeminiLoginCode,
  cancelGeminiLogin,
  waitForGeminiLogin,
  geminiLoginInfo,
} from "./oauth.js";
import { codeAssistFetch, codeAssistChatUrl } from "./codeassist.js";

// Re-export so the pool only needs to import from this module.
export {
  geminiAuthMode,
  geminiAuthStatus,
  startGeminiLogin,
  submitGeminiLoginCode,
  cancelGeminiLogin,
  waitForGeminiLogin,
  geminiLoginInfo,
};

const GEMINI_ROUTE_KEY = "gemini";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const GEMINI_KEY_ENVS = ["GEMINI_API_KEY", "GOOGLE_API_KEY"];
const GEMINI_KEY_FILE = "gemini-api-key";
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * OpenAI reasoning_effort → Gemini 档位。oauth 模式由 codeassist.js 把它译成
 * thinkingConfig；apikey 模式原样交给 OpenAI 兼容层。xhigh / max 落到 high。
 */
const GEMINI_EFFORT_MAP = {
  off: null,
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

/** 用户点名的 4 个模型：内置权威清单，顺序即综合能力由强到弱。 */
const GEMINI_STATIC_MODELS = [
  ["gemini-4-argon", "Gemini 4 Argon"],
  ["gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"],
  ["gemini-3.8-flash", "Gemini 3.8 Flash"],
  ["gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite"],
  // ux-v10：宿主模型下拉里实际存在的 pro 两档，之前没进白名单 → 池里没有 gemini
  // 候选 → 请求直接落到别的渠道并 402。补进来，codeassist 侧已有对应映射。
  ["gemini-3.5-pro", "Gemini 3.5 Pro"],
  ["gemini-3.1-pro-high", "Gemini 3.1 Pro High"],
];

/** 白名单：/models 动态清单里只有这 4 个 id 允许进池，其它一律不放进来。 */
const ALLOWED_MODEL_IDS = new Set(GEMINI_STATIC_MODELS.map(([id]) => id.toLowerCase()));

const CONTEXT_WINDOW = 1_048_576;
const MAX_TOKENS = 65_536;

function normalizeId(raw) {
  let id = String(raw ?? "").trim();
  if (id.startsWith("models/")) id = id.slice("models/".length);
  return id;
}

function isChatModel(id) {
  return ALLOWED_MODEL_IDS.has(String(id ?? "").trim().toLowerCase());
}

function prettyName(id) {
  return String(id)
    .split("-")
    .map((part, index) => {
      if (index === 0) return "Gemini";
      if (/^\d/u.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function describeModel(id, name) {
  return {
    id,
    name: typeof name === "string" && name.trim() !== "" ? name.trim() : prettyName(id),
    api: "openai-completions",
    provider: GEMINI_ROUTE_KEY,
    input: ["text", "image"],
    reasoning: true,
    thinkingLevelMap: GEMINI_EFFORT_MAP,
    cost: NO_COST,
    contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_TOKENS,
    compat: { maxTokensField: "max_tokens" },
  };
}

const STATIC_MODELS = GEMINI_STATIC_MODELS.map(([id, name]) => describeModel(id, name));

let refreshTimer = null;
let refreshToken = 0;
let refreshing = false;
let lastRefreshError = "";
let lastUpstreamHits = 0;

/** 恒为用户点名的 4 条模型：上游 /models 只作可达性验证，不替换这份清单。 */
function currentModels() {
  return STATIC_MODELS;
}

/**
 * API key 读取优先级（apikey 模式用）：
 *   1. process.env.GEMINI_API_KEY / GOOGLE_API_KEY
 *   2. $DSH_HOME/gemini-api-key
 *   3. ~/.dsh/gemini-api-key
 *   4. ctx.get("credentials").resolve(...)
 * 结果缓存 60 秒。全都没有时抛错，由转发层自动切到下一条路由。
 */
export function createGeminiKeyReader(ctx) {
  let cached = { value: "", at: 0 };
  return async () => {
    for (const name of GEMINI_KEY_ENVS) {
      const fromEnv = String(process.env[name] ?? "").trim();
      if (fromEnv !== "") return fromEnv;
    }
    const now = Date.now();
    if (cached.value !== "" && now - cached.at < 60_000) return cached.value;
    let value = "";
    const dshHome = String(process.env.DSH_HOME ?? "").trim();
    const candidates = [
      dshHome === "" ? "" : join(dshHome, GEMINI_KEY_FILE),
      join(homedir(), ".dsh", GEMINI_KEY_FILE),
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
        for (const name of GEMINI_KEY_ENVS) {
          const hit = await service?.resolve?.(name);
          if (typeof hit?.value === "string" && hit.value.trim() !== "") {
            value = hit.value.trim();
            break;
          }
        }
      } catch {
        /* 没有凭据服务 */
      }
    }
    if (value === "") {
      throw new Error("GEMINI_API_KEY 未配置（环境变量、~/.dsh/gemini-api-key 与凭据服务都没有）");
    }
    cached = { value, at: now };
    return value;
  };
}

/**
 * 统一 token reader：池把它的返回值塞进 "Bearer <token>"。
 *   · oauth  模式 → readOAuthAccessToken()（自动刷新，落盘 ~/.dsh/gemini-oauth.json）
 *   · apikey 模式 → 原 key 读取逻辑
 * 每请求现读 geminiAuthMode()，所以 GUI 里完成 OAuth 登录后无需重启即生效。
 */
export function createGeminiTokenReader(ctx) {
  const readApiKey = createGeminiKeyReader(ctx);
  return async () => {
    if (geminiAuthMode() === "oauth") return readOAuthAccessToken();
    return readApiKey();
  };
}

/**
 * 兼容 OpenAI 风格 {data:[{id}]} 与原生 {models:[{name,displayName}]} 两种响应。
 * 只保留白名单里的 4 个 id，按用户点名的顺序返回。
 */
function parseModelRows(doc) {
  const rows = Array.isArray(doc?.data) ? doc.data : Array.isArray(doc?.models) ? doc.models : [];
  const upstream = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = normalizeId(row.id ?? row.name ?? row.model ?? "");
    if (isChatModel(id)) upstream.add(id.toLowerCase());
  }
  return GEMINI_STATIC_MODELS
    .filter(([id]) => upstream.has(id.toLowerCase()))
    .map(([id, name]) => ({ id, name }));
}

async function fetchModelList(readKey) {
  const key = await readKey();
  const response = await geminiFetch(GEMINI_BASE_URL + "/models", {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: "Bearer " + key,
      "x-goog-api-key": key,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error("gemini /models http " + response.status);
  return parseModelRows(await response.json());
}

/**
 * 后台拉一次上游 /models 只做「可达性 + 白名单命中」验证，不替换模型清单。
 * oauth 模式跳过：该端点只认 API key，用 OAuth token 打会得到误导性的 401，
 * 且订阅态模型清单由 codeassist.js 的映射固定，无需探测。
 */
export async function refreshGeminiModels(readKey) {
  if (geminiAuthMode() === "oauth") return false;
  if (refreshing) return false;
  refreshing = true;
  try {
    const rows = await fetchModelList(readKey);
    lastUpstreamHits = rows.length;
    lastRefreshError = "";
    return false;
  } catch (error) {
    lastRefreshError = error instanceof Error ? error.message : String(error);
    return false;
  } finally {
    refreshing = false;
  }
}

/** 立即刷一次 + 每 10 分钟刷一次；返回幂等 stopper。 */
export function startGeminiModelRefresh(readKey, intervalMs = 10 * 60 * 1000) {
  const token = ++refreshToken;
  if (refreshTimer !== null) clearInterval(refreshTimer);
  const tick = () => { void refreshGeminiModels(readKey); };
  tick();
  refreshTimer = setInterval(tick, intervalMs);
  if (typeof refreshTimer.unref === "function") refreshTimer.unref();
  return () => {
    if (token !== refreshToken) return;
    if (refreshTimer !== null) clearInterval(refreshTimer);
    refreshTimer = null;
  };
}

/** 只读诊断，绝不暴露 key / token；池不会调用它（避免被当成积分探针）。 */
export function geminiModelSource() {
  return {
    allowlist: GEMINI_STATIC_MODELS.map(([id]) => id),
    count: currentModels().length,
    upstreamHits: lastUpstreamHits,
    lastRefreshError,
    proxy: geminiProxyInfo(),
    auth: geminiAuthStatus(),
  };
}

/**
 * 隐藏钩子（ux-v14 · P2-3）。
 *
 * 与 workbuddy / trae / qoder / codearts 同一套：lib/index.js 在 apply 时把
 * disabledModelsFor / pickerHiddenFor 注入进来，于是「禁用模型」「禁用渠道」
 * 对 Gemini 也即时生效，不再是一条绕开所有面板规则的例外路由。
 *
 * 注意 pickerHidden 的哨兵（NUL 开头的 hide-all）不会命中任何模型 id，
 * 所以池路由这条路上「池启用就全隐藏」的语义天然不生效 —— 与 codearts 一致。
 */
let externalHidden = function () { return []; };
let pickerHidden = function () { return []; };
export function setExternalHidden(fn) {
  externalHidden = typeof fn === 'function' ? fn : function () { return []; };
}
export function setPickerHidden(fn) {
  pickerHidden = typeof fn === 'function' ? fn : function () { return []; };
}

/**
 * 池路由。
 *
 * ux-v14 起不再声明 libraryBypass：Gemini 的 6 个 id 已全部显式列入
 * shared/pool.js 的 CURATED_MODELS，白名单是唯一真相源；绕过白名单的兜底
 * 一旦留着，上游日后多出一个 id 就会悄悄灌进模型库（P2-3 的原始症状）。
 *
 * token / chatUrl / fetch 均按 geminiAuthMode() 每请求动态分派：
 *   fetch 是一个 wrapper，oauth 模式转给 codeAssistFetch（翻译协议），
 *   apikey 模式转给 geminiFetch（直连 OpenAI 兼容层）。
 */
export function geminiRoute(readToken) {
  const fetchDispatch = (url, init) => {
    if (geminiAuthMode() === "oauth") return codeAssistFetch(url, init);
    return geminiFetch(url, init);
  };
  return {
    key: GEMINI_ROUTE_KEY,
    kind: "gemini",
    providerId: "google-generative-language",
    channelId: "gemini-pro",
    displayName: "Gemini Pro",
    priority: 3,
    voucher: false,
    chatUrl: () =>
      geminiAuthMode() === "oauth"
        ? codeAssistChatUrl()
        : GEMINI_BASE_URL + "/chat/completions",
    token: readToken,
    // 自定义 fetch：apikey 走 clash CONNECT 隧道直连；oauth 走 Code Assist 协议翻译。
    fetch: fetchDispatch,
    models: () => currentModels(),
    // ux-v14：与 codearts/index.js 的拼接法一致，吃面板的禁用模型 / 禁用渠道规则。
    hidden: () => [...externalHidden(GEMINI_ROUTE_KEY), ...pickerHidden(GEMINI_ROUTE_KEY)],
    // 刻意不提供 credits() / status()：订阅制没有积分余额。
  };
}
