/**
 * 自定义路由（kind: "custom"）—— 把注册表里的条目变成池里的一条真实路由。
 *
 * ## 为什么要有这个文件
 *
 * 内置渠道（workbuddy / trae / qoder / codearts / bailian / qiniu）各自有一套
 * 登录态、模型目录和额度接口，都是写死的 provider。用户想接的"其它 OpenAI 兼容
 * API"没有这套东西 —— 他们只有三件事要说清楚：**上游地址、请求路径、模型 id 列表**。
 *
 * 所以自定义路由不写 provider，只把注册表条目翻译成池路由对象
 * （见 {@link createCustomRoute}），由 `lib/shared/pool.js` 的注册表统一调度：
 * 池代理在请求时把 body.model 改成候选模型 id，带上 Bearer token，POST 到
 * `baseUrl + apiPath`。额度、签到、登录态一概没有 —— 这三样对自定义路由不成立，
 * 面板侧也据此短路（probeCustomChannel / claimOne）。
 *
 * ## 装载时机（重要）
 *
 * provider 侧是**冷装载**：只在 DSH 启动时读一次注册表。面板里新建渠道或改写
 * `baseUrl`/`models` 之后，必须重启 DSH 才会出现在模型选择器里。这与
 * `channel-registry.js` 头注释里"面板/聚合侧全动态、provider 侧重启装载"的
 * 既有约定一致，不另开一套热更新通道。
 *
 * ## 凭据
 *
 * API Key 不写进注册表（`connect-channels.json` 会进 git、进备份）。它落在
 * `$DSH_HOME/connect-auth/<渠道 id>.key`，由面板的"粘贴凭据"写入（0600）。
 * 读取顺序与其它渠道一致：环境变量 → 凭据文件 → 宿主凭据服务。
 *
 * @module dsh-pool/custom-routes
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HIDE_ALL_SENTINEL } from "../../shared/hidden.js";
// directFetch：显式直连，绕开别的插件对 globalThis.fetch 的包装（见 net-rescue.js）。
import { directFetch } from "../../shared/net-rescue.js";
// 直接静态引用池注册表：routes-builtin.js 也这么干（它 import logPoolEvent）。
// 别改成动态 import —— check-imports.mjs 只认静态边，「引用了但没导入」会被判失败。
import { registerPoolRoute } from "../../shared/pool.js";
import { normalizeCustomModels, readRegistry, resolveDshHome, writeRegistry } from "../../channel-registry.js";

/** 自定义路由没有计费信息：声称任何价格都会污染"最便宜优先"的排序。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * 自定义路由在池里的优先级。
 *
 * 现有区间：qiniu -1 < workbuddy 0 < trae 1 < qoder 2 < codearts 3 < bailian 9。
 * 取 5 是"排在所有免费/代金券渠道之后、但仍早于百炼代金券"的位置 —— 同名的
 * 模型仍然优先烧免费额度，只有它们都挂了才轮到用户自己掏钱的线路。
 *
 * 实际上用户自填的模型名几乎不会与内置渠道重名，这个值平时不参与决策。
 */
const CUSTOM_PRIORITY = 5;

/** 上游地址兜底：DSH 的默认端口，与 pool/index.js 的 loopback 习惯一致。 */
const CUSTOM_CONTEXT_WINDOW = 200000;
const CUSTOM_MAX_TOKENS = 32000;

/** Key 读取缓存：面板 30 秒轮询凭据，这里 10 秒足够挡住一次请求风暴。 */
const KEY_CACHE_MS = 10_000;

/**
 * 自定义路由对应的环境变量名：`CUSTOM_<ID>_API_KEY`（id 里非字母数字变下划线）。
 *
 * @param {string} id 渠道 id
 * @returns {string}
 */
function keyEnvName(id) {
  return "CUSTOM_" + id.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase() + "_API_KEY";
}

/**
 * 凭据文件路径：`$DSH_HOME/connect-auth/<id>.key`。
 *
 * 与 panel.js 的 authTargets() 保持同一处落点 —— 那边写、这边读，任何一侧改
 * 路径都会让"粘贴后不生效"。
 *
 * @param {string} id 渠道 id
 * @returns {string}
 */
export function customKeyPath(id) {
  // 用宿主那份 resolveDshHome：channel-registry.js 与 panel.js 都从同一处推导，
  // 这里要是自己拼 homedir()，DSH_HOME 指向别处时面板写进去的 key 就永远读不到。
  return join(resolveDshHome(), "connect-auth", id + ".key");
}

/**
 * 造一个读 key 的函数（带 10 秒缓存）。
 *
 * 顺序：环境变量 → 凭据文件 → 宿主凭据服务 `ctx.get("credentials").resolve()`。
 * 三处都没有就抛错 —— 与 bailian / qiniu 的既有写法一致：**不谎报有 key**，
 * 否则请求打到上游才 401，日志里看不出是本地没配。
 *
 * @param {string} id 渠道 id
 * @param {object} [ctx] 宿主上下文（可选，用来拿凭据服务）
 * @returns {() => Promise<string>}
 */
