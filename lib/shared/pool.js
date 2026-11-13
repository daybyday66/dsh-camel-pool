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
  ["deepseek-v4-flash-official", "deepseek-v4-flash"],
  ["deepseekv4flash", "deepseek-v4-flash"],
  ["kimi-k3-1", "kimi-k3-1"],
  ["kimik3", "kimi-k3-1"],
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

/**
 * 用户点名的 4 个 Gemini Pro 模型：官方档位（4 Argon 复杂任务 > 3.1 Pro 高级推理
 * > 3.8 Flash 均衡 > 3.5 Flash-Lite 极速）与通用正则（只认 gemini-2.5 / pro，还给
 * flash / lite 扣分）不一致，这里按「之前的规则」的综合能力直接给固定分，
 * 让它们与既有精选模型一起按 strength 降序混排。分值跨过 kimi-k3（约 249）锚点。
 */
const GEMINI_STRENGTH = new Map([
  ["gemini-4-argon", 270],
  ["gemini-3.1-pro-preview", 230],
  ["gemini-3.8-flash", 140],
  ["gemini-3.5-flash-lite", 100],
  ["gemini-3.5-pro", 240],
  ["gemini-3.1-pro-high", 250],
]);

/** 综合能力的启发式打分：旗舰族 >  Pro 族 > 普通 > flash/mini/air/lite。 */
function strengthOf(group) {
  const fixed = GEMINI_STRENGTH.get(String(group.poolId ?? "").toLowerCase());
  if (fixed !== undefined) return fixed;
  const text = (String(group.poolId) + " " + String(group.name)).toLowerCase();
  let score = 0;
  if (/ultra|opus|550b|nemotron|o3|o4|gpt-?5|claude-?4|gemini-?2\.5|kimi-?k3|hy4|conatus/i.test(text)) score += 100;
  if (/\bpro\b|v4[-_. ]?pro|qwen3\.?8|glm-?5\.?3(?![-_. ]?flash)|deepseek-?v4[-_. ]?pro|kimi-?k3/i.test(text)) score += 60;
  if (/flash|mini|lite|air|small|tiny|haiku|nano|turbo/i.test(text)) score -= 40;
  score += Math.log10(Math.max(1, group.contextWindow ?? 0)) * 8;
  score += Math.log10(Math.max(1, group.maxTokens ?? 0)) * 4;
  if (group.reasoning) score += 12;
  if (Array.isArray(group.input) && group.input.includes("image")) score += 8;
  return score;
}

/**
 * 用户点名的「模型库」白名单：积分池分组只保留这 28 个模型（老渠道 26 + Gemini 6）；
 * CodeArts 只放行 5 个 id，且全部与老渠道同 id 合并成一条，不单独登记。
 * tier 语义：0=免费组（组内按综合能力降序）、1/2/3=三个固定顺位、4=其余（组内按综合能力降序）。
 * index 为用户给出的先后顺序，作为平局时的稳定兜底。
 * 匹配以 poolId / candidate.id 的精确小写为主，slug 兜底应对上游命名差异。
 */
