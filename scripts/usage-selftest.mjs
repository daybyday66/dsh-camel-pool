/**
 * 用量账本离线自测：在临时 DSH_HOME 里跑，不碰真实账本。
 *   node scripts/usage-selftest.mjs
 * 覆盖：字段别名归一化、路径日志/CodeArts 历史补导入、重复导入去重、
 *       SSE 分块 usage 探针零修改透传、余额下降估算积分（扣除上游直报）、
 *       日/周/月/总四窗口与平台拆分、落盘后"重启"不重复计数。
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const usageModule = pathToFileURL(join(root, "lib", "shared", "usage.js")).href;
const home = mkdtempSync(join(tmpdir(), "dsh-usage-selftest-"));
process.env.DSH_HOME = home;

const dayOf = (iso) => new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 10);
const now = new Date().toISOString();
const today = dayOf(now);
const yesterday = "2026-11-13";

/* 历史路径日志：3 条可计数 + 1 条 attempt（应被忽略）+ 1 条 codearts（当天应被专用账本覆盖） */
const history = [
  { at: "2026-11-13T02:00:00.000Z", ev: "served", route: "workbuddy:wb1", model: "m-a" },
  { at: "2026-11-13T02:01:00.000Z", ev: "route-fail", route: "workbuddy:wb1", status: 401 },
  { at: "2026-11-13T02:02:00.000Z", ev: "served", route: "trae", model: "m-b" },
  { at: "2026-11-13T02:03:00.000Z", ev: "attempt", route: "trae", model: "m-b" },
  { at: "2026-11-13T02:04:00.000Z", ev: "served", route: "codearts", model: "glm-5.3-flash" },
].map((x) => JSON.stringify(x)).join("\n") + "\n";
writeFileSync(join(home, ".pool-route.log"), history, "utf8");

writeFileSync(join(home, ".codearts-usage.json"), JSON.stringify({
  version: 1,
  days: {
    [yesterday]: {
      models: {
        "glm-5.3-flash": { requests: 10, promptTokens: 1000, completionTokens: 200, totalTokens: 1200, cachedTokens: 300, reasoningTokens: 0 },
      },
      failures: { upstream: 2 },
    },
  },
}), "utf8");

const ok = [];
const check = (name, fn) => { fn(); ok.push(name); };

const m = await import(usageModule);

/* 1. usage 字段别名 */
check("normalizeUsage 别名", () => {
  const u = m.normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } });
  assert.deepEqual(u, { input: 10, output: 5, total: 15, cacheRead: 3, cacheWrite: 0, reasoning: 0, credits: 0 });
  assert.equal(m.normalizeUsage({}), undefined);
  assert.equal(m.normalizeUsage({ credits: 4 }).credits, 4);
});

/* 2. 渠道真名登记 */
check("registerPlatformMeta", () => {
  m.registerPlatformMeta({ key: "workbuddy:wb1", displayName: "WorkBuddy 主号", kind: "workbuddy", providerId: "wb1", channelId: "wb1" });
});

/* 3. 首次聚合：历史补导入 */
let first;
check("历史补导入与四窗口", () => {
  first = m.usageDocument();
  assert.equal(first.ok, true);
  assert.equal(first.timezone, "Asia/Shanghai (UTC+8)");
  assert.deepEqual(Object.keys(first.windows), ["day", "week", "month", "all"]);
  assert.equal(first.windows.day.key, "day");
  assert.equal(first.windows.week.from, first.weekStart);
  assert.equal(first.trend.length, 14);
  const all = first.windows.all;
  assert.equal(all.requests, 15, "3 条路径日志 + 10 个 codearts 请求 + 2 个 codearts 失败");
  assert.equal(all.served, 12);
  assert.equal(all.failed, 3);
  assert.equal(all.tokens.input, 1000);
  assert.equal(all.tokens.output, 200);
  assert.equal(all.tokens.total, 1200);
  assert.equal(all.tokens.cacheRead, 300);
  const byKey = Object.fromEntries(all.platforms.map((p) => [p.key, p]));
  assert.equal(byKey.codearts.displayName, "CodeArts / 华为云");
  assert.equal(byKey.codearts.requests, 12, "codearts 以专用账本为准，路径日志那条 served 被跳过");
  assert.equal(byKey["workbuddy:wb1"].displayName, "WorkBuddy 主号");
  assert.equal(byKey["workbuddy:wb1"].requests, 2);
  assert.equal(byKey.trae.requests, 1, "attempt 事件不计入请求数");
  assert.equal(Number(all.platforms.reduce((s, p) => s + p.share, 0).toFixed(2)), 1, "占比合计为 1");
  assert.equal(first.ledger.path, join(home, ".dsh-pool-usage.json"));
});

/* 4. 重复调用不重复计数 */
check("重复调用 usageDocument 去重", () => {
  const again = m.usageDocument();
  assert.equal(again.windows.all.requests, first.windows.all.requests);
  assert.equal(again.windows.all.tokens.input, first.windows.all.tokens.input);
});

