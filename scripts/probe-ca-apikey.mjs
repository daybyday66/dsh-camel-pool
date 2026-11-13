import fs from "node:fs"; import { createRequire } from "node:module"; import path from "node:path";
const ROOT=process.argv[2]; const require=createRequire(path.join(ROOT,"package.json")); const undici=require("undici");
const pa=new undici.ProxyAgent("http://127.0.0.1:7897");
const key=fs.readFileSync("C:/Users/00/.dsh/gemini-api-key","utf8").trim();
const cases=[
  ["openai-chat","https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",{model:"gemini-2.5-flash",messages:[{role:"user",content:"Reply just OK."}],max_tokens:16},{"authorization":"Bearer "+key}],
  ["native-gen","https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",{contents:[{parts:[{text:"Reply just OK."}]}],generationConfig:{maxOutputTokens:16}},{"x-goog-api-key":key}],
  ["models-list","https://generativelanguage.googleapis.com/v1beta/models?key="+key,null,{}],
];
function brief(s){try{const j=JSON.parse(s);return (j.error&&j.error.message)||(j.candidates&&"OK:"+(j.candidates[0].content.parts[0].text||"").slice(0,30))||(j.choices&&"OK:"+(j.choices[0].message.content||"").slice(0,30))||(j.models&&"MODELS:"+j.models.length)||s.slice(0,90);}catch(e){return s.replace(/\s+/g," ").slice(0,90);}}
for(const [tag,url,body,extra] of cases){const t=Date.now();try{const r=await undici.fetch(url,{method:body?"POST":"GET",dispatcher:pa,headers:{"content-type":"application/json",...extra},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});const txt=await r.text();console.log("  "+tag.padEnd(14)+" "+r.status+" "+(Date.now()-t)+"ms "+brief(txt));}catch(e){console.log("  "+tag.padEnd(14)+" ERR "+e.name+" "+e.message);}}
console.log("@ "+new Date().toISOString());
