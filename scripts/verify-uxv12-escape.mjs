
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
const ROOT=process.argv[2];
// 假 OAuth 上游：一律 429 RESOURCE_EXHAUSTED（模拟 project 配额耗尽）
const fake=await new Promise((resolve)=>{
  const srv=http.createServer((req,res)=>{
    let b="";req.on("data",c=>b+=c);req.on("end",()=>{
      res.writeHead(429,{"content-type":"application/json"});
      res.end(JSON.stringify({error:{code:429,message:"Resource has been exhausted (e.g. check quota).",status:"RESOURCE_EXHAUSTED"}}));
    });
  });
  srv.listen(0,"127.0.0.1",()=>resolve(srv));
});
process.env.CODE_ASSIST_ENDPOINT="http://127.0.0.1:"+fake.address().port;
process.env.GEMINI_CA_QUOTA_LADDER="50,100,200";
const cas=await import(pathToFileURL(path.join(ROOT,"lib/providers/gemini/codeassist.js")).href);
const { readOAuthAccessToken } = await import(pathToFileURL(path.join(ROOT,"lib/providers/gemini/oauth.js")).href);
const tok=await readOAuthAccessToken();
const t0=Date.now();
const res=await cas.codeAssistFetch("http://x/v1/chat/completions",{method:"POST",headers:{authorization:"Bearer "+tok},body:JSON.stringify({model:"gemini-3.5-flash-lite",stream:true,max_tokens:64,messages:[{role:"user",content:"只回复两个字：可用"}]})});
let text="";
try{ const r=res.body.getReader(); for(;;){ const {value,done}=await r.read(); if(done) break; text+=Buffer.from(value).toString("utf8"); if(text.length>800) break; } }catch(e){ text+="READERR "+e.message; }
console.log("STATUS",res.status,(Date.now()-t0)+"ms");
console.log("CT",res.headers.get("content-type"));
console.log("BODY",text.replace(/\s+/g," ").slice(0,400));
fake.close();
