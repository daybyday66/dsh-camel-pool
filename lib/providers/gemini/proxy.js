/**
 * Gemini 上游的「本机代理隧道」fetch。
 *
 * 本机直连 generativelanguage.googleapis.com:443 不通；clash-meta 在本机
 * 7897 开 HTTP 代理。undici 自带 ProxyAgent 与该隧道做 TLS 握手会被 RST，
 * 实测改用 node:net 建 CONNECT 隧道 + node:tls 握手（ALPN 固定 http/1.1）
 * 后，GET /models 与 POST /chat/completions 都能到达 Google。
 *
 * 只挂在声明了 route.fetch 的 Gemini 路由上；其它渠道仍走全局直连 fetch，
 * 行为完全不变。代理地址可用 GEMINI_PROXY / HTTPS_PROXY 等环境变量覆盖，
 * GEMINI_NO_PROXY=1 强制直连。
 *
 * 凭证纪律：CONNECT 头 / 诊断输出里不带任何 API key 或代理账密；
 * key 只出现在业务请求头，由调用方传入，绝不打印、不落盘。
 */

import net from "node:net";
import tls from "node:tls";
import { Agent, fetch as undiciFetch } from "undici";

const PROBE_HOST = "generativelanguage.googleapis.com";
const PROXY_ENVS = ["GEMINI_PROXY", "GEMINI_HTTPS_PROXY", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];
const DEFAULT_PROXIES = [
  { host: "127.0.0.1", port: 7897 },
  { host: "127.0.0.1", port: 7899 },
  { host: "127.0.0.1", port: 10809 },
  { host: "127.0.0.1", port: 7890 },
];

function parseProxy(raw) {
  try {
    const text = String(raw);
    const url = new URL(text.includes("://") ? text : "http://" + text);
    if (!url.hostname) return null;
    return { host: url.hostname, port: Number(url.port) || 80 };
  } catch {
    return null;
  }
}

function explicitProxy() {
  for (const name of PROXY_ENVS) {
    const raw = String(process.env[name] ?? "").trim();
    if (raw === "") continue;
    const parsed = parseProxy(raw);
    if (parsed !== null) return parsed;
  }
  return null;
}

function probeTunnel(target, ms = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: target.host, port: target.port });
    let head = "";
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* 已断 */ }
      resolve(ok);
    };
    socket.once("error", () => finish(false));
    socket.on("data", (chunk) => {
      head += chunk.toString("latin1");
      if (head.includes("\r\n\r\n")) finish(/^HTTP\/1\.[01] 200/u.test(head.split("\r\n")[0]));
    });
    socket.once("connect", () => {
      socket.write("CONNECT " + PROBE_HOST + ":443 HTTP/1.1\r\nHost: " + PROBE_HOST + ":443\r\n\r\n");
    });
    socket.setTimeout(ms, () => finish(false));
  });
}

function buildDispatcher(target) {
  const connect = (opts, callback) => {
    const hostname = opts.hostname || opts.host;
    const port = Number(opts.port || 443);
    const socket = net.connect({ host: target.host, port: target.port });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* 已断 */ }
      callback(error instanceof Error ? error : new Error(String(error)));
    };
    let head = "";
    const onData = (chunk) => {
      head += chunk.toString("latin1");
      const at = head.indexOf("\r\n\r\n");
      if (at < 0) return;
      socket.removeListener("data", onData);
      const first = head.split("\r\n")[0];
      if (!/^HTTP\/1\.[01] 200/u.test(first)) { fail("proxy CONNECT " + first); return; }
      const extra = Buffer.from(head.slice(at + 4), "latin1");
      const secured = tls.connect({ socket, servername: opts.servername || hostname, ALPNProtocols: ["http/1.1"] });
      secured.once("secureConnect", () => {
        if (settled) return;
        settled = true;
        callback(null, secured);
        if (extra.length > 0) secured.emit("data", extra);
      });
      secured.once("error", fail);
    };
    socket.on("data", onData);
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.write("CONNECT " + hostname + ":" + port + " HTTP/1.1\r\nHost: " + hostname + ":" + port + "\r\n\r\n");
    });
    // 连接建立的超时交给 undici 的 connectTimeout + 外层 AbortSignal；
    // 这里不再挂自定义 setTimeout，避免 TLS 升级成功后旧回调误判为失败。
  };
  return new Agent({ connect, connectTimeout: 15000 });
}

let cached = null;    // { target, dispatcher }；null = 尚未解析或走直连
let resolving = null; // 并发共用一次探测

async function resolveDispatcher() {
  if (String(process.env.GEMINI_NO_PROXY ?? "").trim() === "1") return null;
  if (cached !== null) return cached;
  if (resolving !== null) return resolving;
  resolving = (async () => {
    const explicit = explicitProxy();
    const targets = explicit === null ? DEFAULT_PROXIES : [explicit];
    for (const target of targets) {
      if (explicit === null && !(await probeTunnel(target))) continue;
      cached = { target, dispatcher: buildDispatcher(target) };
      return cached;
    }
    return null;
  })().finally(() => { resolving = null; });
  return resolving;
}

/** 与全局 fetch 同签名，返回标准 Response（.ok/.status/.headers/.text/.body 均兼容）。 */
export async function geminiFetch(url, init = {}, retry = true) {
  const resolved = await resolveDispatcher();
  // 直连分支也用 undici.fetch：全局 fetch 可能被宿主 env 代理（HTTP_PROXY=127.0.0.1:7897）
  // 绑死，代理没开时整条链路 ECONNREFUSED；undici 不读 env 代理。
  if (resolved === null) return undiciFetch(url, init);
  try {
    return await undiciFetch(url, { ...init, dispatcher: resolved.dispatcher });
  } catch (error) {
    // 代理冷启动偶发半开隧道：清缓存、重建 dispatcher 再试一次。
    cached = null;
    if (retry && init.signal?.aborted !== true) {
      try {
        return await geminiFetch(url, init, false);
      } catch { /* 统一抛出首个错误，交给转发层按熔断切路由 */ }
    }
    throw error;
  }
}

/** 只读诊断：不含 key、不含代理账密。 */
export function geminiProxyInfo() {
  return {
    mode: cached === null ? "direct" : "proxy",
    host: cached === null ? null : cached.target.host,
    port: cached === null ? null : cached.target.port,
  };
}
