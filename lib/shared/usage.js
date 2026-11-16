/**
 * 驼峰积分池 —— 用量账本（dsh-pool usage ledger）。
 *
 * 记什么：每个平台（routeKey）每天的成功/失败请求数、token（输入/输出/缓存/推理/合计）、
 *         积分消耗，以及按模型的明细；面板再按 日 / 周 / 月 / 总 四个窗口聚合。
 *
 * 数据来源（三路合一，互不重复计数）：
 *   1. logPoolEvent() 实时事件：served / route-fail / transport / usage。实时记账会同步
 *      推进 cursor.routeLogLastAt，所以自己刚写的那行日志不会被下面的补导入算第二遍。
 *   2. .pool-route.log 历史：首次调用时按 cursor 增量补导入（日志被 8MB 截断重来也安全）。
 *   3. .codearts-usage.json：CodeArts 由插件外的层单独记账，按「日期|模型」增量导入；
 *      同一天里路径日志中的 codearts 事件跳过，以这份专用账本为准。
 *
 * 积分消耗：refreshPoolCredits() 每次拉到余额，与上次快照比较，下降部分记为该平台积分
 *          消耗；若上游 usage 事件已直接上报 credits，从余额差里扣掉，避免双计。
 *
 * 时区：Asia/Shanghai（固定 UTC+8，无夏令时）；周从周一开始。
 * 写盘：tmp + rename 原子替换，1.5s 去抖；任何异常都吞掉，绝不影响聊天请求。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";

const FILE_NAME = ".dsh-pool-usage.json";
const ROUTE_LOG_NAME = ".pool-route.log";
const CODEARTS_USAGE_NAME = ".codearts-usage.json";
/** Asia/Shanghai 是固定 UTC+8，没有夏令时，直接位移即可。 */
const TZ_SHIFT_MS = 8 * 60 * 60 * 1000;
const FLUSH_DELAY_MS = 1500;
const SCAN_KEEP = 16 * 1024;
/** 余额单次下降超过这个数视为重置/单位切换，不记消耗。 */
const MAX_CREDIT_DELTA = 10000;
const TREND_DAYS = 14;

const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite", "total", "reasoning"];

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, reasoning: 0 };
}

function emptyAgg() {
  return {
    requests: 0,
    served: 0,
    failed: 0,
    credits: 0,
    directCredits: 0,
    tokens: emptyTokens(),
  };
}

function num(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

function round(value, digits) {
  if (!Number.isFinite(value)) return 0;
  // 用十进制位移避开 1.005 * 100 = 100.49999999999999 这类二进制误差。
  const shifted = Number(String(value) + "e" + String(digits));
  if (!Number.isFinite(shifted)) {
    const scale = Math.pow(10, digits);
    return Math.round(value * scale) / scale;
  }
  return Number(String(Math.round(shifted)) + "e-" + String(digits));
}

function usageHome() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
  return home;
}

export function usagePath() {
  return join(usageHome(), FILE_NAME);
}

/**
 * 解析时间戳；不带时区标记的 ISO 串按 Asia/Shanghai（UTC+8）解释。
 * 否则同一串在不同宿主 TZ 下会落到不同日桶，日/周/月窗口整体漂移。
 */
function stampMs(at) {
  const raw = typeof at === "string" ? at.trim() : "";
  if (raw === "") return Date.now();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/u.test(raw)) {
    const ms = Date.parse(raw + "Z");
    if (Number.isFinite(ms)) return ms - TZ_SHIFT_MS;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : Date.now();
}

function dayKey(at) {
  return new Date(stampMs(at) + TZ_SHIFT_MS).toISOString().slice(0, 10);
}

function weekStartKey(day) {
  const ms = Date.parse(day + "T00:00:00Z");
  if (!Number.isFinite(ms)) return day;
  const weekday = new Date(ms).getUTCDay();
  const back = (weekday + 6) % 7;
  return new Date(ms - back * 86400000).toISOString().slice(0, 10);
}

function shiftDay(day, delta) {
  const ms = Date.parse(day + "T00:00:00Z");
  return new Date((Number.isFinite(ms) ? ms : Date.now()) + delta * 86400000).toISOString().slice(0, 10);
}

