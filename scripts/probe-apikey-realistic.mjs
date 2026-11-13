
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
    const r=await undici.fetch(base+"/chat/completions",{dispatcher:pa,method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+key,"x-goog-api-key":key},body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
    const txt=await r.text();
    console.log(label, r.status, (Date.now()-t)+"ms", "len="+txt.length, txt.replace(/\s+/g," ").slice(0,240));
  }catch(e){ console.log(label,"ERR",e.name,e.message,(Date.now()-t)+"ms"); }
}
// 1. stream + system + tools + reasoning_effort（复刻宿主真实请求）
await post({model:"gemini-3.5-flash-lite",stream:true,reasoning_effort:"high",max_tokens:256,
 messages:[{role:"system",content:"你是助手"},{role:"user",content:"列出当前目录文件"}],
 tools:[{type:"function",function:{name:"list_files",description:"list",parameters:{type:"object",properties:{path:{type:"string"}}}}}],
 tool_choice:"auto"},"S-stream-tools");
// 2. 非流式 + 同上
await post({model:"gemini-3.5-flash-lite",stream:false,reasoning_effort:"high",max_tokens:256,
 messages:[{role:"system",content:"你是助手"},{role:"user",content:"只回复两个字：可用"}]},"S-nonstream");
// 3. 大 max_tokens 观察 thinking 吃 token
await post({model:"gemini-3.5-flash-lite",stream:true,max_tokens:2048,reasoning_effort:"high",messages:[{role:"user",content:"简述 TCP 三次握手"}]},"S-thinking");
// 4. pro 档在 apikey 上能否用（重试一次看是否偶发）
await post({model:"gemini-3.1-pro-preview",stream:true,max_tokens:64,messages:[{role:"user",content:"只回复两个字：可用"}]},"S-pro-preview");
await post({model:"gemini-3.8-flash",stream:true,max_tokens:512,messages:[{role:"user",content:"只回复两个字：可用"}]},"S-3.8flash");
await post({model:"gemini-3.7-flash",stream:true,max_tokens:512,messages:[{role:"user",content:"只回复两个字：可用"}]},"S-3.7flash");
await post({model:"gemini-3.6-flash",stream:true,max_tokens:512,messages:[{role:"user",content:"只回复两个字：可用"}]},"S-3.6flash");
