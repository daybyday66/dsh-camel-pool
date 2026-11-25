#!/usr/bin/env node
// check-pool-core.mjs —— 池内核运行时断言（不是静态 grep，是真 import 真跑）。
//
// 用法: node scripts/check-pool-core.mjs
//
// 为什么要有它：池的先后顺序全靠三条看不见的规则——
//   ① extractCredits 认出 expiring 之后把 expiryMs 拉近到当日午夜；
//   ② orderedRoutesFor 按「到期时间 → priority → 注册序」排序（最早的先烧）；
//   ③ 任务粘性（latch）只能在同一档内部换先后，不得越过更早到期或还有当日余额的路由。
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
  mergedModelGroups,
  routeModelDiagnostics,
  creditBalanceReport,
} from "../lib/shared/pool.js";
import { HIDE_ALL_SENTINEL } from "../lib/shared/hidden.js";

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
ok("latch 让位给当日额度", latched[0] === "codearts", latched);
// ux-v36：粘性也不得越过「到期更早」的路由。这里 qoder 是 12-03 到期、trae 是 11-30 到期，
// 于是 latch 只能贴在 trae 后面 —— 否则晚到期的先烧、早到期的先作废，正好反过来。
ok("latch 不得越过更早到期的路由", latched[1] === "trae" && latched[2] === "qoder", latched);

// ⑤b ux-v36：同一档（到期时间与 priority 都相同，只有注册序不同）之间粘性仍然生效。
// 真机上这就是「同为 11-30 到期、priority 都是 1 的 trae / trae2」之间来回钉住。
// ux-v47：kind 必须独立成 "fake-tie"，否则 tie-a/tie-b 会和上面的 trae(1800) 落进
// 同一个均衡档（同 kind + 同 11-30 + 同 priority 1），余额差 1700>300，粘性被均衡压住。
const releaseTieA = registerPoolRoute({
  ...fakeRoute("tie-a", 1, {
    status: "signed-in",
    credits: { remaining: 100, total: 100, endTime: "2026-11-30T00:00:00.000Z" },
  }),
  kind: "fake-tie",
});
const releaseTieB = registerPoolRoute({
  ...fakeRoute("tie-b", 1, {
    status: "signed-in",
    credits: { remaining: 100, total: 100, endTime: "2026-11-30T00:00:00.000Z" },
  }),
  kind: "fake-tie",
});
await refreshPoolCredits({ force: true, only: ["tie-a", "tie-b"] });
setLatch(MODEL, "tie-b");
const sameTier = orderedRoutesFor(MODEL, {}).map((item) => item.routeKey);
// ux-v47：同档内余额相同（100/100，差 0 ≤300）时均衡不换手，latch 仍能换先后。
// 但 trae 与 tie 同 expiry/priority、注册序更靠前，会稳定排在 tie 之前，故只断言相对序。
ok(
  "同档路由之间粘性仍生效",
  sameTier[0] === "codearts" &&
    sameTier.indexOf("tie-b") !== -1 &&
    sameTier.indexOf("tie-b") < sameTier.indexOf("tie-a"),
  sameTier,
);
releaseTieA();
releaseTieB();

// ⑤c ux-v36 真实形状回归（用户报的那一例）：workbuddy 两条 12-05 / 12-11 到期、priority 0，
// trae 11-30 到期、priority 1。latch 钉在 workbuddy2 上时，trae 必须仍然排在它前面 ——
// priority 更小只是「同档内的次序」，压不过「更早到期」。
const releaseWb2 = registerPoolRoute(fakeRoute("wb2", 0, {
  status: "signed-in",
  credits: { remaining: 1843, total: 2000, endTime: "2026-12-05T07:20:36.000Z" },
}));
const releaseWb1 = registerPoolRoute(fakeRoute("wb1", 0, {
  status: "signed-in",
  credits: { remaining: 2284, total: 2400, endTime: "2026-12-11T18:08:22.000Z" },
}));
await refreshPoolCredits({ force: true, only: ["wb1", "wb2"] });
setLatch(MODEL, "wb2");
const realShape = orderedRoutesFor(MODEL, {}).map((item) => item.routeKey);
ok("真实形状：11-30 的 trae 必须排在 12-05 的 wb2 之前", realShape.indexOf("trae") < realShape.indexOf("wb2") && realShape.indexOf("wb2") < realShape.indexOf("wb1"), realShape);
releaseWb2();
releaseWb1();

