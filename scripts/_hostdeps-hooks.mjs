// scripts/_hostdeps-hooks.mjs —— ESM 解析钩子（由 _paths.mjs 的 installHostDeps 注册）
//
// 干什么：插件里的 lib/providers/pool/index.js 依赖宿主运行时才有的包
// （@earendil-works/pi-ai、@deepseek-ai/dsh-llm…）。这些包在本机 profile 的
// node_modules 里只是指向宿主安装目录的软链，宿主改成 asar 打包后就全断了。
// 于是「独立跑一个 verify 脚本」会直接抛 ERR_MODULE_NOT_FOUND —— 环境缺口，
// 不是插件缺陷。这个钩子只在这些包「默认解析失败」时，从宿主依赖根里再找一遍，
// 找到就用真实的文件 URL 顶上，找不到就原样抛错（绝不掩盖真正的缺失）。
//
// 只影响本进程；不动 profile、不动宿主。设 DSH_HOSTDEPS_VERBOSE=1 可看到每次兜底。

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";

function candidateRoots() {
  const roots = [];
  if (process.env.DSH_HOST_DEPS_DIR) roots.push(process.env.DSH_HOST_DEPS_DIR);
  // 其它插件的 node_modules（历史插件树里常有宿主包的完整副本）
  try {
    const plug = path.join(os.homedir(), ".dsh", "plugins");
    for (const e of fs.readdirSync(plug)) roots.push(path.join(plug, e, "node_modules"));
  } catch {}
  // 当前 profile 的 node_modules（链接完好时就是它）
  roots.push(path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules"));
  // 宿主解包留下的临时树
  roots.push(path.join(os.tmpdir(), "asar_pkgs", "node_modules"));
  return roots;
}
const ROOTS = candidateRoots();
const FOUND = new Map();

function splitName(spec) {
  const parts = spec.split("/");
  if (spec.startsWith("@")) return [parts.slice(0, 2).join("/"), parts.slice(2).join("/")];
  return [parts[0], parts.slice(1).join("/")];
}
function pickCond(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) { for (const x of v) { const r = pickCond(x); if (r) return r; } return null; }
  if (v && typeof v === "object") return pickCond(v.import ?? v.default ?? v.node ?? v.module ?? null);
  return null;
}
function entryOf(dir, sub) {
  let pj;
  try { pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch { return null; }
  const ex = pj.exports ?? null;
  if (!sub) {
    let rel = null;
    if (typeof ex === "string") rel = ex;
    else if (ex && typeof ex === "object") rel = pickCond(ex["."] ?? (ex.import || ex.default ? ex : null));
    if (!rel) rel = pj.module || pj.main || "index.js";
    const p = path.join(dir, rel);
    return fs.existsSync(p) ? p : null;
  }
  const key = "./" + sub;
  let target = null;
  let mid = "";
  if (ex && typeof ex === "object") {
    target = ex[key] ?? null;
    if (!target) {
      for (const [k, v] of Object.entries(ex)) {
        if (!k.includes("*")) continue;
        const [pre, post] = k.split("*");
        if (key.startsWith(pre) && key.endsWith(post || "")) {
          mid = key.slice(pre.length, key.length - (post || "").length);
          target = v;
          break;
        }
      }
    }
  }
  let rel = pickCond(target);
  // 通配符要在挑完条件之后再替换：条件对象的值是字面量 "./dist/api/*.js"。
  if (rel && mid) rel = rel.replace("*", mid);
  if (rel) { const p = path.join(dir, rel); if (fs.existsSync(p)) return p; }
  const direct = path.join(dir, sub);
  for (const c of [direct, direct + ".js", direct + ".mjs"]) if (fs.existsSync(c)) return c;
  return null;
}
function locate(name) {
  if (FOUND.has(name)) return FOUND.get(name);
  let dir = null;
  for (const r of ROOTS) {
    const d = path.join(r, ...name.split("/"));
    if (fs.existsSync(path.join(d, "package.json"))) { dir = d; break; }
  }
  FOUND.set(name, dir);
  return dir;
}
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) throw err;
    if (specifier.includes("://") || specifier.startsWith("data:")) throw err;
    const [name, sub] = splitName(specifier);
    const dir = locate(name);
    if (!dir) throw err;
    const hit = entryOf(dir, sub);
    if (!hit) throw err;
    if (process.env.DSH_HOSTDEPS_VERBOSE === "1") process._rawDebug("[hostdeps] " + specifier + " -> " + hit);
    return { url: pathToFileURL(hit).href, shortCircuit: true };
  }
}
