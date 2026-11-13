#!/usr/bin/env node
// check-pool-core.mjs —— 池内核运行时断言（不是静态 grep，是真 import 真跑）。
//
// 用法: node scripts/check-pool-core.mjs
//
// 为什么要有它：ux-v14 的「当日额度优先烧」全靠两条看不见的规则——
//   ① extractCredits 认出 expiring 之后把 expiryMs 拉近到当日午夜；
//   ② orderedRoutesFor 让任务粘性（latch）给还有当日余额的路由让位。
// 这两条用 grep 断言不出来（改一个 `??` 成 `||` 照样过静态检查），只能跑。
// 全部用假路由注入，不碰网络、不碰真实凭据，可在 CI 直接跑。
import {
  refreshPoolCredits,
  poolRouteCredits,
  registerPoolRoute,
  orderedRoutesFor,
  setLatch,
  clearBreakers,
  poolStatusDocument,
} from "../lib/shared/pool.js";

let failed = 0;
function ok(label, cond, extra) {
  if (cond) {
    console.log("[core] ok: " + label);
    return;
  }
  failed += 1;
  console.error("[core] FAIL: " + label + "  " + (extra === undefined ? "" : JSON.stringify(extra)));
}

const EXPIRE_AT = "2026-11-14T16:00:00.000Z"; // 上海当日 24:00 对应的 UTC
const PLAN_END = "2026-12-03T00:00:00.000Z";
const MODEL = "deepseek-v4.1-flash";

function fakeRoute(key, priority, creditsDoc) {
  return {
    key,
    kind: "fake",
    providerId: "fake-" + key,
    channelId: "fake-" + key,
    displayName: key,
    priority,
    chatUrl: () => "http://127.0.0.1/",
    token: async () => "test-token",
    models: () => [{ id: MODEL, name: "DeepSeek-V4.1-Flash", contextWindow: 1000, maxTokens: 100, input: ["text"], reasoning: false }],
    hidden: () => [],
    status: async () => ({ status: "signed-in" }),
    credits: async () => creditsDoc,
  };
}

const releaseCodearts = registerPoolRoute(fakeRoute("codearts", 3, {
  status: "signed-in",
  credits: { remaining: 5276.35, total: 5600, expiring: 70.03, expiringAt: EXPIRE_AT, endTime: PLAN_END },
}));
const releaseTrae = registerPoolRoute(fakeRoute("trae", 1, {
  status: "signed-in",
  credits: { remaining: 1800, total: 2000, endTime: "2026-11-30T00:00:00.000Z" },
}));
const releaseQoder = registerPoolRoute(fakeRoute("qoder", 2, {
  status: "signed-in",
  // expiring 显式为 0 的账号不该把自己标成「有当日桶」。
  credits: { accounts: [{ remain: 50, expiring: 0, endTime: PLAN_END }, { remain: 10 }] },
}));

await refreshPoolCredits({ force: true });

// ① 当日桶存在 → expiring 透出，expiryMs 跟着拉近
const codearts = poolRouteCredits("codearts");
ok("expiring 透出", codearts?.expiring === 70.03, codearts?.expiring);
ok("expiringAtMs 解析", codearts?.expiringAtMs === Date.parse(EXPIRE_AT), codearts?.expiringAtMs);
ok("expiryMs=当日午夜而非套餐期末", codearts?.expiryMs === Date.parse(EXPIRE_AT), new Date(codearts?.expiryMs ?? 0).toISOString());

// ② 没有当日桶 → 保持套餐期末，行为与 ux-v13 一致
const trae = poolRouteCredits("trae");
ok("无当日桶 expiryMs=套餐期末", trae?.expiryMs === Date.parse("2026-11-30T00:00:00.000Z") && trae?.expiring === undefined, trae);

// ③ expiring=0 不能被当成「有当日桶」
const qoder = poolRouteCredits("qoder");
ok("accounts expiring=0 视为无当日桶", qoder?.expiring === undefined && qoder?.expiryMs === Date.parse(PLAN_END), { expiring: qoder?.expiring, expiryMs: qoder?.expiryMs });

// ④ 排序：还有当日余额的路由排最前
clearBreakers();
const plain = orderedRoutesFor(MODEL, {}).map((item) => item.routeKey);
ok("无 latch：当日过期路由排第一", plain[0] === "codearts", plain);

// ⑤ latch 让位：粘性不得越过还有当日余额的路由
setLatch(MODEL, "qoder");
const latched = orderedRoutesFor(MODEL, {}).map((item) => item.routeKey);
ok("latch 让位给当日额度", latched[0] === "codearts" && latched[1] === "qoder", latched);

// ⑥ 开关关掉时保留 ux-v13 的旧行为（粘性压过一切）
const legacy = orderedRoutesFor(MODEL, { burnExpiringFirst: false }).map((item) => item.routeKey);
ok("burnExpiringFirst=false 保留旧粘性行为", legacy[0] === "qoder", legacy);

// ⑦ only：只刷指定路由。成功服务后如果 force 全池，10 条路由就是 10 次上游请求，
//    而那时只有刚服务过的那条余额真的变了。
let traeHits = 0;
const traeRoute = { ...fakeRoute("trae", 1, { status: "signed-in", credits: { remaining: 1, total: 2 } }) };
traeRoute.credits = async () => {
  traeHits += 1;
  return { status: "signed-in", credits: { remaining: 1, total: 2 } };
};
const releaseTrae2 = registerPoolRoute(traeRoute);
await refreshPoolCredits({ force: true, only: ["codearts"] });
ok("only 只刷指定路由", traeHits === 0, traeHits);
await refreshPoolCredits({ force: true });
ok("不带 only 时全刷", traeHits === 1, traeHits);
releaseTrae2();

// ⑧ 状态接口要能把这两个字段透出去（面板就是靠它们画「当日将过期」）
const doc = await poolStatusDocument({ refresh: false });
const row = (doc.pool?.routes ?? []).find((item) => item.key === "codearts");
ok("status 行带 expiring", row?.expiring === 70.03, row?.expiring);
ok("status 行带 expiringAt ISO", row?.expiringAt === EXPIRE_AT, row?.expiringAt);

releaseCodearts();
releaseTrae();
releaseQoder();

if (failed > 0) {
  console.error("\ncheck-pool-core: " + failed + " 项失败");
  process.exit(1);
}
console.log("\ncheck-pool-core: 全部通过");