// ⑥ 开关关掉时保留 ux-v13 的旧行为（粘性压过一切）
setLatch(MODEL, "qoder");
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

// ⑨ 官方政策兜底：无上游逐包到期的 Trae / Gemini 也必须有有限 expiryMs。
function policyRoute(key, kind, creditsDoc) {
  const route = fakeRoute(key, 9, creditsDoc);
  route.kind = kind;
  return route;
}
const releaseTraePolicy = registerPoolRoute(policyRoute("trae-policy", "trae", {
  status: "signed-in",
  credits: { remaining: 10, total: 10 },
}));
const geminiPolicyRoute = policyRoute("gemini-policy", "gemini", { status: "ok" });
delete geminiPolicyRoute.credits;
geminiPolicyRoute.status = async () => ({ status: "ok" });
const releaseGeminiPolicy = registerPoolRoute(geminiPolicyRoute);
await refreshPoolCredits({ force: true, only: ["trae-policy", "gemini-policy"] });
const traePolicy = poolRouteCredits("trae-policy");
ok("Trae 无逐包到期时按官网政策估算", traePolicy?.expiryEstimated === true && Number.isFinite(traePolicy?.expiryMs), traePolicy);
const geminiPolicy = poolRouteCredits("gemini-policy");
ok("Gemini 无积分包时按 RPD 重置窗口估算", geminiPolicy?.expiryEstimated === true && Number.isFinite(geminiPolicy?.expiryMs), geminiPolicy);
releaseTraePolicy();
releaseGeminiPolicy();

// ⑩ 渠道级禁用哨兵（HIDE_ALL_SENTINEL）在池内核生效
const hiddenRoute = fakeRoute("disabled-wb", 0, { status: "signed-in", credits: { remaining: 9999, total: 9999 } });
hiddenRoute.hidden = () => [HIDE_ALL_SENTINEL];
const releaseHidden = registerPoolRoute(hiddenRoute);
const activeRoutes = orderedRoutesFor(MODEL, {}).map((item) => item.routeKey);
ok("HIDE_ALL_SENTINEL 禁用整条池路由", !activeRoutes.includes("disabled-wb"), activeRoutes);
releaseHidden();

// ux-v29：Trae 兜底 id 不再被白名单静默过滤 + 诊断能说出丢了谁
const releaseOfficial = registerPoolRoute({
  ...fakeRoute("trae-official", 1, { status: "signed-in", credits: { remaining: 5, total: 5 } }),
  models: () => [
    { id: "DeepSeek-V4-Flash-Official", name: "DeepSeek-V4-Flash Official", contextWindow: 1000, maxTokens: 100, input: ["text"] },
    { id: "Some-Unlisted-Model-XYZ", name: "Some Unlisted", contextWindow: 1000, maxTokens: 100, input: ["text"] },
  ],
});
const groups = mergedModelGroups({});
ok("Trae 兜底 Official id 进模型库", groups.some((g) => g.poolId === "deepseek-v4-flash-official"), groups.map((g) => g.poolId));
const diag = routeModelDiagnostics().find((d) => d.key === "trae-official");
ok("诊断记下被过滤的 id", diag?.rawModelCount === 2 && diag?.curatedModelCount === 1 && (diag?.droppedModels ?? []).includes("some-unlisted-model-xyz"), diag);
releaseOfficial();

// ux-v30：mergedModelGroups 每路由只调一次 models()，且注销清诊断
let modelCalls = 0;
const countingRoute = {
  ...fakeRoute("counting", 1, { status: "signed-in", credits: { remaining: 1, total: 1 } }),
  models: () => { modelCalls += 1; return [{ id: MODEL, name: "DeepSeek-V4.1-Flash", contextWindow: 1000, maxTokens: 100, input: ["text"] }]; },
};
const releaseCounting = registerPoolRoute(countingRoute);
modelCalls = 0;
mergedModelGroups({});
ok("mergedModelGroups 每路由只调一次 models()", modelCalls === 1, modelCalls);
const diagBefore = routeModelDiagnostics().find((d) => d.key === "counting");
ok("诊断里有 counting 路由", diagBefore?.rawModelCount === 1, diagBefore);
releaseCounting();
ok("注销后诊断不再有幽灵条目", !routeModelDiagnostics().some((d) => d.key === "counting"), routeModelDiagnostics().map((d) => d.key));

