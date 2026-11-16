/**
 * 网络兜底 —— 主 `fetch` 撞上坏代理/瞬时断连时，改走**真正绕开代理**的直连重试。
 *
 * 为什么需要这个文件（2026-11-16 在宿主同版本运行时 Electron 44.7.0 / Node 24.21.0
 * 里逐条实测过）：
 *   1) 宿主启动带着 HTTP(S)_PROXY=http://127.0.0.1:7897 与 NODE_USE_ENV_PROXY=1，
 *      Node 24 会按 env 给每条出站请求装 EnvHttpProxyAgent；本机代理一关，
 *      插件到上游的探针就齐刷刷 `TypeError: fetch failed`，cause 是 ECONNREFUSED；
 *   2) 直连是通的（node:https 打 https://api.trae.cn 得到 404），坏的只是代理链路；
 *   3) 启动时就 delete process.env.*_PROXY 没用 —— env 代理的 dispatcher 在引导阶段
 *      就建好了，删变量不会回退直连；
 *   4) `import("undici")` 在**宿主进程**里能解析（渠道依赖带了 undici），但传
 *      `{ dispatcher }` 也只对走 undici 的 fetch 生效；一旦别的插件在它外面又包了
 *      一层 fetch，dispatcher 就被丢掉。
 *
 * 因此这里做两层：
 *   · 首选：用 undici 显式直连 Agent 重试（成功路径零开销，只在网络型失败时触发）；
 *   · 兜底：用 node:https / node:http 发一次裸请求，把结果包成标准 `Response`
 *     （body 走 Readable.toWeb，SSE 这类流式响应照样能读），完全不经过任何代理。
 *
 * 安装方式用**属性访问器**而不是直接赋值：billion-context 这类插件会替换
 * globalThis.fetch，普通赋值会被它覆盖掉（实测：日志里兜底装着、rescued 却永远是 0）。
 * 用 getter/setter 后，别人再赋值也只是换掉我们包裹的底层，我们始终在最外层。
 *
 * 纪律：只在网络型失败时重试一次；不改响应形状、不缓存、幂等安装（Symbol 标记），
 * 插件热重载多次也不会套娃。
 */

import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

const INSTALLED = Symbol.for("dsh-camel-pool.fetch-rescue");
const STATE = Symbol.for("dsh-camel-pool.fetch-rescue.state");
const TAG = Symbol.for("dsh-camel-pool.fetch-rescue.wrapper");
const ORIG = Symbol.for("dsh-camel-pool.fetch-rescue.original");

/** 安装版号：插件热重载后版号变了就重建，避免老版本占着茅坑。 */
const VERSION = 3;

/** undici/Node 里能识别的网络型错误码；命中这些才值得换直连重试。 */
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_ABORTED",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const NETWORK_TEXT = /fetch failed|network|socket|timed? ?out|timeout|ECONN|EPIPE|aborted|handshake|tunnel|proxy/i;

/** 沿 cause 链判一次：这次失败是不是「链路坏了」而不是「上游回了 4xx」。 */
export function networkFailure(error) {
  let cursor = error;
  let depth = 0;
  while (cursor !== undefined && cursor !== null && depth < 6) {
    const code = typeof cursor.code === "string" ? cursor.code : "";
    if (code !== "" && NETWORK_CODES.has(code)) return true;
    const errno = typeof cursor.errno === "string" ? cursor.errno : "";
    if (errno !== "" && NETWORK_CODES.has(errno)) return true;
    const message = typeof cursor.message === "string" ? cursor.message : "";
    if (code.startsWith("UND_ERR_") || code.startsWith("ERR_")) {
      if (NETWORK_CODES.has(code)) return true;
    }
    if (/fetch failed|terminated|other side closed/i.test(message)) return true;
    if (/proxy/i.test(message) && /connect|tunnel|closed|refused|reset/i.test(message)) return true;
    cursor = cursor.cause;
    depth += 1;
  }
  if (typeof error === "string" && NETWORK_TEXT.test(error)) return true;
  return false;
}

let directAgent = null;
let agentResolved = false;
/** undici 命名空间缓存：directFetch 用它拿 undici.fetch（不碰 globalThis.fetch）。 */
let undiciNs = null;

/** 懒加载直连 Agent：不读 HTTP(S)_PROXY，也不复用宿主的全局 dispatcher。 */
async function directDispatcher() {
  if (agentResolved) return directAgent;
  agentResolved = true;
  try {
    const undici = await import("undici");
    undiciNs = undici;
    directAgent = new undici.Agent({
      connect: { timeout: 15000 },
      keepAliveTimeout: 10000,
      keepAliveMaxTimeout: 15000,
      connections: 12,
    });
  } catch {
    directAgent = null;
  }
  return directAgent;
}

