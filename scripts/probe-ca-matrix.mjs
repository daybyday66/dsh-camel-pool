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
const BASE = "https://daily-cloudcode-pa.googleapis.com/v1internal";
async function post(method, payload, accept) {
  const t = Date.now();
  try {
    const r = await undici.fetch(BASE + ":" + method + (accept === "sse" ? "?alt=sse" : ""), {
      method: "POST", dispatcher: pa,
      headers: { "content-type": "application/json", accept: accept === "sse" ? "text/event-stream" : "application/json", authorization: "Bearer " + token, "user-agent": UA },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(30000),
    });
    const txt = await r.text();
    return { status: r.status, ms: Date.now()-t, txt };
  } catch (e) { return { status: -1, ms: Date.now()-t, txt: e.name + ":" + e.message }; }
}
// 1) loadCodeAssist — 看当前账号真实 project / tier
const load = await post("loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY" } }, "json");
console.log("LOAD status=" + load.status + " ms=" + load.ms + " body=" + load.txt.replace(/\s+/g," ").slice(0, 900));
let discovered = null;
try { const j = JSON.parse(load.txt); discovered = j.cloudaicompanionProject || j.response?.cloudaicompanionProject || null; } catch {}

function envelope(opts) {
  const o = opts || {};
  const model = o.model || "gemini-3-flash";
  const env = {
    model,
    request: { model, contents: [{ role: "user", parts: [{ text: "Reply with just OK." }] }], generationConfig: { maxOutputTokens: 16, thinkingConfig: { includeThoughts: true } } },
    requestType: "agent", userAgent: "antigravity", requestId: "agent-" + randomUUID(), user_prompt_id: randomUUID(),
  };
  if (o.project !== null) env.project = o.project === undefined ? "aicode-consumers" : o.project;
  if (o.credits !== null) env.enabled_credit_types = o.credits === undefined ? ["GOOGLE_ONE_AI"] : o.credits;
  if (o.requestType === null) delete env.requestType;
  return env;
}
const matrix = [
  ["P1 cached-project+credits", { project: "aicode-consumers" }],
  ["P2 no-project", { project: null }],
  ["P3 no-credits", { credits: null }],
  ["P4 no-project+no-credits", { project: null, credits: null }],
  ["P5 no-requestType", { requestType: null }],
  ["P6 model-2.5-pro", { model: "gemini-2.5-pro" }],
  ["P7 model-3.1-pro-high", { model: "gemini-3.1-pro-high" }],
  ["P8 model-2.5-flash", { model: "gemini-2.5-flash" }],
  ["P9 credits-empty", { credits: [] }],
  ["P10 generateContent", { method: "generateContent" }],
];
if (discovered) matrix.push(["P11 discovered-project", { project: discovered }]);
for (const [label, o] of matrix) {
  const r = await post(o.method || "streamGenerateContent", envelope(o), o.method === "generateContent" ? "json" : "sse");
  const ok = r.status === 200;
  console.log("MATRIX " + label + " => status=" + r.status + " ms=" + r.ms + (ok ? " OK " + r.txt.replace(/\s+/g," ").slice(0,110) : " " + r.txt.replace(/\s+/g," ").slice(0,180)));
}
console.log("DONE");