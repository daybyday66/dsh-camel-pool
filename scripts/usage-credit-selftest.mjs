/**
 * 积分采样端到端自测：mock 一条余额递减的路由，验证
 *   sampleUsageCredits() 的节流 + 余额差记账 + 节流不漏累计。
 *   node scripts/usage-credit-selftest.mjs
 * 在临时 DSH_HOME 里跑，不碰真实账本。
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), "dsh-credit-selftest-"));
process.env.DSH_HOME = home;

const pool = await import(pathToFileURL(join(root, "lib", "shared", "pool.js")).href);
const usage = await import(pathToFileURL(join(root, "lib", "shared", "usage.js")).href);

let balance = 1000;
let calls = 0;
const route = {
  key: "probe:route",
  kind: "probe",
  chatUrl: () => "http://127.0.0.1:1/v1/chat/completions",
  token: () => "x",
  models: () => [],
  credits: async () => { calls++; return { remaining: balance, total: 1000 }; },
};
const unregister = pool.registerPoolRoute(route);

const ok = [];
const tick = () => new Promise((r) => setTimeout(r, 40));

// 1) 首次刷新只建基线，不记消耗
await pool.refreshPoolCredits({ force: true });
assert.equal(usage.usageDocument().windows.all.credits, 0);
ok.push("首次只建基线");

// 2) 余额下降后采样：force 强刷该路由 → 记 3 积分
balance = 997;
pool.sampleUsageCredits("probe:route");
await tick();
let p = usage.usageDocument().windows.all.platforms.find((x) => x.key === "probe:route");
assert.equal(p?.credits, 3);
ok.push("余额下降 1000→997 记 3 积分");

// 3) 20 秒节流：重复采样不再打上游
const before = calls;
balance = 990;
pool.sampleUsageCredits("probe:route");
await tick();
assert.equal(calls, before);
ok.push("20 秒内节流不重复打上游");

// 4) 节流窗口内累计的余额差不会丢：绕过节流强制刷 → 累计 1000→990 = 10
await pool.refreshPoolCredits({ force: true, only: ["probe:route"] });
p = usage.usageDocument().windows.all.platforms.find((x) => x.key === "probe:route");
assert.equal(p?.credits, 10);
ok.push("节流期间的下降在下次采样累计，不漏记 (3+7=10)");

unregister();
console.log(JSON.stringify({ pass: ok.length, cases: ok, home }, null, 2));
