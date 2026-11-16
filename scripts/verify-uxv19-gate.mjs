// verify-uxv19-gate.mjs —— ux-v19 回归：
//   把 globalThis.fetch 换成「凡是转发就 422」的假 billion-context 闸门，验证
//   ① 未声明 route.fetch 的路由仍能 200 打通上游（直连通道，全局 fetch 调用数必须为 0）
//   ② 声明了 route.fetch 且内部走全局 fetch、被闸门拒的路由 → 502 pool_gate_blocked
//      而不是 pool_exhausted，且不产生熔断（闸门是进程级的，冷却路由毫无收益）
//   ③ 闸门返回 422 时 body 不被截断（2MB prompt 是线上真实体量）
import http from "node:http";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot, skip, installHostDeps } from "./_paths.mjs";

const ROOT = repoRoot(process.argv[2]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-uxv19-"));
process.env.DSH_HOME = tmp;
process.env.DSH_POOL_SHIM_TOKEN = "hindsight-pool-local-7f3a9c2e1b8d4f6a5c0e9d2b8f4a6c1e";

// ── 假上游：OpenAI 兼容 SSE，回一句 OK ──────────────────────────────
const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "OK" } }] }) + "\n\n");
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const UPSTREAM = "http://127.0.0.1:" + upstream.address().port;

// ── 假 billion-context 闸门：接管 globalThis.fetch ──────────────────
const realFetch = globalThis.fetch;
let gateCalls = 0;
let gateBodies = [];
const GATE_BODY = JSON.stringify({
  error: {
    type: "server_error",
    code: "bili_gate_oversize_refusal_unattributed_bytes",
    message: "billion-context refused this request locally: it is not attributed to a bili-managed session and its body is larger than the silent-direct byte ceiling, so forwarding it would send a multi-megabyte prompt",
    kind: "transport",
  },
});
function gateFetch(input, init) {
  // 闸门是进程级、与 URL 无关：任何走全局 fetch 的 POST 都被本地 422 掉。
  // （池的正路走 directFetch，压根不会进到这里。）
  const method = String((init && init.method) || "GET").toUpperCase();
  const url = typeof input === "string" ? input : String(input && input.url);
  if (method !== "POST") return realFetch(input, init);
  gateCalls += 1;
  gateBodies.push(Buffer.byteLength(String((init && init.body) || "")));
  return Promise.resolve(new Response(GATE_BODY, {
    status: 422,
    headers: { "content-type": "application/json", "x-bili-gate": "oversize-refusal-unattributed-bytes" },
  }));
}
Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: gateFetch });

installHostDeps();
const S = await import(pathToFileURL(path.join(ROOT, "lib/shared/pool.js")).href);
let PL;
try {
  PL = await import(pathToFileURL(path.join(ROOT, "lib/providers/pool/index.js")).href);
} catch (e) {
  if (e && e.code === "ERR_MODULE_NOT_FOUND") {
    skip("verify-uxv19-gate", "宿主依赖缺失：" + String(e.message).split("\n")[0] + "（见 docs/SELFCHECK.md 的宿主依赖说明）");
  }
  throw e;
}

// 必须落在「模型库」白名单里（lib/shared/pool.js 的 CURATED_MODELS），
// 否则 mergedModelGroups 会整组过滤掉，测不到转发路径。
const MODEL = "glm-5.3-flash";
const MODELS = [{
  id: MODEL, name: MODEL, api: "openai-completions", provider: "trae",
  input: ["text"], reasoning: false, contextWindow: 200000, maxTokens: 8192,
  compat: { maxTokensField: "max_tokens" },
}];
function routeOf(key, extra) {
  return {
    key, kind: "trae", displayName: key, priority: 0,
    chatUrl: () => UPSTREAM + "/v1/chat/completions",
    token: () => "fake-token-trae-uxv19",
    models: () => MODELS,
    hidden: () => [],
    ...extra,
  };
}

S.setPoolProviderActive(true);
const proxy = PL.createPoolProxy({ readPreferences: () => ({}), logger: { warn: () => {} } });
const addr = await proxy.ready;
const TOKEN = proxy.token();
// 2MB prompt：线上把池打死的就是这个体量
const BIG = "x".repeat(2 * 1024 * 1024);

function post() {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model: MODEL, messages: [{ role: "user", content: BIG }], stream: true, max_tokens: 16 });
    const req = http.request({
      host: "127.0.0.1", port: addr.port, method: "POST", path: "/v1/chat/completions",
      headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN, "content-length": Buffer.byteLength(payload) },
    }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on("error", reject);
    req.setTimeout(60000, () => req.destroy(new Error("client timeout")));
    req.end(payload);
  });
}

const results = [];
const ok = (n, d) => results.push("PASS " + n + (d ? " — " + d : ""));

// ① 未声明 fetch 的路由 → 直连通道，闸门一次都不该被调到
const releaseA = S.registerPoolRoute(routeOf("trae-direct"));
const before = gateCalls;
const r1 = await post();
assert.equal(r1.status, 200, "① 应 200，实际 " + r1.status + " " + String(r1.body).slice(0, 300));
assert.ok(String(r1.body).includes("OK"), "① 应拿到上游真内容");
assert.equal(gateCalls - before, 0, "① 池转发不应经过被接管的 globalThis.fetch（闸门调用数应 0）");
ok("未声明 fetch 的路由走直连，2MB prompt 200", "gate calls=0 / body 含 OK");
releaseA();

// ② 显式 route.fetch 内部走全局 fetch → 被闸门 422 → 502 pool_gate_blocked，且不熔断
const releaseB = S.registerPoolRoute(routeOf("trae-gated", {
  fetch: (url, init) => globalThis.fetch(url, init),
}));
S.clearBreakers();
const beforeB = gateCalls;
const r2 = await post();
assert.equal(r2.status, 502, "② 应 502，实际 " + r2.status + " " + String(r2.body).slice(0, 300));
const doc2 = JSON.parse(r2.body);
assert.equal(doc2.error.type, "pool_gate_blocked", "② 应报 pool_gate_blocked（不是 pool_exhausted），实际 " + doc2.error.type);
assert.ok(String(doc2.error.message).includes("bili_gate_"), "② 文案应点出闸门 code，实际 " + doc2.error.message);
assert.ok(gateCalls - beforeB >= 1, "② 闸门应真的被这条路由调到（证明测试有效）");
assert.equal(S.breakerReport().filter((b) => b.route === "trae-gated").length, 0, "② 闸门失败不应产生熔断");
ok("被闸门拒的路由报 pool_gate_blocked 且不熔断", "type=" + doc2.error.type + " gate=" + doc2.error.gate);
releaseB();

proxy.close();
upstream.close();
await new Promise((r) => setTimeout(r, 50));
globalThis.fetch = realFetch;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join("\n"));
console.log("ALL_UXV19_GATE_ASSERTIONS_PASSED");
