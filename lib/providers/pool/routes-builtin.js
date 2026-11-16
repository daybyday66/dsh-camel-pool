/**
 * dsh-pool 内置轻量路由：阿里云百炼代金券 + 七牛云免费模型。
 *
 * 它们与各渠道 provider 不同：没有登录态、没有会话文件、没有后台刷新，
 * 只有一份静态模型清单和一个 API key 读取器 —— 所以从池外壳里搬出来，
 * 别让 index.js 既装代理又装两家厂商的签名细节。
 *
 * 凭证纪律：key 只在内存里用，日志只记长度。
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { directFetch } from "../../shared/net-rescue.js";
import { safeMessage } from "../../shared/http.js";
import { logPoolEvent } from "../../shared/pool.js";

/** 与 index.js 里的同值常量：这两条路由的模型都不计费。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

//#region 百炼代金券路由

/**
 * 代金券路由的固定事实（2026-11-01 从 cordis.patch.yml 的 aliyun-bailian 段搬到池里）。
 *
 * 这一段不是"又一个渠道"：它没有积分包、没有过期时间，只能兜底。所以它固定
 * priority 9 + voucher:true，由 shared/pool.js 排到所有积分路由之后；偏好里开了
 * poolVoucherFirst 才手动提到最前。
 */
const BAILIAN_KEY = "bailian";
const BAILIAN_BASE_URL = "https://ws-i2d9x1g41bysp1va.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
const BAILIAN_KEY_ENV = "ALIYUN_BAILIAN_API_KEY";
/** yml 里实测过的 5 个模型：识图能力与 off/high/max 档照抄，不与渠道争名字。 */
const BAILIAN_MODELS = [
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", input: ["text"] },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", input: ["text", "image"] },
  { id: "qwen3.8-max", name: "Qwen3.8-Max", input: ["text", "image"] },
  { id: "kimi-k3", name: "Kimi K3", input: ["text", "image"] },
  { id: "glm-5.3", name: "GLM-5.3", input: ["text"] },
];
/** 百炼的档位映射（yml reasoningEfforts：off 不支持，high/max 直通，其余取最近档）。 */
const BAILIAN_EFFORT_MAP = { off: null, low: null, medium: null, high: "high", xhigh: "max", max: "max" };

/**
 * 代金券 key 的读取：先环境变量，再凭据服务（~/.dsh/.credentials.yaml 里加密存着）。
 * 结果缓存 60 秒 —— 凭据服务本身也有开销，而 key 不该每个请求解一次。
 */
export function createBailianKeyReader(ctx) {
  let cached = { value: "", at: 0 };
  return async () => {
    const fromEnv = typeof process.env[BAILIAN_KEY_ENV] === "string" ? process.env[BAILIAN_KEY_ENV].trim() : "";
    if (fromEnv !== "") return fromEnv;
    const now = Date.now();
    if (cached.value !== "" && now - cached.at < 60_000) return cached.value;
    let resolved = "";
    try {
      const service = typeof ctx.get === "function" ? ctx.get("credentials") : undefined;
      const hit = await service?.resolve?.(BAILIAN_KEY_ENV);
      if (typeof hit?.value === "string") resolved = hit.value.trim();
    } catch (error) {
      logPoolEvent({ ev: "bailian-key", error: safeMessage(error) });
    }
    cached = { value: resolved, at: now };
    return resolved;
  };
}

/** 券时间来自 BSS（"yyyy-MM-dd HH:mm"，北京时间）→ 毫秒；解析不出来就给 undefined。 */
function couponLocalMs(value) {
  const text = String(value ?? "").trim();
  if (text === "") return undefined;
  const at = Date.parse(text.replace(" ", "T") + ":00+08:00");
  return Number.isFinite(at) ? at : undefined;
}

