// scripts/_paths.mjs —— 脚本自定位与宿主依赖预检
//
// 背景（ux-v15 补丁）：
//  1) 老脚本用 `process.argv[2] || process.cwd()` 当仓库根。只要不是「在仓库根下执行」，
//     ROOT 就静默指向别处，import 拼出的路径不存在 → ERR_MODULE_NOT_FOUND 一堆栈。
//     这里改成从 import.meta.url 推导，cwd 完全不参与；确需覆盖时走 argv[2] / 环境变量。
//  2) lib/providers/pool/index.js 依赖宿主运行时提供的 @earendil-works/pi-ai 等包。
//     宿主换包形式（asar）或 node_modules 链接断掉时，独立跑脚本会抛 ERR_MODULE_NOT_FOUND。
//     这类失败是环境问题，不是插件缺陷 —— 打印 SKIP 并 exit 0，别伪装成代码崩了。

import fs from "node:fs";
import path from "node:path";
import { createRequire, register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPTS_DIR, "..");

/** 仓库根：argv[2] / DSH_CAMEL_POOL_ROOT 显式指定 > 从本文件位置推导。*/
export function repoRoot(explicit) {
  const cand = explicit || process.env.DSH_CAMEL_POOL_ROOT;
  if (cand) {
    const abs = path.resolve(cand);
    if (!fs.existsSync(path.join(abs, "package.json"))) {
      throw new Error("[paths] 指定的仓库根里没有 package.json：" + abs);
    }
    return abs;
  }
  return REPO_ROOT;
}

/** 以仓库根为基准 import 相对模块，避免手写 path.join + pathToFileURL。*/
export function importFromRoot(rel, root = REPO_ROOT) {
  return import(pathToFileURL(path.join(root, rel)).href);
}

/** 宿主依赖里哪些解析不到（插件在宿主内跑时由宿主提供）。*/
export function missingHostDeps(names, root = REPO_ROOT) {
  const req = createRequire(path.join(root, "package.json"));
  const missing = [];
  for (const name of names) {
    try {
      req.resolve(name);
      continue;
    } catch {
      // ESM-only 包若 exports 不含 require 条件，require.resolve 也会失败；
      // 再用包目录兜底探测一次，避免把「能 import 但 require 不了」误判成缺失。
      const dir = path.join(root, "node_modules", ...name.split("/"));
      if (fs.existsSync(path.join(dir, "package.json"))) continue;
      missing.push(name);
    }
  }
  return missing;
}

/** 注册宿主依赖兜底解析（详见 _hostdeps-hooks.mjs）。
 *
 * 必须在 import lib/providers/pool/index.js 之前调用：
 *   import { installHostDeps } from "./_paths.mjs";
 *   installHostDeps();
 * 只影响本进程，不动 profile、不动宿主。*/
export function installHostDeps() {
  const hookUrl = pathToFileURL(path.join(SCRIPTS_DIR, "_hostdeps-hooks.mjs")).href;
  register(hookUrl);
}

/** 环境不满足时优雅跳过：退出码 0，且输出里带 SKIP 便于 CI 过滤。*/
export function skip(script, reason) {
  console.log("SKIP " + script + " —— " + reason);
  process.exit(0);
}
