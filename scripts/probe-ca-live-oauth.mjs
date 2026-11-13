
import path from "node:path"; import { pathToFileURL } from "node:url";
const ROOT=process.argv[2];
const cas=await import(pathToFileURL(path.join(ROOT,"lib/providers/gemini/codeassist.js")).href);
const { readOAuthAccessToken, getCodeAssistProjectId, geminiAuthStatus } = await import(pathToFileURL(path.join(ROOT,"lib/providers/gemini/oauth.js")).href);
console.log("authStatus", JSON.stringify(geminiAuthStatus()));
const tok=await readOAuthAccessToken();
console.log("tokenLen", tok.length);
const pid=await getCodeAssistProjectId(tok);
console.log("project", pid);
for (const m of ["gemini-3.5-flash-lite","gemini-3.8-flash","gemini-3.5-pro","gemini-4-argon"]) {
  const t=Date.now();
  const res=await cas.codeAssistFetch("http://local/v1/chat/completions",{method:"POST",headers:{authorization:"Bearer "+tok},body:JSON.stringify({model:m,stream:true,messages:[{role:"user",content:"只回复两个字：可用"}],max_tokens:64})});
  let head="";
  try { const r=res.body.getReader(); const {value}=await r.read(); head=Buffer.from(value||[]).toString("utf8").slice(0,160); try{await r.cancel();}catch{} } catch(e){ head="READERR "+e.message; }
  console.log(m, res.status, (Date.now()-t)+"ms", head.replace(/\s+/g," "));
}
