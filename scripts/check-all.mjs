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
mustContain(path.join(ROOT, "lib/shared/pool.js"), "export function sampleUsageCredits", "用量积分采样契约");
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), "sampleUsageCredits(entry.routeKey)", "成功分支接线积分采样");
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
mustContain(path.join(ROOT, "lib/shared/credit-expiry-policy.js"), "export function policyCreditExpiry", "官网积分政策模块在位");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "policyCreditExpiry", "官网积分政策回退已接入池内核");
mustContain(path.join(ROOT, "lib/panel.js"), "policyCreditExpiryFields", "渠道卡片标注政策估算");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "expiringAtMs", "池内核识别当日过期时刻");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "burnExpiringFirst", "latch 让位开关");
mustContain(path.join(ROOT, "lib/providers/codearts/index.js"), "poolKindOf", "codearts 错误体归一为池词汇");
mustContain(path.join(ROOT, "lib/providers/codearts/index.js"), "iam_stale", "codearts 区分 IAM 失效");
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), "structuredFailureKind", "池侧读结构化错误体");
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), 'patch: "ux-v21"', "内核版本标记已升 ux-v21");
// ux-v19：池转发的兜底抓取必须是 directFetch，不能回落 globalThis.fetch。
// billion-context 用 defineProperty 接管全局 fetch 并把自己重链到最外层，未声明
// route.fetch 的路由（trae/trae2/qoder/workbuddy/bailian/qiniu）于是被它的
// silent-direct 闸门本地 422 掉 —— 上游一次没被打到，池却报「所有路由都失败」。
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), 'entry.route.fetch === "function" ? entry.route.fetch : directFetch', "池转发兜底走直连（不回落全局 fetch）");
mustNotContain(path.join(ROOT, "lib/providers/pool/index.js"), "? entry.route.fetch : fetch;", "池转发不再回落 globalThis.fetch");
mustContain(path.join(ROOT, "lib/providers/pool/classifier.js"), "export function localGateRefusal(status, text)", "本机拦截层（bili gate）单独可辨识");
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), 'type: "pool_gate_blocked"', "全池被闸门拦时不再误报 pool_exhausted");
// 闸门分支绝不能记熔断：进程级闸门会把十条路由一起冷却 60s，下一个请求照样全灭。
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), 'kind: "gate", gate', "闸门失败带 gate 分类但不进熔断");
// hy4 家族：同名不同 id 的模型各自被白名单点名时，不能按 name key 合并成一组。
// 合并的后果是 hy4flash 整个消失（一组只产出一个 poolId），请求直接 402 pool_exhausted。
mustContain(path.join(ROOT, "lib/shared/pool.js"), "function curatedEntryOfId(raw)", "白名单条目按 id 反查（供合并判定）");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "const nameKeyUsable =", "同名合并不许跨白名单条目");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "if (nameKeyUsable) keys.push(nameGroupKey);", "name key 按判定条件才登记");
// 目录只声明 supportedEfforts=["high"]，但上游实测接受 low/medium/high/xhigh/max。
// 不补这张表，translateEffort 会把用户选的 medium 距离匹配改写成 high。
mustContain(path.join(ROOT, "lib/providers/workbuddy/index.js"), "MEASURED_EFFORT_ACCEPTANCE", "实测 effort 接受表在位");
mustContain(path.join(ROOT, "lib/providers/workbuddy/index.js"), "const measured = measuredEfforts(info.id);", "声明前先查实测表");
// 跨模块裸调用防线：structuredFailureKind 用的 str 曾在别处才有定义，运行时才炸。
mustContain(path.join(ROOT, "lib/providers/pool/classifier.js"), "export function str(value) {", "池内核自带 str 助手（不再借用 codearts 的）");
mustContain(path.join(ROOT, "scripts/check-imports.mjs"), "findLeakedHelpers", "跨模块裸调用静态闸在位");
// 设置写入白名单必须覆盖 schema 里所有可切换键 —— 漏一个的后果是面板开关点了 400
// no-whitelisted-field，而客户端把 400 当"失败保留原值"，用户看到开关弹回去、
// 却没有任何错误提示。这类漏键只能靠静态比对。
mustContain(path.join(ROOT, "lib/panel.js"), 'safe.poolAutoBoostEffort = patch.poolAutoBoostEffort', "白名单含 poolAutoBoostEffort");
mustContain(path.join(ROOT, "lib/panel.js"), 'safe.disabledChannels = patch.disabledChannels', "白名单含 disabledChannels");
mustContain(path.join(ROOT, "lib/panel.js"), 'safe.disabledModels = patch.disabledModels', "白名单含 disabledModels");
mustContain(path.join(ROOT, "lib/panel.js"), "poolBurnExpiringFirst", "面板暴露当日优先开关");
// 漏导入防线：codearts 适配层必须真的导入 isIamTokenError（曾漏过，运行时才炸）。
mustContain(path.join(ROOT, "lib/providers/codearts/index.js"), "  isIamTokenError,", "codearts 导入 isIamTokenError 判定式");
if (!fs.existsSync(path.join(ROOT, "scripts/check-imports.mjs"))) {
  failed++;
  console.error("CONTRACT FAIL: 缺少 scripts/check-imports.mjs —— 漏导入无静态防线");
} else {
  console.log("[contract] ok: 漏导入静态检查在位 (scripts/check-imports.mjs)");
}

// CHANGELOG 必须存在且覆盖当前内核版本。
const changelogPath = path.join(ROOT, "CHANGELOG.md");
if (!fs.existsSync(changelogPath)) {
  failed++;
  console.error("CONTRACT FAIL: 缺少 CHANGELOG.md —— 内核版本无处可查");
} else {
  const log = fs.readFileSync(changelogPath, "utf8");
  if (!log.includes("ux-v19")) {
    failed++;
    console.error("CONTRACT FAIL: CHANGELOG.md 未记录 ux-v19");
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