function fallbackMeta(key) {
  if (key === "codearts") {
    return { displayName: "CodeArts / 华为云", kind: "codearts", providerId: "codearts", channelId: "codearts" };
  }
  if (key === "trae") {
    return { displayName: "Trae", kind: "trae", providerId: "trae", channelId: "trae" };
  }
  if (key === "aliyun-bailian" || key.includes("bailian")) {
    return { displayName: "阿里云百炼代金券", kind: "bailian", providerId: "aliyun-bailian", channelId: "aliyun-bailian" };
  }
  if (key.startsWith("workbuddy:")) {
    const id = key.slice("workbuddy:".length);
    return { displayName: "WorkBuddy · " + id, kind: "workbuddy", providerId: id, channelId: id };
  }
  if (key.startsWith("qoder:") || key.startsWith("qoder")) {
    const id = key.startsWith("qoder:") ? key.slice("qoder:".length) : key;
    return { displayName: "Qoder · " + id, kind: "qoder", providerId: id, channelId: id };
  }
  const kind = key.split(":")[0];
  return { displayName: key, kind, providerId: key, channelId: key };
}

let state;

function freshDoc() {
  return {
    version: 1,
    updatedAt: "",
    days: {},
    meta: {},
    snapshots: {},
    cursor: {
      routeLogLastAt: "",
      codeartsModels: {},
      codeartsFailures: {},
      codeartsTokens: {},
    },
  };
}

function ensureLoaded() {
  if (state !== undefined) return;
  let doc = freshDoc();
  try {
    const raw = JSON.parse(readFileSync(usagePath(), "utf8"));
    if (raw && raw.version === 1 && raw.days && typeof raw.days === "object") doc = raw;
  } catch {
    /* 账本不存在或写坏了：重建，不影响请求 */
  }
  doc.days = doc.days && typeof doc.days === "object" ? doc.days : {};
  doc.meta = doc.meta && typeof doc.meta === "object" ? doc.meta : {};
  doc.snapshots = doc.snapshots && typeof doc.snapshots === "object" ? doc.snapshots : {};
  const c = doc.cursor && typeof doc.cursor === "object" ? doc.cursor : {};
  doc.cursor = {
    routeLogLastAt: typeof c.routeLogLastAt === "string" ? c.routeLogLastAt : "",
    codeartsModels: c.codeartsModels && typeof c.codeartsModels === "object" ? c.codeartsModels : {},
    codeartsFailures: c.codeartsFailures && typeof c.codeartsFailures === "object" ? c.codeartsFailures : {},
    codeartsTokens: c.codeartsTokens && typeof c.codeartsTokens === "object" ? c.codeartsTokens : {},
  };
  state = { doc, imported: false, dirty: false, timer: undefined };
}

function touch() {
  state.dirty = true;
  scheduleFlush();
}

function scheduleFlush() {
  if (state.timer !== undefined) return;
  const timer = setTimeout(() => {
    state.timer = undefined;
    flushUsage();
  }, FLUSH_DELAY_MS);
  if (typeof timer.unref === "function") timer.unref();
  state.timer = timer;
}

/** 落盘失败后的指数退避重试（1.5s→60s，最多 5 次）。 */
function scheduleFlushRetry(fails) {
  if (state.timer !== undefined) return;
  const delay = Math.min(60_000, FLUSH_DELAY_MS * Math.pow(2, Math.min(fails, 5)));
  const timer = setTimeout(() => {
    state.timer = undefined;
    flushUsage();
  }, delay);
  if (typeof timer.unref === "function") timer.unref();
  state.timer = timer;
}

export function flushUsage() {
  if (state === undefined) return;
  if (state.timer !== undefined) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
  if (!state.dirty) return;
  const file = usagePath();
  // 临时名必须唯一：两个进程/两次 flush 共用固定 .tmp 会互相覆盖或 rename 失败。
  const tmp = file + "." + process.pid + "." + Date.now().toString(36) + "." + Math.random().toString(36).slice(2) + ".tmp";
  try {
    mkdirSync(usageHome(), { recursive: true });
    state.doc.updatedAt = new Date().toISOString();
    writeFileSync(tmp, JSON.stringify(state.doc), "utf8");
    renameSync(tmp, file);
    state.dirty = false;
    state.flushFails = 0;
  } catch {
    /* 写不了盘就留在内存里，绝不影响请求；但必须稍后重试，否则进程退出即丢账本。 */
    try { unlinkSync(tmp); } catch { /* 临时文件可能根本没写出来 */ }
    state.flushFails = (Number(state.flushFails) || 0) + 1;
    if (state.flushFails <= 5) scheduleFlushRetry(state.flushFails);
  }
}

