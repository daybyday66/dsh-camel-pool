/**
 * Gemini Pro 订阅「用量限额」缓存与同步桥。
 *
 * 背景：Gemini App 网页版的 PRO 用量限额是 compute-based 的 5 小时窗口 + 每周
 * 限额，只存在 Google 账号会话里；AI Studio 的 API key 是另一套凭证/额度，
 * 没有公开的 API-key 端点能读到这两个百分比。因此这里用「本机缓存文件 +
 * 回环 POST 同步端点」：任何能读到用量页读数的小脚本 / 浏览器扩展把读数
 * POST 到 /plugins/dsh-pool/status 即可同步，面板读缓存展示。
 *
 * 缓存：~/.dsh/gemini-quota.json（或 $DSH_HOME/gemini-quota.json）。
 * 可选自动刷新：GEMINI_QUOTA_RPC_URL 指向本机桥，GET 它拿同形状 JSON 后落盘。
 *
 * 凭证纪律：只挑额度字段写盘，POST body 里的任何 token/cookie/authorization
 * 一律忽略、不打印、不落盘；错误只回 safeMessage。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { directFetch } from "../../shared/net-rescue.js";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

const QUOTA_FILE = "gemini-quota.json";

export function geminiQuotaPath() {
  const dshHome = String(process.env.DSH_HOME ?? "").trim();
  return dshHome !== "" ? join(dshHome, QUOTA_FILE) : join(homedir(), ".dsh", QUOTA_FILE);
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

function isoOrEmpty(value) {
  if (typeof value !== "string" || value.trim() === "") return "";
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function normalizeBucket(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const used = raw.usedPercent ?? raw.percentUsed ?? raw.used ?? raw.pctUsed;
  const reset = raw.resetAt ?? raw.resetTime ?? raw.windowRefreshesAt;
  if (used === undefined && reset === undefined) return undefined;
  return { usedPercent: clampPercent(used), resetAt: isoOrEmpty(reset) };
}

function text(value, fallback, max) {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : fallback;
}

/** 把外部 payload 收敛成白名单结构；写入时 updatedAt 取 now，读取时保留原值。 */
function coerceDoc(parsed, preserveUpdatedAt) {
  if (!parsed || typeof parsed !== "object") return null;
  const current = normalizeBucket(parsed.current ?? { usedPercent: parsed.currentUsedPercent ?? parsed.currentPercent, resetAt: parsed.currentResetAt });
  const weekly = normalizeBucket(parsed.weekly ?? { usedPercent: parsed.weeklyUsedPercent ?? parsed.weeklyPercent, resetAt: parsed.weeklyResetAt });
  if (!current && !weekly) return null;
  const kept = preserveUpdatedAt ? (isoOrEmpty(parsed.updatedAt) || new Date().toISOString()) : new Date().toISOString();
  return {
    source: text(parsed.source, "本机同步", 120),
    note: text(parsed.note, "", 240),
    syncMode: text(parsed.syncMode, "manual", 40),
    updatedAt: kept,
    current: current ?? { usedPercent: 0, resetAt: "" },
    weekly: weekly ?? { usedPercent: 0, resetAt: "" },
  };
}

function withExpiry(doc) {
  const now = Date.now();
  const mark = (b) => {
    const ms = b && b.resetAt ? Date.parse(b.resetAt) : NaN;
    return { usedPercent: b?.usedPercent ?? 0, resetAt: b?.resetAt ?? "", expired: Number.isFinite(ms) && ms <= now };
  };
  return { ...doc, current: mark(doc.current), weekly: mark(doc.weekly) };
}

/** POST 同步端点用：校验 + 原子写缓存 + 返回可展示文档。 */
export function writeGeminiQuota(payload) {
  const doc = coerceDoc(payload, false);
  if (!doc) throw new Error("gemini quota payload missing current/weekly usage");
  const target = geminiQuotaPath();
  mkdirSync(dirname(target), { recursive: true });
  const tmp = target + ".tmp-" + randomUUID();
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
  renameSync(tmp, target);
  return withExpiry(doc);
}

/**
 * 状态文档用：读缓存 + 标注窗口是否已过期。
 * refresh=true 且配置了 GEMINI_QUOTA_RPC_URL 时，先 GET 本机桥更新缓存。
 * 任何异常都静默回落到「只读缓存」，绝不让额度区块拖垮状态接口。
 */
export async function readGeminiQuota(options = {}) {
  if (options.refresh === true) {
    const url = String(process.env.GEMINI_QUOTA_RPC_URL ?? "").trim();
    if (url !== "") {
      try {
        const res = await directFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
        if (res.ok) writeGeminiQuota(await res.json());
      } catch {
        /* 桥不可达时静默回落缓存 */
      }
    }
  }
  try {
    const parsed = JSON.parse(readFileSync(geminiQuotaPath(), "utf8"));
    const doc = coerceDoc(parsed, true);
    return doc === null ? null : withExpiry(doc);
  } catch {
    return null;
  }
}

export function geminiQuotaExists() {
  return existsSync(geminiQuotaPath());
}
