import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const ROOT = process.argv[2];
// 宿主同款网络路径：不设 GEMINI_NO_PROXY，不 patch fetch，让 geminiFetch 走自定义 CONNECT 隧道
const CA = await import(pathToFileURL(path.join(ROOT, "lib", "providers", "gemini", "codeassist.js")).href);
const OA = await import(pathToFileURL(path.join(ROOT, "lib", "providers", "gemini", "oauth.js")).href);
const PROXY = await import(pathToFileURL(path.join(ROOT, "lib", "providers", "gemini", "proxy.js")).href);
const token = JSON.parse(fs.readFileSync("C:/Users/00/.dsh/gemini-oauth.json", "utf8")).access_token;
console.log("proxyInfo=" + JSON.stringify(PROXY.geminiProxyInfo()) + " endpoint=" + OA.codeAssistEndpoint());
function body(model) {
  return { model, messages: [{ role: "system", content: "You are a coding agent working in a repo. ".repeat(60) }, { role: "user", content: "Reply with just OK." }], stream: true, max_tokens: 32, reasoning_effort: "high" };
}
async function once(model, label) {
  const t = Date.now();
  try {
    const r = await CA.codeAssistFetch("ignored", { method: "POST", headers: { authorization: "Bearer " + token }, body: JSON.stringify(body(model)), signal: AbortSignal.timeout(45000) });
    let txt = ""; try { txt = await r.text(); } catch {}
    const okChunk = /"content":"OK"|\bOK\b/.test(txt);
    console.log("REQ " + label + " model=" + model + " status=" + r.status + " ms=" + (Date.now()-t) + (r.status===200 ? " ok="+okChunk : " body="+txt.slice(0,220).replace(/\s+/g," ")));
    return { status: r.status, ms: Date.now()-t };
  } catch (e) { console.log("REQ " + label + " model=" + model + " THREW " + e.name + ":" + e.message + " ms=" + (Date.now()-t)); return { status: -1, ms: Date.now()-t }; }
}
const MODELS = ["gemini-4-argon","gemini-3.1-pro-preview","gemini-3.8-flash","gemini-3.5-flash-lite"];
for (let round = 1; round <= 3; round++) {
  console.log("=== CONCURRENT round " + round + " ===");
  const rs = await Promise.all(MODELS.map((m, i) => once(m, "c"+round+"-"+i)));
  console.log("SUMMARY round " + round + " => " + rs.map((r,i)=>MODELS[i]+":"+r.status+"/"+r.ms+"ms").join(" | "));
}
console.log("=== SEQUENTIAL 4 ===");
for (let i = 0; i < 4; i++) await once("gemini-3.8-flash", "seq"+i);
console.log("DONE proxyInfo=" + JSON.stringify(PROXY.geminiProxyInfo()));