function dayBucket(day) {
  let bucket = state.doc.days[day];
  if (bucket === undefined || typeof bucket !== "object") {
    bucket = { platforms: {} };
    state.doc.days[day] = bucket;
  }
  if (bucket.platforms === undefined || typeof bucket.platforms !== "object") bucket.platforms = {};
  return bucket;
}

function platformBucket(day, key, meta) {
  const bucket = dayBucket(day);
  const known = state.doc.meta[key] || meta || fallbackMeta(key);
  if (meta !== undefined && Object.keys(meta).length > 0) {
    state.doc.meta[key] = {
      displayName: meta.displayName || state.doc.meta[key]?.displayName || fallbackMeta(key).displayName,
      kind: meta.kind || state.doc.meta[key]?.kind || fallbackMeta(key).kind,
      providerId: meta.providerId || state.doc.meta[key]?.providerId || key,
      channelId: meta.channelId || state.doc.meta[key]?.channelId || key,
    };
  } else if (state.doc.meta[key] === undefined) {
    state.doc.meta[key] = { ...fallbackMeta(key) };
  }
  const finalMeta = state.doc.meta[key] || known;
  let p = bucket.platforms[key];
  if (p === undefined || typeof p !== "object") {
    p = { ...emptyAgg(), ...finalMeta, models: {} };
    bucket.platforms[key] = p;
  }
  if (p.models === undefined || typeof p.models !== "object") p.models = {};
  if (p.tokens === undefined) p.tokens = emptyTokens();
  /* 后注册的路由带真名，覆盖历史兜底名。 */
  if (finalMeta.displayName && p.displayName !== finalMeta.displayName) {
    p.displayName = finalMeta.displayName;
    p.kind = finalMeta.kind || p.kind;
    p.providerId = finalMeta.providerId || p.providerId;
    p.channelId = finalMeta.channelId || p.channelId;
    touch();
  }
  return p;
}

function modelBucket(p, model) {
  if (model === "") return undefined;
  let m = p.models[model];
  if (m === undefined || typeof m !== "object") {
    m = emptyAgg();
    p.models[model] = m;
  }
  if (m.tokens === undefined) m.tokens = emptyTokens();
  return m;
}

function platformKeyOf(ev) {
  return typeof ev.route === "string" && ev.route !== "" ? ev.route : "";
}

function modelOf(ev) {
  if (typeof ev.poolModel === "string" && ev.poolModel !== "") return ev.poolModel;
  if (typeof ev.model === "string" && ev.model !== "") return ev.model;
  return "";
}

function advanceCursor(at) {
  if (typeof at === "string" && at > (state.doc.cursor.routeLogLastAt || "")) {
    state.doc.cursor.routeLogLastAt = at;
    touch();
  }
}

function mergeAgg(target, source) {
  target.requests += num(source.requests);
  target.served += num(source.served);
  target.failed += num(source.failed);
  target.credits += num(source.credits);
  target.directCredits += num(source.directCredits);
  const st = source.tokens || {};
  for (const k of TOKEN_KEYS) target.tokens[k] += num(st[k]);
}

function addRequests(p, m, served, failed) {
  const n = served + failed;
  p.requests += n;
  p.served += served;
  p.failed += failed;
  if (m !== undefined) {
    m.requests += n;
    m.served += served;
    m.failed += failed;
  }
  touch();
}

function addTokens(p, m, u) {
  for (const target of [p, m]) {
    if (target === undefined) continue;
    for (const k of TOKEN_KEYS) target.tokens[k] += num(u[k]);
    if (u.credits > 0) {
      target.credits += u.credits;
      target.directCredits += u.credits;
    }
  }
  touch();
}

