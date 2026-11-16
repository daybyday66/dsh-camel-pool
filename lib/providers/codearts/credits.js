/**
 * CodeArts 积分 / 签到 / 排队 / 本机用量 —— 宿主侧适配层。
 *
 * 复用 vendor 已实测的 signedGet（AK/SK 签名 GET）、福利与队列函数，
 * 按 dsh-codearts@1.3.0 的积分解析规则收敛成驼峰池状态文档能吃的形状。
 * 本层不读凭据文件、不输出任何 token 明文；逐号明细、签到、官方 token 用量、
 * 上游排队位置与本机用量账本都在这里产出，由 codearts/index.js 挂到
 * /plugins/dsh-pool/status 的 doc.codearts 与面板 /status。
 */
import {
  signedGet,
  SNAP_HOST,
  fetchWelfareCampaigns,
  pickDailyWelfareCampaign,
  claimDailyWelfare,
  fetchQueueStatus,
  clearQueueStatus,
  isWelfareClaimedStatus,
  upstreamErrorMessage,
  CodeArtsUsageTracker,
  codeartsUsagePath,
} from './engine.js';

const BENEFIT_GATEWAY_HOST = 'https://opengw.developer.huaweicloud.com';
const EP_STATISTICS_PLUGIN = '/snap-manager/v1/statistics/plugin';
const EP_TOKEN_BALANCE = '/api/v1/user/tokens/balance';

/** 上游用 -1 表示指标不适用；负数与非法值一律当 0。 */
function nonNegative(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function str(value) {
  return typeof value === 'string' ? value : '';
}
function safeJson(text) {
  try { return record(JSON.parse(str(text))); } catch { return {}; }
}

/** 一个积分套餐包的四个数：total / used / remain / expiring。 */
function categoryOf(metric) {
  const m = record(metric);
  return {
    total: nonNegative(m.package_credit_amount),
    used: nonNegative(m.package_credit_used),
    remain: nonNegative(m.package_credit_remain),
    expiring: nonNegative(m.package_credit_expiring_amount),
  };
}
function metricNamed(metrics, name) {
  for (const raw of metrics) {
    const m = record(raw);
    if (str(m.name) === name || str(m.metric_name) === name || str(m.key) === name) return m;
  }
  return undefined;
}
function mapPlanStatus(status) {
  const s = str(status).toLowerCase();
  if (s === 'normal' || s === 'active') return 'active';
  if (s === 'closed' || s === 'expired') return 'expired';
  if (s === 'freeze' || s === 'frozen') return 'frozen';
  return s === '' ? 'unknown' : s;
}

/** 解析积分统计响应。没有 usageTotalPackageCredit 视为没有积分指标，返回 undefined。 */
export function parseCreditStatistics(raw) {
  const body = record(raw);
  const metrics = Array.isArray(body.metrics) ? body.metrics.map(record) : [];
  const totalMetric = metricNamed(metrics, 'usageTotalPackageCredit');
  if (totalMetric === undefined) return undefined;
  const pkg = record(body.package);
  const total = categoryOf(totalMetric);
  const bonusMetric = metricNamed(metrics, 'usageBonusPackageCredit');
  const basicMetric = metricNamed(metrics, 'usageBasicPackageCredit');
  const onDemandMetric = metricNamed(metrics, 'usageOnDemandPackageCredit');
  return {
    planName: str(pkg.package_name_cn) || str(pkg.package_name_en),
    planNameEn: str(pkg.package_name_en),
    specCode: str(pkg.spec_code),
    planStatus: mapPlanStatus(pkg.status),
    isCreditPackage: pkg.is_credit_package === true,
    periodStart: str(body.start_date),
    periodEnd: str(body.end_date),
    total: total.total,
    remain: total.remain,
    used: total.used,
    expiring: total.expiring,
    ...bonusMetric ? { bonus: categoryOf(bonusMetric) } : {},
    ...basicMetric ? { basic: categoryOf(basicMetric) } : {},
    ...onDemandMetric ? { onDemand: categoryOf(onDemandMetric) } : {},
    fetchedAt: Date.now(),
  };
}

/** 官方 token 用量口径（/api/v1/user/tokens/balance）。 */
export function parseTokenBalance(raw) {
  const body = record(raw);
  const result = record(body.result || body);
  return {
    balance: nonNegative(result.total_balance),
    quota: nonNegative(result.total_quota),
    dailyLimit: nonNegative(result.daily_token_limit),
    dailyUsed: nonNegative(result.daily_tokens_used),
    monthlyLimit: nonNegative(result.monthly_token_limit),
    monthlyUsed: nonNegative(result.monthly_tokens_used),
  };
}

/**
 * 取一个账号的积分 + 福利活动 + 官方 token 用量。
 * credential 来自 store.resolve(id)，至少含 token/accessKeyId/secretAccessKey/securityToken；
 * 只带 x-auth-token 会被 401 APIG.0301，所以必须走 signedGet 的 AK/SK 签名。
 */
export async function fetchAccountCredits(credential, signal) {
  const statistics = await signedGet(SNAP_HOST + EP_STATISTICS_PLUGIN, credential, undefined, signal);
  const balance = await signedGet(BENEFIT_GATEWAY_HOST + EP_TOKEN_BALANCE, credential, undefined, signal)
    .catch(function (error) { return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) }; });
  let welfare;
  try {
    const campaigns = await fetchWelfareCampaigns(credential, signal);
    const target = pickDailyWelfareCampaign(campaigns);
    if (target) {
      welfare = {
        claimable: target.claimable === true,
        claimedToday: !target.claimable && isWelfareClaimedStatus(target.status),
        amount: nonNegative(target.amount),
        title: str(target.title),
      };
    }
  } catch { welfare = undefined; }
  if (!statistics.ok) {
    throw new Error('积分统计接口失败 (' + statistics.status + '): ' + upstreamErrorMessage(str(statistics.message), statistics.status));
  }
  const credits = parseCreditStatistics(safeJson(statistics.text));
  if (credits === undefined) throw new Error('statistics response carries no credit metrics');
  return {
    credits,
    ...balance.ok ? { tokens: parseTokenBalance(safeJson(balance.text)) } : {},
    ...welfare ? { welfare } : {},
  };
}