/* ────────────────────────── 裸直连（不依赖 undici） ────────────────────────── */

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16, timeout: 30000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, timeout: 30000 });

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** HeadersInit（Headers 实例 / 数组 / 普通对象）→ 普通对象。 */
function headersToObject(source) {
  const out = Object.create(null);
  if (source === undefined || source === null) return out;
  if (typeof source.forEach === "function" && typeof source.get === "function") {
    source.forEach((value, key) => {
      out[String(key).toLowerCase()] = String(value);
    });
    return out;
  }
  if (Array.isArray(source)) {
    for (const pair of source) {
      if (Array.isArray(pair) && pair.length >= 2) out[String(pair[0]).toLowerCase()] = String(pair[1]);
    }
    return out;
  }
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

/** 请求体归一：字符串 / Buffer / TypedArray / URLSearchParams / 流。 */
async function bodyToBuffer(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (Buffer.isBuffer(body)) return body;
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof body.toString === "function" && body.constructor?.name === "URLSearchParams") {
    return Buffer.from(body.toString(), "utf8");
  }
  if (typeof body.getReader === "function") {
    const chunks = [];
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  return null;
}

function responseHeaders(raw) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw || {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, String(item));
    } else {
      headers.append(key, String(value));
    }
  }
  return headers;
}

function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function abortedError() {
  if (typeof DOMException === "function") return new DOMException("The operation was aborted.", "AbortError");
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/** 单次直连请求 → 标准 Response（3xx 原样返回，跳转交给上层）。 */
function directOnce(url, method, headers, body, signal) {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === "" ? (isHttps ? 443 : 80) : Number(url.port),
        path: url.pathname + url.search,
        method,
        headers,
        agent: isHttps ? httpsAgent : httpAgent,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const noBody = method === "HEAD" || status === 204 || status === 304;
        const stream = noBody ? null : Readable.toWeb(response);
        let out;
        try {
          out = new Response(stream, {
            status,
            statusText: response.statusMessage ?? "",
            headers: responseHeaders(response.headers),
          });
        } catch (error) {
          response.destroy();
          reject(toError(error));
          return;
        }
        resolve(out);
      },
    );
    const onAbort = () => {
      request.destroy();
      reject(abortedError());
    };
    if (signal !== undefined && signal !== null) {
      if (signal.aborted === true) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      request.on("close", () => signal.removeEventListener("abort", onAbort));
    }
    request.on("error", (error) => reject(toError(error)));
    if (body !== null) request.write(body);
    request.end();
  });
}

/** 直连抓取：不读 env 代理、不用宿主全局 dispatcher，手动跟最多 5 次跳转。 */
async function rawDirectFetch(input, init) {
  const options = init === undefined || init === null ? {} : init;
  let rawUrl;
  let inputMethod;
  let inputHeaders;
  let inputBody;
  if (typeof input === "string") {
    rawUrl = input;
  } else if (input instanceof URL) {
    rawUrl = input.href;
  } else if (input !== null && typeof input === "object" && typeof input.url === "string") {
    rawUrl = input.url;
    inputMethod = typeof input.method === "string" ? input.method : undefined;
    inputHeaders = input.headers;
    if (typeof input.arrayBuffer === "function" && typeof input.clone === "function") {
      const clone = input.clone();
      const buffer = await clone.arrayBuffer();
      if (buffer.byteLength > 0) inputBody = Buffer.from(buffer);
    }
  } else {
    throw new TypeError("net-rescue: 无法识别的 fetch 入参");
  }
  const method = String(options.method ?? inputMethod ?? "GET").toUpperCase();
  const headers = { ...headersToObject(inputHeaders), ...headersToObject(options.headers) };
  const body = await bodyToBuffer(options.body ?? inputBody);
  if (body !== null) {
    if (headers["content-length"] === undefined) headers["content-length"] = String(body.byteLength);
    if (headers["content-type"] === undefined && options.body instanceof URLSearchParams) {
      headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
    }
  }
  const signal = options.signal ?? null;
  const redirectMode = typeof options.redirect === "string" ? options.redirect : "follow";

  let url = new URL(rawUrl);
  let currentMethod = method;
  let currentBody = body;
  let currentHeaders = headers;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await directOnce(url, currentMethod, currentHeaders, currentBody, signal);
    if (redirectMode !== "follow" || !REDIRECT_STATUS.has(response.status)) return response;
    const location = response.headers.get("location");
    if (location === null || location === "") return response;
    await response.body?.cancel().catch(() => {});
    url = new URL(location, url);
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === "POST")) {
      currentMethod = "GET";
      currentBody = null;
      delete currentHeaders["content-length"];
      delete currentHeaders["content-type"];
    }
  }
  throw new Error("net-rescue: 跳转次数超限");
}

