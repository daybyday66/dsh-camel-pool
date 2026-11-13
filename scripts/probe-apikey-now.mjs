
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const ROOT=process.argv[2];
const require=createRequire(path.join(ROOT,"package.json"));
let undici;
try { undici=require("undici"); } catch(e){ console.log("NO_UNDICI "+e.message); process.exit(1);}
const key=fs.readFileSync("C:/Users/00/.dsh/gemini-api-key","utf8").trim();
console.log("keyLen="+key.length+" prefix="+key.slice(0,6));
const pa=new undici.ProxyAgent("http://127.0.0.1:7897");
async function go(url, opt={}) {
  const t=Date.now();
  try {
    const r=await undici.fetch(url,{dispatcher:pa,signal:AbortSignal.timeout(20000),...opt});
    const txt=await r.text();
    console.log(r.status+" "+(Date.now()-t)+"ms "+url.replace(/\?.*/,"")+" :: "+txt.replace(/\s+/g," ").slice(0,300));
    return {status:r.status,txt};
  } catch(e) { console.log("ERR "+(Date.now()-t)+"ms "+e.name+" "+e.message); return null; }
}
const base="https://generativelanguage.googleapis.com/v1beta/openai";
await go(base+"/models",{headers:{accept:"application/json",authorization:"Bearer "+key,"x-goog-api-key":key}});
for (const m of ["gemini-2.5-flash","gemini-2.5-pro","gemini-3-flash","gemini-3-pro-preview","gemini-3.1-pro-high"]) {
  await go(base+"/chat/completions",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+key,"x-goog-api-key":key},body:JSON.stringify({model:m,messages:[{role:"user",content:"Say OK"}],max_tokens:8})});
}
