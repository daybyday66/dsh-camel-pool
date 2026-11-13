
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const ROOT = process.argv[2];
const require = createRequire(path.join(ROOT, "package.json"));
const undici = require("undici");
const pa = new undici.ProxyAgent("http://127.0.0.1:7897");
const token = JSON.parse(fs.readFileSync("C:/Users/00/.dsh/gemini-oauth.json", "utf8")).access_token;
const UA = "antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)";
const EPS = { daily: "https://daily-cloudcode-pa.googleapis.com", cloudcode: "https://cloudcode-pa.googleapis.com" };
const SAFE = ["HARM_CATEGORY_HARASSMENT","HARM_CATEGORY_HATE_SPEECH","HARM_CATEGORY_SEXUALLY_EXPLICIT","HARM_CATEGORY_DANGEROUS_CONTENT","HARM_CATEGORY_CIVIC_INTEGRITY"].map(category=>({category,threshold:"OFF"}));
function env(model){ const gc={maxOutputTokens:16,thinkingConfig:{includeThoughts:true}}; return {project:"aicode-consumers",model,request:{model,contents:[{role:"user",parts:[{text:"Reply just OK."}]}],generationConfig:gc,safetySettings:SAFE},requestType:"agent",userAgent:"antigravity",requestId:"agent-"+randomUUID(),user_prompt_id:randomUUID(),enabled_credit_types:["GOOGLE_ONE_AI"]}; }
async function one(ep,method,model){
  const stream=method==="sse";
  const url=ep+"/v1internal:"+(stream?"streamGenerateContent?alt=sse":"generateContent");
  const t=Date.now();
  try{
    const r=await undici.fetch(url,{method:"POST",dispatcher:pa,headers:{"content-type":"application/json",accept:stream?"text/event-stream":"application/json",authorization:"Bearer "+token,"user-agent":UA},body:JSON.stringify(env(model)),signal:AbortSignal.timeout(12000)});
    const txt=await r.text(); let code="OK";
    const m=/"code":s*(d+)/.exec(txt); const st=/"status":s*"([A-Z_]+)"/.exec(txt);
    if(r.status!==200)code=(m?m[1]:"?")+(st?"/"+st[1]:"")+" "+(/"message":s*"([^"]+)"/.exec(txt)?.[1]||"").slice(0,48);
    return {s:r.status,ms:Date.now()-t,code};
  }catch(e){return {s:-1,ms:Date.now()-t,code:e.name};}
}
const COMBOS=[];
for(const [en,eu] of Object.entries(EPS))for(const method of ["sse","json"])for(const model of ["gemini-3-flash","gemini-3.1-pro-high"])COMBOS.push([en,eu,method,model]);
for(let round=1;round<=3;round++){
  const rs=await Promise.all(COMBOS.map(c=>one(c[1],c[2],c[3])));
  console.log("=== ROUND "+round+" @ "+new Date().toISOString()+" ===");
  COMBOS.forEach((c,i)=>{const r=rs[i];console.log("  "+c[0].padEnd(10)+" "+c[2].padEnd(4)+" "+c[3].padEnd(22)+" => "+r.s+" "+r.ms+"ms "+r.code);});
  if(round<3)await new Promise(x=>setTimeout(x,2500));
}
// time-series: daily + sse + gemini-3-flash, 12 sequential
console.log("=== TIME-SERIES daily/sse/gemini-3-flash x12 ===");
let ok=0;
for(let i=0;i<12;i++){const r=await one(EPS.daily,"sse","gemini-3-flash");if(r.s===200)ok++;console.log("  #"+String(i).padStart(2)+" "+r.s+" "+r.ms+"ms "+r.code);await new Promise(x=>setTimeout(x,1500));}
console.log("SERIES 200 count="+ok+"/12");
console.log("DONE");
