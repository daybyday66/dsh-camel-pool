import http from "node:http";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot, skip, installHostDeps } from "./_paths.mjs";

// 仓库根从本文件位置推导：以前默认 undefined，不带参数直接跑就崩在 path.join(undefined)。
const ROOT = repoRoot(process.argv[2]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-gemini-e2e-"));
fs.writeFileSync(path.join(tmp, "gemini-ca-project.json"), JSON.stringify({ projectId: "test-project-429" }));
process.env.DSH_HOME = tmp;
process.env.GEMINI_NO_PROXY = "1";
// ux-v12：这两套测的是 OAuth 语义本身，关掉 apikey 逃生通道（否则真实 ~/.dsh key 会兜底成功）。
process.env.GEMINI_NO_APIKEY_ESCAPE = "1";
// 压缩 429 阶梯（2+4+8+16+24+32s → 只有几百毫秒），只改时长不改判定。
process.env.GEMINI_CA_QUOTA_LADDER = "150,300,600,1200,2400";
process.env.CODE_ASSIST_API_VERSION = "v1internal";
process.env.DSH_POOL_SHIM_TOKEN = "hindsight-pool-local-7f3a9c2e1b8d4f6a5c0e9d2b8f4a6c1e";

const QUOTA = JSON.stringify({ error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } });
const OK = JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 } } });