// ux-v31：非数组 models() 不得打挂整池（v1.0.4 回归：Set / 字符串 / 对象）
for (const bad of [new Set([{ id: MODEL }]), "nope", { a: 1 }]) {
  const off = registerPoolRoute({ ...fakeRoute("bad-models", 1, { status: "signed-in", credits: { remaining: 1 } }), models: () => bad });
  let threw = false;
  try { mergedModelGroups({}); } catch { threw = true; }
  ok("非数组 models() 不抛（" + Object.prototype.toString.call(bad) + "）", !threw);
  // Set 应被展开成 1 条，字符串 / 对象当空；无论如何不影响其他路由
  const diagBad = routeModelDiagnostics().find((d) => d.key === "bad-models");
  ok("非数组 models() 诊断条数合理", diagBad?.rawModelCount === (bad instanceof Set ? 1 : 0), diagBad);
  off();
}
// ux-v32：归一化展开本身抛错也不得打穿整池（迭代器中途抛 / getter 抛）
for (const [label, bad] of [
  ["迭代器中途抛", { [Symbol.iterator]: function* () { yield { id: MODEL }; throw new Error("mid-iteration"); } }],
  ["Symbol.iterator getter 抛", (() => { const o = {}; Object.defineProperty(o, Symbol.iterator, { get() { throw new Error("getter blew up"); } }); return o; })()],
  ["迭代器立即抛", { [Symbol.iterator]: () => { throw new Error("iterator blew up"); } }],
]) {
  const off = registerPoolRoute({ ...fakeRoute("bad-iterator", 1, { status: "signed-in", credits: { remaining: 1 } }), models: () => bad });
  let threw = false;
  try { mergedModelGroups({}); } catch { threw = true; }
  ok("抛错的迭代器不打挂整池（" + label + "）", !threw);
  const diagBad = routeModelDiagnostics().find((d) => d.key === "bad-iterator");
  ok("抛错的迭代器诊断记 0 条（" + label + "）", diagBad?.rawModelCount === 0, diagBad);
  off();
}
// droppedModels 上限 8 条
const manyUnlisted = Array.from({ length: 12 }, (_, i) => ({ id: "unlisted-" + i, name: "U" + i, contextWindow: 1000, maxTokens: 100, input: ["text"] }));
const offMany = registerPoolRoute({ ...fakeRoute("many-unlisted", 1, { status: "signed-in", credits: { remaining: 1 } }), models: () => manyUnlisted });
mergedModelGroups({});
const diagMany = routeModelDiagnostics().find((d) => d.key === "many-unlisted");
ok("droppedModels 上限 8 条", (diagMany?.droppedModels ?? []).length === 8 && diagMany?.rawModelCount === 12, diagMany);
offMany();
// hiddenModelCount 有读数
const offHidden = registerPoolRoute({ ...fakeRoute("hidden-one", 1, { status: "signed-in", credits: { remaining: 1 } }), hidden: () => [MODEL], models: () => [{ id: MODEL, name: "DeepSeek-V4.1-Flash", contextWindow: 1000, maxTokens: 100, input: ["text"] }, { id: "hy4flash-free", name: "Hy4 flash", contextWindow: 1000, maxTokens: 100, input: ["text"] }] });
mergedModelGroups({});
const diagHidden = routeModelDiagnostics().find((d) => d.key === "hidden-one");
ok("hiddenModelCount 计入被 hidden() 滤掉的模型", diagHidden?.hiddenModelCount === 1 && diagHidden?.rawModelCount === 2, diagHidden);
offHidden();

// ux-v47：同档同类路由的 300 分滞回均衡（trae/trae2 同到期时，差 >300 才换手）
function fakeBalanceRoute(key, priority, kind, holder) {
  return {
    key,
    kind,
    providerId: "bal-" + key,
    channelId: "bal-" + key,
    displayName: key,
    priority,
    chatUrl: () => "http://127.0.0.1/",
    token: async () => "test-token",
    models: () => [{ id: MODEL, name: "DeepSeek-V4.1-Flash", contextWindow: 1000, maxTokens: 100, input: ["text"] }],
    hidden: () => [],
    status: async () => ({ status: "signed-in" }),
    credits: async () => holder.doc,
  };
}
const BAL_END = "2026-12-20T00:00:00.000Z";
const balA = { doc: { status: "signed-in", credits: { remaining: 2000, total: 4000, endTime: BAL_END } } };
const balB = { doc: { status: "signed-in", credits: { remaining: 2000, total: 4000, endTime: BAL_END } } };
const releaseBalA = registerPoolRoute(fakeBalanceRoute("bal-a", 1, "bal-trae", balA));
const releaseBalB = registerPoolRoute(fakeBalanceRoute("bal-b", 1, "bal-trae", balB));
await refreshPoolCredits({ force: true, only: ["bal-a", "bal-b"] });
const balOrder = () => orderedRoutesFor(MODEL, {}).map((item) => item.routeKey).filter((key) => key.startsWith("bal-"));

