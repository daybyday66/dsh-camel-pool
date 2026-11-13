import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const ROOT = process.argv[2];
const require = createRequire(path.join(ROOT, "package.json"));
const undici = require("undici");
const pa = new undici.ProxyAgent("http://127.0.0.1:7897");
const token = JSON.parse(fs.readFileSync("C:/Users/00/.dsh/gemini-oauth.json", "utf8")).access_token;
const UA = "antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)";
const DAILY = "https://daily-cloudcode-pa.googleapis.com";
const CC = "https://cloudcode-pa.googleapis.com";
async function ctrl(name, node) {
  const u = "http://127.0.0.1:9097/proxies/" + encodeURIComponent(name);
  const r = await undici.request(u, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: node }), signal: AbortSignal.timeout(6000) });
  await r.body.dump(); return r.statusCode;
}
async function cur(name) {
  const r = await undici.fetch("http://127.0.0.1:9097/proxies/" + encodeURIComponent(name), { signal: AbortSignal.timeout(6000) });
  return (await r.json()).now;
}
async function egress() {
  try { const r = await undici.fetch("https://api.ipify.org?format=json", { dispatcher: pa, signal: AbortSignal.timeout(9000) }); const j = await r.json(); return j.ip || "?"; } catch(e) { return "ERR:" + e.name; }
}
async function gen(ep, model) {
  const gc = { maxOutputTokens: 16, thinkingConfig: { includeThoughts: true } };
  const envelope = { project: "aicode-consumers", model, request: { model, contents: [{ role: "user", parts: [{ text: "Reply with just OK." }] }], generationConfig: gc }, requestType: "agent", userAgent: "antigravity", requestId: "agent-" + randomUUID(), user_prompt_id: randomUUID(), enabled_credit_types: ["GOOGLE_ONE_AI"] };
  const t = Date.now();
  try {
    const r = await undici.fetch(ep + "/v1internal:streamGenerateContent?alt=sse", { method: "POST", dispatcher: pa, headers: { "content-type": "application/json", accept: "text/event-stream", authorization: "Bearer " + token, "user-agent": UA }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(20000) });
    const txt = await r.text();
    let msg = r.status === 200 ? "OK" : txt.replace(/\s+/g, " ").slice(0, 100);
    return { s: r.status, ms: Date.now() - t, msg };
  } catch (e) { return { s: -1, ms: Date.now() - t, msg: e.name }; }
}
async function gl() {
  const t = Date.now();
  try {
    const r = await undici.fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", { method: "POST", dispatcher: pa, headers: { "content-type": "application/json", authorization: "Bearer " + token, "user-agent": UA }, body: JSON.stringify({ contents: [{ parts: [{ text: "Reply OK" }] }], generationConfig: { maxOutputTokens: 16 } }), signal: AbortSignal.timeout(15000) });
    const txt = await r.text(); return { s: r.status, ms: Date.now()-t, msg: txt.replace(/\s+/g," ").slice(0,140) };
  } catch(e) { return { s: -1, ms: Date.now()-t, msg: e.name }; }
}
const GROUPS = ["GLOBAL", "一元机场.VIP"];
const originals = {}; for (const g of GROUPS) originals[g] = await cur(g);
console.log("ORIGINAL " + JSON.stringify(originals));
console.log("@ " + new Date().toISOString());
const g = await gl(); console.log("generativelanguage (oauth token, current node) => " + g.s + " " + g.ms + "ms " + g.msg);
const NODES = [
  "美国LisaLAX-rl(主力D)", "美国LisaSFO-rl(主力B)",
  "新加坡Lisa-rl-gemini", "新加坡Lisa-hy2hop-gemini",
  "美国-DAL大带宽-rl(主力)gemini", "美国-LA大带宽-rl(禁联通)gemini",
  "美国-LA极速ccs-rl(主力)gemini", "美国-美西极速-rl(主力)gemini",
  "美国极速05-rl-gemini", "美国极速05-hy2hop-gemini", "美国极速04-hy2hop-gemini",
  "越南河内MAX-rl(移动优选)gemini", "Premium-日本软银01", "Premium-台湾顶级商宽-大安",
  "Scaleway荷兰极速-rl(主力)", "德国法兰克福-rl(主力)", "爱尔兰Dublin-rl",
];
for (const n of NODES) {
  let ok = true; for (const gr of GROUPS) { try { const s = await ctrl(gr, n); if (s !== 204 && s !== 200) ok = false; } catch(e) { ok = false; } }
  if (!ok) { console.log("NODE " + n + " => SWITCH-FAILED"); continue; }
  await new Promise(x => setTimeout(x, 350));
  const ip = await egress();
  const d = await gen(DAILY, "gemini-3-flash");
  console.log("NODE " + n + " ip=" + ip + " DAILY => " + d.s + " " + d.ms + "ms " + d.msg);
  if (d.s !== 200) { const c = await gen(CC, "gemini-3-flash"); console.log("    CC => " + c.s + " " + c.ms + "ms " + c.msg); }
}
for (const gr of GROUPS) { try { await ctrl(gr, originals[gr]); } catch(e){} }
console.log("RESTORED " + JSON.stringify(originals));
console.log("DONE");