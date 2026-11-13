
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const ROOT=process.argv[2];
const require=createRequire(path.join(ROOT,"package.json"));
const undici=require("undici");
const key=fs.readFileSync("C:/Users/00/.dsh/gemini-api-key","utf8").trim();
const pa=new undici.ProxyAgent("http://127.0.0.1:7897");
const base="https://generativelanguage.googleapis.com/v1beta/openai";
async function post(body,label){
  const t=Date.now();
  try{
    const r=await undici.fetch(base+"/chat/completions",{dispatcher:pa,method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+key,"x-goog-api-key":key},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
    const txt=await r.text();
    console.log(label.padEnd(28), r.status, (Date.now()-t)+"ms", txt.replace(/\s+/g," ").slice(0,200));
  }catch(e){ console.log(label.padEnd(28),"ERR",e.name,(Date.now()-t)+"ms"); }
}
await post({model:"gemini-3.5-flash-lite",stream:false,max_tokens:65536,messages:[{role:"user",content:"只回复两个字：可用"}]},"max65536");
await post({model:"gemini-3.5-flash-lite",stream:false,max_tokens:65536,reasoning_effort:"high",messages:[{role:"user",content:"只回复两个字：可用"}]},"max65536+effort");
await post({model:"gemini-3.5-flash-lite",stream:false,max_tokens:65536,temperature:0.7,top_p:1,messages:[{role:"user",content:"只回复两个字：可用"}]},"max+temperature");
// 宿主可能带 tool 定义但 tool_choice: auto
