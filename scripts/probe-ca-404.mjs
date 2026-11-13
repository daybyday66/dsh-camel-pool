import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const ROOT = process.argv[2];
const require = createRequire(path.join(ROOT, "package.json"));
const undici = require("undici");
const agent = new undici.ProxyAgent("http://127.0.0.1:7897");
const real = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const t = Date.now();
  const r = await undici.fetch(url, { ...init, dispatcher: agent });
  const ms = Date.now() - t;
  if (!r.ok) {
    let txt = ""; try { txt = await r.clone().text(); } catch {}
    console.log("UPSTREAM_FAIL status=" + r.status + " ms=" + ms + " url=" + String(url).slice(0, 120) + " body=" + txt.slice(0, 400).replace(/\s+/g, " "));
  } else { console.log("UPSTREAM_OK status=" + r.status + " ms=" + ms); }
  return r;
};
process.env.GEMINI_NO_PROXY = "1";
const CA = await import(pathToFileURL(path.join(ROOT, "lib", "providers", "gemini", "codeassist.js")).href);
const token = JSON.parse(fs.readFileSync("C:/Users/00/.dsh/gemini-oauth.json", "utf8")).access_token;
function mkBody(big) {
  const sys = big ? ("You are a coding agent. ".repeat(1200)) : "You are a helpful assistant.";
  return { model: "gemini-3.8-flash", messages: [{ role: "system", content: sys }, { role: "user", content: "Reply with just OK." }], stream: true, max_tokens: 32, reasoning_effort: "high" };
}
for (const [label, big] of [["small", false], ["big", true], ["small2", false], ["big2", true]]) {
  console.log("=== RUN " + label + " ===");
  const t = Date.now();
  try {
    const r = await CA.codeAssistFetch("ignored", { method: "POST", headers: { authorization: "Bearer " + token }, body: JSON.stringify(mkBody(big)) });
    let txt = ""; try { txt = await r.text(); } catch {}
    console.log("RESULT " + label + " status=" + r.status + " ms=" + (Date.now()-t) + " body=" + txt.slice(0, 260).replace(/\s+/g, " "));
  } catch (e) { console.log("RESULT " + label + " THREW " + e.message + " ms=" + (Date.now()-t)); }
}
console.log("DONE");