ok("ux-v47 同余额时保持注册序，不来回切", balOrder().join(",") === "bal-a,bal-b", balOrder());
balA.doc.credits.remaining = 1500;
await refreshPoolCredits({ force: true, only: ["bal-a"] });
ok("ux-v47 积分差 >300 换到积分多的一方", balOrder().join(",") === "bal-b,bal-a", balOrder());
ok("ux-v47 均衡状态可查（当前烧 bal-b）", creditBalanceReport().some((item) => item.routeKey === "bal-b"), creditBalanceReport());
balB.doc.credits.remaining = 1700;
await refreshPoolCredits({ force: true, only: ["bal-b"] });
ok("ux-v47 差 200 落在滞回带内不切回", balOrder().join(",") === "bal-b,bal-a", balOrder());
balB.doc.credits.remaining = 1100;
await refreshPoolCredits({ force: true, only: ["bal-b"] });
ok("ux-v47 反向差 >300 切回另一条", balOrder().join(",") === "bal-a,bal-b", balOrder());
// 跨渠道：到期时间与 priority 完全相同，但 kind 不同 —— 不得互相均衡
const balC = { doc: { status: "signed-in", credits: { remaining: 9000, total: 9000, endTime: BAL_END } } };
const releaseBalC = registerPoolRoute(fakeBalanceRoute("bal-c", 1, "bal-qoder", balC));
await refreshPoolCredits({ force: true, only: ["bal-c"] });
const balOrder2 = balOrder();
ok("ux-v47 跨渠道不混着均衡（bal-c 不抢 bal-trae 档的首位）", balOrder2.join(",") === "bal-a,bal-b,bal-c", balOrder2);
releaseBalC();
balB.doc.credits.remaining = 5000;
await refreshPoolCredits({ force: true, only: ["bal-b"] });
ok("ux-v47 差 3500 再次换到 bal-b", balOrder().join(",") === "bal-b,bal-a", balOrder());
const balOff = orderedRoutesFor(MODEL, { balanceCredits: false }).map((item) => item.routeKey).filter((key) => key.startsWith("bal-"));
ok("ux-v47 可关闭均衡（balanceCredits:false 回纯注册序）", balOff.join(",") === "bal-a,bal-b", balOff);

// ---- ux-v48：report 观测补齐 + 边界加固（Muse 复核建议） ----
// ① 没换过手的档也要出现在 creditBalanceReport（ux-v48 修复点）
const repA = { doc: { status: "signed-in", credits: { remaining: 2000, total: 4000, endTime: BAL_END } } };
const repB = { doc: { status: "signed-in", credits: { remaining: 1800, total: 4000, endTime: BAL_END } } };
const releaseRepA = registerPoolRoute(fakeBalanceRoute("rep-a", 1, "bal-report", repA));
const releaseRepB = registerPoolRoute(fakeBalanceRoute("rep-b", 1, "bal-report", repB));
await refreshPoolCredits({ force: true, only: ["rep-a", "rep-b"] });
const repKeys = () => orderedRoutesFor(MODEL, {}).map((i) => i.routeKey).filter((k) => k.startsWith("rep-"));
const repOrder = repKeys();
ok("ux-v48 未换手的档也在 balance 报告里", creditBalanceReport().some((i) => i.routeKey === "rep-a"), creditBalanceReport());
ok("ux-v48 差值 200 ≤300 不换手，保持注册序", repOrder.join(",") === "rep-a,rep-b", repOrder);

