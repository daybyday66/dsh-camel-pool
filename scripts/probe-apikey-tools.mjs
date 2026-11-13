
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const ROOT=process.argv[2];
const require=createRequire(path.join(ROOT,"package.json"));
const undici=require("undici");
const key=fs.readFileSync("C:/Users/00/.dsh/gemini-api-key","utf8").trim();
const pa=new undici.ProxyAgent("http://127.0.0.1:7897");
const base="https://generativelanguage.googleapis.com/v1beta/openai";
const H={"content-type":"application/json",authorization:"Bearer "+key,"x-goog-api-key":key};
const tools=[{type:"function",function:{name:"list_files",description:"list files",parameters:{type:"object",properties:{path:{type:"string"}}}}}];
async function call(body,label){
  const t=Date.now();
  try{
    const r=await undici.fetch(base+"/chat/completions",{dispatcher:pa,method:"POST",headers:H,body:JSON.stringify(body),signal:AbortSignal.timeout(40000)});
    const txt=await r.text();
    console.log(label.padEnd(26),r.status,(Date.now()-t)+"ms",txt.replace(/\s+/g," ").slice(0,260));
    return {status:r.status,txt};
  }catch(e){ console.log(label.padEnd(26),"ERR",e.name,(Date.now()-t)+"ms"); return null; }
}
const m="gemini-3.5-flash-lite";
const r1=await call({model:m,stream:false,max_tokens:512,messages:[{role:"user",content:"用 list_files 看看当前目录"}],tools},"turn1-tools");
let asstMsg=null;
try{ const j=JSON.parse(r1.txt); asstMsg=j.choices[0].message; console.log("  asst=",JSON.stringify(asstMsg).slice(0,300)); }catch{}
if (asstMsg?.tool_calls?.length) {
  // 去掉 extra_content，模拟宿主回传
  const cleaned={role:"assistant",content:asstMsg.content??null,tool_calls:asstMsg.tool_calls.map(tc=>({id:tc.id,type:"function",function:tc.function}))};
  await call({model:m,stream:false,max_tokens:512,tools,messages:[{role:"user",content:"用 list_files 看看当前目录"},cleaned,{role:"tool",tool_call_id:asstMsg.tool_calls[0].id,content:'["a.txt","b.txt"]'}]},"turn2-no-sig");
  const withSig={role:"assistant",content:asstMsg.content??null,tool_calls:asstMsg.tool_calls};
  await call({model:m,stream:false,max_tokens:512,tools,messages:[{role:"user",content:"用 list_files 看看当前目录"},withSig,{role:"tool",tool_call_id:asstMsg.tool_calls[0].id,content:'["a.txt","b.txt"]'}]},"turn2-with-sig");
}
