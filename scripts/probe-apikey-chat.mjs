
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const ROOT=process.argv[2];
const require=createRequire(path.join(ROOT,"package.json"));
const undici=require("undici");
const key=fs.readFileSync("C:/Users/00/.dsh/gemini-api-key","utf8").trim();
const pa=new undici.ProxyAgent("http://127.0.0.1:7897");
const base="https://generativelanguage.googleapis.com/v1beta/openai";
async function chat(m, extra={}) {
  const t=Date.now();
  try {
    const r=await undici.fetch(base+"/chat/completions",{dispatcher:pa,method:"POST",
      headers:{"content-type":"application/json",authorization:"Bearer "+key,"x-goog-api-key":key},
      body:JSON.stringify({model:m,messages:[{role:"user",content:"只回复两个字：可用"}],max_tokens:32,...extra}),
      signal:AbortSignal.timeout(60000)});
    const txt=await r.text();
    let summary=txt.replace(/\s+/g," ").slice(0,220);
    try { const j=JSON.parse(txt); if(j.choices) summary="CONTENT="+JSON.stringify(j.choices[0].message.content)+" finish="+j.choices[0].finish_reason+" usage="+JSON.stringify(j.usage); } catch(e){}
    console.log("  "+m.padEnd(30)+r.status+" "+(Date.now()-t)+"ms "+summary);
  } catch(e){ console.log("  "+m.padEnd(30)+"ERR "+e.name+" "+e.message+" "+(Date.now()-t)+"ms"); }
}
for (const m of ["gemini-3.8-flash","gemini-4-argon","gemini-3.1-pro-preview","gemini-3.5-flash-lite","gemini-3.5-flash","gemini-pro-latest","gemini-3.1-flash-lite"]) await chat(m);
console.log("--- stream test gemini-3.8-flash ---");
{
  const t=Date.now();
  const r=await undici.fetch(base+"/chat/completions",{dispatcher:pa,method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+key,"x-goog-api-key":key},body:JSON.stringify({model:"gemini-3.8-flash",stream:true,messages:[{role:"user",content:"只回复两个字：可用"}]}),signal:AbortSignal.timeout(60000)});
  const txt=await r.text();
  console.log("  status",r.status,(Date.now()-t)+"ms","len",txt.length,"has[DONE]",txt.includes("[DONE]"));
  console.log("  head",txt.replace(/\s+/g," ").slice(0,300));
}