export function createCustomKeyReader(id, ctx) {
  let cached = { value: "", at: 0 };
  const envName = keyEnvName(id);
  const file = customKeyPath(id);
  return async () => {
    const now = Date.now();
    if (cached.value !== "" && now - cached.at < KEY_CACHE_MS) return cached.value;
    let resolved = "";
    const fromEnv = process.env[envName];
    if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
      resolved = fromEnv.trim();
    }
    if (resolved === "") {
      try {
        resolved = (await readFile(file, "utf8")).trim();
      } catch {
        /* 文件不存在就是没配，继续往下走 */
      }
    }
    if (resolved === "") {
      try {
        const service = typeof ctx?.get === "function" ? ctx.get("credentials") : undefined;
        const hit = await service?.resolve?.(envName);
        if (typeof hit?.value === "string") resolved = hit.value.trim();
      } catch {
        /* 没有凭据服务就是这个环境不支持，不算错误 */
      }
    }
    if (resolved === "") {
      throw new Error(envName + " 未配置（面板粘贴 API Key，或写 " + file + "，或设环境变量）");
    }
    cached = { value: resolved, at: now };
    return resolved;
  };
}

/**
 * 这条自定义路由该隐藏哪些模型 id。
 *
 * 与 panel.js 的 disabledModelsFor() 同一套语义，但**不能直接 import panel.js**
 * ——那会把整块面板（以及它依赖的 fs / 设置服务）拖进 provider 的模块图。
 *
 *   · 渠道被整条禁用（prefs.disabledChannels 含该 id）→ 返回哨兵，全隐藏；
 *   · 逐模型禁用（prefs.disabledModels 里的 `<id>/<model>`）→ 返回模型 id。
 *
 * @param {string} id 渠道 id
 * @param {() => object} readPreferences 面板偏好读取函数
 * @returns {string[]}
 */
function hiddenOf(id, readPreferences) {
  let prefs;
  try {
    prefs = typeof readPreferences === "function" ? readPreferences() : undefined;
  } catch {
    prefs = undefined;
  }
  const disabledChannels = Array.isArray(prefs?.disabledChannels) ? prefs.disabledChannels : [];
  if (disabledChannels.includes(id)) return [HIDE_ALL_SENTINEL];
  const disabledModels = Array.isArray(prefs?.disabledModels) ? prefs.disabledModels : [];
  const prefix = id + "/";
  const out = [];
  for (const value of disabledModels) {
    if (typeof value === "string" && value.startsWith(prefix) && value.length > prefix.length) {
      out.push(value.slice(prefix.length));
    }
  }
  return out;
}

/**
 * 把一条注册表条目翻译成池路由。
 *
 * 契约见 `lib/shared/pool.js` 的 assertRoute()：key 非空 + chatUrl()/token()/models()。
 *
 * @param {{id: string, displayName?: string, baseUrl: string, apiPath?: string, models?: string[]}} entry 注册表条目
 * @param {{readPreferences?: () => object, ctx?: object}} [options]
 * @returns {object} 池路由
 */
export function createCustomRoute(entry, options = {}) {
  const id = entry.id;
  const apiPath = typeof entry.apiPath === "string" && entry.apiPath !== "" ? entry.apiPath : "/chat/completions";
  const chatUrl = entry.baseUrl + apiPath;
  const ids = Array.isArray(entry.models) ? entry.models.filter((value) => typeof value === "string" && value !== "") : [];
  const readKey = createCustomKeyReader(id, options.ctx);
  const readPreferences = options.readPreferences;
  return {
    key: id,
    kind: "custom",
    providerId: id,
    channelId: id,
    displayName: typeof entry.displayName === "string" && entry.displayName !== "" ? entry.displayName : id,
    priority: CUSTOM_PRIORITY,
    voucher: false,
    // 上游地址在注册时就定死了：改地址等于换了一条线路，必须重启 DSH。
    chatUrl: () => chatUrl,
    token: readKey,
    models: () =>
      ids.map((modelId) => ({
        id: modelId,
        name: modelId,
        api: "openai-completions",
        provider: id,
        // 自定义线路的能力未知，只声称文本：多说一句"支持图片"就会让宿主往上送
        // base64，上游不认时用户看到的是莫名其妙的 400。
        input: ["text"],
        reasoning: false,
        cost: NO_COST,
        contextWindow: CUSTOM_CONTEXT_WINDOW,
        maxTokens: CUSTOM_MAX_TOKENS,
        compat: { maxTokensField: "max_tokens" },
      })),
    hidden: () => hiddenOf(id, readPreferences),
    // 上游不提供余额接口：不声明 credits()，refreshOneRoute 会按"无额度信息"处理，
    // 面板上这一行只有模型清单，没有余额条 —— 好过编一个假的 0。
  };
}

