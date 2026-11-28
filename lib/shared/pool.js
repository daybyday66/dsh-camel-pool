/**
 * 驼峰积分池 —— 跨渠道模型池化的共享层。
 *
 * 设计要点：
 *   1. 渠道模块只负责"把自己的路由报进来"（registerPoolRoute），池不反向依赖渠道。
 *   2. 同名模型跨路由合并成一个选择器条目（poolId）——用户只挑模型，不挑渠道。
 *   3. 条目内部的真实路由顺序 = 最早过期的积分包优先（先烧快过期的），
 *      无过期信息的渠道按 priority 垫后，代金券（bailian）默认最后一级。
 *   4. 任务粘性（latch）：同一条对话第二次请求仍走上次成功的路由，避免模型漂移。
 *   5. 熔断：某路由报配额/限流 → 本次让位，换路由不换模型；一段时间后自愈。
 *   6. 档位翻译：DSH 的抽象档位（low/high/xhigh/max）落到各渠道自己的档位名。
 *
 * 本文件不 import 任何渠道代码，也不 import pi-ai —— 纯逻辑，可直接单测。
 */
import { appendFileSync, mkdirSync, statSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { noteCreditObservation, recordUsageEvent, registerPlatformMeta } from "./usage.js";
import { policyCreditExpiry } from "./credit-expiry-policy.js";
import { hiddenMatcher } from "./hidden.js";

/** DSH 抽象推理档位，从弱到强。 */
export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 上游展示名里的倍率尾巴，例如 "GLM-5.3-Flash · x0.08"、"Kimi K3 · 0.1×"。 */
// 尾巴有两种写法：前缀式 "· x0.08" 与后缀式 "· 0.1×"，都要剥掉。
const RATE_TAIL = /[\s·・|/-]*(?:[x×]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*[x×])\s*$/iu;

/** 去掉渠道展示名里的倍率后缀，只留模型名。 */
export function stripRateSuffix(name) {
  if (typeof name !== "string") return "";
  let out = name.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(RATE_TAIL, "").trim();
    if (next === out || next === "") break;
    out = next;
  }
  return out;
}

/** 名称归一：小写、去分隔符、去尾部数字版本（kimi-k3 ≈ kimi k3）。 */
function normName(name) {
  return stripRateSuffix(name)
    .toLowerCase()
    .replace(/\([^)]*\)/gu, "")
    .replace(/[^a-z0-9]+/gu, "");
}

/** 不同渠道对同一模型的叫法差异（左侧为上游 id 的小写形式）。 */
const ID_ALIASES = new Map([
  ["dfmodel", "deepseek-v4-flash"],
  ["deepseekv4flash", "deepseek-v4-flash"],
  ["kimi-k3-1", "kimi-k3-1"],
  ["kimik3", "kimi-k3-1"],
  // ux-v53：qoder 上游的指针别名（display name 会漂移，不能只靠名称 fuzzy 兜底）。
  // 按 id 直接钉到白名单条目，让合并走 id 键——上游改 display name 也不影响这两个已知别名。
  ["qmodel_latest", "qwen4-max"],
  ["gmodel_latest", "glm-5.4"],
]);

function canonicalId(id) {
  const key = String(id ?? "").trim().toLowerCase();
  if (!key) return "";
  return ID_ALIASES.get(key) ?? key;
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toMs(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ── 路由注册表 ───────────────────────────────────────────────────────────

const registry = [];
let nextIndex = 0;
const listeners = new Set();
let providerActive = false;
let voucherFirstDefault = false;

function notifyRoutesChanged() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* 面板刷新失败不能影响路由本身 */
    }
  }
}

