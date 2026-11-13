
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const ROOT = process.argv[2];
const require = createRequire(path.join(ROOT, "package.json"));
const undici = require("undici");
const pa = new undici.ProxyAgent("http://127.0.0.1:7897");
const token = JSON.parse(fs.readFileSync("C:/Users/00/.dsh/gemini-oauth.json", "utf8")).access_token;
const UA = "antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)";
const DAILY = "https://daily-cloudcode-pa.googleapis.com";
const CA = await import(pathToFileURL(path.join(ROOT, "lib/providers/gemini/codeassist.js")).href);
const PX = await import(pathToFileURL(path.join(ROOT, "lib/providers/gemini/proxy.js")).href);
const SAFE = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" },
];
function env(model, full, thinking) {
  const gc = { maxOutputTokens: 16 };
  if (thinking) gc.thinkingConfig = { includeThoughts: true };
  const request = { model, contents: [{ role: "user", parts: [{ text: "Reply just OK." }] }], generationConfig: gc };
  if (full) request.safetySettings = SAFE;
  return { project: "aicode-consumers", model, request, requestType: "agent", userAgent: "antigravity", requestId: "agent-" + randomUUID(), user_prompt_id: randomUUID(), enabled_credit_types: ["GOOGLE_ONE_AI"] };
}
const H = { "content-type": "application/json", authorization: "Bearer " + token, "user-agent": UA };
const urlOf = (stream) => DAILY + "/v1internal:" + (stream ? "streamGenerateContent?alt=sse" : "generateContent");
async function viaPA(e, stream) {
  const t = Date.now();
  try {
    const r = await undici.fetch(urlOf(stream), { method: "POST", dispatcher: pa, headers: { ...H, accept: stream ? "text/event-stream" : "application/json" }, body: JSON.stringify(e), signal: AbortSignal.timeout(20000) });
    const txt = await r.text();
    return { s: r.status, ms: Date.now() - t, msg: r.status === 200 ? "OK" : txt.replace(/\s+/g, " ").slice(0, 100) };
  } catch (err) { return { s: -1, ms: Date.now() - t, msg: err.name }; }
}
async function viaTunnel(e, stream) {
  const t = Date.now();
  try {
    const r = await PX.geminiFetch(urlOf(stream), { method: "POST", headers: { ...H, accept: stream ? "text/event-stream" : "application/json" }, body: JSON.stringify(e), signal: AbortSignal.timeout(20000) });
    const txt = await r.text();
    return { s: r.status, ms: Date.now() - t, msg: r.status === 200 ? "OK" : txt.replace(/\s+/g, " ").slice(0, 100) };
  } catch (err) { return { s: -1, ms: Date.now() - t, msg: err.name }; }
}
const fmt = (r) => r.s + " " + r.ms + "ms " + r.msg;
console.log("@ " + new Date().toISOString());
console.log("=== A) 单变量=网络路径, full envelope, model=gemini-3-flash, thinking=on, stream=false, 交错 5 轮 ===");
for (let i = 0; i < 5; i++) {
  const a = await viaPA(env("gemini-3-flash", true, true), false);
  const b = await viaTunnel(env("gemini-3-flash", true, true), false);
  console.log("  A#" + i + " ProxyAgent=[" + fmt(a) + "]  隧道=[" + fmt(b) + "]");
}
console.log("=== B) 单变量=envelope 字段 (全走 ProxyAgent, gemini-3-flash, stream=false) ===");
for (const [label, full, th] of [["minimal/no-think", false, false], ["minimal/think", false, true], ["full/no-think", true, false], ["full/think", true, true]]) {
  console.log("  " + label + " => " + fmt(await viaPA(env("gemini-3-flash", full, th), false)));
}
console.log("=== C) 5 个候选模型, full envelope, stream=false, ProxyAgent vs 隧道 ===");
for (const m of ["gemini-3-flash", "gemini-3.1-pro-high", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-pro-preview"]) {
  const a = await viaPA(env(m, true, true), false);
  const b = await viaTunnel(env(m, true, true), false);
  console.log("  " + m.padEnd(22) + " PA=[" + fmt(a) + "]  隧道=[" + fmt(b) + "]");
}
console.log("=== D) codeAssistFetch 本体, 单变量=GEMINI_NO_PROXY (A=patched ProxyAgent / B=宿主隧道), model=gemini-3.8-flash ===");
const origFetch = globalThis.fetch;
globalThis.fetch = (u, i) => undici.fetch(u, { ...i, dispatcher: pa });
async function caRun(stream) {
  const init = { method: "POST", headers: { authorization: "Bearer " + token }, body: JSON.stringify({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "Reply OK" }], max_tokens: 16, stream, reasoning_effort: "high" }), signal: AbortSignal.timeout(30000) };
  const t = Date.now();
  try {
    const r = await CA.codeAssistFetch("x", init);
    let msg = "OK";
    if (r.status !== 200) { try { msg = (await r.text()).replace(/\s+/g, " ").slice(0, 100); } catch {} }
    try { await r.body?.cancel?.(); } catch {}
    return { s: r.status, ms: Date.now() - t, msg };
  } catch (err) { return { s: -1, ms: Date.now() - t, msg: err.name + ":" + err.message }; }
}
for (const stream of [false, true]) {
  for (let i = 0; i < 2; i++) {
    process.env.GEMINI_NO_PROXY = "1";
    const a = await caRun(stream);
    delete process.env.GEMINI_NO_PROXY;
    const b = await caRun(stream);
    console.log("  stream=" + stream + " #" + i + " A(ProxyAgent)=[" + fmt(a) + "]  B(隧道)=[" + fmt(b) + "]");
  }
}
globalThis.fetch = origFetch;
console.log("proxyInfo after = " + JSON.stringify(PX.geminiProxyInfo()));
console.log("DONE");
