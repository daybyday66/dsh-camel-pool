import fs from "node:fs"; import { createRequire } from "node:module"; import path from "node:path"; import { randomUUID } from "node:crypto";
const ROOT=process.argv[2]; const require=createRequire(path.join(ROOT,"package.json")); const undici=require("undici");
const UA="antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)";
const c=JSON.parse(fs.readFileSync("C:/Users/00/.dsh/gemini-oauth.json","utf8"));
console.log("token valid="+(c.expiry_date>Date.now())+" @ "+new Date().toISOString());
const SAFE=["HARM_CATEGORY_HARASSMENT","HARM_CATEGORY_HATE_SPEECH","HARM_CATEGORY_SEXUALLY_EXPLICIT","HARM_CATEGORY_DANGEROUS_CONTENT","HARM_CATEGORY_CIVIC_INTEGRITY"].map(category=>({category,threshold:"OFF"}));
function env(){const model="gemini-3-flash";return {project:"aicode-consumers",model,request:{model,contents:[{role:"user",parts:[{text:"Reply just OK."}]}],generationConfig:{maxOutputTokens:16,thinkingConfig:{includeThoughts:true}},safetySettings:SAFE},requestType:"agent",userAgent:"antigravity",requestId:"agent-"+randomUUID(),user_prompt_id:randomUUID(),enabled_credit_types:["GOOGLE_ONE_AI"]};}
function brief(txt){try{const j=JSON.parse(txt);return (j.error&&j.error.message)||"OK200";}catch(e){return txt.indexOf("data:")===0?"OK200-SSE":txt.replace(new RegExp(String.fromCharCode(92)+"s+","g")," ").slice(0,45);}}
async function egress(agent){try{const r=await undici.fetch("https://api.ipify.org?format=json",{dispatcher:agent,signal:AbortSignal.timeout(7000)});return (await r.json()).ip;}catch(e){return "ERR";}}
async function gen(agent){const t=Date.now();try{const r=await undici.fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",{method:"POST",dispatcher:agent,headers:{"content-type":"application/json",accept:"text/event-stream",authorization:"Bearer "+c.access_token,"user-agent":UA,connection:"close"},body:JSON.stringify(env()),signal:AbortSignal.timeout(14000)});const txt=await r.text();return r.status+" "+(Date.now()-t)+"ms "+brief(txt).slice(0,48);}catch(e){return "ERR "+e.name;}}
console.log("\n--- A) FRESH tunnel each round (new ProxyAgent + connection:close), node unchanged ---");
for(let i=0;i<8;i++){const a=new undici.ProxyAgent("http://127.0.0.1:7897");const ip=await egress(a);const g=await gen(a);console.log("  #"+i+" ip="+String(ip).padEnd(17)+" "+g);await a.close();await new Promise(x=>setTimeout(x,400));}
console.log("\n--- B) REUSED single tunnel (one ProxyAgent, keep-alive), node unchanged ---");
const one=new undici.ProxyAgent("http://127.0.0.1:7897");
for(let i=0;i<8;i++){const ip=await egress(one);const g=await gen(one);console.log("  #"+i+" ip="+String(ip).padEnd(17)+" "+g);await new Promise(x=>setTimeout(x,400));}
await one.close();
console.log("@ "+new Date().toISOString());