export function bailianRoute(readKey, readVoucher) {
  return {
    key: BAILIAN_KEY,
    kind: "bailian",
    providerId: "aliyun-bailian",
    channelId: "aliyun-bailian",
    displayName: "阿里云百炼代金券",
    priority: 9,
    voucher: true,
    chatUrl: () => BAILIAN_BASE_URL + "/chat/completions",
    token: async () => {
      const key = await readKey();
      if (key === "") throw new Error("ALIYUN_BAILIAN_API_KEY 未配置（环境变量与凭据服务都没有）");
      return key;
    },
    models: () =>
      BAILIAN_MODELS.map((model) => ({
        id: model.id,
        name: model.name,
        api: "openai-completions",
        provider: BAILIAN_KEY,
        input: model.input,
        reasoning: true,
        thinkingLevelMap: BAILIAN_EFFORT_MAP,
        cost: NO_COST,
        contextWindow: 131072,
        maxTokens: 32768,
        compat: { maxTokensField: "max_tokens" },
      })),
    hidden: () => [],
    // 需求 1：给 refreshPoolCredits / poolStatusDocument 提供代金券余额。
    // 本机 /plugins/aliyun-voucher/balance 优先，没装那个插件就直签 BSS。
    credits: async () => {
      const voucher = await readVoucher();
      return {
        status: "ok",
        credits: {
          remaining: voucher.remaining,
          total: voucher.maxBudget,
          accounts: Array.isArray(voucher.coupons)
            ? voucher.coupons.map((coupon) => ({
                name: coupon.no ?? coupon.id ?? "代金券",
                packageName: coupon.description ?? coupon.no ?? "代金券",
                remaining: coupon.remaining,
                remain: coupon.remaining,
                // effectiveTime 是"生效时间"，绝不能叫 endTime —— minExpiry 会把它
                // 当成到期时间，导致代金券被误判成"最早过期"而抢先烧掉。
                effectiveTime: couponLocalMs(coupon.effectiveTime),
                expireTime: couponLocalMs(coupon.expiryTime),
              }))
            : [],
          // 券的到期时间（北京时间字符串 → ms）；minExpiry 会据此排到真正的到期点。
          expiry: couponLocalMs(voucher.expiresSoonest),
        },
        voucher,
      };
    },
  };
}

//#endregion

//#region 阿里云百炼代金券余额（需求 1）

/**
 * 内联一份 BSS OpenAPI v3 (ACS3-HMAC-SHA256) 只读签名。
 * 为什么不 import dsh-aliyun-voucher：池不能对另一个插件产生硬依赖，
 * 那个插件没装 / 没启用时余额照样要显示。逻辑与
 * ~/.dsh/plugins/dsh-aliyun-voucher/lib/aliyun-voucher.js 保持一致。
 */
const BSS_ENDPOINT = "https://business.aliyuncs.com/";
const BSS_HOST = "business.aliyuncs.com";
const VOUCHER_CREDENTIAL_VARS = [
  "ALIBABA_CLOUD_ACCESS_KEY_ID",
  "ALIBABA_CLOUD_ACCESS_KEY_SECRET",
  "ALIBABA_CLOUD_SECURITY_TOKEN",
];
const BAILIAN_VOUCHER_TTL_MS = 300_000;

const bssHash = (value) => createHash("sha256").update(value).digest("hex");

function canonicalQueryString(params) {
  const enc = (value) => encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return Object.entries(params ?? {})
    .map(([key, value]) => enc(key) + "=" + enc(value))
    .sort()
    .join("&");
}

async function resolveVoucherCredential(ctx, name) {
  try {
    const service = typeof ctx?.get === "function" ? ctx.get("credentials") : undefined;
    const hit = await service?.resolve?.(name);
    if (typeof hit?.value === "string" && hit.value.trim() !== "") return hit.value.trim();
  } catch {
    /* 回落到环境变量 */
  }
  return String(process.env[name] ?? "").trim();
}

function signBssRequest(accessKeyId, accessKeySecret, securityToken, spec, { now = new Date(), nonce = randomUUID() } = {}) {
  const query = canonicalQueryString(spec.query);
  const headers = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
    host: BSS_HOST,
    "x-acs-action": spec.action,
    "x-acs-content-sha256": bssHash(""),
    "x-acs-date": now.toISOString().replace(/\.\d{3}Z$/u, "Z"),
    "x-acs-signature-nonce": nonce,
    "x-acs-version": spec.version,
  };
  if (securityToken) headers["x-acs-security-token"] = securityToken;
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((key) => key + ":" + String(headers[key]).trim() + "\n")
    .join("");
  const canonical = ["POST", "/", query, canonicalHeaders, signedHeaders, bssHash("")].join("\n");
  const signature = createHmac("sha256", accessKeySecret).update("ACS3-HMAC-SHA256\n" + bssHash(canonical)).digest("hex");
  headers.authorization = "ACS3-HMAC-SHA256 Credential=" + accessKeyId + ",SignedHeaders=" + signedHeaders + ",Signature=" + signature;
  const url = query ? BSS_ENDPOINT + "?" + query : BSS_ENDPOINT;
  return { url, init: { method: "POST", headers, body: "", redirect: "manual" } };
}

