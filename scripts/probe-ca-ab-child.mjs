import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const ROOT = process.argv[2], MODE = process.argv[3];
const require = createRequire(path.join(ROOT, "package.json"));
if (MODE === "A") {
  const undici = require("undici");
  const pa = new undici.ProxyAgent("http://127.0.0.1:7897");
  const raw = globalThis.fetch;
  globalThis.fetch = (u, i = {}) => undici.fetch(u, { ...i, dispatcher: pa });
  process.env.GEMINI_NO_PROXY = "1";
}
const CA = await import(pathToFileURL(path.join(ROOT, "lib", "providers", "gemini", "codeassist.js")).href);
const token = JSON.parse(fs.readFileSync("C:/Users/00/.dsh/gemini-oauth.json", "utf8")).access_token;
const b = { model: "gemini-3.8-flash", messages: [{ role: "user", content: "Reply with just OK." }], stream: true, max_tokens: 16, reasoning_effort: "high" };
const t = Date.now();
try {
  const r = await CA.codeAssistFetch("ignored", { method: "POST", headers: { authorization: "Bearer " + token }, body: JSON.stringify(b), signal: AbortSignal.timeout(45000) });
  let txt = ""; try { txt = await r.text(); } catch {}
  console.log("RESULT " + MODE + " status=" + r.status + " ms=" + (Date.now()-t) + " " + (r.status===200 ? "OK" : txt.replace(/\s+/g," ").slice(0,120)));
} catch (e) { console.log("RESULT " + MODE + " THREW " + e.message + " ms=" + (Date.now()-t)); }