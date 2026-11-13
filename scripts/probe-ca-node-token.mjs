import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const ROOT = process.argv[2];
const OA = "C:/Users/00/.dsh/gemini-oauth.json";
const NL = String.fromCharCode(10);
const WS = new RegExp(String.fromCharCode(92) + "s+", "g");
const require = createRequire(path.join(ROOT, "package.json"));
const undici = require("undici");
const pa = new undici.ProxyAgent("http://127.0.0.1:7897");
const UA = "antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)";
const DAILY = "https://daily-cloudcode-pa.googleapis.com";
const CLOUD = "https://cloudcode-pa.googleapis.com";
const SAFE = ["HARM_CATEGORY_HARASSMENT","HARM_CATEGORY_HATE_SPEECH","HARM_CATEGORY_SEXUALLY_EXPLICIT","HARM_CATEGORY_DANGEROUS_CONTENT","HARM_CATEGORY_CIVIC_INTEGRITY"].map(category=>({category,threshold:"OFF"}));
function env(model){return {project:"aicode-consumers",model,request:{model,contents:[{role:"user",parts:[{text:"Reply just OK."}]}],generationConfig:{maxOutputTokens:16,thinkingConfig:{includeThoughts:true}},safetySettings:SAFE},requestType:"agent",userAgent:"antigravity",requestId:"agent-"+randomUUID(),user_prompt_id:randomUUID(),enabled_credit_types:["GOOGLE_ONE_AI"]};}
function brief(txt){try{const j=JSON.parse(txt);if(j&&j.error&&j.error.message)return j.error.message;}catch(e){}return String(txt).replace(WS," ").slice(0,60);}
async function gen(token,host,model){
  const t=Date.now();
  try{
    const r=await undici.fetch(host+"/v1internal:streamGenerateContent?alt=sse",{method:"POST",dispatcher:pa,headers:{"content-type":"application/json",accept:"text/event-stream",authorization:"Bearer "+token,"user-agent":UA},body:JSON.stringify(env(model||"gemini-3-flash")),signal:AbortSignal.timeout(12000)});
    const txt=await r.text();
    return {s:r.status,ms:Date.now()-t,code:(r.status===200?"OK":brief(txt)).slice(0,54)};
  }catch(e){return {s:-1,ms:Date.now()-t,code:e.name};}
}
async function setNode(node){
  try{const r=await undici.request("http://127.0.0.1:9097/proxies/"+encodeURIComponent("一元机场.VIP"),{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({name:node}),signal:AbortSignal.timeout(6000)});await r.body.dump();return r.statusCode;}catch(e){return -1;}
}
async function getNode(){
  try{const r=await undici.fetch("http://127.0.0.1:9097/proxies/"+encodeURIComponent("一元机场.VIP"),{signal:AbortSignal.timeout(6000)});return (await r.json()).now;}catch(e){return "ERR";}
}
const tok=()=>JSON.parse(fs.readFileSync(OA,"utf8"));
const fmt=(r)=>r.s+" "+r.ms+"ms "+r.code;
const ORIG=await getNode();
console.log("@ "+new Date().toISOString()+"  ORIG node="+ORIG+"  token.exp="+new Date(tok().expiry_date).toISOString());
console.log("=== PHASE1 节点单变量交错 3 轮 x4 (daily/sse, gemini-3-flash) ===");
const A="美国LisaLAX-rl(主力D)", B="新加坡Lisa-rl-gemini", C="美国-LA极速ccs-rl(主力)gemini";
for(let i=0;i<3;i++){
  for(const n of [A,B,C,A]){
    await setNode(n); await new Promise(x=>setTimeout(x,250));
    const r=await gen(tok().access_token,DAILY);
    console.log("  r"+i+" "+(n===A?"原节点      ":n.slice(0,14).padEnd(14))+" => "+fmt(r));
  }
}
await setNode(ORIG);
console.log("=== PHASE2 强制刷新 token 前后交错对照 ===");
const before=tok();
console.log("  BEFORE exp="+new Date(before.expiry_date).toISOString());
const CID="1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CSEC="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";
const body=new URLSearchParams({client_id:CID,client_secret:CSEC,refresh_token:before.refresh_token,grant_type:"refresh_token"}).toString();
let fresh=null,rs=-1,rtxt="";
try{
  const r=await undici.fetch("https://oauth2.googleapis.com/token",{method:"POST",dispatcher:pa,headers:{"content-type":"application/x-www-form-urlencoded",accept:"application/json"},body,signal:AbortSignal.timeout(30000)});
  rs=r.status; rtxt=await r.text();
  if(r.ok){const j=JSON.parse(rtxt);fresh={...before,access_token:j.access_token,refresh_token:j.refresh_token||before.refresh_token,expiry_date:Date.now()+Number(j.expires_in||3600)*1000,scope:j.scope||before.scope};}
}catch(e){rtxt=e.name;}
console.log("  REFRESH http="+rs+" "+(fresh?"OK newExp="+new Date(fresh.expiry_date).toISOString()+" changed="+(fresh.access_token!==before.access_token):"FAIL "+String(rtxt).replace(WS," ").slice(0,140)));
if(fresh){
  console.log("  OLD vs NEW 交错 3 轮 (daily) + cloudcode(new) 2 次:");
  for(let i=0;i<3;i++){
    const o1=await gen(before.access_token,DAILY), n1=await gen(fresh.access_token,DAILY);
    console.log("    r"+i+" OLD "+fmt(o1));
    console.log("    r"+i+" NEW "+fmt(n1));
  }
  for(let i=0;i<2;i++)console.log("    CLOUD(new) "+fmt(await gen(fresh.access_token,CLOUD)));
  try{
    const r=await undici.fetch(DAILY+"/v1internal:loadCodeAssist",{method:"POST",dispatcher:pa,headers:{"content-type":"application/json",accept:"application/json",authorization:"Bearer "+fresh.access_token,"user-agent":UA},body:JSON.stringify({metadata:{ideType:"ANTIGRAVITY"}}),signal:AbortSignal.timeout(12000)});
    console.log("  loadCodeAssist(NEW) http="+r.status+" "+(await r.text()).replace(WS," ").slice(0,190));
  }catch(e){console.log("  loadCodeAssist ERR "+e.name);}
  const check=await gen(fresh.access_token,DAILY);
  if(check.s===200){fs.writeFileSync(OA,JSON.stringify(fresh,null,2)+NL);console.log("  >>> SAVED new token (produced 200)");}
  else{console.log("  >>> KEPT old token on disk (new token did NOT fix it)");}
}
console.log("=== PHASE3 磁盘 token 连续 6 次 (daily) ===");
for(let i=0;i<6;i++){const r=await gen(tok().access_token,DAILY);console.log("  #"+i+" "+fmt(r));await new Promise(x=>setTimeout(x,400));}
console.log("  node now="+await getNode()+"  (ORIG was "+ORIG+")");
console.log("DONE");