/** 从任意形状的上游 usage 对象里抽归一化字段。 */
export function normalizeUsage(raw) {
  if (raw === undefined || raw === null || typeof raw !== "object") return undefined;
  const pick = (obj, keys) => {
    for (const k of keys) {
      if (obj === undefined || obj === null) return 0;
      const v = obj[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0) return Number(v);
    }
    return 0;
  };
  const details = raw.prompt_tokens_details || raw.promptTokensDetails || raw.input_tokens_details || {};
  const cacheDetails = raw.usage_details || raw.usageDetails || {};
  const input = pick(raw, ["input", "input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
  const output = pick(raw, ["output", "output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
  let total = pick(raw, ["total", "total_tokens", "totalTokens"]);
  if (total === 0) total = input + output;
  const cacheRead =
    pick(raw, ["cacheRead", "cache_read", "cached_tokens", "cache_read_input_tokens", "cacheReadTokens", "cachedTokens"]) ||
    pick(details, ["cached_tokens", "cache_read_tokens", "cachedTokens"]) ||
    pick(cacheDetails, ["cache_read", "cached_tokens"]);
  const cacheWrite =
    pick(raw, ["cacheWrite", "cache_write", "cache_creation_input_tokens", "cacheWriteTokens"]) ||
    pick(details, ["cache_creation_tokens"]) ||
    pick(cacheDetails, ["cache_write", "cache_creation_input_tokens"]);
  const reasoning =
    pick(raw, ["reasoning", "reasoning_tokens", "reasoningTokens"]) ||
    pick(details, ["reasoning_tokens"]) ||
    pick(cacheDetails, ["reasoning_tokens"]);
  const credits = pick(raw, ["credits", "credit", "creditCost", "credit_cost", "creditUsed", "credit_used", "points"]);
  let any = false;
  for (const v of [input, output, total, cacheRead, cacheWrite, reasoning, credits]) if (v > 0) any = true;
  if (!any) return undefined;
  return { input, output, total, cacheRead, cacheWrite, reasoning, credits };
}

function usageSourceOf(ev) {
  const u = ev.usage && typeof ev.usage === "object" ? ev.usage : {};
  return Object.assign({}, ev, u);
}

function applyEvent(ev, meta, advance) {
  const at = typeof ev.at === "string" && ev.at !== "" ? ev.at : new Date().toISOString();
  const key = platformKeyOf(ev);
  const countable = ev.ev === "served" || ev.ev === "route-fail" || ev.ev === "transport" || ev.ev === "usage";
  if (key === "" || !countable) {
    if (advance) advanceCursor(at);
    return;
  }
  /* CodeArts 有插件外那层专用的 .codearts-usage.json，同一天以它为准，跳过路径日志里的事件。 */
  if (key === "codearts" && state.codeartsDays && state.codeartsDays[dayKey(at)] !== undefined) {
    if (advance) advanceCursor(at);
    return;
  }
  const p = platformBucket(dayKey(at), key, meta);
  const m = modelBucket(p, modelOf(ev));
  if (ev.ev === "served") addRequests(p, m, 1, 0);
  else if (ev.ev === "route-fail" || ev.ev === "transport") addRequests(p, m, 0, 1);
  else if (ev.ev === "usage") {
    const u = normalizeUsage(usageSourceOf(ev));
    if (u !== undefined) addTokens(p, m, u);
  }
  if (advance) advanceCursor(at);
}

function readCodeartsDays() {
  const out = {};
  try {
    const raw = JSON.parse(readFileSync(join(usageHome(), CODEARTS_USAGE_NAME), "utf8"));
    const days = raw && raw.days && typeof raw.days === "object" ? raw.days : {};
    for (const [date, day] of Object.entries(days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || day === null || typeof day !== "object") continue;
      const models = day.models && typeof day.models === "object" ? day.models : {};
      let failures = 0;
      if (day.failures && typeof day.failures === "object") {
        for (const v of Object.values(day.failures)) failures += num(v);
      }
      out[date] = { models, failures };
    }
  } catch {
    /* 没有这个文件就只走路径日志 */
  }
  return out;
}

function importRouteLog(codeartsDays) {
  let text = "";
  try {
    text = readFileSync(join(usageHome(), ROUTE_LOG_NAME), "utf8");
  } catch {
    return;
  }
  const lastAt = state.doc.cursor.routeLogLastAt || "";
  let newest = lastAt;
  for (const line of text.split("\n")) {
    if (line === "" || line[0] !== "{") continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const at = typeof ev.at === "string" ? ev.at : "";
    if (at === "") continue;
    if (at > newest) newest = at;
    if (at <= lastAt) continue;
    if (ev.ev !== "served" && ev.ev !== "route-fail" && ev.ev !== "transport" && ev.ev !== "usage") continue;
    if (platformKeyOf(ev) === "codearts" && codeartsDays[dayKey(at)] !== undefined) continue;
    applyEvent(ev, undefined, false);
  }
  if (newest > lastAt) {
    state.doc.cursor.routeLogLastAt = newest;
    touch();
  }
}

function importCodearts(codeartsDays) {
  const meta = fallbackMeta("codearts");
  for (const [date, info] of Object.entries(codeartsDays)) {
    const p = platformBucket(date, "codearts", meta);
    for (const [model, stat] of Object.entries(info.models)) {
      if (stat === null || typeof stat !== "object") continue;
      const ck = date + "|" + model;
      const want = num(stat.requests);
      const already = num(state.doc.cursor.codeartsModels[ck]);
      const delta = want - already;
      const m = modelBucket(p, model);
      if (delta > 0) addRequests(p, m, delta, 0);
      /* token 也按「本次累计 - 上次累计」导入，防止文件重写时重复累加。 */
      const wanted = [
        num(stat.promptTokens),
        num(stat.completionTokens),
        num(stat.totalTokens),
        num(stat.cachedTokens),
        num(stat.reasoningTokens),
      ];
      const prev = Array.isArray(state.doc.cursor.codeartsTokens[ck]) ? state.doc.cursor.codeartsTokens[ck] : [0, 0, 0, 0, 0];
      const inc = {
        input: Math.max(0, wanted[0] - num(prev[0])),
        output: Math.max(0, wanted[1] - num(prev[1])),
        total: Math.max(0, wanted[2] - num(prev[2])),
        cacheRead: Math.max(0, wanted[3] - num(prev[3])),
        cacheWrite: 0,
        reasoning: Math.max(0, wanted[4] - num(prev[4])),
        credits: 0,
      };
      if (TOKEN_KEYS.some((k) => inc[k] > 0)) addTokens(p, m, inc);
      state.doc.cursor.codeartsModels[ck] = want;
      state.doc.cursor.codeartsTokens[ck] = wanted;
    }
    const fWant = num(info.failures);
    const fAlready = num(state.doc.cursor.codeartsFailures[date]);
    if (fWant > fAlready) addRequests(p, undefined, 0, fWant - fAlready);
    state.doc.cursor.codeartsFailures[date] = fWant;
    touch();
  }
}

function refreshImports() {
  const codeartsDays = readCodeartsDays();
  state.codeartsDays = codeartsDays;
  importRouteLog(codeartsDays);
  importCodearts(codeartsDays);
}

function ensureImported() {
  if (state.imported) return;
  state.imported = true;
  try {
    refreshImports();
    flushUsage();
  } catch {
    /* 历史补导入失败不影响实时记账 */
  }
}

/** 由 registerPoolRoute() 调用，把渠道真名写进账本（重启后仍在）。 */
export function registerPlatformMeta(route) {
  try {
    ensureLoaded();
    if (route === undefined || typeof route.key !== "string" || route.key === "") return;
    platformBucket(dayKey(new Date().toISOString()), route.key, {
      displayName: typeof route.displayName === "string" ? route.displayName : "",
      kind: typeof route.kind === "string" ? route.kind : "",
      providerId: typeof route.providerId === "string" ? route.providerId : "",
      channelId: typeof route.channelId === "string" ? route.channelId : "",
    });
    touch();
  } catch {
    /* 元数据登记失败不影响路由 */
  }
}

/** logPoolEvent() 的唯一记账入口：先记账推进 cursor，再落日志，避免同一行被补导入算两遍。 */
export function recordUsageEvent(event) {
  try {
    ensureLoaded();
    ensureImported();
    applyEvent(event, undefined, true);
  } catch {
    /* 记账不能影响请求 */
  }
}

/** 响应流探针专用：usage 不写路径日志，也不推进 cursor（账本已持久化，重启不会重复）。 */
export function recordUsageProbe(event) {
  try {
    ensureLoaded();
    ensureImported();
    applyEvent(event, undefined, false);
  } catch {
    /* 记账不能影响请求 */
  }
}

/** 面板/定时调用时把外部持续更新的两个历史源再增量同步一次。 */
export function refreshUsageImports() {
  try {
    ensureLoaded();
    ensureImported();
    refreshImports();
    flushUsage();
  } catch {
    /* 增量同步失败就展示已有账本 */
  }
}

function totalDirectCredits(routeKey) {
  let sum = 0;
  for (const day of Object.values(state.doc.days)) {
    const p = day && day.platforms ? day.platforms[routeKey] : undefined;
    if (p !== undefined) sum += num(p.directCredits);
  }
  return sum;
}

/**
 * refreshPoolCredits() 拉到新余额时调用。余额下降 = 积分消耗；
 * 减去同一时段上游 usage 直接上报的 credits，防止双计。
 */
export function noteCreditObservation(routeKey, remaining, at) {
  try {
    ensureLoaded();
    ensureImported();
    if (typeof routeKey !== "string" || routeKey === "" || !Number.isFinite(remaining)) return;
    const stamp = typeof at === "string" && at !== "" ? at : new Date().toISOString();
    const prev = state.doc.snapshots[routeKey];
    const directNow = totalDirectCredits(routeKey);
    if (prev === undefined) {
      // 首次只建基线。
      state.doc.snapshots[routeKey] = { remaining, at: stamp, direct: directNow };
      touch();
      return;
    }
    const delta = num(prev.remaining) - remaining;
    if (!(delta > 0)) {
      // 充值/重置：新余额就是新基线，之前的下降不该再补记。
      state.doc.snapshots[routeKey] = { remaining, at: stamp, direct: directNow };
      touch();
      return;
    }
    if (delta > MAX_CREDIT_DELTA) {
      // 异常跳变（单位切换/脏数据）：保留旧基线，只标记 suspect，避免把整段重置记成消耗。
      state.doc.snapshots[routeKey] = { remaining: num(prev.remaining), at: stamp, direct: directNow, suspect: true };
      touch();
      return;
    }
    const directDelta = Math.max(0, directNow - num(prev.direct));
    const effective = round(Math.max(0, delta - directDelta), 2);
    state.doc.snapshots[routeKey] = { remaining, at: stamp, direct: directNow };
    if (effective <= 0) {
      touch();
      return;
    }
    const p = platformBucket(dayKey(stamp), routeKey);
    p.credits = round(p.credits + effective, 2);
    touch();
  } catch {
    /* 积分快照不能影响额度刷新 */
  }
}

// ── 上游响应 usage 探针 ───────────────────────────────────────────────────

function emptyUsageMax() {
  return { input: -1, output: -1, total: -1, cacheRead: -1, cacheWrite: -1, reasoning: -1, credits: -1 };
}

function mergeMax(acc, u) {
  for (const k of Object.keys(acc)) if (num(u[k]) > acc[k]) acc[k] = num(u[k]);
}

function maxUsage(acc) {
  const out = {};
  let any = false;
  for (const k of Object.keys(acc)) {
    out[k] = acc[k] < 0 ? 0 : acc[k];
    if (out[k] > 0) any = true;
  }
  return any ? out : undefined;
}

function matchBrace(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 扫描一段文本里所有 "usage": {...}（SSE 多帧 / 整块 JSON 通吃）。 */
function scanUsage(text, onFound) {
  let from = 0;
  for (;;) {
    const i = text.indexOf('"usage"', from);
    if (i < 0) return;
    const brace = text.indexOf("{", i + 7);
    if (brace < 0) return;
    if (!/^[\s:]*$/.test(text.slice(i + 7, brace))) {
      from = i + 7;
      continue;
    }
    const end = matchBrace(text, brace);
    if (end < 0) return; // 半个对象，等下一块
    try {
      const u = normalizeUsage(JSON.parse(text.slice(brace, end + 1)));
      if (u !== undefined) onFound(u);
    } catch {
      /* 畸形 usage 片段跳过 */
    }
    from = end + 1;
  }
}

/**
 * 生成一个零修改的 Transform：原样透传 chunk，顺带把响应里的 usage 聚合成一个事件。
 * 各字段取最大值 —— OpenAI 流式最后一帧给的是整次请求总量，取 max 等于最终值，
 * 不会把逐帧重复的 usage 累加成几倍。
 */
export function createUsageTap(onUsage) {
  let tail = "";
  const acc = emptyUsageMax();
  let fired = false;
  const finish = () => {
    if (fired) return;
    fired = true;
    const u = maxUsage(acc);
    if (u !== undefined && typeof onUsage === "function") {
      try {
        onUsage(u);
      } catch {
        /* 回调异常不能打断响应流 */
      }
    }
  };
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      try {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        tail = (tail + text).slice(-SCAN_KEEP * 4);
        scanUsage(tail, (u) => mergeMax(acc, u));
        tail = tail.length > SCAN_KEEP ? tail.slice(-SCAN_KEEP) : tail;
      } catch {
        /* 探测失败就当没有 usage */
      }
      cb(null, chunk);
    },
    flush(cb) {
      try {
        scanUsage(tail, (u) => mergeMax(acc, u));
      } catch {
        /* 同上 */
      }
      finish();
      cb();
    },
  });
  tap.on("error", finish);
  return tap;
}

// ── 面板文档：日 / 周 / 月 / 总 四个窗口 ──────────────────────────────────

function aggregateDays(pairs) {
  const total = { ...emptyAgg(), platforms: [] };
  const byKey = new Map();
  for (const [, day] of pairs) {
    const platforms = day && day.platforms && typeof day.platforms === "object" ? day.platforms : {};
    for (const [key, p] of Object.entries(platforms)) {
      if (p === null || typeof p !== "object") continue;
      let acc = byKey.get(key);
      if (acc === undefined) {
        acc = {
          ...emptyAgg(),
          key,
          displayName: p.displayName || fallbackMeta(key).displayName,
          kind: p.kind || fallbackMeta(key).kind,
          providerId: p.providerId || key,
          channelId: p.channelId || key,
          models: new Map(),
        };
        byKey.set(key, acc);
      }
      if (p.displayName && p.displayName !== acc.displayName) acc.displayName = p.displayName;
      mergeAgg(acc, p);
      const models = p.models && typeof p.models === "object" ? p.models : {};
      for (const [name, m] of Object.entries(models)) {
        if (m === null || typeof m !== "object") continue;
        let mm = acc.models.get(name);
        if (mm === undefined) {
          mm = emptyAgg();
          acc.models.set(name, mm);
        }
        mergeAgg(mm, m);
      }
    }
  }
  for (const p of byKey.values()) mergeAgg(total, p);
  const list = [...byKey.values()];
  for (const p of list) {
    p.credits = round(p.credits, 2);
    p.tokens.total = p.tokens.total || p.tokens.input + p.tokens.output;
    p.share =
      total.credits > 0
        ? round(p.credits / total.credits, 4)
        : total.requests > 0
          ? round(p.requests / total.requests, 4)
          : 0;
    p.models = [...p.models.entries()]
      .map(([name, m]) => ({ name, ...m, tokens: { ...m.tokens, total: m.tokens.total || m.tokens.input + m.tokens.output } }))
      .sort((a, b) => b.requests - a.requests || b.tokens.total - a.tokens.total)
      .slice(0, 12);
  }
  list.sort((a, b) => b.credits - a.credits || b.requests - a.requests || a.key.localeCompare(b.key));
  total.credits = round(total.credits, 2);
  total.tokens.total = total.tokens.total || total.tokens.input + total.tokens.output;
  total.platforms = list;
  return total;
}

function windowOf(predicate, key, label, from, to) {
  const pairs = Object.entries(state.doc.days).filter(([date]) => predicate(date));
  const agg = aggregateDays(pairs);
  return { key, label, from, to, ...agg };
}

export function usageDocument() {
  ensureLoaded();
  ensureImported();
  refreshUsageImports();
  const now = new Date().toISOString();
  const today = dayKey(now);
  const weekStart = weekStartKey(today);
  const month = today.slice(0, 7);
  const allDays = Object.keys(state.doc.days).sort();
  const from = allDays.length > 0 ? allDays[0] : today;
  const windows = {
    day: windowOf((d) => d === today, "day", "今日", today, today),
    week: windowOf((d) => d >= weekStart && d <= today, "week", "本周", weekStart, today),
    month: windowOf((d) => d.startsWith(month), "month", "本月", month + "-01", today),
    all: windowOf(() => true, "all", "总计", from, today),
  };
  const trend = [];
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const date = shiftDay(today, -i);
    const agg = aggregateDays([[date, state.doc.days[date] || {}]]);
    trend.push({
      date,
      requests: agg.requests,
      served: agg.served,
      failed: agg.failed,
      credits: agg.credits,
      tokens: agg.tokens,
    });
  }
  return {
    ok: true,
    generatedAt: now,
    timezone: "Asia/Shanghai (UTC+8)",
    today,
    weekStart,
    month,
    windows,
    trend,
    ledger: {
      path: usagePath(),
      updatedAt: state.doc.updatedAt || now,
      cursor: state.doc.cursor,
      days: allDays.length,
    },
  };
}