function toAmount(value) {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

/** ISO(yyyy-MM-ddTHH:mm:ssZ) → yyyy-MM-dd HH:mm，券列表与面板展示共用。 */
function isoToLocalText(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/u.exec(String(iso ?? ""));
  return m ? m[1] + "-" + m[2] + "-" + m[3] + " " + m[4] + ":" + m[5] : (iso || null);
}

/** GET /plugins/aliyun-voucher/balance 在就直接用（那边也做了 5 分钟缓存）。 */
async function voucherFromLoopback() {
  const bases = ["http://127.0.0.1:7245", "http://127.0.0.1:3032"];
  for (const base of bases) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        const response = await directFetch(base + "/plugins/aliyun-voucher/balance", { signal: controller.signal });
        if (!response.ok) continue;
        const data = await response.json();
        if (typeof data?.remaining !== "number") continue;
        return data;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      /* 换下一个端口 / 回落到直签 */
    }
  }
  return undefined;
}

export function createBailianCreditsReader(ctx) {
  let cached = { doc: undefined, at: 0 };
  let inFlight;
  const run = async () => {
    const local = await voucherFromLoopback();
    if (local !== undefined) return local;
    const [accessKeyId, accessKeySecret, securityToken] = await Promise.all(
      VOUCHER_CREDENTIAL_VARS.map((name) => resolveVoucherCredential(ctx, name)),
    );
    if (!accessKeyId || !accessKeySecret) {
      throw new Error("请先配置 ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET（RAM AccessKey，不是百炼模型 API Key）");
    }
    const spec = { action: "QueryCashCoupons", version: "2017-12-14", query: { EffectiveOrNot: "true" } };
    const { url, init } = signBssRequest(accessKeyId, accessKeySecret, securityToken, spec);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    let response;
    try {
      response = await directFetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      throw new Error("阿里云网络请求失败：" + safeMessage(error));
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = body?.Message || body?.Code || "";
      } catch {
        /* 无 body */
      }
      throw new Error("QueryCashCoupons HTTP " + response.status + (detail ? "：" + detail : ""));
    }
    const data = await response.json();
    if ((data?.Code && data.Code !== "Success") || data?.Success === false) {
      throw new Error("QueryCashCoupons 未成功：" + (data?.Message || data?.Code || "未知错误") + "（需要 RAM 权限 bss:DescribeCoupons）");
    }
    const list = Array.isArray(data?.Data?.CashCoupon) ? data.Data.CashCoupon : [];
    const coupons = list
      .map((item) => ({
        id: item.CashCouponId ?? null,
        no: item.CashCouponNo ?? null,
        remaining: toAmount(item.Balance),
        nominalValue: toAmount(item.NominalValue),
        status: item.Status ?? null,
        effectiveTime: isoToLocalText(item.EffectiveTime),
        expiryTime: isoToLocalText(item.ExpiryTime),
        description: typeof item.Description === "string" ? item.Description : null,
        applicableScenarios: item.ApplicableScenarios ?? null,
      }))
      .filter((coupon) => coupon.remaining !== null);
    const remaining = coupons.reduce((acc, coupon) => acc + coupon.remaining, 0);
    const maxBudget = coupons.reduce((acc, coupon) => acc + (coupon.nominalValue ?? coupon.remaining), 0);
    const expiresSoonest = coupons
      .filter((coupon) => !coupon.expiryTime || coupon.status !== "Expired")
      .map((coupon) => coupon.expiryTime)
      .filter(Boolean)
      .sort()[0] ?? null;
    return {
      label: "阿里云百炼代金券",
      unit: "CNY",
      remaining: Math.round(remaining * 100) / 100,
      maxBudget: Math.round(maxBudget * 100) / 100,
      spend: Math.round((maxBudget - remaining) * 100) / 100,
      count: coupons.length,
      coupons,
      expiresSoonest,
      updatedAt: new Date().toISOString(),
    };
  };
  return async (force = false) => {
    const now = Date.now();
    if (!force && cached.doc !== undefined && now - cached.at < BAILIAN_VOUCHER_TTL_MS) return cached.doc;
    if (inFlight !== undefined) return inFlight;
    inFlight = run()
      .then((doc) => {
        cached = { doc, at: Date.now() };
        return doc;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}

//#endregion

//#region 七牛云免费模型（需求 8）

const QINIU_ROUTE_KEY = "qiniu";
const QINIU_BASE_URL = "https://api.qnaigc.com/v1";
const QINIU_KEY_ENV = "QINIU_API_KEY";
const QINIU_KEY_FILE = "qiniu-api-key";
/** 2026-11-08 官网活动页：Conatus 限免 10.24 00:00 ~ 11.30 23:59（北京时间）。 */
const QINIU_CONATUS_FREE_UNTIL = Date.parse("2026-11-30T15:59:00Z");
const QINIU_FREE_MODELS = [
  {
    id: "qiniu/conatus-free",
    name: "七牛 Conatus 免费",
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    freeUntil: QINIU_CONATUS_FREE_UNTIL,
    freeLabel: "限时免费至 11.30",
  },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b0-free",
    name: "Nemotron 3 Ultra 550B 免费",
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    freeUntil: undefined,
    freeLabel: "免费（不承诺稳定性）",
  },
];
const QINIU_EFFORT_MAP = { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: "max", max: "max" };

function qiniuFreeModels() {
  const override = String(process.env.QINIU_FREE_MODELS ?? "").trim();
  if (override === "") return QINIU_FREE_MODELS;
  const ids = override.split(",").map((item) => item.trim()).filter(Boolean);
  // 活动结束/下线时只改 env 即可，不必改代码；配置过的 id 保留免费标记。
  return ids.map((id, index) => ({
    ...(QINIU_FREE_MODELS[index] ?? QINIU_FREE_MODELS[QINIU_FREE_MODELS.length - 1]),
    id,
    name: "七牛 " + id,
    input: ["text"],
  }));
}

export function createQiniuKeyReader(ctx) {
  let cached = { value: "", at: 0 };
  return async () => {
    const fromEnv = String(process.env[QINIU_KEY_ENV] ?? "").trim();
    if (fromEnv !== "") return fromEnv;
    const now = Date.now();
    if (cached.value !== "" && now - cached.at < 60_000) return cached.value;
    let value = "";
    const dshHome = String(process.env.DSH_HOME ?? "").trim();
    const candidates = [
      dshHome === "" ? "" : join(dshHome, QINIU_KEY_FILE),
      join(homedir(), ".dsh", QINIU_KEY_FILE),
    ].filter(Boolean);
    for (const file of candidates) {
      try {
        const text = (await readFile(file, "utf8")).trim();
        if (text !== "") {
          value = text;
          break;
        }
      } catch {
        /* 试下一个位置 */
      }
    }
    if (value === "") {
      try {
        const service = typeof ctx?.get === "function" ? ctx.get("credentials") : undefined;
        const hit = await service?.resolve?.(QINIU_KEY_ENV);
        if (typeof hit?.value === "string") value = hit.value.trim();
      } catch {
        /* 没有凭据服务 */
      }
    }
    if (value === "") throw new Error("QINIU_API_KEY 未配置（环境变量、~/.dsh/qiniu-api-key 与凭据服务都没有）");
    cached = { value, at: now };
    return value;
  };
}

export function qiniuRoute(readKey) {
  return {
    key: QINIU_ROUTE_KEY,
    kind: "qiniu",
    providerId: QINIU_ROUTE_KEY,
    channelId: QINIU_ROUTE_KEY,
    displayName: "七牛云免费 API",
    // 免费额度每日 00:00 重置、不结转，优先烧掉不浪费。
    priority: -1,
    voucher: false,
    free: true,
    chatUrl: () => QINIU_BASE_URL + "/chat/completions",
    token: readKey,
    models: () =>
      qiniuFreeModels().map((model) => ({
        id: model.id,
        name: model.name,
        api: "openai-completions",
        provider: QINIU_ROUTE_KEY,
        input: model.input,
        reasoning: true,
        thinkingLevelMap: QINIU_EFFORT_MAP,
        cost: NO_COST,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        free: true,
        freeUntil: model.freeUntil,
        freeLabel: model.freeLabel,
        badges: ["免费"],
        compat: { maxTokensField: "max_tokens" },
      })),
    hidden: () => [],
    // 免费额度每日 00:00（北京时间）重置、不结转 → 当天到期即"最早过期"，
    // 理应优先烧掉。但它是无限量占位值，不是真实积分：标记 syntheticBalance，
    // 让状态文档不要把它加进 credits.total、也不要用它撑爆前端进度条。
    credits: async () => ({
      status: "ok",
      syntheticBalance: true,
      credits: { remaining: 1e12, accounts: [], expiry: nextBeijingMidnight() },
    }),
  };
}

/** 下一个北京时间 00:00（UTC+8）的 UTC 毫秒时间戳。 */
function nextBeijingMidnight(now = Date.now()) {
  const shift = 8 * 60 * 60 * 1000;
  const day = 24 * 60 * 60 * 1000;
  return Math.floor((now + shift) / day) * day + day - shift;
}

//#endregion

/** 池外壳注册路由时只认这 5 个入口（上面每个构造函数都用 export 前缀导出）。 */