/**
 * 显式直连抓取 —— **完全不经过 globalThis.fetch**。
 *
 * 为什么 provider 的请求点要用它：billion-context 之类插件会用 defineProperty 把
 * globalThis.fetch 换成自己的包装（实测 name === "patched"），装在我们外面的兜底
 * 因此可能永远拿不到调用（fetchRescueInfo().outermost === false，rescue 计数不涨，
 * 调用方却照旧抛 "fetch failed"）。请求点改成显式调用这里，装配顺序就再也不是变量。
 *
 * 顺序：undici 直连 Agent（不读 env 代理）→ 裸 node:https/http。两者都不碰代理。
 */
export async function directFetch(input, init) {
  const options = init === undefined || init === null ? {} : init;
  const urlOf = typeof input === "string" ? input : input !== null && input !== undefined && typeof input.url === "string" ? input.url : "";
  const dispatcher = await directDispatcher();
  if (dispatcher !== null && undiciNs !== null) {
    try {
      const response = await undiciNs.fetch(input, { ...options, dispatcher });
      stats.directOk += 1;
      return response;
    } catch (error) {
      stats.directFail += 1;
      stats.lastDirectError = noteError(error);
      if (!networkFailure(error)) throw error;
    }
  }
  try {
    const response = await rawDirectFetch(input, options);
    stats.directOk += 1;
    return response;
  } catch (rawError) {
    stats.directFail += 1;
    stats.lastDirectError = noteError(rawError) + " @raw " + urlOf;
    throw rawError;
  }
}

/* ────────────────────────── 安装与诊断 ────────────────────────── */

/** 最近若干次「进过兜底」的调用，供状态接口排障用。 */
const recent = [];

function noteRecent(record) {
  recent.unshift(record);
  if (recent.length > 20) recent.length = 20;
}

const stats = {
  attempts: 0,
  networkFailures: 0,
  dispatcherOk: 0,
  dispatcherFail: 0,
  rawOk: 0,
  rawFail: 0,
  directOk: 0,
  directFail: 0,
  lastDirectError: null,
  lastDispatcherError: null,
  lastRawError: null,
  lastRescue: null,
};

function noteError(error) {
  if (error === undefined || error === null) return "unknown";
  const code = error.code ?? error.cause?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code !== undefined && code !== null ? String(code) + ": " + message : message;
}

/** 造一个包裹 base 的兜底 fetch；带 TAG/ORIG 标记，方便识别链条、避免自我套娃。 */
function buildWrapper(base) {
  const target = base[TAG] === TAG && typeof base[ORIG] === "function" ? base[ORIG] : base;
  const wrapped = async function fetchRescue(input, init) {
    stats.attempts += 1;
    const urlOf = typeof input === "string" ? input : input !== null && input !== undefined && typeof input.url === "string" ? input.url : "";
    try {
      return await target(input, init);
    } catch (error) {
      if (!networkFailure(error)) throw error;
      stats.networkFailures += 1;
      const abortSignal = init !== undefined && init !== null ? init.signal : undefined;
      if (abortSignal !== undefined && abortSignal !== null && abortSignal.aborted === true) throw error;
      const dispatcher = await directDispatcher();
      if (dispatcher !== null) {
        try {
          const response = await target(input, { ...(init || {}), dispatcher });
          stats.dispatcherOk += 1;
          noteRecent({ url: urlOf, stage: "dispatcher", status: response.status, first: noteError(error), at: Date.now() });
          return response;
        } catch (retryError) {
          stats.dispatcherFail += 1;
          stats.lastDispatcherError = noteError(retryError);
        }
      }
      try {
        const response = await rawDirectFetch(input, init);
        stats.rawOk += 1;
        stats.lastRescue = { url: urlOf, at: Date.now() };
        noteRecent({ url: urlOf, stage: "raw", status: response.status, first: noteError(error), at: Date.now() });
        return response;
      } catch (rawError) {
        stats.rawFail += 1;
        stats.lastRawError = noteError(rawError);
        noteRecent({ url: urlOf, stage: "fail", status: 0, first: noteError(error), second: noteError(rawError), at: Date.now() });
        throw error;
      }
    }
  };
  try {
    Object.defineProperty(wrapped, "name", { value: "fetchRescue", configurable: true });
  } catch {
    /* 名称改不了不影响行为 */
  }
  wrapped[TAG] = TAG;
  wrapped[ORIG] = target;
  return wrapped;
}

