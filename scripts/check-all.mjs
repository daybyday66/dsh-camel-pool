#!/usr/bin/env node
// check-all.mjs —— 驼峰积分池静态契约检查（T0 工程基座）
// 用法: node scripts/check-all.mjs [ROOT]（默认 process.cwd()）
// 检查: 1) lib 全部 .js 通过 node --check  2) 关键契约串仍在源码中
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.argv[2] || process.cwd();
const LIB = path.join(ROOT, "lib");
let failed = 0;

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.name.endsWith(".js")) out.push(p);
  }
  return out;
}

// ── 1. 语法检查 ──────────────────────────────────────────────
const files = walk(LIB);
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) {
    failed++;
    console.error("SYNTAX FAIL:", path.relative(ROOT, f));
    if (r.stderr) console.error(r.stderr.split("\n").slice(0, 4).join("\n"));
  }
}
console.log(`[syntax] ${files.length - failed}/${files.length} ok`);

// ── 2. 契约断言 ──────────────────────────────────────────────
function mustContain(file, needle, label) {
  const rel = path.relative(ROOT, file).replaceAll("\\", "/");
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(needle)) {
    failed++;
    console.error(`CONTRACT FAIL: ${label} —— ${rel} 缺少 ${JSON.stringify(needle)}`);
  } else {
    console.log(`[contract] ok: ${label} (${rel})`);
  }
}

mustContain(path.join(ROOT, "lib/providers/pool/index.js"), 'POOL_STATUS_PATH = "/plugins/dsh-pool/status"', "对外状态路径");
mustContain(path.join(ROOT, "lib/panel.js"), '"dsh-camel-pool"', "settings 命名空间");
mustContain(path.join(ROOT, "lib/shared/pool.js"), 'export function registerPoolRoute', "池路由注册契约");
mustContain(path.join(ROOT, "lib/shared/pool.js"), 'export function orderedRoutesFor', "排序内核契约");
mustContain(path.join(ROOT, "lib/shared/pool.js"), 'export async function refreshPoolCredits', "积分刷新契约");
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), 'BOOT_PLACEHOLDER', "池启动占位模型锚点");
mustContain(path.join(ROOT, "lib/panel.js"), 'autoCheckin', "白名单键 autoCheckin");
mustContain(path.join(ROOT, "lib/panel.js"), 'poolVoucherFirst', "白名单键 poolVoucherFirst");
mustContain(path.join(ROOT, "lib/panel.js"), 'poolBurnExpiringFirst', "白名单键 poolBurnExpiringFirst");
mustContain(path.join(ROOT, "lib/shared/pool.js"), 'expiring', "expiring 信号入池内核");

// ── 3. 负向断言（P2-3 白名单唯一真相源 / 隐藏钩子接线）─────────────
function mustNotContain(file, needle, label) {
  const rel = path.relative(ROOT, file).replaceAll("\\", "/");
  const text = fs.readFileSync(file, "utf8");
  const hit = text.split("\n").findIndex((line) => line.includes(needle));
  if (hit !== -1) {
    failed++;
    console.error(`CONTRACT FAIL: ${label} —— ${rel}:${hit + 1} 仍含 ${JSON.stringify(needle)}`);
  } else {
    console.log(`[contract] ok: ${label} (${rel})`);
  }
}

mustNotContain(path.join(ROOT, "lib/providers/gemini/index.js"), "libraryBypass: true", "gemini 不再绕过白名单");
mustNotContain(path.join(ROOT, "lib/shared/pool.js"), "hasLibraryBypassRoute", "白名单无绕过分支");
mustContain(path.join(ROOT, "lib/providers/gemini/index.js"), "setExternalHidden", "gemini 隐藏钩子已接线");
mustContain(path.join(ROOT, "lib/providers/gemini/index.js"), "externalHidden(GEMINI_ROUTE_KEY)", "gemini hidden 读面板规则");
mustContain(path.join(ROOT, "lib/index.js"), '["gemini", gemini]', "gemini 进 HOOKED_PROVIDERS");

