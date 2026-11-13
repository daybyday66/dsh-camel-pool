
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const ROOT=process.argv[2];
const require=createRequire(path.join(ROOT,"package.json"));
const undici=require("undici");
const key=fs.readFileSync("C:/Users/00/.dsh/gemini-api-key","utf8").trim();
const pa=new undici.ProxyAgent("http://127.0.0.1:7897");
const r=await undici.fetch("https://generativelanguage.googleapis.com/v1beta/openai/models",{dispatcher:pa,headers:{authorization:"Bearer "+key,"x-goog-api-key":key},signal:AbortSignal.timeout(20000)});
const j=await r.json();
const ids=(j.data||[]).map(m=>m.id);
console.log("count",ids.length);
console.log(ids.join("\n"));
