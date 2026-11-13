// verify-uxv11-e2e.mjs —— ux-v11 池级回归：
//   S1 429 时间窗（跨窗口自愈，池零熔断、客户端拿 200 真内容）
//   S2 持续 429（有界失败：走完阶梯回 502，不会无限挂住）
//   S3 单路由慢首字节 7s（旧的 6s probe-timeout 静默切空 → 502 已修）
import http from "node:http";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.argv[2];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-uxv11-"));
fs.writeFileSync(path.join(tmp, "gemini-ca-project.json"), JSON.stringify({ projectId: "test-project-uxv11" }));
process.env.DSH_HOME = tmp;
process.env.GEMINI_NO_PROXY = "1";
// ux-v12：这两套测的是 OAuth 语义本身，关掉 apikey 逃生通道（否则真实 ~/.dsh key 会兜底成功）。
process.env.GEMINI_NO_APIKEY_ESCAPE = "1";
process.env.CODE_ASSIST_API_VERSION = "v1internal";
process.env.DSH_POOL_SHIM_TOKEN = "hindsight-pool-local-7f3a9c2e1b8d4f6a5c0e9d2b8f4a6c1e";
// 把 2/4/8/16/24s 阶梯压成 150/300/600/1200/2400ms：只改时长，不改判定与预算逻辑。
process.env.GEMINI_CA_QUOTA_LADDER = "150,300,600,1200,2400";

const QUOTA = JSON.stringify({ error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } });
const OK_FRAME = "data: " + JSON.stringify({
  response: { candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 } },
  traceId: "t-uxv11",
}) + "\n\n";

let mode = "window";
let hits = 0;
let windowMs = 1500;
let startedAt = Date.now();
let firstByteDelayMs = 0;

const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    hits += 1;
    const inWindow = mode === "window" && Date.now() - startedAt < windowMs;
    if (mode === "always429" || inWindow) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(QUOTA);
      return;
    }
    const wantSse = String(req.url || "").includes("alt=sse");
    const send = () => {
      if (!wantSse) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 } }, traceId: "t-uxv11" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.write(OK_FRAME);
      res.write("data: [DONE]\n\n");
      res.end();
    };
    if (firstByteDelayMs > 0) setTimeout(send, firstByteDelayMs);
    else send();
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
process.env.CODE_ASSIST_ENDPOINT = "http://127.0.0.1:" + upstream.address().port;

const S = await import(pathToFileURL(path.join(ROOT, "lib", "shared", "pool.js")).href);
const CA = await import(pathToFileURL(path.join(ROOT, "lib", "providers", "gemini", "codeassist.js")).href);
const PL = await import(pathToFileURL(path.join(ROOT, "lib", "providers", "pool", "index.js")).href);

const EFFORT = { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash"].map((id) => ({
  id, name: id, api: "openai-completions", provider: "gemini", input: ["text", "image"],
  reasoning: true, thinkingLevelMap: EFFORT, contextWindow: 1048576, maxTokens: 65536,
  compat: { maxTokensField: "max_tokens" },
}));
const route = {
  key: "gemini", kind: "gemini", displayName: "Gemini", priority: 0,
  chatUrl: () => CA.codeAssistChatUrl(),
  token: () => "faketoken123456",
  fetch: (url, init) => CA.codeAssistFetch(url, init),
  models: () => MODELS,
  hidden: () => [],
};
S.setPoolProviderActive(true);
const release = S.registerPoolRoute(route);

const proxy = PL.createPoolProxy({ readPreferences: () => ({}), logger: { warn: () => {} } });
const addr = await proxy.ready;
const TOKEN = proxy.token();
const PID = "gemini-3.5-flash-lite";

function post(stream) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model: PID, messages: [{ role: "user", content: "reply with just OK" }], stream: Boolean(stream), max_tokens: 16 });
    const t0 = Date.now();
    const req = http.request({ host: "127.0.0.1", port: addr.port, method: "POST", path: "/v1/chat/completions",
      headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN, "content-length": Buffer.byteLength(payload) } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ status: res.statusCode, body: raw, ms: Date.now() - t0 }));
    });
    req.on("error", reject);
    req.setTimeout(90000, () => req.destroy(new Error("client timeout")));
    req.end(payload);
  });
}
function logLines() { try { return fs.readFileSync(path.join(tmp, ".pool-route.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
function reset(m, w, delay = 0) { S.clearBreakers("gemini"); mode = m; windowMs = w; startedAt = Date.now(); hits = 0; firstByteDelayMs = delay; }

const results = [];
const ok = (n, d) => results.push("PASS " + n + (d ? " — " + d : ""));

// S1：1.5s 的 429 窗口内（阶梯 150/300/600/1200 足以跨过）→ 200 真内容，池零熔断
reset("window", 1500);
let base = logLines().length;
let r1 = await post(false);
let ev1 = logLines().slice(base);
assert.equal(r1.status, 200, "S1 应 200，实际 " + r1.status + " " + r1.body.slice(0, 300));
assert.equal(JSON.parse(r1.body).choices[0].message.content, "OK", "S1 内容应为 OK");
assert.ok(hits >= 3, "S1 上游应多次 429 后成功，实际 hits=" + hits);
assert.equal(S.breakerReport().length, 0, "S1 之后不应有熔断（池没看到 429）");
assert.ok(ev1.some((e) => e.ev === "served"), "S1 日志应有 served");
assert.ok(!ev1.some((e) => e.ev === "route-fail"), "S1 日志不应有 route-fail");
ok("S1 429 窗口内自愈", "hits=" + hits + " / 200 content=OK / " + r1.ms + "ms / cooling=[] / 无 route-fail");

// S2：持续 429 → 走完阶梯后有界失败（502 或 429 直传），不无限挂住
reset("always429", 0);
base = logLines().length;
let r2 = await post(false);
let ev2 = logLines().slice(base);
assert.ok(r2.status >= 400, "S2 应失败，实际 " + r2.status);
assert.ok(r2.ms < 60000, "S2 必须在预算内返回，实际 " + r2.ms + "ms");
assert.ok(ev2.some((e) => e.ev === "route-fail" || e.ev === "pool-exhausted"), "S2 日志应记录失败");
ok("S2 持续 429 有界失败", "status=" + r2.status + " / " + r2.ms + "ms / hits=" + hits);

// S3：单路由慢首字节 7s（旧 6s probe-timeout 会静默切空 → 502）
reset("ok", 0, 7000);
base = logLines().length;
let r3 = await post(false);
let ev3 = logLines().slice(base);
assert.equal(r3.status, 200, "S3 应 200（首字节 7s 不被 6s 掐断），实际 " + r3.status + " " + r3.body.slice(0, 300));
assert.ok(r3.ms >= 6500, "S3 应真的等到了 7s 首字节，实际 " + r3.ms + "ms");
assert.ok(!ev3.some((e) => /probe/i.test(String(e.reason ?? e.error ?? ""))), "S3 不应出现 probe 失败");
ok("S3 单路由慢首字节 7s 不再被 6s 掐断", r3.ms + "ms → 200 OK");

release();
proxy.close();
upstream.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join("\n"));
console.log("ALL_UXV11_E2E_ASSERTIONS_PASSED");
