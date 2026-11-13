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
async function req(url, opts) {
  const t = Date.now();
  try {
    const r = await undici.fetch(url, { ...opts, dispatcher: pa, signal: AbortSignal.timeout(20000) });
    const txt = await r.text();
    return { status: r.status, ms: Date.now()-t, txt };
  } catch (e) { return { status: -1, ms: Date.now()-t, txt: e.name + ":" + e.message }; }
}
// 出口地区
for (const ipurl of ["https://api.ipify.org?format=json", "https://ipapi.co/json/"]) {
  const r = await req(ipurl, { method: "GET" });
  console.log("EGRESS " + ipurl + " => " + r.status + " " + r.txt.replace(/\s+/g," ").slice(0, 260));
}
const ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
  "https://autopush-cloudcode-pa.googleapis.com",
  "https://staging-cloudcode-pa.googleapis.com",
];
function envelope(model) {
  return {
    project: "aicode-consumers", model,
    request: { model, contents: [{ role: "user", parts: [{ text: "Reply with just OK." }] }], generationConfig: { maxOutputTokens: 16 } },
    requestType: "agent", userAgent: "antigravity", requestId: "agent-" + randomUUID(), user_prompt_id: randomUUID(),
    enabled_credit_types: ["GOOGLE_ONE_AI"],
  };
}
const H = { "content-type": "application/json", accept: "text/event-stream", authorization: "Bearer " + token, "user-agent": UA };
for (const ep of ENDPOINTS) {
  // loadCodeAssist
  const l = await req(ep + "/v1internal:loadCodeAssist", { method: "POST", headers: { ...H, accept: "application/json" }, body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }) });
  let tier = "?"; try { const j = JSON.parse(l.txt); tier = JSON.stringify({ p: j.cloudaicompanionProject, t: j.currentTier?.id, allowed: j.allowedTiers?.map(x=>x.id) }); } catch {}
  console.log("EP " + ep + " LOAD => " + l.status + " " + l.ms + "ms " + (l.status===200 ? tier : l.txt.replace(/\s+/g," ").slice(0,160)));
  // 3 次 generate
  const rs = await Promise.all([0,1,2].map((i) => req(ep + "/v1internal:streamGenerateContent?alt=sse", { method: "POST", headers: H, body: JSON.stringify(envelope("gemini-3-flash")) })));
  console.log("EP " + ep + " GEN  => " + rs.map((r)=>r.status+"/"+r.ms+"ms"+(r.status!==200?":"+r.txt.replace(/\s+/g," ").slice(0,80):"")).join(" | "));
}
console.log("DONE");