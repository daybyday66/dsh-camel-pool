/**
 * 官方积分政策兜底：当上游没有逐包到期字段时，给免费/签到制渠道一个有限的、
 * 可解释的保守估算到期时间。估算只用于「最早过期优先」排序与展示，绝不改写余额。
 */
const SHIFT = 8 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

export const CREDIT_POLICY_URLS = {
  trae: "https://docs.trae.cn/ide_plans-and-billing",
  qoderDaily: "http://docs.qoder.com/zh/events/100credits",
  qoderPricing: "http://docs.qoder.com/account/pricing",
  gemini: "https://aistudio.google.com/docs/rate-limits",
  codeartsBilling: "https://support.huaweicloud.com/price-codeartsagent/codeartsagent_billing_0028.md",
  codeartsOffers: "https://support.huaweicloud.com/offers-codeartsagent/codeartsagent_offers_0004.md",
};

function beijingMonthEndMs(now) {
  const shifted = new Date(now + SHIFT);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  return Date.UTC(y, m + 1, 1, 0, 0, 0, 0) - SHIFT - 1;
}

function nextBeijingMidnightMs(now) {
  return Math.floor((now + SHIFT) / DAY) * DAY + DAY - SHIFT;
}

const LA_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function laParts(ms) {
  const map = {};
  for (const part of LA_FMT.formatToParts(new Date(ms))) map[part.type] = part.value;
  return {
    y: Number(map.year),
    m: Number(map.month),
    d: Number(map.day),
    h: Number(map.hour),
    min: Number(map.minute),
    s: Number(map.second),
  };
}

/** 把 America/Los_Angeles 的墙钟时间解成 UTC 毫秒，自动处理 PST/PDT。 */
function laWallToUtc(y, m, d, h, mi, s, ms, guess) {
  const wall = Date.UTC(y, m - 1, d, h, mi, s, ms);
  let utc = wall;
  for (let i = 0; i < 3; i += 1) {
    const p = laParts(utc);
    const wallAsUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s, 0);
    const offset = wallAsUtc - Math.floor(utc / 1000) * 1000;
    utc = wall - offset;
  }
  return utc;
}

function nextPacificMidnightMs(now) {
  const p = laParts(now);
  const today = laWallToUtc(p.y, p.m, p.d, 0, 0, 0, 0, now);
  if (now < today) return today;
  return laWallToUtc(p.y, p.m, p.d + 1, 0, 0, 0, 0, now);
}

function makePolicy(expiryMs, policy, urls) {
  return { expiryMs, estimated: true, source: "official-policy", policy, urls };
}

export function policyCreditExpiry(route, doc, now = Date.now()) {
  const kind = String((route && (route.kind || route.providerId)) || "").toLowerCase();
  const status = String((doc && doc.status) || "").toLowerCase();
  if (status === "signed-out" || status === "unavailable" || status === "error") return undefined;

  if (kind.indexOf("trae") >= 0) {
    // 每月登录赠送 500 积分「当前自然月」；签到/邀请/新用户等多为 31 个自然日。
    // 上游不拆包时取两者较早者（通常是当前自然月末），宁可提前烧也不把渠道排成无限期。
    const expiryMs = Math.min(beijingMonthEndMs(now), now + 31 * DAY);
    return makePolicy(
      expiryMs,
      "Trae CN：每月登录赠送 500 积分当前自然月有效；签到/邀请/新用户等 31 个自然日。无逐包到期时按当前自然月末保守估算。",
      [CREDIT_POLICY_URLS.trae],
    );
  }

  if (kind.indexOf("qoder") >= 0) {
    // Plan Credits 当前计费周期末不结转；每日 100 Credits 自领取日起 30 天。
    // 同样取较早者，避免缺失 expiryMs 时排序用 Number.MAX_SAFE_INTEGER。
    const expiryMs = Math.min(beijingMonthEndMs(now), now + 30 * DAY);
    return makePolicy(
      expiryMs,
      "Qoder：Plan Credits 当前计费周期末过期且不结转；每日 100 Credits 自领取日起 30 天有效。无逐笔到期时按当前自然月末保守估算。",
      [CREDIT_POLICY_URLS.qoderDaily, CREDIT_POLICY_URLS.qoderPricing],
    );
  }

  if (kind.indexOf("gemini") >= 0 || kind.indexOf("google") >= 0) {
    return makePolicy(
      nextPacificMidnightMs(now),
      "Gemini API：免费层 RPD 日配额于太平洋时间午夜重置；这是速率窗口，不是可结转积分包。",
      [CREDIT_POLICY_URLS.gemini],
    );
  }

  return undefined;
}
