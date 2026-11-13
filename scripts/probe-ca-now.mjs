import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module"; import { randomUUID } from "node:crypto";
const ROOT=process.argv[2]; const WS=new RegExp(String.fromCharCode(92)+"s+","g");
const require=createRequire(path.join(ROOT,"package.json")); const undici=require("undici");
const pa=new undici.ProxyAgent("http://127.0.0.1:7897");
const UA="antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)";
const c=JSON.parse(fs.readFileSync("C:/Users/00/.dsh/gemini-oauth.json","utf8"));
const SAFE=["HARM_CATEGORY_HARASSMENT","HARM_CATEGORY_HATE_SPEECH","HARM_CATEGORY_SEXUALLY_EXPLICIT","HARM_CATEGORY_DANGEROUS_CONTENT","HARM_CATEGORY_CIVIC_INTEGRITY"].map(category=>({category,threshold:"OFF"}));
const env={project:"aicode-consumers",model:"gemini-3-flash",request:{model:"gemini-3-flash",contents:[{role:"user",parts:[{text:"Reply just OK."}]}],generationConfig:{maxOutputTokens:16,thinkingConfig:{includeThoughts:true}},safetySettings:SAFE},requestType:"agent",userAgent:"antigravity",requestId:"agent-"+randomUUID(),user_prompt_id:randomUUID(),enabled_credit_types:["GOOGLE_ONE_AI"]};
console.log("token exp="+new Date(c.expiry_date).toISOString()+" valid="+(c.expiry_date>Date.now()));
for(const host of ["https://daily-cloudcode-pa.googleapis.com","https://cloudcode-pa.googleapis.com"]){
  for(let i=0;i<3;i++){const t=Date.now();try{const r=await undici.fetch(host+"/v1internal:streamGenerateContent?alt=sse",{method:"POST",dispatcher:pa,headers:{"content-type":"application/json",accept:"text/event-stream",authorization:"Bearer "+c.access_token,"user-agent":UA},body:JSON.stringify(env),signal:AbortSignal.timeout(12000)});const txt=await r.text();let m="OK";if(r.status!==200){try{m=JSON.parse(txt).error.message;}catch(e){m=txt.replace(WS," ").slice(0,60);}}console.log("  "+host.split("//")[1].split(".")[0].padEnd(22)+" #"+i+" "+r.status+" "+(Date.now()-t)+"ms "+m.slice(0,60));}catch(e){console.log("  ERR "+e.name);}}
  await new Promise(x=>setTimeout(x,700));
}
console.log("@ "+new Date().toISOString());