let mode = "ok";
let hits = 0;
let calls = [];
const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => raw += c);
  req.on("end", () => {
    hits++;
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
    calls.push({ model: body?.request?.model, status: 0 });
    let status = 200, payload = OK;
    if (mode === "flaky" && hits <= 2) { status = 429; payload = QUOTA; }
    else if (mode === "always429") { status = 429; payload = QUOTA; }
    calls[calls.length - 1].status = status;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
process.env.CODE_ASSIST_ENDPOINT = "http://127.0.0.1:" + upstream.address().port;

// 池代理要用宿主提供的 pi-ai / dsh-llm：本进程内兜底解析，找不到才 SKIP。
installHostDeps();

const S = await import(pathToFileURL(path.join(ROOT, "lib", "shared", "pool.js")).href);
const CA = await import(pathToFileURL(path.join(ROOT, "lib", "providers", "gemini", "codeassist.js")).href);
let P;
try {
  P = await import(pathToFileURL(path.join(ROOT, "lib", "providers", "pool", "index.js")).href);
} catch (e) {
  if (e && e.code === "ERR_MODULE_NOT_FOUND") {
    skip("verify-gemini-429-e2e", "宿主依赖缺失：" + String(e.message).split("\n")[0] + "（见 docs/SELFCHECK.md 的宿主依赖说明）");
  }
  throw e;
}

// 与 geminiRoute() 的 oauth 分支等价：fetch 直接绑真实 codeAssistFetch
const EFFORT = { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };
const MODELS = ["gemini-4-argon","gemini-3.1-pro-preview","gemini-3.8-flash","gemini-3.5-flash-lite"].map((id) => ({
  id, name: id, api: "openai-completions", provider: "gemini", input: ["text","image"],
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

const proxy = P.createPoolProxy({ readPreferences: () => ({}), logger: { warn: () => {} } });
const addr = await proxy.ready;
const PORT = addr.port;
const TOKEN = proxy.token();

function post(model) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model, messages: [{ role: "user", content: "reply with just OK" }], stream: false, max_tokens: 16 });
    const req = http.request({ host: "127.0.0.1", port: PORT, method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json", "authorization": "Bearer " + TOKEN, "content-length": Buffer.byteLength(payload) } }, (res) => {
      let raw = ""; res.on("data", (c) => raw += c); res.on("end", () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on("error", reject);
    req.setTimeout(20000, () => req.destroy(new Error("client timeout")));
    req.end(payload);
  });
}
function logLines() { try { return fs.readFileSync(path.join(tmp, ".pool-route.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
const results = [];
function ok(name, detail) { results.push("PASS " + name + (detail ? " — " + detail : "")); }
function reset(m) { S.clearBreakers("gemini"); mode = m; hits = 0; calls = []; }
const PID = "gemini-3.5-flash-lite";

// S1 偶发 429 在 route.fetch 内消化，池零熔断
reset("flaky");
let base = logLines().length;
let r1 = await post(PID);
let ev1 = logLines().slice(base);
assert.equal(r1.status, 200, "S1 应 200，实际 " + r1.status + " " + r1.body.slice(0, 200));
assert.equal(JSON.parse(r1.body).choices[0].message.content, "OK", "S1 内容应为 OK");
assert.equal(hits, 3, "S1 上游应 3 次调用（2x429+1x200），实际 " + hits);
assert.equal(S.breakerReport().length, 0, "S1 之后不应有熔断（池没看到 429）");
assert.ok(ev1.some((e) => e.ev === "served"), "S1 日志应有 served");
assert.ok(!ev1.some((e) => e.ev === "route-fail"), "S1 日志不应有 route-fail");
assert.ok(!ev1.some((e) => e.ev === "pool-empty"), "S1 日志不应有 pool-empty");
ok("S1 偶发429自愈且零熔断", "3 次上游调用 / 200 content=OK / cooling=[] / 无 route-fail");

// S2 quota 冷却 + 上游已恢复 → breaker-probe 放行（旧代码会 402）
reset("ok");
S.noteRouteFailure("gemini", "quota");
assert.equal(S.orderedRoutesFor(PID, {}).length, 0, "S2 前置：quota 冷却应让默认路由为空");
base = logLines().length;
let r2 = await post(PID);
let ev2 = logLines().slice(base);
assert.equal(r2.status, 200, "S2 应 200（breaker-probe），实际 " + r2.status + " " + r2.body.slice(0, 200));
assert.equal(JSON.parse(r2.body).choices[0].message.content, "OK", "S2 内容应为 OK");
assert.ok(ev2.some((e) => e.ev === "breaker-probe"), "S2 日志应有 breaker-probe");
assert.equal(S.breakerReport().length, 0, "S2 noteRouteSuccess 应清掉 quota 冷却");
ok("S2 quota冷却自动探测恢复", "旧行为 402 → 新行为 200 / breaker-probe / 冷却清零");

// S3 auth 冷却仍锁死（10 分钟保护保留，不打上游）
reset("ok");
S.noteRouteFailure("gemini", "auth");
base = logLines().length;
let r3 = await post(PID);
let ev3 = logLines().slice(base);
assert.equal(r3.status, 402, "S3 auth 冷却应仍 402");
assert.equal(JSON.parse(r3.body).error.type, "pool_exhausted", "S3 应为 pool_exhausted");
assert.equal(hits, 0, "S3 不应探测上游（auth 冷却不放行）");
assert.ok(!ev3.some((e) => e.ev === "breaker-probe"), "S3 日志不应有 breaker-probe");
ok("S3 auth冷却保护保留", "402 pool_exhausted / 上游 0 次调用 / 无 breaker-probe");

// S4 持续 429 → 池标 quota 熔断(502) → 下一次 breaker-probe 自动恢复
reset("always429");
base = logLines().length;
let r4a = await post(PID);
let ev4a = logLines().slice(base);
assert.equal(r4a.status, 502, "S4a 全池失败应 502，实际 " + r4a.status + " " + r4a.body.slice(0, 300));
assert.ok(ev4a.some((e) => e.ev === "route-fail" && e.kind === "quota"), "S4a 日志应有 quota route-fail");
assert.equal(S.breakerReport()[0]?.kind, "quota", "S4a 应标 gemini/quota 冷却");
mode = "ok"; hits = 0;
base = logLines().length;
let r4b = await post(PID);
let ev4b = logLines().slice(base);
assert.equal(r4b.status, 200, "S4b 冷却内应靠 breaker-probe 恢复 200，实际 " + r4b.status + " " + r4b.body.slice(0, 200));
assert.ok(ev4b.some((e) => e.ev === "breaker-probe"), "S4b 日志应有 breaker-probe");
ok("S4 持续429→熔断→冷却内自动恢复", "502(quota 熔断) → 200(breaker-probe)，无需等 60s");

release();
proxy.close();
upstream.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join("\n"));
console.log("ALL_E2E_ASSERTIONS_PASSED");