// ② 差值恰好 =300 严格不切（滞回上沿，gap > 300 才切）
const exA = { doc: { status: "signed-in", credits: { remaining: 1700, total: 4000, endTime: BAL_END } } };
const exB = { doc: { status: "signed-in", credits: { remaining: 2000, total: 4000, endTime: BAL_END } } };
const releaseExA = registerPoolRoute(fakeBalanceRoute("ex-a", 1, "bal-exact", exA));
const releaseExB = registerPoolRoute(fakeBalanceRoute("ex-b", 1, "bal-exact", exB));
await refreshPoolCredits({ force: true, only: ["ex-a", "ex-b"] });
const exKeys = orderedRoutesFor(MODEL, {}).map((i) => i.routeKey).filter((k) => k.startsWith("ex-"));
ok("ux-v48 差值恰好=300 严格不切", exKeys.join(",") === "ex-a,ex-b", exKeys);
releaseExA(); releaseExB();

// ③ 3 路由档：换手后其余保持相对注册序
const triA = { doc: { status: "signed-in", credits: { remaining: 1000, total: 4000, endTime: BAL_END } } };
const triB = { doc: { status: "signed-in", credits: { remaining: 1000, total: 4000, endTime: BAL_END } } };
const triC = { doc: { status: "signed-in", credits: { remaining: 5000, total: 4000, endTime: BAL_END } } };
const releaseTriA = registerPoolRoute(fakeBalanceRoute("tri-a", 1, "bal-tri", triA));
const releaseTriB = registerPoolRoute(fakeBalanceRoute("tri-b", 1, "bal-tri", triB));
const releaseTriC = registerPoolRoute(fakeBalanceRoute("tri-c", 1, "bal-tri", triC));
await refreshPoolCredits({ force: true, only: ["tri-a", "tri-b", "tri-c"] });
const triKeys = orderedRoutesFor(MODEL, {}).map((i) => i.routeKey).filter((k) => k.startsWith("tri-"));
ok("ux-v48 3 路由档换手后其余保序", triKeys.join(",") === "tri-c,tri-a,tri-b", triKeys);
releaseTriA(); releaseTriB(); releaseTriC();

// ④ expiry 不同 / priority 不同 → 分属不同档，不互相均衡（保持注册序）
const dA = { doc: { status: "signed-in", credits: { remaining: 100, total: 4000, endTime: BAL_END } } };
const dB = { doc: { status: "signed-in", credits: { remaining: 9000, total: 4000, endTime: "2026-12-21T00:00:00.000Z" } } };
const releaseDA = registerPoolRoute(fakeBalanceRoute("diff-a", 1, "bal-diff", dA));
const releaseDB = registerPoolRoute(fakeBalanceRoute("diff-b", 1, "bal-diff", dB));
await refreshPoolCredits({ force: true, only: ["diff-a", "diff-b"] });
const diffExp = orderedRoutesFor(MODEL, {}).map((i) => i.routeKey).filter((k) => k.startsWith("diff-"));
ok("ux-v48 expiry 不同不混算（保持注册序）", diffExp.join(",") === "diff-a,diff-b", diffExp);
releaseDA(); releaseDB();
const pA = { doc: { status: "signed-in", credits: { remaining: 100, total: 4000, endTime: BAL_END } } };
const pB = { doc: { status: "signed-in", credits: { remaining: 9000, total: 4000, endTime: BAL_END } } };
const releasePA = registerPoolRoute(fakeBalanceRoute("prio-a", 1, "bal-prio", pA));
const releasePB = registerPoolRoute(fakeBalanceRoute("prio-b", 2, "bal-prio", pB));
await refreshPoolCredits({ force: true, only: ["prio-a", "prio-b"] });
const diffPri = orderedRoutesFor(MODEL, {}).map((i) => i.routeKey).filter((k) => k.startsWith("prio-"));
ok("ux-v48 priority 不同不混算（保持注册序）", diffPri.join(",") === "prio-a,prio-b", diffPri);
releasePA(); releasePB();

// ⑤ 块内余额非有限 → 整块跳过不猜，保持注册序
const nfA = { doc: { status: "signed-in", credits: { remaining: 1000, total: 4000, endTime: BAL_END } } };
const nfB = { doc: { status: "signed-out" } }; // 无 credits.remaining
const releaseNfA = registerPoolRoute(fakeBalanceRoute("nf-a", 1, "bal-nf", nfA));
const releaseNfB = registerPoolRoute(fakeBalanceRoute("nf-b", 1, "bal-nf", nfB));
await refreshPoolCredits({ force: true, only: ["nf-a", "nf-b"] });
const nfKeys = orderedRoutesFor(MODEL, {}).map((i) => i.routeKey).filter((k) => k.startsWith("nf-"));
ok("ux-v48 块内余额非有限整块跳过", nfKeys.join(",") === "nf-a,nf-b", nfKeys);
releaseNfA(); releaseNfB();

