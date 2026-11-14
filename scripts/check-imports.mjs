#!/usr/bin/env node
// check-imports.mjs —— 「引用了但没导入」静态检查（同类 bug 的通用防线）
//
// 为什么需要它：lib/providers/codearts/index.js 曾调用 isIamTokenError()，但
// engine.js 的导入表里没有它 —— node --check 只查语法，ReferenceError 要等
// 真正走到那个分支（上游回错误帧）才炸；而它一炸就被 forwardChat 兜成
// kind="transport"，真实分类（iam_stale）被掩盖 60 秒。跑一百次正常流量都不会
// 触发，所以必须静态查。
//
// 判定规则：engine.js 重导出的每一个可读名，在 lib/ 其它文件的**代码区**出现
// 裸引用（前面不是 . 也不是标识符字符）时，必须来自 import 或本文件声明。
// 注释与字符串先剥掉 —— 否则「与 vendor chatStream 同语义」这种说明文字会被
// 当成漏导入（第一版就是这么误报的）。
//
// 用法: node scripts/check-imports.mjs [ROOT]        退出码 1 = 有漏导入
//       node scripts/check-imports.mjs --selftest   内存里删掉那行 import 再找回来
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 把注释与字符串字面量替换成空格（保留 \${...} 里的代码），换行位置不变。 */
export function stripNonCode(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  const stack = []; // 模板字符串嵌套：记录每层 \${ 的花括号深度
  let braceDepth = 0;
  const push = (ch) => { out += ch; };
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // 行注释
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") { push(" "); i++; }
      continue;
    }
    // 块注释
    if (c === "/" && c2 === "*") {
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { push(src[i] === "\n" ? "\n" : " "); i++; }
      push("  "); i += 2;
      continue;
    }
    // 字符串
    if (c === "'" || c === '"') {
      const quote = c;
      push(" "); i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < n) { push(" "); i++; }
        push(src[i] === "\n" ? "\n" : " "); i++;
      }
      push(" "); i++;
      continue;
    }
    // 模板字符串
    if (c === "`") {
      push(" "); i++;
      while (i < n) {
        if (src[i] === "\\") { push("  "); i += 2; continue; }
        if (src[i] === "`") { push(" "); i++; break; }
        if (src[i] === "$" && src[i + 1] === "{") {
          // 进入插值：原样保留里面的代码，直到配对花括号
          push("  "); i += 2;
          braceDepth = 0;
          while (i < n) {
            if (src[i] === "{") braceDepth++;
            if (src[i] === "}") {
              if (braceDepth === 0) { push(" "); i++; break; }
              braceDepth--;
            }
            push(src[i]); i++;
          }
          continue;
        }
        push(src[i] === "\n" ? "\n" : " "); i++;
      }
      continue;
    }
    push(c); i++;
  }
  return out;
}

/** engine.js 里 `x: readableName` 形式的重导出名。 */
export function engineExportNames(root) {
  const enginePath = path.join(root, "lib/providers/codearts/engine.js");
  const names = new Set();
  for (const m of fs.readFileSync(enginePath, "utf8").matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*,/gm)) names.add(m[2]);
  return names;
}

function walkJs(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "vendor") continue; // vendor 是上游构建产物，逐字节不动
      out.push(...walkJs(p));
    } else if (ent.name.endsWith(".js")) out.push(p);
  }
  return out;
}

