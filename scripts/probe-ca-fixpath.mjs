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
function env(model, ua, credits, thinking) {
  const gc = { maxOutputTokens: 16 }; if (thinking) gc.thinkingConfig = { includeThoughts: true };
  const e = { project: "aicode-consumers", model, request: { model, contents: [{ role: "user", parts: [{ text: "Reply with just OK." }] }], generationConfig: gc }, requestType: "agent", userAgent: "antigravity", requestId: "agent-" + randomUUID(), user_prompt_id: randomUUID() };
  if (credits !== null) e.enabled_credit_types = credits;
  return e;
}
async function gen(ep, model, ua, credits, thinking) {
  const t = Date.now();
  try {
    const r = await undici.fetch(ep + "/v1internal:streamGenerateContent?alt=sse", { method: "POST", dispatcher: pa, headers: { "content-type": "application/json", accept: "text/event-stream", authorization: "Bearer " + token, "user-agent": ua || UA }, body: JSON.stringify(env(model, ua, credits, thinking)), signal: AbortSignal.timeout(25000) });
    const txt = await r.text(); return { s: r.status, ms: Date.now()-t, msg: (r.status===200 ? "OK" : txt.replace(/\s+/g," ").slice(0,90)) };
  } catch (e) { return { s: -1, ms: Date.now()-t, msg: e.name }; }
}
const DAILY = "https://daily-cloudcode-pa.googleapis.com", CC = "https://cloudcode-pa.googleapis.com";
console.log("@ " + new Date().toISOString());
console.log("=== cloudcode 429 self-heal? 6 sequential gemini-3-flash ===");
for (let i=0;i<6;i++){ const r=await gen(CC,"gemini-3-flash",UA,["GOOGLE_ONE_AI"],true); console.log("  CC#"+i+" => "+r.s+" "+r.ms+"ms "+r.msg); await new Promise(x=>setTimeout(x,900)); }
console.log("=== daily variants ===");
const V = [
  ["base", UA, ["GOOGLE_ONE_AI"], true],
  ["no-thinking", UA, ["GOOGLE_ONE_AI"], false],
  ["no-credits", UA, null, true],
  ["ua-minimal", "antigravity/hub/2.24.0", ["GOOGLE_ONE_AI"], true],
  ["ua-windows", "antigravity/hub/2.24.0 (aidev_client; os_type=windows; arch=x64; cl=1000335682)", ["GOOGLE_ONE_AI"], true],
];
for (const [label,ua,cr,th] of V){ const r=await gen(DAILY,"gemini-3-flash",ua,cr,th); console.log("  DAILY "+label+" => "+r.s+" "+r.ms+"ms "+r.msg); }
console.log("=== daily model sweep ===");
for (const m of ["gemini-3-flash","gemini-3.1-pro-high","gemini-2.5-flash","gemini-2.5-pro","gemini-3-pro-preview"]){ const r=await gen(DAILY,m,UA,["GOOGLE_ONE_AI"],true); console.log("  DAILY "+m+" => "+r.s+" "+r.ms+"ms "+r.msg); }
console.log("DONE");