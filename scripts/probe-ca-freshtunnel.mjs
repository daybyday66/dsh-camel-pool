import fs from "node:fs"; import { createRequire } from "node:module"; import path from "node:path"; import { randomUUID } from "node:crypto";
const ROOT=process.argv[2]; const require=createRequire(path.join(ROOT,"package.json")); const undici=require("undici");
const UA="antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)";
const CTRL="http://127.0.0.1:9097";
const c=JSON.parse(fs.readFileSync("C:/Users/00/.dsh/gemini-oauth.json","utf8"));
console.log("token exp="+new Date(c.expiry_date).toISOString()+" valid="+(c.expiry_date>Date.now())+" @ "+new Date().toISOString());
const SAFE=["HARM_CATEGORY_HARASSMENT","HARM_CATEGORY_HATE_SPEECH","HARM_CATEGORY_SEXUALLY_EXPLICIT","HARM_CATEGORY_DANGEROUS_CONTENT","HARM_CATEGORY_CIVIC_INTEGRITY"].map(category=>({category,threshold:"OFF"}));
function env(model){return {project:"aicode-consumers",model,request:{model,contents:[{role:"user",parts:[{text:"Reply just OK."}]}],generationConfig:{maxOutputTokens:16,thinkingConfig:{includeThoughts:true}},safetySettings:SAFE},requestType:"agent",userAgent:"antigravity",requestId:"agent-"+randomUUID(),user_prompt_id:randomUUID(),enabled_credit_types:["GOOGLE_ONE_AI"]};}
function brief(txt){try{const j=JSON.parse(txt);return (j.error&&j.error.message)||txt.slice(0,70);}catch(e){return txt.replace(new RegExp(String.fromCharCode(92)+"s+","g")," ").slice(0,70);}}
async function setNode(name){for(const g of ["GLOBAL","一元机场.VIP"]){const r=await undici.fetch(CTRL+"/proxies/"+encodeURIComponent(g),{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({name}),signal:AbortSignal.timeout(5000)});if(r.status!==204)console.log("  setNode "+g+" -> "+r.status);}}
async function egress(agent){try{const r=await undici.fetch("https://api.ipify.org?format=json",{dispatcher:agent,signal:AbortSignal.timeout(8000)});const j=await r.json();return j.ip;}catch(e){return "ERR";}}
async function gen(agent,host,model){const t=Date.now();try{const r=await undici.fetch(host+"/v1internal:streamGenerateContent?alt=sse",{method:"POST",dispatcher:agent,headers:{"content-type":"application/json",accept:"text/event-stream",authorization:"Bearer "+c.access_token,"user-agent":UA,connection:"close"},body:JSON.stringify(env(model)),signal:AbortSignal.timeout(14000)});const txt=await r.text();return r.status+" "+(Date.now()-t)+"ms "+brief(txt).slice(0,58);}catch(e){return "ERR "+e.name;}}
const nodes=["美国LisaLAX-rl(主力D)","新加坡Lisa-rl-gemini","越南河内MAX-rl(移动优选)gemini","日本Lisa-rl","荷兰Lisa-rl","DIRECT"];
for(const node of nodes){
  await setNode(node); await new Promise(x=>setTimeout(x,600));
  const agent=new undici.ProxyAgent("http://127.0.0.1:7897");
  const ip=await egress(agent);
  const d=await gen(agent,"https://daily-cloudcode-pa.googleapis.com","gemini-3-flash");
  const cl=await gen(agent,"https://cloudcode-pa.googleapis.com","gemini-3-flash");
  console.log("  "+node.padEnd(30)+" ip="+String(ip).padEnd(17)+" daily["+d+"] cloud["+cl+"]");
  await agent.close();
}
await setNode("美国LisaLAX-rl(主力D)"); console.log("RESTORED @ "+new Date().toISOString());
