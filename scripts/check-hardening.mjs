#!/usr/bin/env node
/**
 * 加固回归自检（check-hardening）。
 *
 * 覆盖三件以前没人拦的事：
 *   1. fetch 兜底重复安装必须空操作 —— 标记存的是 tag 字符串，守卫曾经只比 === true，
 *      于是每次 install 都把已包装的 fetch 再包一层，网络错误时触发嵌套直连重试。
 *   2. lib/client.js 的 classic-script / module-loader 契约 —— node --check 对 ESM 同样放行，
 *      一旦出现顶层 import/export，宿主 combo bundle 会整批抛 SyntaxError 且报错指向无辜插件。
 *   3. 本轮修复的落盘 / 并发 / 路由锚点，防止回退。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installFetchRescue, fetchRescueInfo } from "../lib/shared/net-rescue.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function ok(label, condition, detail) {
  if (condition) {
    console.log("[hardening] ok: " + label);
    return;
  }
  failed += 1;
  console.error("[hardening] FAIL: " + label + (detail === undefined ? "" : " :: " + JSON.stringify(detail)));
}

function mustContain(rel, needle, label) {
  ok(label + " (" + rel + ")", readFileSync(join(ROOT, rel), "utf8").includes(needle), needle);
}

// ① fetch 兜底幂等
{
  const SYM = Symbol.for("dsh-camel-pool.fetch-rescue");
  const savedFetch = globalThis.fetch;
  const had = Object.prototype.hasOwnProperty.call(globalThis, SYM);
  const savedTag = globalThis[SYM];
  delete globalThis[SYM];
  globalThis.fetch = async function baseFetch() { return "base"; };
  const first = installFetchRescue({ tag: "selftest" });
  const wrapped = globalThis.fetch;
  const second = installFetchRescue({ tag: "selftest-again" });
  const info = fetchRescueInfo();
  const value = await wrapped("https://example.invalid/");
  ok("fetch rescue 首次安装", first.installed === true && first.reason === "ok", first);
  ok("fetch rescue 重复安装是空操作", second.installed === false && second.reason === "already" && globalThis.fetch === wrapped, second);
  ok("fetch rescue 诊断保留字符串 tag", info.installed === true && info.tag === "selftest", info);
  ok("fetch rescue 首次安装不改写成功路径", value === "base", value);
  globalThis.fetch = savedFetch;
  if (had) globalThis[SYM] = savedTag;
  else delete globalThis[SYM];
}

// ② client.js classic-script / module-loader 契约
{
  const rel = "lib/client.js";
  const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
  const offenders = [];
  lines.forEach((line, i) => {
    if (/^\s*(?:import|export)\b/u.test(line)) offenders.push((i + 1) + ": " + line.trim().slice(0, 80));
  });
  ok("client.js 无顶层 import/export", offenders.length === 0, offenders.slice(0, 5));
  for (const needle of ["window.__ModuleLoader__.load({", "id: \"dsh-camel-pool\"", "factory: (require) => {", "var module = { exports: {} };", "var exports = module.exports;"]) {
    mustContain(rel, needle, "module-loader 契约");
  }
  mustContain(rel, "let inFlight = false;", "useUsage 请求去重");
  mustContain(rel, "document.addEventListener('visibilitychange', onVis);", "useUsage 可见性恢复刷新");
  mustContain(rel, "document.removeEventListener('visibilitychange', onVis);", "useUsage 可见性监听清理");
  mustContain(rel, "let forcePending = false;", "强制刷新排队");
  mustContain(rel, "!Array.isArray(v)", "状态文档形状校验");
}

// ③ 落盘 / 并发 / 路由锚点
mustContain("lib/shared/net-rescue.js", "typeof existing === \"string\" || existing === true", "fetch 兜底幂等兼容字符串/旧布尔");
mustContain("lib/shared/usage.js", "function scheduleFlushRetry(fails)", "账本落盘失败重试");
mustContain("lib/shared/usage.js", "function stampMs(at)", "无时区时间戳按 Asia/Shanghai 解释");
mustContain("lib/shared/usage.js", "suspect: true", "异常积分跳变保留基线");
mustContain("lib/shared/pool.js", "const creditRefreshInFlight = new Map();", "余额刷新 in-flight 合并");
mustContain("lib/shared/pool.js", "creditSampleAt.delete(key);", "注销清理采样时间戳");
mustContain("lib/shared/node.js", "renameSync(tmp, path);", "状态文件原子写");
mustContain("lib/channel-registry.js", "${process.pid}", "注册表临时文件唯一化");
mustContain("lib/panel.js", "path: HUB_CHECKIN_ROUTE + \"/\"", "签到前缀路由与 exact 错开");
mustContain("lib/panel.js", "if (id === \"\") {", "裸签到路径回退一键签到");
mustContain("lib/providers/pool/classifier.js", "export function firstJsonObject(text)", "结构化错误体宽松解析");
mustContain("lib/providers/pool/index.js", "cancelled.catch(() => {});", "probe 超时取消不产生未处理 rejection");
mustContain("lib/providers/pool/index.js", "kind });", "失败路由带分类");
mustContain("lib/providers/pool/index.js", "const routeFetch = typeof entry.route.fetch === \"function\" ? entry.route.fetch : directFetch;", "池转发兜底直连（billion-context 接管全局 fetch 后不再被本地 422）");
mustContain("lib/providers/pool/classifier.js", "export function localGateRefusal(status, text)", "本机拦截层（bili gate）单独可辨识");

if (failed > 0) {
  console.error("[hardening] FAILED " + failed + " assertion(s)");
  process.exitCode = 1;
} else {
  console.log("[hardening] ALL_HARDENING_ASSERTIONS_PASSED");
}
