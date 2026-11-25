#!/usr/bin/env node
/**
 * scripts/check-index-fresh.mjs — 抓「盘上内容与 HEAD 不一致，但 git 说自己干净」。
 *
 * 真实事故（ux-v49，一次，复发一次）：patch 标记 ux-v48→ux-v49、版本号 1.0.12→1.0.13、
 * 文档里 58→60 与 61 项→60 项，都是**等长替换**。这类编辑之后 `git status` / `git diff`
 * 会报干净，提交里仍是旧值 —— 本地 npm run check 读工作树所以全绿，直到远端干净 clone
 * 复跑才炸。两次都是靠人肉 git show HEAD:<file> 才发现的。
 *
 * 为什么不能靠 stat-cache 判：git 的 stat-cache 看 ctime/mtime/size，而这里的问题正是
 * 这些元数据「看起来没变」（同秒、等长）。所以本闸**完全不看 stat-cache**：
 *   1. 取 HEAD 的完整树：path -> blob sha；
 *   2. 用 `git hash-object --stdin-paths` 重算每个跟踪文件**盘上真实内容**的 sha
 *      （这条路径不读 index，也不走 stat 快路径，编辑成什么样就哈希成什么样）；
 *   3. sha 不同 = 盘上确实与 HEAD 不同；
 *   4. 再用 `git diff --name-only HEAD` 看 git 认不认这些差异：
 *        git 认 → 正常未提交改动，只提示；
 *        git 不认（说干净）→ **漏暂存**，判失败，因为此刻任何「已提交」的结论都不可信。
 *
 * 两种模式：
 *   默认（npm run check）—— 只警告不阻断。check 校验的是代码本身，不该因为「你有等长改动
 *                          还没提交」就判失败；但它必须吼出来，因为此刻那份"全绿"不可轻信。
 *   --strict（npm run sync 走）—— 致命。推送前发现 git 说干净、盘上却不同 = 这次同步会
 *                          把旧内容发出去，必须停下来先 touch + add。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STRICT = process.argv.includes("--strict");
const run = (args, input) => execFileSync("git", args, { cwd: ROOT, maxBuffer: 1 << 26, input }).toString();

let headReady = true;
try { run(["rev-parse", "--verify", "HEAD"]); } catch { headReady = false; }
if (!headReady) {
  console.log("[index] skip: 仓库还没有提交，无可比对");
  process.exit(0);
}

const headTree = new Map();
for (const row of run(["ls-tree", "-r", "HEAD"]).trim().split("\n").filter(Boolean)) {
  const tab = row.indexOf("\t");
  const sha = row.slice(0, tab).split(" ")[2];
  headTree.set(row.slice(tab + 1), sha);
}

const paths = [...headTree.keys()].filter((p) => existsSync(join(ROOT, p)));
const actual = run(["hash-object", "--stdin-paths"], paths.join("\n") + (paths.length ? "\n" : ""))
  .trim().split("\n").filter(Boolean);
const differing = [];
paths.forEach((p, i) => { if (actual[i] !== headTree.get(p)) differing.push(p); });

if (differing.length === 0) {
  console.log("[index] ok: 盘上内容与 HEAD 逐文件一致（" + paths.length + " 个文件，按内容哈希比对）");
  process.exit(0);
}

const admitted = new Set(run(["diff", "--name-only", "HEAD"]).trim().split("\n").filter(Boolean));
const leaked = differing.filter((p) => !admitted.has(p));
const pending = differing.filter((p) => admitted.has(p));

if (leaked.length > 0) {
  const say = STRICT ? (m) => console.error(m) : (m) => console.log(m);
  say((STRICT ? "[index] FAIL" : "[index] WARN") + ": 这些文件盘上内容与 HEAD 不同，但 git 说自己干净（漏暂存/racy）：");
  for (const p of leaked) say("        " + p);
  say("        此刻「已提交」的任何结论都不可信。落提交前必须让 git 真正看见改动");
  say("        （这类等长改动下 git add 自己也会被 stat-cache 跳过，必须先 touch 刷 mtime）：");
  say("        touch " + leaked.join(" ") + " && git add " + leaked.join(" ") + " && git commit --amend --no-edit");
  if (STRICT) process.exit(1);
}
console.log("[index] ok: 无漏暂存（另有 " + pending.length + " 个文件尚未提交，属正常开发状态）");