/**
 * 注册表里所有自定义条目（已经过 normalizeEntry，baseUrl/apiPath/models 都可用）。
 *
 * @returns {{id: string, displayName?: string, baseUrl: string, apiPath?: string, models?: string[]}[]}
 */
export function listCustomEntries() {
  let channels;
  try {
    channels = readRegistry().channels;
  } catch {
    return [];
  }
  return channels.filter((entry) => entry.kind === "custom" && typeof entry.baseUrl === "string" && entry.baseUrl !== "");
}

/**
 * 一次性注册全部自定义路由，返回注销函数数组（调用方塞进自己的 disposers）。
 *
 * 没写 API Key 的条目**跳过并留一条 warn**：否则模型选择器里会出现一批必然
 * 401 的模型，用户分不清是"没配 key"还是"上游坏了"。配好 key 后重启 DSH 即生效。
 *
 * @param {{readPreferences?: () => object, ctx?: object, logger?: object}} [options]
 * @returns {Promise<(() => void)[]>}
 */
export async function registerCustomRoutes(options = {}) {
  const releases = [];
  for (const entry of listCustomEntries()) {
    const route = createCustomRoute(entry, options);
    let key = "";
    try {
      key = await route.token();
    } catch {
      key = "";
    }
    if (key === "") {
      options.logger?.warn?.("dsh-pool: 自定义路由 " + entry.id + " 未写 API Key，先不注册（面板粘贴后重启 DSH）");
      continue;
    }
    releases.push(registerPoolRoute(route));
  }
  if (releases.length > 0) options.logger?.info?.("dsh-pool: 已挂载 " + String(releases.length) + " 条自定义路由");
  return releases;
}
/**
 * 「更新模型」按钮的实现：问上游要一份 /models，写回注册表。
 *
 * 自定义路由没有 provider 可以 forceRefresh —— 模型 id 是用户手填的，唯一的
 * 权威就是上游自己的目录接口。所以这里真的发一次 GET：
 *
 *   baseUrl + <apiPath 去掉末尾 /chat/completions> + /models
 *
 * 拿到 data[].id（或 models[] / 纯字符串数组），归一化后写回注册表。写回之后
 * 面板立刻能看到新清单，但**模型选择器要重启 DSH 才跟上**（provider 侧冷装载）。
 *
 * 上游没有 /models 是常态（不少中转只实现 /chat/completions）——那不属于故障，
 * 所以错误文案要说清楚「可以手填」，别让人以为渠道坏了。
 *
 * @param {string} id 渠道 id
 * @param {{ctx?: object}} [options]
 * @returns {Promise<{ok: boolean, added?: string[], count?: number, error?: string}>}
 */
export async function refreshCustomModels(id, options = {}) {
  const registry = readRegistry();
  const entry = registry.channels.find((item) => item.id === id);
  if (entry === undefined || entry.kind !== "custom") return { ok: false, error: "未知的自定义渠道 " + id };

  const apiPath = typeof entry.apiPath === "string" && entry.apiPath !== "" ? entry.apiPath : "/chat/completions";
  const suffix = "/chat/completions";
  const modelsPath = apiPath.endsWith(suffix) ? apiPath.slice(0, apiPath.length - suffix.length) + "/models" : "/models";
  const url = entry.baseUrl + modelsPath;

  let key = "";
  try {
    key = await createCustomKeyReader(id, options.ctx)();
  } catch {
    key = "";
  }
  if (key === "") return { ok: false, error: "还没写 API Key —— 先在这一行粘贴，再点更新模型" };

  let payload;
  try {
    const response = await directFetch(url, {
      method: "GET",
      headers: { accept: "application/json", authorization: "Bearer " + key },
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok !== true) {
      return { ok: false, error: "上游 " + url + " 回 HTTP " + String(response.status) + "（该线路可能没有 /models，模型清单可以手填）" };
    }
    payload = await response.json();
  } catch (error) {
    const message = typeof error?.message === "string" ? error.message : String(error);
    return { ok: false, error: "连不上 " + url + "：" + message + "（也可以跳过，模型清单手填）" };
  }

  const raw = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];
  const collected = raw.map((item) => (typeof item === "string" ? item : item?.id)).filter((value) => typeof value === "string");
  const models = normalizeCustomModels(collected);
  if (models.length === 0) return { ok: false, error: "上游 /models 里没有可用的模型 id（返回体形状不认识）" };

  const before = Array.isArray(entry.models) ? entry.models : [];
  const added = models.filter((modelId) => !before.includes(modelId));
  const same = added.length === 0 && models.length === before.length;
  if (same) return { ok: true, added: [], count: models.length };

  writeRegistry(registry.channels.map((item) => (item.id === id ? { ...item, models } : item)));
  return { ok: true, added, count: models.length };
}