/** 把一个账号的积分文档收敛成池状态文档的 account 行（零密文）。 */
export function accountRow(summary, detail) {
  const c = detail.credits;
  const expireAt = str(c.periodEnd);
  // periodEnd 是纯日期 "2026-12-03"：Date.parse 按 UTC 午夜解析，
  // 面板（Asia/Shanghai）会显示成 12/3 08:00，而套餐实际有效期到当天结束。
  // 纯日期统一按北京当天 23:59:59.999 落点，显示与计费周期一致。
  const dayOnly = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(expireAt);
  const parsed = dayOnly
    ? Date.parse(expireAt + 'T23:59:59.999+08:00')
    : Date.parse(expireAt);
  const endTimeMs = Number.isFinite(parsed) ? parsed : undefined;
  return {
    id: str(summary.id),
    label: str(summary.label) || str(summary.userName) || str(summary.id),
    userName: str(summary.userName),
    size: c.total,
    remain: c.remain,
    used: c.used,
    expiring: c.expiring,
    expireAt,
    ...endTimeMs !== undefined ? { endTimeMs } : {},
    planName: c.planName,
    planStatus: c.planStatus,
    ...c.basic ? { basic: { size: c.basic.total, remain: c.basic.remain, expiring: c.basic.expiring } } : {},
    ...c.bonus ? { bonus: { size: c.bonus.total, remain: c.bonus.remain, expiring: c.bonus.expiring } } : {},
    ...c.onDemand ? { onDemand: { size: c.onDemand.total, remain: c.onDemand.remain, expiring: c.onDemand.expiring } } : {},
    ...detail.tokens ? { tokens: detail.tokens } : {},
    ...detail.welfare ? { checkin: detail.welfare } : {},
    signable: summary.signable === true,
    stale: summary.stale === true,
    paused: summary.paused === true,
    pinned: summary.pinned === true,
    expiration: str(summary.expiration),
  };
}

/** 查询失败的账号占位行：逐号明细里仍显示这一号，只是标注错误。 */
export function placeholderRow(summary, error) {
  return {
    id: str(summary.id),
    label: str(summary.label) || str(summary.userName) || str(summary.id),
    userName: str(summary.userName),
    size: 0,
    remain: 0,
    expiring: 0,
    signable: summary.signable === true,
    stale: summary.stale === true,
    paused: summary.paused === true,
    pinned: summary.pinned === true,
    error: str(error).slice(0, 200),
  };
}

/** 每日签到（幂等）：把 vendor 的 state 映射成 panel 的 claim.state。 */
export async function claimCheckin(credential, signal) {
  const result = await claimDailyWelfare(credential, signal);
  const state = result.state === 'claimed' ? 'claimed'
    : result.state === 'already' ? 'already-claimed'
    : result.state === 'unavailable' ? 'unsupported'
    : 'failed';
  return { state, amount: nonNegative(result.amount), message: str(result.message) };
}

/**
 * 上游排队位置探测。GET /api/v1/queue/status 是占号语义，查完立刻 DELETE 清票，
 * 不留幽灵任务。默认不主动占号，用户点开信息行才探一次（由 index.js 控制）。
 */
export async function probeQueue(credential, model, chatId, signal) {
  try {
    const q = await fetchQueueStatus(credential, chatId, model, signal);
    try { await clearQueueStatus(credential, chatId, model, signal); } catch { /* 清票失败不影响读数 */ }
    return {
      status: str(q.status),
      position: nonNegative(q.queuePosition),
      length: nonNegative(q.queueLength),
      message: str(q.message),
      model,
      at: Date.now(),
    };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error), model, at: Date.now() };
  }
}

let tracker;
/** 本机用量账本（按账号 / 按天，保留 60 天；不产生上游请求）。 */
export function usageTracker() {
  if (!tracker) tracker = new CodeArtsUsageTracker({ path: codeartsUsagePath() });
  return tracker;
}
export function usageSnapshot() {
  try { return usageTracker().snapshot(); } catch { return undefined; }
}
export function noteRequest(accountId, model) {
  try { usageTracker().noteRequest(accountId, model); } catch { /* 账本失败不影响聊天 */ }
}
export function noteUsage(accountId, model, rawUsage) {
  try { usageTracker().noteUsage(accountId, model, rawUsage); } catch { /* 同上 */ }
}
export function noteFailure(kind, accountId) {
  try { usageTracker().noteFailure(kind, accountId); } catch { /* 同上 */ }
}
