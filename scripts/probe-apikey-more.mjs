
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const ROOT=process.argv[2];
const require=createRequire(path.join(ROOT,"package.json"));
const undici=require("undici");
const key=fs.readFileSync("C:/Users/00/.dsh/gemini-api-key","utf8").trim();
const pa=new undici.ProxyAgent("http://127.0.0.1:7897");
const base="https://generativelanguage.googleapis.com/v1beta/openai";
async function chat(m,stream,tmo){
  const t=Date.now();
  try{
    const r=await undici.fetch(base+"/chat/completions",{dispatcher:pa,method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+key,"x-goog-api-key":key},
      body:JSON.stringify({model:m,stream,max_tokens:512,messages:[{role:"user",content:"只回复两个字：可用"}]}),signal:AbortSignal.timeout(tmo||30000)});
    const txt=await r.text();
    const hasDone=txt.includes("[DONE]");
    let tail=txt.slice(-120).replace(/\s+/g," ");
    console.log(m.padEnd(34),"stream="+stream,r.status,(Date.now()-t)+"ms","len="+txt.length,"done="+hasDone,"tail="+tail);
  }catch(e){ console.log(m.padEnd(34),"stream="+stream,"ERR",e.name,(Date.now()-t)+"ms"); }
}
for (const m of ["gemini-flash-lite-latest","gemini-2.5-flash-lite","gemini-3.1-flash-lite-preview","gemini-3.5-flash","gemini-flash-latest"]) await chat(m,true,30000);
