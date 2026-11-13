import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const ROOT=process.argv[2], OA="C:/Users/00/.dsh/gemini-oauth.json", NL=String.fromCharCode(10);
const WS=new RegExp(String.fromCharCode(92)+"s+","g");
const require=createRequire(path.join(ROOT,"package.json"));
const undici=require("undici");
const pa=new undici.ProxyAgent("http://127.0.0.1:7897");
const UA="antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)";
const DAILY="https://daily-cloudcode-pa.googleapis.com", CLOUD="https://cloudcode-pa.googleapis.com";
const SAFE=["HARM_CATEGORY_HARASSMENT","HARM_CATEGORY_HATE_SPEECH","HARM_CATEGORY_SEXUALLY_EXPLICIT","HARM_CATEGORY_DANGEROUS_CONTENT","HARM_CATEGORY_CIVIC_INTEGRITY"].map(category=>({category,threshold:"OFF"}));
function env(model){return {project:"aicode-consumers",model,request:{model,contents:[{role:"user",parts:[{text:"Reply just OK."}]}],generationConfig:{maxOutputTokens:16,thinkingConfig:{includeThoughts:true}},safetySettings:SAFE},requestType:"agent",userAgent:"antigravity",requestId:"agent-"+randomUUID(),user_prompt_id:randomUUID(),enabled_credit_types:["GOOGLE_ONE_AI"]};}
function brief(txt){try{const j=JSON.parse(txt);if(j&&j.error&&j.error.message)return j.error.message;if(j&&j.error&&j.error.status)return j.error.status;}catch(e){}return String(txt).replace(WS," ").slice(0,50);}
async function gen(token,host,model){const t=Date.now();try{const r=await undici.fetch(host+"/v1internal:streamGenerateContent?alt=sse",{method:"POST",dispatcher:pa,headers:{"content-type":"application/json",accept:"text/event-stream",authorization:"Bearer "+token,"user-agent":UA},body:JSON.stringify(env(model)),signal:AbortSignal.timeout(14000)});const txt=await r.text();return {s:r.status,ms:Date.now()-t,code:(r.status===200?"OK":brief(txt)).slice(0,46)};}catch(e){return {s:-1,ms:Date.now()-t,code:e.name};}}
async function setNode(g,node){try{const r=await undici.request("http://127.0.0.1:9097/proxies/"+encodeURIComponent(g),{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({name:node}),signal:AbortSignal.timeout(6000)});await r.body.dump();return r.statusCode;}catch(e){return -1;}}
async function getNode(g){try{const r=await undici.fetch("http://127.0.0.1:9097/proxies/"+encodeURIComponent(g),{signal:AbortSignal.timeout(6000)});return (await r.json()).now;}catch(e){return "ERR";}}
const fmt=r=>r.s+" "+r.ms+"ms "+r.code;
const G="一元机场.VIP", GG="GLOBAL";
const origG=await getNode(G), origGG=await getNode(GG);
console.log("@ "+new Date().toISOString()+"  orig "+G+"="+origG+"  "+GG+"="+origGG);
// 1) force refresh to get a VALID token (disk token expired)
const before=JSON.parse(fs.readFileSync(OA,"utf8"));
console.log("disk token exp="+new Date(before.expiry_date).toISOString()+" expired="+(before.expiry_date<=Date.now()));
const CID="1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com", CSEC="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";
const rbody=new URLSearchParams({client_id:CID,client_secret:CSEC,refresh_token:before.refresh_token,grant_type:"refresh_token"}).toString();
let fresh=null;
const rr=await undici.fetch("https://oauth2.googleapis.com/token",{method:"POST",dispatcher:pa,headers:{"content-type":"application/x-www-form-urlencoded",accept:"application/json"},body:rbody,signal:AbortSignal.timeout(30000)});
const rt=await rr.text();
if(rr.ok){const j=JSON.parse(rt);fresh={...before,access_token:j.access_token,refresh_token:j.refresh_token||before.refresh_token,expiry_date:Date.now()+Number(j.expires_in||3600)*1000,scope:j.scope||before.scope};}
console.log("REFRESH http="+rr.status+" "+(fresh?"OK exp="+new Date(fresh.expiry_date).toISOString():"FAIL "+brief(rt)));
if(!fresh){console.log("ABORT: no valid token");process.exit(0);}
const TK=fresh.access_token;
console.log("sanity daily/gemini-3-flash with NEW token => "+fmt(await gen(TK,DAILY,"gemini-3-flash")));
// 2) node x endpoint scan with VALID token
const NODES=[
  "美国LisaLAX-rl(主力D)","美国LisaSFO-rl(主力B)","新加坡Lisa-hy2hop-gemini","新加坡Lisa-rl-gemini",
  "美国-DAL大带宽-rl(主力)gemini","美国-LA大带宽-rl(禁联通)gemini","美国-LA极速ccs-rl(主力)gemini",
  "美国-美西极速-rl(主力)gemini","美国极速05-hy2hop-gemini","美国极速05-rl-gemini","越南河内MAX-rl(移动优选)gemini"
];
console.log("=== NODE x ENDPOINT scan (VALID token, model=gemini-3-flash) ===");
let wins=[];
for(const n of NODES){
  const a=await setNode(G,n), b=await setNode(GG,n);
  await new Promise(x=>setTimeout(x,450));
  const d=await gen(TK,DAILY,"gemini-3-flash");
  const c=await gen(TK,CLOUD,"gemini-3-flash");
  const line="  "+n.slice(0,22).padEnd(23)+" set="+a+"/"+b+"  daily="+fmt(d)+"  cloud="+fmt(c);
  console.log(line);
  if(d.s===200)wins.push([n,"daily"]); if(c.s===200)wins.push([n,"cloud"]);
}
console.log("WINS="+wins.length+" "+JSON.stringify(wins));
// 3) if any 200, hammer that combo 5x for stability
if(wins.length){
  const [wn,wh]=wins[0]; await setNode(G,wn); await setNode(GG,wn); await new Promise(x=>setTimeout(x,500));
  console.log("=== STABILITY x5 on "+wn+" / "+wh+" ===");
  for(let i=0;i<5;i++)console.log("  #"+i+" "+fmt(await gen(TK,wh==="daily"?DAILY:CLOUD,"gemini-3-flash")));
  // pro models too
  console.log("=== MODEL sweep on winning node ===");
  for(const m of ["gemini-3.1-pro-high","gemini-2.5-flash","gemini-3-pro-preview"])console.log("  "+m.padEnd(22)+" "+fmt(await gen(TK,wh==="daily"?DAILY:CLOUD,m)));
}
// 4) RESTORE + write valid token to disk (old is expired, strictly better); keep backup already made
await setNode(G,origG); await setNode(GG,origGG);
fs.writeFileSync(OA,JSON.stringify(fresh,null,2)+NL);
console.log("RESTORED nodes; WROTE valid refreshed token to disk (exp="+new Date(fresh.expiry_date).toISOString()+")");
console.log("DONE @ "+new Date().toISOString());