/**
 * 安装兜底。返回 { installed, reason, tag, version }；同版本重复调用是空操作。
 * options.tag 只用于日志前缀。
 */
export function installFetchRescue(options = {}) {
  const g = globalThis;
  const previous = g[STATE];
  const tag = typeof options.tag === "string" && options.tag !== "" ? options.tag : "dsh-camel-pool";
  const current = g.fetch;
  if (typeof current !== "function") return { installed: false, reason: "no-fetch", version: VERSION };
  const reusable = previous !== undefined && previous !== null && previous.version === VERSION && typeof previous.setBase === "function";
  const state = reusable
    ? previous
    : { version: VERSION, tag, base: null, wrapped: null, setBase: null };

  /**
   * 换底：别人（billion-context 之类）赋值 globalThis.fetch 时也会走到这里，
   * 于是我们永远是最外层，而不是被它一脚踢开。
   */
  state.setBase = (next) => {
    if (typeof next !== "function") return;
    // 底没变就别重建 —— 否则每次重复安装都会换出一个新函数，
    // 让"已安装"的引用相等性判断（自检、别人缓存的 fetch 引用）失效。
    if (next === state.base) return;
    if (next === state.wrapped) return;
    if (next[TAG] === TAG && next[ORIG] === state.base) return;
    state.base = next;
    state.wrapped = buildWrapper(next);
  };
  /**
   * 重复安装是空操作，不是"再包一层"。
   *
   * 判据三条同时成立：同版本状态可复用、globalThis.fetch 已经是我们的访问器、
   * 且访问器回的就是当前这份 wrapper。少任何一条都得继续往下走 —— 说明中途
   * 有人赋值过 globalThis.fetch（billion-context 那种），需要重新挂底。
   *
   * tag 只在首次安装时写：重复调用换个 tag 不该把已有的诊断标记改掉，
   * 否则日志里分不清是哪次启动装的。
   */
  if (reusable) {
    const desc = Object.getOwnPropertyDescriptor(g, "fetch");
    const stillOurs = desc !== undefined && desc !== null && typeof desc.get === "function" && desc.get() === state.wrapped;
    if (stillOurs) return { installed: false, reason: "already", tag: state.tag ?? tag, version: VERSION };
  }
  g[STATE] = state;
  g[INSTALLED] = state.tag;
  state.setBase(current[TAG] === TAG && typeof current[ORIG] === "function" ? current[ORIG] : current);

  const descriptor = Object.getOwnPropertyDescriptor(g, "fetch");
  const alreadyAccessor = descriptor !== undefined && descriptor !== null && typeof descriptor.get === "function" && typeof descriptor.set === "function";
  if (!alreadyAccessor) {
    Object.defineProperty(g, "fetch", {
      configurable: true,
      enumerable: descriptor !== undefined && descriptor !== null ? descriptor.enumerable !== false : true,
      get() {
        return state.wrapped;
      },
      set(next) {
        state.setBase(next);
      },
    });
  } else {
    g.fetch = state.wrapped;
  }
  const upgraded = previous !== undefined && previous !== null;
  return { installed: true, reason: upgraded ? "upgraded" : "ok", tag, version: VERSION };
}

/** 只读诊断：兜底是否已装、直连通道是否可用、救回过几次（不含任何凭据）。 */
export function fetchRescueInfo() {
  const state = globalThis[STATE];
  // 标记兼容两种历史写法：字符串 tag（当前）与旧版本的 true。
  const existing = globalThis[INSTALLED];
  return {
    version: state !== undefined && state !== null ? state.version : 0,
    installed: typeof existing === "string" || existing === true,
    tag: state !== undefined && state !== null ? state.tag ?? null : null,
    outermost: state !== undefined && state !== null ? globalThis.fetch === state.wrapped : false,
    base: state !== undefined && state !== null && typeof state.base === "function" ? state.base.name || "anonymous" : null,
    directAgent: directAgent === null ? "none" : "ready",
    rawDirect: true,
    ...stats,
    recent: recent.map((item) => ({ ...item })),
  };
}