// ── 4. ux-v14 断言（当日额度优先 / 结构化错误分类 / 版本可查）─────────
mustContain(path.join(ROOT, "lib/shared/pool.js"), "expiringAtMs", "池内核识别当日过期时刻");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "burnExpiringFirst", "latch 让位开关");
mustContain(path.join(ROOT, "lib/providers/codearts/index.js"), "poolKindOf", "codearts 错误体归一为池词汇");
mustContain(path.join(ROOT, "lib/providers/codearts/index.js"), "iam_stale", "codearts 区分 IAM 失效");
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), "structuredFailureKind", "池侧读结构化错误体");
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), 'patch: "ux-v14"', "内核版本标记已升 ux-v14");
mustContain(path.join(ROOT, "lib/panel.js"), "poolBurnExpiringFirst", "面板暴露当日优先开关");

// CHANGELOG 必须存在且覆盖当前内核版本。
const changelogPath = path.join(ROOT, "CHANGELOG.md");
if (!fs.existsSync(changelogPath)) {
  failed++;
  console.error("CONTRACT FAIL: 缺少 CHANGELOG.md —— 内核版本无处可查");
} else {
  const log = fs.readFileSync(changelogPath, "utf8");
  if (!log.includes("ux-v14")) {
    failed++;
    console.error("CONTRACT FAIL: CHANGELOG.md 未记录 ux-v14");
  } else {
    console.log("[contract] ok: CHANGELOG 覆盖当前内核版本 (CHANGELOG.md)");
  }
}

// ── 5. ux-v14 断言（表驱动 id 校验 / 真窗口预检 / 结构化 invalid）─────────
// 这三条都是「同一个事实写在两处就会漂移」的收敛点：id 形状只在 CHANNEL_KINDS、
// 上下文窗口只在模型目录、错误分类只在适配层 —— 断言负向失守即为回归。
mustContain(path.join(ROOT, "lib/channel-registry.js"), "export function channelIdMatches", "id 形状单一事实源");
// （原 mustNotContain '/^workbuddy[1-9]' 已移到下方 mustCount：表里保留唯一一份才叫表驱动）
mustNotContain(path.join(ROOT, "lib/panel.js"), '/^workbuddy[1-9]', "面板不再内联 workbuddy 正则");
mustNotContain(path.join(ROOT, "lib/panel.js"), 'id !== kind', "面板不再内联单例判断");
mustContain(path.join(ROOT, "lib/panel.js"), "channelIdMatches(kind, id)", "面板走共享 id 校验");
mustContain(path.join(ROOT, "lib/providers/codearts/index.js"), "contextWindowFor", "codearts 用目录窗口做预检");
mustNotContain(path.join(ROOT, "lib/providers/codearts/index.js"), "prepareChatBody(body, 0)", "codearts 不再把窗口写成 0");
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), 'declared === "invalid"', "池侧认适配层声明的 invalid");

// 表驱动的意思不是「正则消失」，而是「同一个正则只出现一次」。
// 写成 mustNotContain 会把 CHANNEL_KINDS 里的那一份也算成回归 —— 断言本身先错。
function mustCount(file, needle, expected, label) {
  const rel = path.relative(ROOT, file).replaceAll("\\", "/");
  const text = fs.readFileSync(file, "utf8");
  const count = text.split(needle).length - 1;
  if (count !== expected) {
    failed++;
    console.error(`CONTRACT FAIL: ${label} —— ${rel} 命中 ${count} 次，应为 ${expected} 次：${JSON.stringify(needle)}`);
  } else {
    console.log(`[contract] ok: ${label} (${rel})`);
  }
}

mustCount(path.join(ROOT, "lib/channel-registry.js"), "idPattern: /^workbuddy[1-9]", 1, "workbuddy 正则只以 idPattern 形式出现一次");
mustCount(path.join(ROOT, "lib/channel-registry.js"), "export function channelIdMatches", 1, "channelIdMatches 定义唯一");
mustContain(path.join(ROOT, "lib/channel-registry.js"), "if (!channelIdMatches(kind, id)) return undefined;", "注册表读取走共享校验");

if (failed > 0) {
  console.error(`\ncheck-all: ${failed} 项失败`);
  process.exit(1);
}
console.log("\ncheck-all: 全部通过");