// ⑥ latch + 均衡联动：latch 播种 A，B 多 >300 切走 B，下一轮不再切回
const lkA = { doc: { status: "signed-in", credits: { remaining: 1000, total: 4000, endTime: BAL_END } } };
const lkB = { doc: { status: "signed-in", credits: { remaining: 2000, total: 4000, endTime: BAL_END } } };
const releaseLkA = registerPoolRoute(fakeBalanceRoute("lk-a", 1, "bal-lk", lkA));
const releaseLkB = registerPoolRoute(fakeBalanceRoute("lk-b", 1, "bal-lk", lkB));
await refreshPoolCredits({ force: true, only: ["lk-a", "lk-b"] });
setLatch(MODEL, "lk-a");
const lk1 = orderedRoutesFor(MODEL, {}).map((i) => i.routeKey).filter((k) => k.startsWith("lk-"));
ok("ux-v48 latch 播种 A 后 B 多>300 切走 B", lk1[0] === "lk-b", lk1);
const lk2 = orderedRoutesFor(MODEL, {}).map((i) => i.routeKey).filter((k) => k.startsWith("lk-"));
ok("ux-v48 切到 B 后下一轮不切回（滞回收敛）", lk2[0] === "lk-b", lk2);
releaseLkA(); releaseLkB();

// ⑦ unregisterPoolRoute 清掉该档的均衡记忆
const repAfter = creditBalanceReport().filter((i) => i.routeKey === "rep-a");
ok("ux-v48 注销当前首选后该档从报告消失", repAfter.length === 1, creditBalanceReport());
releaseRepA();
const repGone = creditBalanceReport().filter((i) => i.routeKey === "rep-a");
ok("ux-v48 注销后 balanceCurrent 清记忆", repGone.length === 0, creditBalanceReport());

// ---- ux-v49：Muse 复核补测（精确回归 + report 过滤 + 反向分支） ----
// ① 精确回归：3 路由档，latch 播种到非锚点，均衡锚点仍排在 latch 前面
//    （ux-v48 真 bug 的精确复现：floor 在同档非锚点路由处提前 break，把 latch 插到锚点前）
const rgA = { doc: { status: "signed-in", credits: { remaining: 1000, total: 4000, endTime: BAL_END } } };
const rgB = { doc: { status: "signed-in", credits: { remaining: 1000, total: 4000, endTime: BAL_END } } };
const rgC = { doc: { status: "signed-in", credits: { remaining: 5000, total: 4000, endTime: BAL_END } } };
const releaseRgA = registerPoolRoute(fakeBalanceRoute("rg-a", 1, "bal-reg", rgA));
const releaseRgB = registerPoolRoute(fakeBalanceRoute("rg-b", 1, "bal-reg", rgB));
const releaseRgC = registerPoolRoute(fakeBalanceRoute("rg-c", 1, "bal-reg", rgC));
await refreshPoolCredits({ force: true, only: ["rg-a", "rg-b", "rg-c"] });
orderedRoutesFor(MODEL, {}); // 先跑一次，均衡把 rg-c 设为锚点
setLatch(MODEL, "rg-a"); // latch 播种到非锚点
const regKeys = orderedRoutesFor(MODEL, {}).map((i) => i.routeKey).filter((k) => k.startsWith("rg-"));
ok("ux-v49 3 路由档 latch 播种非锚点，均衡锚点仍排前（bug 回归）", regKeys.join(",") === "rg-c,rg-a,rg-b", regKeys);
releaseRgA(); releaseRgB(); releaseRgC();

// ② report 过滤单条档：同档注销到只剩 1 条后，该档从 report 消失（无均衡意义）
const sA = { doc: { status: "signed-in", credits: { remaining: 2000, total: 4000, endTime: BAL_END } } };
const sB = { doc: { status: "signed-in", credits: { remaining: 1800, total: 4000, endTime: BAL_END } } };
const releaseSA = registerPoolRoute(fakeBalanceRoute("sg-a", 1, "bal-single", sA));
const releaseSB = registerPoolRoute(fakeBalanceRoute("sg-b", 1, "bal-single", sB));
await refreshPoolCredits({ force: true, only: ["sg-a", "sg-b"] });
orderedRoutesFor(MODEL, {});
ok("ux-v49 两条同档时进 report", creditBalanceReport().some((i) => i.routeKey === "sg-a"), creditBalanceReport());
releaseSB(); // 注销非首选，档内只剩 1 条
ok("ux-v49 档内只剩 1 条后从 report 过滤掉", !creditBalanceReport().some((i) => i.routeKey.startsWith("sg-")), creditBalanceReport());
releaseSA();