/** 从已去注释的源码里摘出 import 名与本地声明名。 */
export function declaredNames(code) {
  const imported = new Set();
  for (const m of code.matchAll(/import\s*\{([\s\S]*?)\}\s*from/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      imported.add(t.split(/\s+as\s+/).pop().trim());
    }
  }
  for (const m of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) imported.add(m[1]);
  const local = new Set();
  for (const m of code.matchAll(/\b(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
  for (const m of code.matchAll(/\{([^{}]*)\}\s*=/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) local.add(t); // const { a, b } = ...
    }
  }
  for (const m of code.matchAll(/^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) local.add(m[1]);
  return { imported, local };
}

/**
 * 数「裸调用」次数：name(...) 且前面不是点、也不是声明关键字。
 *
 * 为什么不是简单地数裸标识符出现次数：第一版就那么写，结果 7 处误报全来自
 * 同名字段/形参 —— { refresh_token: refreshToken }、async chatStream(...) { }、
 * client.refreshToken(credential)。它们都是**同名符号**，不是漏导入。
 * 漏导入的语义永远是「把一个不存在的函数当函数调」，所以只认调用位置。
 */
export function countBareCalls(code, name) {
  let count = 0;
  const re = new RegExp("(?<![.\\w$])" + name + "(?![\\w$])", "g");
  let m;
  while ((m = re.exec(code)) !== null) {
    const start = m.index;
    const before = code.slice(Math.max(0, start - 16), start);
    // 定义位置：function x / async x / get x / set x / static x / class x / *x
    if (/\b(?:async|function|get|set|static|class)\s*$/.test(before)) continue;
    if (code[start - 1] === "*") continue;
    let j = start + name.length;
    while (j < code.length && /\s/.test(code[j])) j++;
    if (code[j] !== "(") continue; // 不是调用（属性名 / 形参 / 简写属性）
    let depth = 0;
    let k = j;
    for (; k < code.length; k++) {
      if (code[k] === "(") depth++;
      else if (code[k] === ")") { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) continue;
    let t = k + 1;
    while (t < code.length && /\s/.test(code[t])) t++;
    if (code[t] === "{") continue; // 方法定义 name(...) { —— 声明不是调用
    count++;
  }
  return count;
}

/** 返回 [{file, name, count}]。srcOverride 仅供自测注入破例。 */
export function findMissingImports(root, srcOverride) {
  const names = engineExportNames(root);
  const problems = [];
  for (const file of walkJs(path.join(root, "lib"))) {
    if (file.endsWith("engine.js")) continue;
    const raw = srcOverride && srcOverride[file] !== undefined ? srcOverride[file] : fs.readFileSync(file, "utf8");
    const code = stripNonCode(raw);
    const { imported, local } = declaredNames(code);
    for (const name of names) {
      if (imported.has(name) || local.has(name)) continue;
      const count = countBareCalls(code, name);
      if (count > 0) problems.push({ file: path.relative(root, file).replaceAll("\\", "/"), name, count });
    }
  }
  return problems;
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const root = process.argv.slice(2).find((a) => !a.startsWith("--")) || process.cwd();

  if (process.argv.includes("--selftest")) {
    // 自测：把已修好的那次真实事故在内存里复现，扫描器必须重新抓到。
    const victim = path.join(root, "lib/providers/codearts/index.js");
    const original = fs.readFileSync(victim, "utf8");
    const broken = original.replace(/\n\s*isIamTokenError,\n/, "\n");
    if (broken === original) {
      console.error("[selftest] 构造不出破例（导入行不在预期位置）—— 自测失效");
      process.exit(1);
    }
    const hits = findMissingImports(root, { [victim]: broken });
    if (!hits.some((h) => h.name === "isIamTokenError" && h.file.endsWith("providers/codearts/index.js"))) {
      console.error("[selftest] 扫描器漏报了内存构造的破例");
      process.exit(1);
    }
    const clean = findMissingImports(root);
    if (clean.length > 0) {
      console.error("[selftest] 干净树上出现误报：" + JSON.stringify(clean));
      process.exit(1);
    }
    console.log("[selftest] ok：删掉 import 能抓到，干净树零误报");
    process.exit(0);
  }

  const problems = findMissingImports(root);
  if (problems.length > 0) {
    for (const p of problems) {
      console.error("IMPORT FAIL: " + p.file + " 引用了 " + p.name + "（" + p.count + " 次）但没有 import/声明 —— 运行时 ReferenceError");
    }
    console.error("\ncheck-imports: " + problems.length + " 处漏导入");
    process.exit(1);
  }
  const total = engineExportNames(root).size;
  console.log("[imports] engine.js 的 " + total + " 个导出名，全部先导入后使用");
}