const CURATED_MODELS = [
  ["qiniu/conatus-free", 0],
  ["hy4free", 0],
  ["nvidia/nemotron-3-ultra-550b-a55b0-free", 0],
  ["qwen3.8-flash", 4], // ux-v6：0.04 倍率不是免费模型，退出具免费前排
  ["hy3", 0],
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
  // Gemini Pro 订阅：用户点名的 4 个，显式列入白名单（不再依赖 libraryBypass 兜底）。
  ["gemini-4-argon", 4],
  ["gemini-3.1-pro-preview", 4],
  ["gemini-3.8-flash", 4],
  ["gemini-3.5-flash-lite", 4],
  ["gemini-3.5-pro", 4],
  ["gemini-3.1-pro-high", 4],
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
export function mergedModelGroups(options = {}) {
  // poolMergeModels 开关保留兼容（历史上控制「路由 × 模型」是否拆条）；
  // 白名单「模型库」恒以「一个模型 = 一条 + 多渠道候选」输出，故不再按 merge 拆条。
  const costFirst = options.costFirst ?? costFirstDefault;
  const groups = new Map();
  for (const item of registry) {
    const route = item.route;
    let hidden;
    try {
      hidden = new Set(route.hidden?.() ?? []);
    } catch {
      hidden = new Set();
    }
    let models = [];
    try {
      models = route.models() ?? [];
    } catch {
      models = [];
    }
    for (const model of models) {
      if (!model || typeof model !== "object" || typeof model.id !== "string" || model.id === "") continue;
      if (hidden.has(model.id)) continue;
      const candidate = describeCandidate(route, model);
      // 「模型库」白名单契约：同一模型恒聚合为一个条目（多渠道候选并进 candidates），
      // 这样选择模型后 orderedRoutesFor 才能跨渠道按积分过期顺序调用。
      // poolMergeModels 开关保留兼容，但不再把白名单模型拆成「路由 × 模型」独立条目。
      const keys = [model.id.toLowerCase(), canonicalId(model.id), "name:" + normName(candidate.name)];
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
  // 「模型库」白名单：只保留点名的 28 个模型；costFirst 仅在这批里切换排序，集合不变。
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
    if (!c) continue;
    // 统一规范 poolId 为白名单 id：让 buildModels / v1/models / orderedRoutesFor /
    // poolStatusDocument 四处一致，避免上游别名或渠道前缀导致「选中模型找不到路由」。
    group.poolId = c.idLower;
    curated.push({ g: group, c, power: strengthOf(group) });
  }
  curated.sort(costFirst ? curatedCostCompare : curatedDefaultCompare);
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
const BREAKER_TTL_MS = { quota: 60_000, transport: 60_000, auth: 10 * 60_000, upstream: 15_000 };

/** 记住某条路由刚刚报过的失败，冷却期内不再优先尝试。 */
export function noteRouteFailure(routeKey, kind) {
  const normalized = kind === "quota" ? "quota" : kind === "auth" ? "auth" : kind === "upstream" ? "upstream" : "transport";
  breakers.set(routeKey, { kind: normalized, at: Date.now() });
}

/** 路由成功后清掉熔断标记（成功即自愈）。 */
export function noteRouteSuccess(routeKey) {
  breakers.delete(routeKey);
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
  const latch = latchOf(group.poolId);
  if (latch) {
    const at = ordered.findIndex((item) => item.routeKey === latch);
    if (at > 0) {
      // ux-v14：粘性不得越过「当日将过期余额还没烧完」的路由——烧当日积分的优先级
      // 高于任务粘性，否则上次会话钉在别的路由上，当日额度就白白过期了。
      // burnExpiringFirst === false 时保留旧行为（粘性压过一切）。
      let floor = 0;
      if (options.burnExpiringFirst !== false) {
        while (floor < at && (credits.get(ordered[floor].routeKey)?.expiring ?? 0) > 0) {
          floor += 1;
        }
      }
      if (floor < at) {
        // 把 latch 路由插到 floor 位（紧贴在 expiring>0 头部块之后），其余相对次序不变。
        const item = ordered[at];
        ordered = [...ordered.slice(0, floor), item, ...ordered.slice(floor, at), ...ordered.slice(at + 1)];
      }
    }
  }
  return ordered.map(({ routeKey, route, candidate, candidates }) => ({ routeKey, route, candidate, candidates }));
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
  let best;
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (!account || typeof account !== "object") continue;
    const at =
      toMs(account.endTimeMs) ??
      toMs(account.endTime) ??
      toMs(account.expireAt) ??
      toMs(account.expiresAt) ??
      toMs(account.expiry) ??
      toMs(account.expireTime);
    if (at === undefined) continue;
    if (best === undefined || at < best) best = at;
  }
  return best;
}

function extractCredits(doc) {
  if (!doc || typeof doc !== "object") return undefined;
  const voucher = doc.voucher && typeof doc.voucher === "object" ? doc.voucher : undefined;
  // 免费无限量渠道的 remaining 是"占位大数"，不能计入真实积分总额。
  const syntheticBalance = doc.syntheticBalance === true;
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
    const baseExpiry =
      minExpiry(accounts) ??
      toMs(creditsDoc.endTime) ??
      toMs(creditsDoc.expireAt) ??
      toMs(creditsDoc.expiresAt) ??
      toMs(creditsDoc.expiry) ??
      toMs(voucher?.expiresSoonest);
    const expiryMs =
      typeof expiring === "number" && expiring > 0 && expiringAtMs !== undefined
        ? Math.min(baseExpiry ?? Number.MAX_SAFE_INTEGER, expiringAtMs)
        : baseExpiry;
    return {
      remaining,
      total,
      accounts,
      expiryMs,
      ...(typeof expiring === "number" && expiring > 0 ? { expiring, expiringAtMs } : {}),
      signedOut: false,
      voucher,
      syntheticBalance,
    };
  }
  if (quotaDoc) {
    const remaining = num(quotaDoc.remaining) ?? num(quotaDoc.total) ?? num(quotaDoc.totalCredits);
    return { remaining, total: num(quotaDoc.total), accounts: [], expiryMs: toMs(voucher?.expiresSoonest), signedOut: false, voucher, syntheticBalance };
  }
  if (typeof doc.status === "string" && doc.status !== "signed-in" && doc.status !== "ok") {
    return { signedOut: true, accounts: [] };
  }
  return undefined;
}

/** 拉一遍各渠道余额（默认 5 分钟软缓存；force 全刷）。 */
export async function refreshPoolCredits(options = {}) {
  const force = options.force === true;
  const ttl = Number.isFinite(options.ttlMs) ? options.ttlMs : 300_000;
  const now = Date.now();
  await Promise.all(
    poolRoutes().map(async (route) => {
      const cached = credits.get(route.key);
      if (!force && cached && now - cached.at < ttl) return;
      let doc;
      try {
        if (typeof route.credits === "function") doc = await route.credits();
        else if (typeof route.status === "function") doc = await route.status();
        else return;
      } catch (error) {
        credits.set(route.key, {
          at: now,
          error: error instanceof Error ? error.message : String(error),
          accounts: [],
          signedOut: true,
        });
        return;
      }
      const parsed = extractCredits(doc);
      credits.set(route.key, { at: now, ...(parsed ?? { accounts: [] }) });
    }),
  );
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
        return {
          key: route.key,
          kind: route.kind,
          providerId: route.providerId,
          channelId: route.channelId,
          displayName: route.displayName,
          priority: route.priority ?? 0,
          voucher: isVoucherRoute(route),
          syntheticBalance: credit?.syntheticBalance === true,
          remaining: credit?.syntheticBalance === true ? undefined : credit?.remaining,
          total: credit?.total,
          expiry: credit?.expiryMs === undefined ? undefined : new Date(credit.expiryMs).toISOString(),
          expiring: credit?.expiring,
          expiringAt: credit?.expiringAtMs === undefined ? undefined : new Date(credit.expiringAtMs).toISOString(),
          error: credit?.error,
          coupons: credit?.voucher?.coupons,
          maxBudget: credit?.voucher?.maxBudget,
          spend: credit?.voucher?.spend,
          expiresSoonest: credit?.voucher?.expiresSoonest,
          updatedAt: credit?.voucher?.updatedAt,
        };
      }),
      latches: Object.fromEntries(latches),
      broken: [...breakers.entries()].map(([key, value]) => ({ key, kind: value.kind, at: value.at })),
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
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8");
  } catch {
    /* 日志写不了不能影响请求 */
  }
}

export function poolLogPath() {
  return logPath();
}