// ③ 反向分支：balancedTo === latch 时粘性不被跳过（不崩，首位是均衡锚点 = latch）
const vkA = { doc: { status: "signed-in", credits: { remaining: 2000, total: 4000, endTime: BAL_END } } };
const vkB = { doc: { status: "signed-in", credits: { remaining: 1000, total: 4000, endTime: BAL_END } } };
const releaseVkA = registerPoolRoute(fakeBalanceRoute("vk-a", 1, "bal-vk", vkA));
const releaseVkB = registerPoolRoute(fakeBalanceRoute("vk-b", 1, "bal-vk", vkB));
await refreshPoolCredits({ force: true, only: ["vk-a", "vk-b"] });
orderedRoutesFor(MODEL, {}); // 均衡选 vk-a 为锚点
setLatch(MODEL, "vk-a"); // latch 设在锚点上 → balancedTo === latch
const vkKeys = orderedRoutesFor(MODEL, {}).map((i) => i.routeKey).filter((k) => k.startsWith("vk-"));
ok("ux-v49 balancedTo===latch 时粘性正常生效", vkKeys.join(",") === "vk-a,vk-b", vkKeys);
releaseVkA(); releaseVkB();

// ux-v51：上游新上架的 3 个真新模型必须过白名单（否则被静默丢弃），老一代存量仍按原样滤掉。
const releaseNew = registerPoolRoute({
  ...fakeRoute("new-models", 1, { status: "signed-in", credits: { remaining: 1, total: 1 } }),
  models: () => [
    { id: "glm-5.4", name: "GLM-5.4", contextWindow: 1000000, maxTokens: 32768, input: ["text"] },
    { id: "qwen4-max", name: "Qwen4-Max", contextWindow: 1000000, maxTokens: 200000, input: ["text"] },
    { id: "kimi-k3.1-pro-highspeed", name: "Kimi-K3.1-Pro-Highspeed", contextWindow: 1000000, maxTokens: 200000, input: ["text"] },
    { id: "glm-5.2", name: "GLM-5.2", contextWindow: 1000000, maxTokens: 64000, input: ["text"] },
    { id: "minimax-m2.7", name: "MiniMax-M2.7", contextWindow: 200000, maxTokens: 48000, input: ["text"] },
    { id: "kimi-k2.8-preview", name: "Kimi-K2.8-Preview", contextWindow: 1000000, maxTokens: 64000, input: ["text"] },
  ],
});
const newGroups = mergedModelGroups({});
const newIds = new Set(newGroups.map((g) => g.poolId));
ok("ux-v51 glm-5.4 过白名单", newIds.has("glm-5.4"), [...newIds].filter((x) => x.startsWith("glm")));
ok("ux-v51 qwen4-max 过白名单", newIds.has("qwen4-max"), [...newIds].filter((x) => x.startsWith("qwen")));
ok("ux-v51 kimi-k3.1-pro-highspeed 过白名单", newIds.has("kimi-k3.1-pro-highspeed"), [...newIds].filter((x) => x.startsWith("kimi")));
const diagNew = routeModelDiagnostics().find((d) => d.key === "new-models");
ok("ux-v51 老一代存量仍被滤掉（glm-5.2 / minimax-m2.7 / kimi-k2.8-preview）",
  diagNew?.rawModelCount === 6 && diagNew?.curatedModelCount === 3
  && ["glm-5.2", "minimax-m2.7", "kimi-k2.8-preview"].every((id) => (diagNew?.droppedModels ?? []).includes(id)), diagNew);
releaseNew();

releaseRepB();
releaseBalA();
releaseBalB();

releaseCodearts();
releaseTrae();
releaseQoder();

if (failed > 0) {
  console.error("\ncheck-pool-core: " + failed + " 项失败");
  process.exit(1);
}
console.log("\ncheck-pool-core: 全部通过");