/* 5. 实时路由事件 */
check("recordUsageEvent 实时记账", () => {
  m.recordUsageEvent({ ev: "served", at: now, route: "workbuddy:wb1", model: "m-a" });
  m.recordUsageEvent({ ev: "transport", at: new Date(Date.now() + 1).toISOString(), route: "qoder:q1" });
  const d = m.usageDocument();
  assert.equal(d.windows.all.requests, 17);
  assert.equal(d.windows.day.requests, 2);
  const byKey = Object.fromEntries(d.windows.all.platforms.map((p) => [p.key, p]));
  assert.equal(byKey["qoder:q1"].failed, 1);
});

/* 6. SSE 分块 usage 探针：零修改透传 + 取 max 不翻倍 */
let tapped;
const sse = [
  'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":', 
  '10,"completion_tokens":5,"total_tokens":15,"credits":1}}\n\n',
].join("");
tapped = await new Promise((resolve, reject) => {
  let seen;
  const tap = m.createUsageTap((u) => { seen = u; });
  const chunks = [];
  tap.on("data", (c) => chunks.push(c.toString("utf8")));
  tap.on("end", () => resolve({ usage: seen, text: chunks.join("") }));
  tap.on("error", reject);
  const parts = [
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
    'data: {"choices":[],"usage":{"prompt_tok',
    'ens":10,"completion_tokens":5,"total_tokens":15,"credits":1}}\n\n',
  ];
  for (const p of parts) tap.write(Buffer.from(p, "utf8"));
  tap.end();
});
check("SSE 探针结果", () => {
  assert.equal(tapped.text, 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"credits":1}}\n\n');
  assert.equal(tapped.usage.input, 10);
  assert.equal(tapped.usage.output, 5);
  assert.equal(tapped.usage.total, 15);
  assert.equal(tapped.usage.credits, 1);
});

/* 7. 积分余额下降，扣掉上游直报 credits */
check("noteCreditObservation 基线", () => {
  m.noteCreditObservation("workbuddy:wb1", 1000, now);
});
m.recordUsageProbe({ ev: "usage", at: now, route: "workbuddy:wb1", poolModel: "m-a", usage: tapped.usage });
check("余额差积分扣除上游直报", () => {
  m.noteCreditObservation("workbuddy:wb1", 997.5, new Date(Date.now() + 2).toISOString());
  const d = m.usageDocument();
  const p = d.windows.all.platforms.find((x) => x.key === "workbuddy:wb1");
  assert.equal(p.credits, 2.5, "余额差 2.5 = 直报 1 + 估算 1.5，合计就是实际消耗");
  assert.equal(p.directCredits, 1);
  assert.equal(p.tokens.input, 10);
  assert.equal(p.tokens.total, 15);
  assert.equal(p.models.find((x) => x.name === "m-a").tokens.total, 15);
});

/* 8. 异常余额（上涨 / 超过 MAX_CREDIT_DELTA 的跳变）不记消耗 */
check("余额上涨与超阈值跳变不记消耗", () => {
  const before = m.usageDocument().windows.all.platforms.find((x) => x.key === "workbuddy:wb1").credits;
  m.noteCreditObservation("workbuddy:wb1", 1500, new Date(Date.now() + 3).toISOString());
  m.noteCreditObservation("workbuddy:wb1", 20000, new Date(Date.now() + 4).toISOString());
  m.noteCreditObservation("workbuddy:wb1", 0, new Date(Date.now() + 5).toISOString());
  const after = m.usageDocument().windows.all.platforms.find((x) => x.key === "workbuddy:wb1").credits;
  assert.equal(after, before);
});

/* 9. 落盘 + 模拟重启：新模块实例重新导入，数字不变 */
m.flushUsage();
check("flushUsage 落盘", () => {
  assert.equal(existsSync(join(home, ".dsh-pool-usage.json")), true);
  const raw = JSON.parse(readFileSync(join(home, ".dsh-pool-usage.json"), "utf8"));
  assert.equal(raw.version, 1);
  assert.ok(Object.keys(raw.days).length >= 2);
});
const beforeRestart = m.usageDocument().windows.all;
const m2 = await import(usageModule + "?restart=1");
const afterRestart = m2.usageDocument().windows.all;
check("重启后不重复计数", () => {
  assert.equal(afterRestart.requests, beforeRestart.requests);
  assert.equal(afterRestart.served, beforeRestart.served);
  assert.equal(afterRestart.failed, beforeRestart.failed);
  assert.equal(afterRestart.tokens.input, beforeRestart.tokens.input);
  assert.equal(afterRestart.tokens.total, beforeRestart.tokens.total);
  assert.equal(afterRestart.credits, beforeRestart.credits);
});

console.log(JSON.stringify({
  pass: ok.length,
  cases: ok,
  windows: Object.fromEntries(Object.entries(afterRestart).filter(([k]) => ["requests","served","failed","credits","tokens"].includes(k))),
  platforms: afterRestart.platforms.map((p) => ({ key: p.key, displayName: p.displayName, requests: p.requests, credits: p.credits, tokens: p.tokens.total, share: p.share })),
  today,
  ledger: join(home, ".dsh-pool-usage.json"),
}, null, 2));