/** 路由表变化（渠道上线/下线/目录刷新）时回调，用于让 DSH 重新拉模型列表。 */
export function onPoolRoutesChanged(fn) {
  if (typeof fn !== "function") return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 主动通知「模型目录变了」：供后台动态拉清单的 provider 复用，不重新注册路由（避免清掉粘性锁/熔断）。 */
export function notifyPoolRoutesChanged() {
  notifyRoutesChanged();
}

function assertRoute(route) {
  if (!route || typeof route !== "object") throw new TypeError("pool route must be an object");
  if (typeof route.key !== "string" || route.key === "") throw new TypeError("pool route needs a non-empty key");
  if (typeof route.chatUrl !== "function") throw new TypeError("pool route needs chatUrl()");
  if (typeof route.token !== "function") throw new TypeError("pool route needs token()");
  if (typeof route.models !== "function") throw new TypeError("pool route needs models()");
}

/**
 * 注册一条可路由的渠道。
 * route = {key, kind, providerId, channelId, displayName, priority, voucher,
 *          chatUrl(), token(), models(), hidden(), status(), credits()}
 */
export function registerPoolRoute(route) {
  assertRoute(route);
  registerPlatformMeta(route);
  const entry = { route, index: nextIndex++ };
  const at = registry.findIndex((item) => item.route.key === route.key);
  if (at >= 0) {
    entry.index = registry[at].index;
    registry[at] = entry;
  } else {
    registry.push(entry);
  }
  credits.delete(route.key);
  breakers.delete(route.key);
  for (const [poolId, routeKey] of latches) {
    if (routeKey === route.key) latches.delete(poolId);
  }
  notifyRoutesChanged();
  return () => unregisterPoolRoute(route.key, route);
}

/** 注销路由；传 route 时只在同一条实例上生效，避免旧渠道下线踢掉新渠道。 */
export function unregisterPoolRoute(key, route) {
  const at = registry.findIndex((item) => item.route.key === key && (!route || item.route === route));
  if (at < 0) return false;
  registry.splice(at, 1);
  credits.delete(key);
  breakers.delete(key);
  // 注销时同步清掉粘性 latch 与采样时间戳：否则 pool.latches 会永久暴露已下线路由。
  for (const [poolId, routeKey] of latches) {
    if (routeKey === key) latches.delete(poolId);
  }
  creditSampleAt.delete(key);
  routeDiagnostics.delete(key); // ux-v30: 注销不同步清诊断会留幽灵条目
  // ux-v47：注销同时清均衡偏好，否则同档剩下的路由会一直对一条已下线的 routeKey 记状态。
  for (const [tier, routeKey] of balanceCurrent) {
    if (routeKey === key) balanceCurrent.delete(tier);
  }
  notifyRoutesChanged();
  return true;
}

/** 当前路由，按 (priority, 注册序) 排序 —— 仅用于展示与兜底，真实路由顺序见 orderedRoutesFor。 */
export function poolRoutes() {
  return registry
    .slice()
    .sort((a, b) => (a.route.priority ?? 0) - (b.route.priority ?? 0) || a.index - b.index)
    .map((item) => item.route);
}

function entryOf(key) {
  return registry.find((item) => item.route.key === key);
}

/** 池 provider 是否启用（面板开关；关掉后模型列表为空，DSH 里就看不到积分池）。 */
export function setPoolProviderActive(active) {
  providerActive = active === true;
  notifyRoutesChanged();
}

export function poolProviderActive() {
  return providerActive;
}

/** 面板里的"代金券优先"默认值；单次调用可用 opts.voucherFirst 覆盖。 */
export function setPoolVoucherPreference(on) {
  voucherFirstDefault = on === true;
}

export function poolVoucherPreference() {
  return voucherFirstDefault;
}

/**
 * 「不同渠道的相同模型合并」开关。
 * 默认 true（历史行为）。关掉后每条路由的模型各自成为一个可选条目，
 * 名称带上渠道名 —— 这样某个合并后的模型失灵时，仍能手动挑到运行正常的路由。
 */
let mergeModelsDefault = true;
export function setPoolMergePreference(on) {
  const next = on !== false;
  if (next === mergeModelsDefault) return;
  mergeModelsDefault = next;
  notifyRoutesChanged();
}
export function poolMergePreference() {
  return mergeModelsDefault;
}

/** 「按性价比排序」开关：只影响模型列表顺序，不影响路由。 */
let costFirstDefault = false;
export function setPoolCostFirstPreference(on) {
  const next = on === true;
  if (next === costFirstDefault) return;
  costFirstDefault = next;
  notifyRoutesChanged();
}
export function poolCostFirstPreference() {
  return costFirstDefault;
}

// ── 模型合并 ─────────────────────────────────────────────────────────────

/** 把 "x0.00 credits" / "0.1×" / 数字倍率统一成数值。 */
function parseRate(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const match = /x?\s*(\d+(?:\.\d+)?)/iu.exec(value.trim());
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 综合能力的启发式打分：旗舰族 >  Pro 族 > 普通 > flash/mini/air/lite。 */
function strengthOf(group) {
  const text = (String(group.poolId) + " " + String(group.name)).toLowerCase();
  let score = 0;
  if (/ultra|opus|550b|nemotron|o3|o4|gpt-?5|claude-?4|gemini-?2\.5|kimi-?k3|hy4|conatus/i.test(text)) score += 100;
  if (/\bpro\b|v4[-_. ]?pro|qwen3\.?8|qwen4|glm-?5\.[3-9](?![-_. ]?flash)|deepseek-?v4[-_. ]?pro|kimi-?k3/i.test(text)) score += 60;
  if (/flash|mini|lite|air|small|tiny|haiku|nano|turbo/i.test(text)) score -= 40;
  score += Math.log10(Math.max(1, group.contextWindow ?? 0)) * 8;
  score += Math.log10(Math.max(1, group.maxTokens ?? 0)) * 4;
  if (group.reasoning) score += 12;
  if (Array.isArray(group.input) && group.input.includes("image")) score += 8;
  return score;
}

/**
 * 用户点名的「模型库」白名单：积分池分组只保留这 29 个模型（老渠道 23 + Trae
 * 兜底名单里的 3 个真实上游 id；Gemini 6 个已于 ux-v22 按需求整组移出，不再登记）；
 * ux-v29：Trae SOLO 兜底名单里的 DeepSeek-V4-Flash-Official / Pro-Official /
 * MiniMax-M3 以前不在白名单里，产品误判成 solo 或快照缺失时它们会被静默过滤，
 * 表现为「Trae 路由莫名其妙掉了」——现在显式登记，id 原样保留，不做错误映射。
 * CodeArts 只放行 5 个 id，且全部与老渠道同 id 合并成一条，不单独登记。
 * tier 语义：0=免费组（组内按综合能力降序）、1/2/3=三个固定顺位、4=其余（组内按综合能力降序）。
 * index 为用户给出的先后顺序，作为平局时的稳定兜底。
 * 匹配以 poolId / candidate.id 的精确小写为主，slug 兜底应对上游命名差异。
 */
const CURATED_MODELS = [
  ["qiniu/conatus-free", 0],
  // 2026-11-16：hy4free 与 hy3 已从 WorkBuddy 上游目录消失（被 hy4 家族顶掉），
  // 换成现役 id；hy4flash-free 是 0 倍率免费档（960k ctx），进免费组前排。
  ["hy4flash-free", 0],
  ["nvidia/nemotron-3-ultra-550b-a55b0-free", 0],
  ["qwen3.8-flash", 4], // ux-v6：0.04 倍率不是免费模型，退出具免费前排
  ["deepseek-v4.1-flash", 1],
  ["glm-5.3-flash", 2],
  ["glm-5.3-flashx", 3],
  ["kimi-k3.1-pro", 4],
  ["kimi-k3", 4],
  ["deepseek-v4-pro", 4],
  ["step-5-preview", 4],
  ["mimo-v2.6-pro", 4],
  ["doubao-seed-2.1-pro", 4],
  ["doubao-seed-2.1-turbo", 4],
  ["doubao-seed-code", 4],
  ["doubao-seed-evolving", 4],
  ["mimo-v2.6-flash", 4],
  ["qwen3.8-max", 4],
  ["space-bunny", 4],
  ["minimax-m3.1-flash", 4],
  ["glm-5.3", 4],
  ["hy4std", 4],
  ["hy4flash", 4],
  // ux-v29：Trae 兜底/快照里的真实 id（见 lib/providers/trae/index.js 的
  // FALLBACK_TRAE_MODELS），不在白名单会被 mergedModelGroups 静默丢掉。
  ["deepseek-v4-flash-official", 4],
  ["deepseek-v4-pro-official", 4],
  ["minimax-m3", 4],
  // ux-v51：上游新上架的 3 个真新模型（2026-11-26 实测 rawModelCount / droppedModels）——
  //   Trae：qwen4-max（qwen3.8-max 的下一代）、kimi-k3.1-pro-highspeed（k3.1-pro 高速档）；
  //   WorkBuddy：glm-5.4（glm-5.3 的下一代）。不登记就会被 mergedModelGroups 静默丢弃。
  // 同批被滤掉的 glm-5.2 / minimax-m2.7 / kimi-k2.8-preview 是上一代存量，不新增登记。
  ["glm-5.4", 4],
  ["qwen4-max", 4],
  ["kimi-k3.1-pro-highspeed", 4],
  // CodeArts 只保留用户点名的 5 个：deepseek-v4.1-flash / glm-5.3-flash 已在上表，
  // glm-5.3 / kimi-k3 / kimi-k3.1-pro 也已在上表，无需重复登记。
].map(([id, tier], index) => ({
  id,
  idLower: id.toLowerCase(),
  slug: id.toLowerCase().replace(/[^a-z0-9]+/gu, ""),
  tier,
  index,
}));

const CURATED_BY_ID = new Map(CURATED_MODELS.map((c) => [c.idLower, c]));
const CURATED_BY_SLUG = new Map(CURATED_MODELS.map((c) => [c.slug, c]));

/**
 * 给裸 id 求它归属的白名单条目（精确 id 优先，slug 兜底）。名称归并前用它判定
 * 「两个模型是不是同一个点名模型」，因此绝不能把 display name 掺进来。
 */
function curatedEntryOfId(raw) {
  const key = String(raw ?? "").toLowerCase();
  if (key === "") return undefined;
  return CURATED_BY_ID.get(key) ?? CURATED_BY_SLUG.get(nameSlug(key));
}

function nameSlug(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

/** 判断合并后的组是否命中白名单；精确 id 优先，candidate.id 次之，名称 slug 兜底。 */
function curatedKeyOf(group) {
  const exact = [];
  const pushExact = (v) => { if (typeof v === "string" && v) exact.push(v.toLowerCase()); };
  pushExact(group.poolId);
  if (typeof group.poolId === "string" && group.poolId.includes("/")) {
    pushExact(group.poolId.slice(group.poolId.lastIndexOf("/") + 1));
  }
  for (const list of group.candidates?.values?.() ?? []) {
    for (const candidate of list ?? []) pushExact(candidate?.id);
  }
  for (const key of exact) {
    const hit = CURATED_BY_ID.get(key);
    if (hit) return hit;
  }
  for (const key of exact) {
    const hit = CURATED_BY_SLUG.get(nameSlug(key));
    if (hit) return hit;
  }
  const fuzzy = [group.name];
  for (const list of group.candidates?.values?.() ?? []) {
    for (const candidate of list ?? []) fuzzy.push(candidate?.name);
  }
  for (const key of fuzzy) {
    const hit = CURATED_BY_ID.get(String(key ?? "").toLowerCase()) ?? CURATED_BY_SLUG.get(nameSlug(key));
    if (hit) return hit;
  }
  return undefined;
}

/** 综合能力序：免费组 → 三个固定顺位 → 其余；组内按 strengthOf 降序，平局按点名顺序。 */
function curatedDefaultCompare(pa, pb) {
  // ux-v6：免费前排动态判定 —— tier0 白名单被正倍率污染时不再当前排，
  // 运行时限免（g.free）仍可进前排；与性价比序共用同一免费语义。
  const fa = (pa.c.tier === 0 && !(Number.isFinite(pa.g.rate) && pa.g.rate > 0)) || pa.g.free === true;
  const fb = (pb.c.tier === 0 && !(Number.isFinite(pb.g.rate) && pb.g.rate > 0)) || pb.g.free === true;
  if (fa !== fb) return fa ? -1 : 1;
  if (pa.c.tier !== pb.c.tier) return pa.c.tier - pb.c.tier;
  return pb.power - pa.power || pa.c.index - pb.c.index;
}

/** 性价比序：免费优先，其余按倍率升序；同档按能力降序。集合恒为同一批 22 个。 */
function curatedCostCompare(pa, pb) {
  // 免费判定（ux-v6 收窄）：运行时 free 之外，tier0 白名单只在「没有正倍率」时兜底。
  // 白名单里若混进了带倍率的模型（如 qwen3.8-flash 按 0.04 扣分），按真实成本排序，
  // 不再把它标成免费 —— 渠道数据缺失时宁可少标免费，也不虚标。
  const tier0Free = (c) => c.c.tier === 0 && !(Number.isFinite(c.g.rate) && c.g.rate > 0);
  const fa = tier0Free(pa) || pa.g.free === true;
  const fb = tier0Free(pb) || pb.g.free === true;
  if (fa !== fb) return fa ? -1 : 1;
  if (!fa) {
    const ra = pa.g.rate ?? Number.POSITIVE_INFINITY;
    const rb = pb.g.rate ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
  }
  return pb.power - pa.power || pa.c.index - pb.c.index;
}

/** 展示名：打开路由显示时把「来自哪个渠道」拼到模型名后；id 不变，路由仍可解析。 */
export function modelDisplayName(group, showRoutes) {
  const base = String(group.name ?? group.poolId ?? "model");
  if (!showRoutes) return base;
  const labels = Array.isArray(group.channelLabels) && group.channelLabels.length > 0
    ? group.channelLabels
    : [...(group.candidates?.keys?.() ?? [])];
  if (labels.length === 0) return base;
  return base + " · " + [...new Set(labels)].join(" / ");
}

/** 用户点名的两个次优先模型：deepseek-v4.1-flash 与 glm-5.3-flash（词尾边界避免误命中 flashx）。 */
function isFlashPreferred(group) {
  const text = (String(group.poolId) + " " + String(group.name)).toLowerCase();
  return /deepseek[-_. ]?v4\.?1[-_. ]?flash\b|deepseekv4\.?1flash\b|glm[-_. ]?5\.?3[-_. ]?flash\b|glm5\.?3flash\b/u.test(text);
}

/** 旧的全量排序器（保留备用）；实际输出顺序由 curated*Compare 决定。 */
function groupSort(a, b, costFirst) {
  if (costFirst) {
    const ra = a.free ? -1 : (a.rate ?? Number.POSITIVE_INFINITY);
    const rb = b.free ? -1 : (b.rate ?? Number.POSITIVE_INFINITY);
    if (ra !== rb) return ra - rb;
    return strengthOf(b) - strengthOf(a) || a.order - b.order;
  }
  const tier = (g) => (g.free ? 0 : isFlashPreferred(g) ? 1 : 2);
  if (tier(a) !== tier(b)) return tier(a) - tier(b);
  return strengthOf(b) - strengthOf(a) || a.order - b.order;
}

function describeCandidate(route, model) {
  const name = stripRateSuffix(model.name ?? model.id);
  const thinking = model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? model.thinkingLevelMap : undefined;
  const billing = model.billing && typeof model.billing === "object" ? model.billing : {};
  const now = Date.now();
  // 实时限免窗口：只认当前生效、factor === 0 的促销；过期窗口一律不算免费。
  let freeUntil;
  let freeFrom;
  let freeLabel;
  const promos = Array.isArray(model.promotions) ? model.promotions : undefined;
  if (promos) {
    const active = promos
      .filter((p) => {
        if (!p || typeof p !== "object") return false;
        const start = toMs(p.start);
        const end = toMs(p.end);
        const factor = num(p.factor);
        return (start === undefined || now >= start) && (end === undefined || now < end) && (factor === 0 || factor === undefined);
      })
      .sort((l, r) => (r.priority ?? 0) - (l.priority ?? 0));
    const hit = active[0];
    if (hit) {
      freeFrom = toMs(hit.start);
      freeUntil = toMs(hit.end);
      freeLabel = typeof hit.label === "string" ? hit.label : undefined;
    }
  }
  // 直接字段（七牛静态限免等）：同样按当前时间实时判定，活动结束就不再标免费。
  const configuredEnd = toMs(model.freeUntil);
  const configuredStart = toMs(model.freeFrom);
  const inDirectWindow =
    configuredEnd !== undefined && now < configuredEnd && (configuredStart === undefined || now >= configuredStart);
  if (freeFrom === undefined) freeFrom = configuredStart;
  if (freeUntil === undefined && inDirectWindow) freeUntil = configuredEnd;
  if (freeLabel === undefined && typeof model.freeLabel === "string" && (configuredEnd === undefined || inDirectWindow)) {
    freeLabel = model.freeLabel;
  }
  const rate = parseRate(model.rate ?? model.credits ?? billing.credits);
  // 显式配了截止时间但已经过期 → 不再算免费（限免实时性的关键）。
  const deadlineExpired = configuredEnd !== undefined && !inDirectWindow;
  // ux-v6 收窄：上游显式声明的 free 标志若与真实成本矛盾（配了正倍率且没有生效的
  // 限免窗口），以成本为准撤销免费 —— 修复 qwen3.8-flash 被误标免费的问题。
  const paidRate = rate !== undefined && rate > 0;
  const free =
    !deadlineExpired &&
    (rate === 0 ||
      freeUntil !== undefined ||
      ((model.free === true || model.isFree === true || billing.free === true) && !paidRate));
  const badges = Array.isArray(model.badges) ? model.badges.filter((x) => typeof x === "string")
    : Array.isArray(billing.badges) ? billing.badges.filter((x) => typeof x === "string") : [];
  return {
    routeKey: route.key,
    routeDisplayName: route.displayName ?? route.key,
    id: String(model.id),
    name: name === "" ? String(model.id) : name,
    input: Array.isArray(model.input) ? model.input.slice() : ["text"],
    contextWindow: num(model.contextWindow),
    maxTokens: num(model.maxTokens),
    reasoning: model.reasoning === true,
    thinkingLevelMap: thinking,
    priority: route.priority ?? 0,
    free: free === true,
    freeFrom,
    freeUntil,
    freeLabel,
    rate,
    badges,
  };
}

/**
 * 把"路由 × 模型"摊平成组：一个 poolId = 一个用户可见的模型。
 * 返回 [{poolId, name, candidates: Map<routeKey, candidate[]>, contextWindow, maxTokens,
 *        input, reasoning, thinkingLevelMap, routes}]
 */
// ux-v29：每次 mergedModelGroups() 的诊断快照——某条路由「掉了」时，不再靠猜。
// rawModelCount = 该路由 models() 原样返回的条数；curatedModelCount = 进白名单
// 的条数；droppedModels = 被白名单过滤掉的上游 id（最多记 8 个，排查用）。
const routeDiagnostics = new Map();
export function routeModelDiagnostics() {
  return [...routeDiagnostics.entries()].map(([key, value]) => ({ key, ...value }));
}
export function mergedModelGroups(options = {}) {
  // ux-v30: 主循环那次 route.models() 的结果存下来给诊断复用——此前诊断段又调了
  // 两次，注释却写着“不重复调”，热路径上 Trae 的 buildModels() 无缓存，每次重建目录。
  // poolMergeModels 开关保留兼容（历史上控制「路由 × 模型」是否拆条）；
  // 白名单「模型库」恒以「一个模型 = 一条 + 多渠道候选」输出，故不再按 merge 拆条。
  const costFirst = options.costFirst ?? costFirstDefault;
  const diagRawIds = new Map();
  const groups = new Map();
  /**
   * 自定义路由的 key 集合（ux-custom）：白名单旁路用。
   *
   * CURATED_MODELS 是「模型库」白名单 —— 只放行我们点名的那 26 个模型。
   * 自定义路由的存在意义恰恰是**用户自己填的任意模型名**，拿白名单卡它等于
   * 让这个功能彻底无效（新建完一条线路，模型选择器里空空如也）。
   * 所以 custom 路由的模型一律放行，但仍**参与同名归并**：别人那台机器上
   * 接了同样的上游，两条线路会并成一个模型的两条候选，按积分/优先级调度。
   */
  const customRouteKeys = new Set();
  for (const item of registry) {
    const route = item.route;
    if (route.kind === "custom") customRouteKeys.add(route.key);
    let isHidden;
    try {
      isHidden = hiddenMatcher(route.hidden?.() ?? []);
    } catch {
      isHidden = () => false;
    }
    let models = [];
    let modelList = [];
    try {
      models = route.models() ?? [];
      // ux-v31（P0 回归修复）：models() 的返回值不受 assertRoute 约束——它只校验
      // typeof models === "function"，不校验返回值。先归一化成数组再用：
      // 数组原样、其他可迭代（Set）展开、字符串与普通对象一律当空（字符串逐字符迭代是旧版的另一个坑）。
      // ux-v32：展开本身也可能抛（迭代器中途抛错 / Symbol.iterator 的 getter 抛错），
      // 必须和调用一起包在这个 try 里——ux-v31 只兜住了调用，没兜住展开，照样打穿 status。
      modelList = Array.isArray(models)
        ? models
        : models != null && typeof models !== "string" && typeof models[Symbol.iterator] === "function"
          ? [...models]
          : [];
    } catch {
      models = [];
      modelList = [];
    }
    // ux-v30: 诊断用的原始条数 / 隐藏条数 / 原始 id 在这里一次算完，诊断段不再调 models()。
    diagRawIds.set(route.key, modelList.filter((m) => m && typeof m.id === "string").map((m) => m.id.toLowerCase()));
    routeDiagnostics.set(route.key, {
      ...(routeDiagnostics.get(route.key) ?? {}),
      rawModelCount: modelList.length,
      hiddenModelCount: modelList.filter((m) => m && typeof m.id === "string" && isHidden(m.id)).length,
    });
    for (const model of modelList) {
      if (!model || typeof model !== "object" || typeof model.id !== "string" || model.id === "") continue;
      if (isHidden(model.id)) continue;
      const candidate = describeCandidate(route, model);
      // 「模型库」白名单契约：同一模型恒聚合为一个条目（多渠道候选并进 candidates），
      // 这样选择模型后 orderedRoutesFor 才能跨渠道按积分过期顺序调用。
      // poolMergeModels 开关保留兼容，但不再把白名单模型拆成「路由 × 模型」独立条目。
      const idLower = model.id.toLowerCase();
      const ownCurated = curatedEntryOfId(idLower);
      const nameGroupKey = "name:" + normName(candidate.name);
      // 白名单身份 > 名称归并：同名不同价的两档（hy4flash-free 与 hy4flash 的 name 都是
      // "Hy4 flash"）绝不能被名称键并成一组 —— 一个组只能输出一个 poolId，被并掉的那档
      // 在 /v1/models 里彻底消失，请求它只拿到 402 pool_exhausted（2026-11-16 实测）。
      // 允许归并的只有两种情况：本组还没归属任何点名条目，或两者点名的就是同一条目。
      const nameOwner = groups.get(nameGroupKey);
      const ownerCurated = nameOwner === undefined ? undefined : curatedEntryOfId(nameOwner.poolId);
      const nameKeyUsable = nameOwner === undefined || ownCurated === undefined || ownerCurated === ownCurated;
      const keys = [idLower, canonicalId(model.id)];
      if (nameKeyUsable) keys.push(nameGroupKey);
      let group;
      for (const key of keys) {
        if (groups.has(key)) {
          group = groups.get(key);
          break;
        }
      }
      if (!group) {
        group = {
          poolId: canonicalId(model.id) || model.id,
          keepPoolId: false,
          label: undefined,
          candidates: new Map(),
          names: new Map(),
          ids: new Map(),
          order: groups.size,
        };
      }
      for (const key of keys) {
        if (!groups.has(key)) groups.set(key, group);
      }
      const list = group.candidates.get(route.key) ?? [];
      list.push(candidate);
      group.candidates.set(route.key, list);
      const nameKey = normName(candidate.name);
      const seen = group.names.get(nameKey);
      group.names.set(nameKey, { name: seen && seen.name !== candidate.name ? pickName(seen.name, candidate.name) : candidate.name, count: (seen?.count ?? 0) + 1 });
      group.ids.set(candidate.id, (group.ids.get(candidate.id) ?? 0) + 1);
    }
  }

  const unique = [...new Set(groups.values())];
  // 「模型库」白名单：只保留点名的 26 个模型；costFirst 仅在这批里切换排序，集合不变。
  //
  // ux-v14（P2-3）：删掉了 route.libraryBypass 的绕过分支。历史上来历是「Gemini / CodeArts
  // 这类上游 id 会漂移，写死白名单会漏模型」，实际后果是 13 个动态模型以 tier:4 / index:1000+
  // 静默灌进模型库，白名单形同虚设。现在两家 id 都已显式登记在 CURATED_MODELS 里，
  // **白名单是唯一真相源**：上游多出任何未登记 id 一律不进池（要加模型 = 往表里加一行）。
  const curated = [];
  for (let i = 0; i < unique.length; i += 1) {
    const group = summarizeGroup(unique[i]);
    group.order = i;
    const c = curatedKeyOf(group);
    if (!c) {
      // —— 白名单旁路：只要本组有**自定义路由**的候选就保留 ——
      //
      // 自定义线路的模型名是用户从上游文档抄来的，我们无从预知，也不可能往
      // CURATED_MODELS 里登记 —— 所以这里给它们一条专用的合成条目。
      //
      // 合成条目的两个字段只是为了让排序比较器不炸（它读 pa.c.tier / pa.c.index）：
      //   tier: 5 —— 排在白名单四档之后（自建线路是「兜底」，不该抢前排）；
      //   index: 用 group.order 保序，避免所有自定义组比较器相等导致顺序抖动。
      // poolId **不改写**：它就是上游声明的模型 id，改写会把请求路由到不存在的名字。
      const hasCustom = [...group.candidates.keys()].some((routeKey) => customRouteKeys.has(routeKey));
      if (!hasCustom) continue;
      curated.push({
        g: group,
        c: { idLower: String(group.poolId).toLowerCase(), tier: 5, index: group.order, synthetic: true },
        power: strengthOf(group),
      });
      continue;
    }
    // 统一规范 poolId 为白名单 id：让 buildModels / v1/models / orderedRoutesFor /
    // poolStatusDocument 四处一致，避免上游别名或渠道前缀导致「选中模型找不到路由」。
    group.poolId = c.idLower;
    curated.push({ g: group, c, power: strengthOf(group) });
  }
  // ux-v53：poolId 唯一性不变量。alias-first 注册顺序下，同一白名单 id 的候选会散在
  // 两个 group 对象里（各自在上面被改写成同一个 poolId）——不合并则 /v1/models 出现
  // 两条同名，请求第二条永远 402 pool_exhausted。按 poolId 合并候选，保证输出去重，
  // 且与注册顺序无关（canonical-first 与 alias-first 结果一致）。
  const mergedByPoolId = new Map();
  for (const entry of curated) {
    const existing = mergedByPoolId.get(entry.g.poolId);
    if (!existing) { mergedByPoolId.set(entry.g.poolId, entry); continue; }
    const target = existing.g;
    for (const [routeKey, list] of entry.g.candidates) {
      const slot = target.candidates.get(routeKey) ?? [];
      slot.push(...list);
      target.candidates.set(routeKey, slot);
    }
    for (const [nameKey, info] of entry.g.names) {
      const seen = target.names.get(nameKey);
      target.names.set(nameKey, {
        name: seen && seen.name !== info.name ? pickName(seen.name, info.name) : info.name,
        count: (seen?.count ?? 0) + info.count,
      });
    }
    for (const [id, n] of entry.g.ids) target.ids.set(id, (target.ids.get(id) ?? 0) + n);
  }
  const deduped = [...mergedByPoolId.values()].map((entry) => ({ ...entry, power: strengthOf(entry.g) }));
  deduped.sort(costFirst ? curatedCostCompare : curatedDefaultCompare);
  curated.length = 0;
  curated.push(...deduped);
  // ux-v29 诊断：白名单后每条路由还剩几条、丢了哪些 id（id 来自主循环存下的那份，不再调 models()）。
  {
    const kept = new Map();
    const keptIds = new Map();
    for (const entry of curated) {
      for (const routeKey of entry.g.candidates.keys()) {
        kept.set(routeKey, (kept.get(routeKey) ?? 0) + 1);
        const ids = keptIds.get(routeKey) ?? new Set();
        for (const list of entry.g.candidates.get(routeKey) ?? []) ids.add(String(list.id).toLowerCase());
        keptIds.set(routeKey, ids);
      }
    }
    for (const [key, diag] of routeDiagnostics) {
      const rawIds = new Set(diagRawIds.get(key) ?? []);
      const dropped = [...rawIds].filter((id) => !(keptIds.get(key)?.has(id) ?? false)).slice(0, 8);
      routeDiagnostics.set(key, { ...diag, curatedModelCount: kept.get(key) ?? 0, droppedModels: dropped });
    }
  }
  return curated.map((entry) => entry.g);
}

/** 同一个模型在多个渠道的写法里挑一个当展示名：票多者胜，平票偏向带大写的写法。 */
function pickName(left, right) {
  const upperLeft = /[A-Z]/u.test(left);
  const upperRight = /[A-Z]/u.test(right);
  if (upperLeft !== upperRight) return upperRight ? right : left;
  return left.length <= right.length ? left : right;
}

function mostCommon(entries) {
  if (entries.length === 0) return undefined;
  let best;
  for (const value of entries) {
    if (!best || value.count > best.count) best = value;
  }
  return best?.name;
}

function summarizeGroup(group) {
  let contextWindow;
  let maxTokens;
  let reasoning = false;
  let input = ["text"];
  let free = false;
  let freeUntil;
  let freeFrom;
  let freeLabel;
  let rate;
  const badges = new Set();
  const levels = new Set();
  const routes = [];
  const channelLabels = [];
  for (const [routeKey, list] of group.candidates) {
    routes.push(routeKey);
    const channelLabel = list?.[0]?.routeDisplayName;
    if (channelLabel) channelLabels.push(channelLabel);
    for (const candidate of list) {
      if (candidate.contextWindow !== undefined) {
        contextWindow = contextWindow === undefined ? candidate.contextWindow : Math.max(contextWindow, candidate.contextWindow);
      }
      if (candidate.maxTokens !== undefined) {
        maxTokens = maxTokens === undefined ? candidate.maxTokens : Math.max(maxTokens, candidate.maxTokens);
      }
      if (candidate.reasoning) reasoning = true;
      if (candidate.input.includes("image")) input = ["text", "image"];
      if (candidate.free) {
        free = true;
        if (candidate.freeUntil !== undefined && (freeUntil === undefined || candidate.freeUntil > freeUntil)) {
          freeUntil = candidate.freeUntil;
          freeFrom = candidate.freeFrom;
          freeLabel = candidate.freeLabel;
        } else if (freeUntil === undefined && candidate.freeLabel) {
          freeLabel = candidate.freeLabel;
        }
      }
      if (candidate.rate !== undefined && (rate === undefined || candidate.rate < rate)) rate = candidate.rate;
      for (const badge of candidate.badges ?? []) badges.add(badge);
      if (candidate.thinkingLevelMap) {
        for (const [level, wire] of Object.entries(candidate.thinkingLevelMap)) {
          if (wire === null || wire === undefined) continue;
          levels.add(level);
        }
      }
    }
  }
  const thinkingLevelMap = {};
  for (const level of EFFORT_LEVELS) {
    if (levels.has(level)) thinkingLevelMap[level] = level;
  }
  // ux-v6 组级纠错：跨渠道 OR 聚合可能让「一条限免渠道」把整组标免费，
  // 但组倍率取的是 min —— 若纠错后仍有正倍率且没有任何生效限免窗口，撤销免费。
  if (free && rate !== undefined && rate > 0 && freeUntil === undefined) {
    free = false;
    freeFrom = undefined;
    freeLabel = undefined;
  }
  const idVotes = [...group.ids.entries()].sort((a, b) => b[1] - a[1]);
  const rawPoolId = String(group.poolId);
  const canonical = canonicalId(rawPoolId);
  const votedId = idVotes.length > 0 && idVotes[0][1] > 1 ? idVotes[0][0] : undefined;
  const poolId = group.keepPoolId
    ? rawPoolId
    : canonical !== rawPoolId.toLowerCase() || votedId === undefined ? canonical : votedId;
  return {
    poolId: String(poolId),
    name: group.label ?? mostCommon([...group.names.values()]) ?? rawPoolId,
    candidates: group.candidates,
    contextWindow,
    maxTokens,
    input,
    reasoning,
    thinkingLevelMap,
    routes,
    channelLabels: [...new Set(channelLabels)],
    order: group.order,
    free,
    freeFrom,
    freeUntil,
    freeLabel,
    rate,
    badges: [...badges],
  };
}

// ── 路由顺序 / 粘性 / 熔断 ──────────────────────────────────────────────

const credits = new Map();
const latches = new Map();
const breakers = new Map();
const BREAKER_MS = 60_000;
/**
 * 不同失败原因的冷却时长。
 * · quota     —— 额度耗尽：60 秒后重试（可能换号、可能整点恢复）；
 * · transport —— 502/超时/连接断：60 秒；
 * · auth      —— 账号被封 / 掉登录 / 上游 401·403：10 分钟。这类失败不会自己好，
 *               60 秒一撞只会让每个请求都白打一遍上游（workbuddy4 被封时就是这样）；
 *               又不能太长，否则重新登录后要干等。
 */
const BREAKER_TTL_MS = { quota: 60_000, transport: 60_000, auth: 10 * 60_000, upstream: 15_000, capacity: 20_000 };
/*
 * capacity —— 上游「并发会话占满」（CodeArts 免费档只允许 3 个会话，第 4 个请求必被
 * 400 打回，TM.00001041）。它不是额度耗尽、也不是账号坏了：被打断的会话约一分钟才
 * 释放，所以冷却要短（20 秒），且绝不该像 auth 那样锁 10 分钟。
 */

/**
 * 记住某条路由刚刚报过的失败，冷却期内不再优先尝试。
 * capacity 单独成一档：它既不能按 60 秒（那会把唯一能用的免费路由锁死），
 * 也不能并进 auth。
 */
export function noteRouteFailure(routeKey, kind) {
  const normalized = kind === "quota"
    ? "quota"
    : kind === "auth"
      ? "auth"
      : kind === "upstream"
        ? "upstream"
        : kind === "capacity"
          ? "capacity"
          : "transport";
  breakers.set(routeKey, { kind: normalized, at: Date.now() });
}

/** 路由成功后清掉熔断标记（成功即自愈）。 */
export function noteRouteSuccess(routeKey) {
  breakers.delete(routeKey);
}

/**
 * 状态快照：和 breakerReport 用同一套 TTL 口径，顺手把已经过期的条目删掉。
 * 之前直接摊 breakers.entries()，一条路由熔断后若没被再次探测（当前模型不在它的候选里），
 * 20 秒的 capacity 冷却也能在面板上挂几个小时，看起来像永远熔断。
 */
export function breakerSnapshot(now = Date.now()) {
  const out = [];
  for (const [routeKey, hit] of breakers) {
    const ttl = BREAKER_TTL_MS[hit.kind] ?? BREAKER_MS;
    if (now - hit.at > ttl) {
      breakers.delete(routeKey);
      continue;
    }
    out.push({ key: routeKey, kind: hit.kind, at: hit.at, leftMs: ttl - (now - hit.at) });
  }
  return out.sort((a, b) => a.leftMs - b.leftMs);
}

/** 当前处于冷却中的路由（给状态接口 / 报错文案用，只读快照）。 */
export function breakerReport() {
  const now = Date.now();
  const out = [];
  for (const [routeKey, hit] of breakers) {
    const ttl = BREAKER_TTL_MS[hit.kind] ?? BREAKER_MS;
    const left = ttl - (now - hit.at);
    if (left > 0) out.push({ route: routeKey, kind: hit.kind, leftMs: left });
  }
  return out.sort((a, b) => a.leftMs - b.leftMs);
}

/**
 * 手动清冷却：重新登录 / 换号之后不必干等冷却走完。
 * 传 routeKey 清那一条；不传（或空串）清全部。返回清掉的条数。
 */
export function clearBreakers(routeKey) {
  if (typeof routeKey !== "string" || routeKey === "") {
    const count = breakers.size;
    breakers.clear();
    return count;
  }
  return breakers.delete(routeKey) ? 1 : 0;
}

function breakerActive(routeKey, now) {
  const hit = breakers.get(routeKey);
  if (!hit) return false;
  if (now - hit.at > (BREAKER_TTL_MS[hit.kind] ?? BREAKER_MS)) {
    breakers.delete(routeKey);
    return false;
  }
  return true;
}

/**
 * 当日桶判据：expiring 只有在「今天（Asia/Shanghai）结束前就过期」时才算当日将作废余额。
 * 否则它只是套餐期末到期量（CodeArts 的 periodEnd 是 12-03），拿它抢队首会让
 * 真正更早到期的路由（trae/trae2，11-30）永远烧不到。
 */
export function expiringToday(credit, now) {
  if (!credit || typeof credit !== "object") return false;
  const amount = credit.expiring;
  const at = credit.expiringAtMs;
  if (typeof amount !== "number" || !(amount > 0)) return false;
  if (typeof at !== "number" || !Number.isFinite(at)) return false;
  const sh = new Date(now + 8 * 3600_000);
  const dayEnd = Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate()) + 16 * 3600_000;
  return at <= dayEnd;
}

/** 任务粘性：让 poolId 下次优先走 routeKey。 */
export function setLatch(poolId, routeKey) {
  if (!poolId || !routeKey) return;
  latches.set(String(poolId), String(routeKey));
}

export function latchOf(poolId) {
  return latches.get(String(poolId));
}

/**
 * 某路由额度耗尽/熔断后，清掉所有指向它的任务粘性。
 * 下一次请求会自然按「最早过期优先」走到下一条路由，不会中断当前这一轮思考。
 */
export function releaseLatchesForRoute(routeKey) {
  let removed = 0;
  for (const [poolId, key] of latches) {
    if (key === routeKey) {
      latches.delete(poolId);
      removed += 1;
    }
  }
  return removed;
}

function isVoucherRoute(route) {
  return route.kind === "bailian" || route.voucher === true;
}

function routeRank(entry) {
  const credit = credits.get(entry.route.key);
  const expiry = credit?.expiryMs;
  return [
    typeof expiry === "number" && Number.isFinite(expiry) ? expiry : Number.MAX_SAFE_INTEGER,
    Number.isFinite(entry.route.priority) ? entry.route.priority : 0,
    entry.index,
  ];
}

function compareRank(a, b) {
  const ra = routeRank(a);
  const rb = routeRank(b);
  for (let i = 0; i < ra.length; i += 1) {
    if (ra[i] !== rb[i]) return ra[i] - rb[i];
  }
  return 0;
}

/**
 * a 是否在「到期时间 → priority」这两级上严格排在 b 前面（ux-v36）。
 * 第三级注册序不参与判定：两条路由只在注册序上不同，才算「同一档」，
 * 粘性才允许在它们之间换先后。
 */
function ranksBefore(a, b) {
  const ra = routeRank(a);
  const rb = routeRank(b);
  return ra[0] < rb[0] || (ra[0] === rb[0] && ra[1] < rb[1]);
}

// ── 同档同类路由的积分均衡（ux-v47）──────────────────────────────────────

/**
 * 用户规则：正常按「最早过期优先」调用时，两条同类路由（如 trae / trae2）若到期时间
 * 相同，就一直烧其中一条；直到另一条比它多出 300 分以上才换过去，换过去后同样烧到
 * 反过来比另一条少 300 分以上再换回来。300 分是滞回带，避免每消耗一点就来回切。
 *
 * 「同档同类」判据 = 同 kind + 同 expiryMs + 同 priority。只有同一渠道的多槽
 * （trae/trae2、workbuddy1..3、qoder1/qoder2）才互相均衡；不同渠道就算到期时间
 * 撞在一起也不混着算。
 */
const CREDIT_BALANCE_GAP = 300;
const balanceCurrent = new Map(); // tierKey -> 当前正在烧的 routeKey

function balanceTierKeyOf(route, credit) {
  const expiry = credit?.expiryMs;
  const expiryKey = typeof expiry === "number" && Number.isFinite(expiry) ? String(expiry) : "none";
  const priority = Number.isFinite(route.priority) ? route.priority : 0;
  const kind = typeof route.kind === "string" ? route.kind : "";
  return kind + "|" + expiryKey + "|" + priority;
}

/** 各档当前正在烧的路由（状态接口 / 排查用，只读快照）。 */
export function creditBalanceReport() {
  // ux-v49：report 只呈现「当前可均衡的档」——单路由档（该 tier 在注册表只剩 0 或 1 条）没有
  // 均衡意义，留着会让人误以为在均衡（codearts 当日桶曾偶现就是历史 balanceCurrent 残留）；
  // 同时过滤 balanceCurrent 指向已下线路由的孤儿指针（配置重载而非 unregister 时清理走不到）。
  // 只过滤呈现，不删 balanceCurrent 记忆：路由回来还能继续用，unregister 的清记忆路径不变。
  const counts = new Map();
  for (const entry of registry) {
    const key = balanceTierKeyOf(entry.route, credits.get(entry.route.key));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out = [];
  for (const [tier, routeKey] of balanceCurrent) {
    if ((counts.get(tier) ?? 0) < 2) continue;
    if (!registry.some((entry) => entry.route.key === routeKey)) continue;
    const remaining = credits.get(routeKey)?.remaining;
    out.push({
      tier,
      routeKey,
      remaining: typeof remaining === "number" && Number.isFinite(remaining) ? remaining : undefined,
    });
  }
  return out;
}

/**
 * 按 300 分滞回对「同档同类」的路由重排，返回新数组与本池的均衡锚点。
 * 锚点 = 该档当前该烧的那条：latch 不得越过锚点，否则粘性会把刚切过去的路由又压回
 * 身后 —— 每轮都「切一次、被 latch 拉回」，差值永远落在 300 以内，均衡等于不生效。
 */
function applyCreditBalance(items) {
  const anchors = new Set();
  // ux-v48：tier -> 该档当前首选。粘性要知道「本档已经被均衡换给别人了」，
  // 否则 latch 会在同档非锚点路由处提前 break，插到锚点前面，把刚换过去的路由又顶回身后。
  const tiers = new Map();
  if (items.length < 2) return { ordered: items, anchors, tiers };
  const buckets = new Map();
  for (let at = 0; at < items.length; at += 1) {
    const item = items[at];
    const key = balanceTierKeyOf(item.route, credits.get(item.routeKey));
    const bucket = buckets.get(key);
    if (bucket) bucket.push(at);
    else buckets.set(key, [at]);
  }
  const out = items.slice();
  for (const [tierKey, slots] of buckets) {
    if (slots.length < 2) continue;
    const block = slots.map((at) => items[at]);
    // 余额还有没拉到的（signed-out / 刚注册）就不猜，保持原序。
    const allMeasured = block.every((item) => {
      const remaining = credits.get(item.routeKey)?.remaining;
      return typeof remaining === "number" && Number.isFinite(remaining);
    });
    if (!allMeasured) continue;
    let current = balanceCurrent.get(tierKey);
    if (current === undefined || !block.some((item) => item.routeKey === current)) {
      current = block[0].routeKey;
    }
    let top = block[0];
    for (const item of block) {
      if (credits.get(item.routeKey).remaining > credits.get(top.routeKey).remaining) top = item;
    }
    const gap = credits.get(top.routeKey).remaining - credits.get(current).remaining;
    if (top.routeKey !== current && gap > CREDIT_BALANCE_GAP) {
      current = top.routeKey;
    }
    // ux-v48：没换手的档也要记下来，否则 creditBalanceReport / 面板只看得见换过手的档，
    // 会误以为没换手的档不在均衡。写回是幂等的（同键同值）。
    balanceCurrent.set(tierKey, current);
    anchors.add(current);
    tiers.set(tierKey, current);
    const chosen = block.find((item) => item.routeKey === current) ?? block[0];
    const rest = block.filter((item) => item !== chosen);
    const reordered = [chosen, ...rest];
    for (let i = 0; i < slots.length; i += 1) out[slots[i]] = reordered[i];
  }
  return { ordered: out, anchors, tiers };
}

/**
 * 某模型的具体路由尝试顺序。
 * 返回 [{routeKey, route, candidate, candidates}]
 */
export function orderedRoutesFor(poolId, options = {}) {
  const group = mergedModelGroups({ merge: options.merge, costFirst: options.costFirst }).find((item) => item.poolId === poolId);
  if (!group) return [];
  const now = Date.now();
  const voucherFirst = options.voucherFirst ?? voucherFirstDefault;
  const live = [];
  for (const [routeKey, list] of group.candidates) {
    // ignoreBreakers：单路由组（gemini）在 quota/transport 冷却期做最后一次探测时用，
    // 避免一次偶发 429 把整组锁死 60 秒；auth 冷却（掉登录/封号）不走这条路径。
    if (!options.ignoreBreakers && breakerActive(routeKey, now)) continue;
    const entry = entryOf(routeKey);
    if (!entry) continue;
    live.push({ routeKey, route: entry.route, candidate: list[0], candidates: list, entry });
  }
  const normal = live.filter((item) => !isVoucherRoute(item.route)).sort(compareRank);
  const vouchers = live.filter((item) => isVoucherRoute(item.route)).sort(compareRank);
  let ordered = voucherFirst ? [...vouchers, ...normal] : [...normal, ...vouchers];
  // ux-v47：「积分差 >300 才换手」的滞回均衡只在同档同类块内换先后，不碰档间顺序。
  // latch 先取：被本池服务成功过的那条路由本身就是该档「当前该烧的那条」，先播种进
  // balanceCurrent，均衡才不会把刚服务的路由立刻换掉（否则每轮都切一次再被粘性拉回）。
  const latch = latchOf(group.poolId);
  if (latch && options.balanceCredits !== false && ordered.some((item) => item.routeKey === latch)) {
    const latchEntry = entryOf(latch);
    const latchCredit = credits.get(latch);
    if (latchEntry && latchCredit) balanceCurrent.set(balanceTierKeyOf(latchEntry.route, latchCredit), latch);
  }
  const balance = options.balanceCredits === false
    ? { ordered, anchors: new Set(), tiers: new Map() }
    : applyCreditBalance(ordered);
  ordered = balance.ordered;
  const balanceAnchors = balance.anchors;
  // ux-v48：本档若已被均衡判定该烧别的路由，粘性不得再抬升 —— 同档有三条以上路由时，
  // floor 扫描会先在同档非锚点路由处 break，于是 latch 插到锚点前面，差值又被拉回 300 内，
  // 均衡等于不生效（2 路由档正好在锚点处 break，所以只有 3+ 档暴露）。
  const latchCredit = latch ? credits.get(latch) : undefined;
  const latchRoute = latch ? entryOf(latch)?.route : undefined;
  const latchTierKey = latch && latchRoute && latchCredit ? balanceTierKeyOf(latchRoute, latchCredit) : "";
  const balancedTo = latchTierKey ? balance.tiers.get(latchTierKey) : undefined;
  const balancedElsewhere = typeof balancedTo === "string" && balancedTo !== latch;
  if (latch && !balancedElsewhere) {
    const at = ordered.findIndex((item) => item.routeKey === latch);
    if (at > 0) {
      // ux-v14：粘性不得越过「当日将过期余额还没烧完」的路由——烧当日积分的优先级
      // 高于任务粘性，否则上次会话钉在别的路由上，当日额度就白白过期了。
      // ux-v42：排序的骨架就是「到期时间 → priority」，粘性只允许在两级都相同（仅注册序
      // 不同）的路由之间换先后。此前只让位给 expiring>0 的头部块，于是 latch 钉在 12-05
      // 到期的 workbuddy2 上时会把 11-30 到期的 trae 顶到身后 —— 晚到期的先烧、早到期的
      // 先作废，与「最早过期优先」正好相反。
      // burnExpiringFirst === false 时保留旧行为（粘性压过一切）。
      let floor = 0;
      if (options.burnExpiringFirst !== false) {
        while (floor < at) {
          const head = ordered[floor];
          const burnsToday = expiringToday(credits.get(head.routeKey), now);
          // ux-v47：均衡锚点也吃同样的保护 —— latch 越过它，刚切过去的路由下一轮就被拉回，
          // 差值永远落在 300 以内，均衡再也切不动。
          if (!burnsToday && !balanceAnchors.has(head.routeKey) && !ranksBefore(head, ordered[at])) break;
          floor += 1;
        }
      }
      if (floor < at) {
        // 把 latch 路由插到 floor 位（紧贴在「当日桶 / 更早到期」的头部块之后），其余相对次序不变。
        const item = ordered[at];
        ordered = [...ordered.slice(0, floor), item, ...ordered.slice(floor, at), ...ordered.slice(at + 1)];
      }
    }
  }
  return ordered.map(({ routeKey, route, candidate, candidates }) => ({ routeKey, route, candidate, candidates }));
}

// ── 并发闸门 ──────────────────────────────────────────────────────────────

const inflight = new Map();

/**
 * ux-v54：本机并发闸门。
 *
 * CodeArts 免费档「同时只允许 3 个会话」是一堵硬墙：第 4 个并发请求一定被上游 400
 * 打回（TM.00001041）。池的顺序回退在它面前没有意义 —— 三条免费路由本来就是同一份
 * 额度，换一条还是撞同一堵墙，只是白烧一次请求。所以这里做排队而不是失败：
 * 路由声明 maxInflight，池循环发请求前 acquire，拿不到槽位就跳过这条路由（不记熔断），
 * 把并发交还给闸门，选哪条路由才留给池。
 *
 * 语义与熔断正交：熔断记的是这条路刚坏过，闸门记的是这条路正忙。
 *
 * @param {string} routeKey 池内路由 key（qoder1/codearts/...）
 * @param {number} max 上限；非正数或不给 = 不设闸门（返回一个什么都不做的 release）
 * @returns {null | (() => void)} 满额返回 null（调用方跳过该路由），否则返回幂等 release
 */
export function acquireRouteInflight(routeKey, max) {
  const limit = Number.isFinite(max) ? Math.floor(Number(max)) : 0;
  if (limit <= 0) return function noopRelease() {};
  const current = inflight.get(routeKey) ?? 0;
  if (current >= limit) return null;
  inflight.set(routeKey, current + 1);
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    const left = (inflight.get(routeKey) ?? 1) - 1;
    if (left <= 0) inflight.delete(routeKey);
    else inflight.set(routeKey, left);
  };
}

/** 某路由当前占用（状态接口 / 日志用）。 */
export function inflightCountOf(routeKey) {
  return inflight.get(routeKey) ?? 0;
}

// ── 推理档位翻译 ─────────────────────────────────────────────────────────

function declaredLevels(candidate) {
  const map = candidate?.thinkingLevelMap;
  if (!map || typeof map !== "object") return [];
  return EFFORT_LEVELS.filter((level) => map[level] !== null && map[level] !== undefined);
}

/**
 * 把 DSH 档位翻译成上游档位：优先原名直通，否则取最近的已声明档位，
 * 距离相同取更强的一侧（宁可多推理，不要悄悄降档）。
 */
export function translateEffort(candidate, effort) {
  if (effort === undefined || effort === null || effort === "") return undefined;
  const level = String(effort).toLowerCase();
  const map = candidate?.thinkingLevelMap;
  if (!map || typeof map !== "object") return level;
  if (Object.prototype.hasOwnProperty.call(map, level) && map[level] !== null && map[level] !== undefined) {
    return map[level];
  }
  if (level === "off") return map.off === null || map.off === undefined ? null : map.off;
  const levels = declaredLevels(candidate);
  if (levels.length === 0) return undefined;
  const target = EFFORT_LEVELS.indexOf(level);
  if (target < 0) return map[levels[levels.length - 1]];
  let best = levels[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidateLevel of levels) {
    const distance = Math.abs(EFFORT_LEVELS.indexOf(candidateLevel) - target);
    const score = distance * 2 + (EFFORT_LEVELS.indexOf(candidateLevel) >= target ? 0 : 1);
    if (score < bestScore) {
      best = candidateLevel;
      bestScore = score;
    }
  }
  return map[best];
}

// ── 积分 / 状态 ─────────────────────────────────────────────────────────

function minExpiry(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  let best;
  let fallback;
  for (const account of list) {
    if (!account || typeof account !== "object") continue;
    const at =
      toMs(account.endTimeMs) ??
      toMs(account.endTime) ??
      toMs(account.expireAt) ??
      toMs(account.expiresAt) ??
      toMs(account.expiry) ??
      toMs(account.expireTime);
    if (at === undefined) continue;
    if (fallback === undefined || at < fallback) fallback = at;
    // 已耗尽的裂变包 endTimeMs 往往最早，但它不再承载任何可用积分；
    // 只有仍有余额（或未提供余额字段）的包才参与「真实最早到期」的计算。
    const remain = num(account.remain) ?? num(account.remaining);
    if (remain !== undefined && remain <= 0) continue;
    if (best === undefined || at < best) best = at;
  }
  return best ?? fallback;
}

function extractCredits(doc, route, now = Date.now()) {
  if (!doc || typeof doc !== "object") return undefined;
  const voucher = doc.voucher && typeof doc.voucher === "object" ? doc.voucher : undefined;
  /**
   * 渠道自报的**账号归属**（谁登的）。
   *
   * 池里多条同 kind 路由（trae / trae2、qoder1 / qoder2）以前在面板上只能看到
   * 余额与到期时间 —— 两个槽被 adopt 成同一个号时，两行数字一模一样，却没有任何
   * 字段能证明「这是同一个号」。这里把 provider 报的 userId 原样带出去，由界面做
   * 同号告警（判重在界面，池内核不据此做任何路由决策）。
   */
  const identity = doc.identity !== null && typeof doc.identity === "object" ? doc.identity : undefined;
  // 免费无限量渠道的 remaining 是"占位大数"，不能计入真实积分总额。
  const syntheticBalance = doc.syntheticBalance === true;
  if (typeof doc.status === "string" && doc.status !== "signed-in" && doc.status !== "ok") {
    return { signedOut: true, accounts: [] };
  }
  const policy = policyCreditExpiry(route, doc, now);
  const policyFields = policy
    ? { expiryEstimated: true, expirySource: policy.source, expiryPolicy: policy.policy, expiryUrls: policy.urls }
    : {};
  const creditsDoc =
    doc.credits && typeof doc.credits === "object"
      ? doc.credits
      : typeof doc.total === "number" || Array.isArray(doc.accounts)
        ? doc
        : undefined;
  const quotaDoc = doc.quota && typeof doc.quota === "object" ? doc.quota : undefined;
  if (creditsDoc) {
    const accounts = Array.isArray(creditsDoc.accounts) ? creditsDoc.accounts : [];
    const remaining =
      num(creditsDoc.remain) ?? num(creditsDoc.remaining) ?? num(creditsDoc.total) ?? num(creditsDoc.balance);
    const total = num(creditsDoc.total) ?? num(creditsDoc.quota);
    // ux-v14：「当日将过期余额」是池的一等公民信号——任何渠道报了 expiring（当天午夜作废的量），
    // 池内核就要在它烧完之前优先用这条路由（expiryMs 被 expiringAt 拉近），烧完自动回落。
    const expiring = num(creditsDoc.expiring) ?? accounts.reduce((sum, account) => sum + (num(account?.expiring) ?? 0), 0);
    const expiringAtMs = toMs(creditsDoc.expiringAt) ?? toMs(creditsDoc.dailyExpiringAt);
    const upstreamExpiry =
      minExpiry(accounts) ??
      toMs(creditsDoc.endTime) ??
      toMs(creditsDoc.expireAt) ??
      toMs(creditsDoc.expiresAt) ??
      toMs(creditsDoc.expiry) ??
      toMs(voucher?.expiresSoonest);
    const baseExpiry = upstreamExpiry ?? policy?.expiryMs;
    const expiryMs =
      typeof expiring === "number" && expiring > 0 && expiringAtMs !== undefined
        ? Math.min(baseExpiry ?? Number.MAX_SAFE_INTEGER, expiringAtMs)
        : baseExpiry;
    const usePolicy = upstreamExpiry === undefined && policy !== undefined && expiryMs === policy.expiryMs;
    return {
      remaining,
      total,
      accounts,
      expiryMs,
      ...(usePolicy ? policyFields : {}),
      ...(typeof expiring === "number" && expiring > 0 ? { expiring, expiringAtMs } : {}),
      signedOut: false,
      voucher,
      syntheticBalance,
      ...(identity === undefined ? {} : { identity }),
    };
  }
  if (quotaDoc) {
    const remaining = num(quotaDoc.remaining) ?? num(quotaDoc.total) ?? num(quotaDoc.totalCredits);
    const upstreamExpiry = toMs(voucher?.expiresSoonest);
    const expiryMs = upstreamExpiry ?? policy?.expiryMs;
    const usePolicy = upstreamExpiry === undefined && policy !== undefined && expiryMs === policy.expiryMs;
    return { remaining, total: num(quotaDoc.total), accounts: [], expiryMs, ...(usePolicy ? policyFields : {}), signedOut: false, voucher, syntheticBalance, ...(identity === undefined ? {} : { identity }) };
  }
  if (policy) {
    return { accounts: [], expiryMs: policy.expiryMs, ...policyFields, signedOut: false, voucher, syntheticBalance };
  }
  return undefined;
}

/**
 * 拉一遍各渠道余额（默认 5 分钟软缓存；force 刷指定的那些）。
 *
 * options.only：只刷这些 routeKey。ux-v14 的「烧一次当日额度就更新记账」走这条路——
 * 每次成功服务都 force 全池等于每条路由都打一次上游（10 条就是 10 个 HTTP），
 * 而那时只有刚服务过的那条路由余额真的变了。
 */
/** 同一路由的在飞拉取；并发强刷复用同一个 Promise，避免重复打上游与旧值覆盖新值。 */
const creditRefreshInFlight = new Map();

export async function refreshPoolCredits(options = {}) {
  const force = options.force === true;
  const ttl = Number.isFinite(options.ttlMs) ? options.ttlMs : 300_000;
  const only = Array.isArray(options.only) && options.only.length > 0 ? new Set(options.only) : undefined;
  const now = Date.now();
  await Promise.all(
    poolRoutes().map((route) => {
      if (only && !only.has(route.key)) return undefined;
      const cached = credits.get(route.key);
      if (!force && cached && now - cached.at < ttl) return undefined;
      const inflightRefresh = creditRefreshInFlight.get(route.key);
      if (inflightRefresh !== undefined) return inflightRefresh;
      const job = refreshOneRoute(route, now);
      creditRefreshInFlight.set(route.key, job);
      const done = () => {
        if (creditRefreshInFlight.get(route.key) === job) creditRefreshInFlight.delete(route.key);
      };
      void job.then(done, done);
      return job;
    }),
  );
}

/** 单条路由的余额拉取（refreshPoolCredits 的内部实现）。 */
async function refreshOneRoute(route, now) {
      let doc;
      try {
        if (typeof route.credits === "function") doc = await route.credits();
        else if (typeof route.status === "function") doc = await route.status();
        else doc = { status: "ok" };
        if (doc === undefined || doc === null) doc = { status: "signed-out" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const previous = credits.get(route.key);
        // 一次网络抖动不该把面板上已经显示的余额抹成 0。上一份好数据继续用，
        // 只打 stale + error + lastGoodAt，等下一次成功拉取自然覆盖。
        const keepable =
          previous !== undefined &&
          previous.signedOut !== true &&
          (typeof previous.remaining === "number" ||
            (Array.isArray(previous.accounts) && previous.accounts.length > 0) ||
            typeof previous.expiryMs === "number");
        if (keepable) {
          credits.set(route.key, {
            ...previous,
            at: now,
            error: message,
            stale: true,
            lastGoodAt: previous.lastGoodAt ?? (typeof previous.at === "number" ? previous.at : now),
          });
          return;
        }
        credits.set(route.key, { at: now, error: message, accounts: [], signedOut: true });
        return;
      }
      const parsed = extractCredits(doc, route, now);
      credits.set(route.key, { at: now, ...(parsed ?? { accounts: [] }), stale: false, lastGoodAt: now });
  if (typeof parsed?.remaining === "number" && Number.isFinite(parsed.remaining)) {
    noteCreditObservation(route.key, parsed.remaining, new Date().toISOString());
  }
}

/** 用量账本积分采样：成功服务后按最小间隔强刷单条路由余额，让余额差落到账本。
 *  只刷刚服务过的这一条（only），20 秒节流，避免每个请求都打上游。 */
const creditSampleAt = new Map();
const CREDIT_SAMPLE_MIN_MS = 20_000;
export function sampleUsageCredits(routeKey) {
  if (typeof routeKey !== "string" || routeKey === "") return;
  const now = Date.now();
  if (now - (creditSampleAt.get(routeKey) ?? 0) < CREDIT_SAMPLE_MIN_MS) return;
  creditSampleAt.set(routeKey, now);
  void refreshPoolCredits({ force: true, only: [routeKey] }).catch(() => {});
}

export function poolRouteCredits(routeKey) {
  return credits.get(routeKey);
}

/** 面板/状态接口用的文档；形状与旧版 dsh-pool 保持一致。 */
export async function poolStatusDocument(options = {}) {
  if (options.refresh !== false) await refreshPoolCredits({ force: options.force === true });
  const groups = mergedModelGroups({ merge: options.merge, costFirst: options.costFirst });
  const routes = poolRoutes();
  const accounts = [];
  let total = 0;
  let signedIn = false;
  for (const route of routes) {
    const credit = credits.get(route.key);
    if (credit && credit.signedOut !== true) signedIn = true;
    // 免费无限量路由的 1e12 是排序占位，不是可计积分。
    if (credit?.syntheticBalance !== true && typeof credit?.remaining === "number") total += credit.remaining;
    for (const account of credit?.accounts ?? []) accounts.push({ route: route.key, ...account });
  }
  const voucherFirst = options.voucherFirst ?? voucherFirstDefault;
  return {
    status: groups.length > 0 || routes.length > 0 || signedIn ? "signed-in" : "signed-out",
    provider: "dsh-pool",
    nickname: "积分池",
    active: providerActive,
    credits: { total: Math.round(total * 100) / 100, accounts },
    models: groups.map((group) => ({
      id: group.poolId,
      name: String(group.name ?? group.poolId ?? "model"),
      baseName: String(group.name ?? group.poolId ?? "model"),
      routeName: modelDisplayName(group, options.showRoutes === true),
      contextWindow: group.contextWindow,
      maxTokens: group.maxTokens,
      reasoning: group.reasoning,
      input: group.input,
      routes: [...group.candidates.keys()],
      channels: [...group.candidates.keys()],
      channelLabels: group.channelLabels ?? [],
      free: group.free === true,
      freeFrom: group.freeFrom === undefined ? undefined : new Date(group.freeFrom).toISOString(),
      freeUntil: group.freeUntil === undefined ? undefined : new Date(group.freeUntil).toISOString(),
      freeLabel: group.freeLabel,
      rate: group.rate,
      badges: group.badges,
    })),
    pool: {
      order: voucherFirst ? "voucher-first" : "credits-first",
      voucherFirst,
      mergeModels: options.merge ?? mergeModelsDefault,
      costFirst: options.costFirst ?? costFirstDefault,
      routes: routes.map((route) => {
        const credit = credits.get(route.key);
        const diag = routeDiagnostics.get(route.key) ?? {};
        return {
          key: route.key,
          modelCount: diag.curatedModelCount,
          rawModelCount: diag.rawModelCount,
          hiddenModelCount: diag.hiddenModelCount ?? 0,
          droppedModels: diag.droppedModels ?? [],
          kind: route.kind,
          providerId: route.providerId,
          channelId: route.channelId,
          displayName: route.displayName,
          priority: route.priority ?? 0,
          voucher: isVoucherRoute(route),
          /** 账号归属（userId / account）；同 kind 多槽被登成同一个号时界面据此告警。 */
          identity: credit?.identity,
          syntheticBalance: credit?.syntheticBalance === true,
          remaining: credit?.syntheticBalance === true ? undefined : credit?.remaining,
          total: credit?.total,
          expiry: credit?.expiryMs === undefined ? undefined : new Date(credit.expiryMs).toISOString(),
          expiryEstimated: credit?.expiryEstimated === true,
          expirySource: credit?.expirySource,
          expiryPolicy: credit?.expiryPolicy,
          expiryUrls: credit?.expiryUrls,
          expiring: credit?.expiring,
          expiringAt: credit?.expiringAtMs === undefined ? undefined : new Date(credit.expiringAtMs).toISOString(),
          error: credit?.error,
          stale: credit?.stale === true,
          lastGoodAt: typeof credit?.lastGoodAt === "number" ? new Date(credit.lastGoodAt).toISOString() : undefined,
          coupons: credit?.voucher?.coupons,
          maxBudget: credit?.voucher?.maxBudget,
          spend: credit?.voucher?.spend,
          expiresSoonest: credit?.voucher?.expiresSoonest,
          updatedAt: credit?.voucher?.updatedAt,
        };
      }),
      latches: Object.fromEntries(latches),
      balance: creditBalanceReport(),
      broken: breakerSnapshot(),
    },
  };
}

// ── 路由日志 ─────────────────────────────────────────────────────────────

function logPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, ".pool-route.log");
}

/**
 * 追加一行 JSON 事件。凭证零输出：token 只记长度，永不记内容。
 *
 * 这条在每次 attempt/served/route-fail 上都会跑，是池里最热的路径：
 *  - 目录只在首次写入时创建一次，之后不再 mkdirSync；
 *  - 体积检查每 100 行才做一次（不是每次都 statSync）；
 *  - 超限时改名轮转保留一份 .1 备份，不再 truncateSync(0) 把历史一刀清零，
 *    也不会在别的进程正在 append 时把文件截成半行。
 */
let logDirReady = false;
let logLinesSinceStat = 0;
export function logPoolEvent(event) {
  const line = { at: new Date().toISOString(), ...event };
  /* 用量账本唯一实时入口：先记账并推进补导入游标，再落路径日志，避免重启重复计数。 */
  recordUsageEvent(line);
  try {
    const file = logPath();
    if (!logDirReady) {
      mkdirSync(join(file, ".."), { recursive: true });
      logDirReady = true;
    }
    if (logLinesSinceStat++ % 100 === 0) {
      try {
        if (statSync(file).size > 8 * 1024 * 1024) {
          const backup = file + ".1";
          try { rmSync(backup, { force: true }); } catch { /* 旧备份清不掉就算了 */ }
          renameSync(file, backup);
        }
      } catch {
        /* 文件还不存在 —— 下一行 append 会创建 */
      }
    }
    appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
  } catch {
    /* 日志写不了不能影响请求 */
  }
}

export function poolLogPath() {
  return logPath();
}
