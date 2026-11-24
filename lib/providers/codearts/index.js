/**
 * CodeArts 渠道 —— 驼峰积分池 dsh-camel-pool 的一条 registerPoolRoute。
 *
 * 架构（按驼峰规则，不复刻市场插件、不起独立 shim）：
 *  · 协议引擎是 vendor/ 下四个实测构建产物，由 engine.js 重导出可读名；
 *  · 本文件只做 registerPoolRoute 契约、账号/登录会话、模型目录、web 路由、池状态挂载；
 *  · route.fetch 忽略池塞进来的 Bearer 头，把最终 init.body 交给 prepareChatBody
 *    白名单重建，再用真实凭据签名，经 transport.js 的 node:https 直连出网并转
 *    OpenAI SSE。签名字节就是发出的字节，中间没有代理可以改写。
 *    注意不能用全局 fetch：billion-context 会接管 globalThis.fetch，对它认出的
 *    SDK-HMAC-SHA256 签名请求先压缩再重签，而它没有 CodeArts 凭据，于是本地
 *    403 signed_request_requires_resign / bili_resign_unavailable —— 这正是旧
 *    shim 与上一版的失败点。
 *  · 积分 / 签到 / 上游排队位置 / 本机用量经 credits() 与 /plugins/dsh-pool/status
 *    的 doc.codearts 汇入统一面板；两个开关单独控制「积分」「排队位置」的显示。
 *
 * 凭证纪律：token / AK / SK / refresh_token / DPoP 私钥一律不出进程，
 * 日志与端点零密文，凭据只由 CodeArtsAccountStore 以 0600 落盘。
 */
import {
  prepareChatBody,
  SNAP_HOST,
  fetchModels,
  canonicalModel,
  isBenefitModel,
  fetchCallerIdentity,
  upstreamErrorMessage,
  maxTokensCeilingFor,
  modelDisplayName,
  isIamTokenError,
  startLogin,
  defaultLoginConfig,
  credentialFromOAuth,
  MANUAL_ACCOUNT_ID,
  codeartsAccountsPath,
  codeartsAuthPath,
  CodeArtsAccountStore,
} from './engine.js';
import { chatStreamDirect, signedJson } from './transport.js';
import {
  fetchAccountCredits,
  accountRow,
  placeholderRow,
  claimCheckin,
  probeQueue,
  usageSnapshot,
  noteRequest,
  noteUsage,
  noteFailure,
} from './credits.js';
import { writeJson, loopbackRequest, safeMessage } from '../../shared/http.js';

export const CODEARTS_ROUTE_KEY = 'codearts';
export const CODEARTS_OAUTH_PATH = '/plugins/dsh-pool/codearts-oauth';
export const CODEARTS_STATUS_PATH = '/plugins/dsh-connect/codearts/status';
export const CODEARTS_CHECKIN_PATH = '/plugins/dsh-connect/codearts/checkin';
export const CODEARTS_QUEUE_PATH = '/plugins/dsh-pool/codearts-queue';
const CHAT_PATH = '/api/v2/chat/completions';
const CREDITS_TTL_MS = 60000;
const THINKING_PATH = '/v1/model/thinking-variants';

function str(value) {
  return typeof value === 'string' ? value : '';
}
function rec(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function positiveNum(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const store = new CodeArtsAccountStore(codeartsAccountsPath(), codeartsAuthPath());

// 用户点名保留的 5 个 CodeArts 模型（按模型库里展示顺序）。上游目录会漂移，
// 这里只放行这 5 个 id；其余（openpangu / speed / glm-5.2* / 1017 等）一律不进池。
const ALLOWED_CODEARTS_MODELS = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1048576, maxTokens: 65536, supportsImages: true },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1048576, maxTokens: 65536, supportsImages: true },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1048576, maxTokens: 65536, supportsImages: true },
  { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 1048576, maxTokens: 65536, supportsImages: true },
  { id: 'kimi-k3.1-pro', name: 'Kimi-K3.1-Pro', contextWindow: 1048576, maxTokens: 65536, supportsImages: true },
];
const ALLOWED_IDS = new Set(ALLOWED_CODEARTS_MODELS.map(function (m) { return m.id.toLowerCase(); }));
function isAllowedModel(id) { return ALLOWED_IDS.has(String(id).toLowerCase()); }

// —— 模型目录 ——
// 思考档位（宿主叫 reasoning metadata）必须来自上游真实 strengths：
// dsh-llm 对 reasoning=true 但 efforts 为空的模型直接抛
//   adapter returned invalid reasoning metadata for provider "dsh-pool" model "..."
// 并把整个 provider 的模型列表清空（2026-11-13 实测，openpangu-2.0-pro 触发）。
// 所以：拿到 strengths 才标 reasoning=true 并给出 thinkingLevelMap；拿不到就
// reasoning=false —— 模型照常进模型库、照常可选，只是宿主不显示档位选择器。
const EFFORT_WORDS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
let thinkingByModel = new Map();

function thinkingLevelsFor(id) {
  const entry = thinkingByModel.get(String(id).toLowerCase());
  const list = entry && Array.isArray(entry.strengths) ? entry.strengths : [];
  const levels = [];
  for (const raw of list) {
    const word = String(raw).toLowerCase();
    if (EFFORT_WORDS.has(word) && !levels.includes(word)) levels.push(word);
  }
  return levels;
}

async function fetchThinking(credential, ids) {
  const names = ids.filter(function (v) { return typeof v === 'string' && v !== ''; }).slice(0, 50);
  if (names.length === 0) return new Map();
  const res = await signedJson(credential, SNAP_HOST + THINKING_PATH, 'POST', { model_names: names }, AbortSignal.timeout(15000));
  if (!res.ok) throw new Error('thinking-variants HTTP ' + res.status);
  const out = new Map();
  const variants = rec(res.json && res.json.variants);
  for (const name of Object.keys(variants)) {
    const item = rec(variants[name]);
    const list = Array.isArray(item.strengths) ? item.strengths.map(str).filter(function (v) { return v !== ''; }) : [];
    if (list.length === 0) continue;
    out.set(String(name).trim().toLowerCase(), { strengths: list, default: str(item.default_strength) });
  }
  return out;
}

function toPoolModel(m) {
  const id = str(m.id);
  const name = str(m.name) || modelDisplayName(id) || id;
  const ceiling = maxTokensCeilingFor(id);
  const levels = thinkingLevelsFor(id);
  const thinkingLevelMap = {};
  for (const level of levels) thinkingLevelMap[level] = level;
  const model = {
    id,
    name,
    input: m.supportsImages === true ? ['text', 'image'] : ['text'],
    contextWindow: positiveNum(m.contextWindow) || 32768,
    maxTokens: Math.min(positiveNum(m.maxTokens) || 8000, ceiling > 0 ? ceiling : 65536) || 8000,
    reasoning: levels.length > 0,
  };
  if (levels.length > 0) model.thinkingLevelMap = thinkingLevelMap;
  return {
    ...model,
    ...m.ratio !== undefined && Number.isFinite(Number(m.ratio)) ? { rate: Number(m.ratio) } : {},
    ...m.benefit === true ? { badges: ['限时福利'] } : {},
  };
}
let currentModels = ALLOWED_CODEARTS_MODELS.map(toPoolModel);
let modelSource = { source: 'allowlist', count: currentModels.length, at: Date.now(), error: '' };
let refreshing = false;
// 模型库可见性与其他渠道（workbuddy / trae / qoder）完全一致：登录与否都恒定给出
// 目录；未登录时点选拿到的是 401 + 中文提示，而不是条目凭空消失。
// 面板下发的两条钩子，形状与三个老渠道一致：
//   setExternalHidden —— 「禁用模型 / 禁用渠道」黑名单
//   setPickerHidden   —— 池启用时把本渠道原生分组从选择器收起（池路由里的哨兵不命中任何 id）
let externalHidden = function () { return []; };
let pickerHidden = function () { return []; };
export function setExternalHidden(fn) {
  externalHidden = typeof fn === 'function' ? fn : function () { return []; };
}
export function setPickerHidden(fn) {
  pickerHidden = typeof fn === 'function' ? fn : function () { return []; };
}

async function firstCredential() {
  const ids = await store.dispatchIds().catch(function () { return []; });
  for (const id of ids) {
    const c = await store.resolve(id).catch(function () { return undefined; });
    if (c) return { ...c, id, securityToken: c.securityToken || c.token };
  }
  return undefined;
}

export async function refreshCodeartsModels() {
  if (refreshing) return { ok: false, reason: 'inflight' };
  const credential = await firstCredential();
  if (!credential) {
    return { ok: false, reason: 'signed-out' };
  }
  refreshing = true;
  try {
    const result = await fetchModels(credential, AbortSignal.timeout(30000));
    const rows = (Array.isArray(result.models) ? result.models : []).filter(function (m) { return typeof m.id === 'string' && isAllowedModel(m.id); });
    if (rows.length === 0) {
      modelSource = { ...modelSource, at: Date.now(), error: '上游目录里没有允许的 5 个模型，保留本地清单' };
      return { ok: true, count: currentModels.length, kept: true };
    }
    // 宿主对 reasoning 元数据是硬校验（efforts 为空即抛 INVALID_MODEL_REASONING，
    // 整个 dsh-pool 的模型列表会被清空）。档位只信上游 thinking-variants；
    // 拿不到就整批标非推理模型，模型仍然在库里。
    let thinking = new Map();
    try {
      thinking = await fetchThinking(credential, rows.map(function (m) { return m.id; }));
    } catch (error) {
      thinking = new Map();
    }
    thinkingByModel = thinking;
    // 按用户点名的固定顺序输出，不受上游返回顺序影响。
    currentModels = ALLOWED_CODEARTS_MODELS.map(function (m) {
      const upstream = rows.find(function (r) { return String(r.id).toLowerCase() === m.id.toLowerCase(); });
      return toPoolModel(upstream || m);
    });
    modelSource = { source: 'upstream', count: currentModels.length, at: Date.now(), sources: result.sources, errors: result.errors, error: '' };
    return { ok: true, count: currentModels.length };
  } catch (error) {
    modelSource = { ...modelSource, at: Date.now(), error: safeMessage(error) };
    return { ok: false, error: safeMessage(error) };
  } finally {
    refreshing = false;
  }
}

let refreshTimer = null;
let keepAliveTimer = null;
let refreshSeq = 0;
let lastAliveNote = '';
/**
 * 保活结果的可观测性。
 *
 * ux-v41：以前这里是 `void store.keepAlive().catch(function () {})` —— 失败被完全吞掉，
 * 日志里连一条 stale 都没有，用户说「又掉了」时只能靠猜。现在把 keepAlive 的返回值
 * （刷了几个、哪些要重登）和每个槽位最近一次的续期失败原文写进宿主日志。
 * 同一句话只打一次：保活每 5 分钟一轮，不去重会把日志刷满。
 */
function reportAlive(logger, text, warn) {
  if (text === '') { lastAliveNote = ''; return; }
  if (text === lastAliveNote) return;
  lastAliveNote = text;
  if (warn === true) logger?.warn?.(text); else logger?.info?.(text);
}
export function startCodeartsRefresh(intervalMs = 30 * 60 * 1000, keepAliveMs = 5 * 60 * 1000, logger) {
  const seq = ++refreshSeq;
  if (refreshTimer) clearInterval(refreshTimer);
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  const tick = function () { void refreshCodeartsModels(); };
  const aliveTick = function () {
    void (async function () {
      try {
        const result = await store.keepAlive();
        const rows = await store.list().catch(function () { return []; });
        const failed = rows.filter(function (row) {
          return typeof row.refreshError === 'string' && row.refreshError !== '';
        });
        const parts = [];
        if (result.refreshed > 0) parts.push('已续期 ' + result.refreshed + ' 个');
        if (result.needsLogin.length > 0) parts.push('需要重新登录：' + result.needsLogin.join(','));
        if (failed.length > 0) parts.push('最近一次失败：' + failed.map(function (row) { return row.id + ' ' + row.refreshError; }).join(' | '));
        reportAlive(logger, parts.length === 0 ? '' : '[codearts] ' + parts.join('；'), result.needsLogin.length > 0 || failed.length > 0);
      } catch (error) {
        reportAlive(logger, '[codearts] 保活异常：' + safeMessage(error), true);
      }
    })();
  };
  void refreshCodeartsModels();
  aliveTick();
  refreshTimer = setInterval(tick, intervalMs);
  keepAliveTimer = setInterval(aliveTick, keepAliveMs);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
  if (typeof keepAliveTimer.unref === 'function') keepAliveTimer.unref();
  return function () {
    if (seq !== refreshSeq) return;
    if (refreshTimer) clearInterval(refreshTimer);
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    refreshTimer = null;
    keepAliveTimer = null;
  };
}

// —— 账号轮转（粘性）——
let lastAccountId = '';
async function pickCredential() {
  const ids = await store.dispatchIds().catch(function () { return []; });
  if (ids.length === 0) return undefined;
  const ordered = ids.includes(lastAccountId)
    ? [lastAccountId, ...ids.filter(function (id) { return id !== lastAccountId; })]
    : ids;
  for (const id of ordered) {
    const c = await store.resolve(id).catch(function () { return undefined; });
    if (c) {
      lastAccountId = id;
      return { ...c, id, securityToken: c.securityToken || c.token };
    }
  }
  return undefined;
}

export function createCodeartsTokenReader() {
  return async function () {
    const c = await pickCredential().catch(function () { return undefined; });
    return c ? str(c.token) : '';
  };
}

// —— 最后一公里重签 + SSE ——
let creditsCache = { at: 0, doc: undefined, inflight: null };
let lastQueue = undefined;
function invalidateCredits() { creditsCache.at = 0; }

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

// —— ux-v14（P2-5）：错误体结构化 ——
//
// 历史问题：本适配层回给池的正文是中文人话（upstreamErrorMessage 的产物），而池侧的
// 分类器 looksLikeAuthFailure 只认英文正则，于是「IAM token 失效」被误判成 transport，
// 只冷却 60 秒，之后每个请求都白撞一次上游。
//
// 现在错误体统一带 kind，取值是**池内核的词汇表**（shared/pool.js:682 noteRouteFailure 的
// 四类 + upstream），池侧优先读它，正则只作无 kind 时的兜底：
//   session_dead —— 掉登录 / 被封号 / 无权限（池会记 10 分钟 auth 冷却并清 latch）
//   iam_stale    —— IAM token 失效（同上，可自动续期）
//   quota        —— 额度/福利耗尽（池记 60 秒 quota 并清 latch）
//   upstream     —— 上游短时波动（15 秒，下一请求立刻探测）
//   transport    —— 网络/协议层失败（60 秒）
const KIND_BY_TRANSPORT = {
  session_dead: 'session_dead',
  iam_stale: 'iam_stale',
  hard_credit: 'quota',
  soft_rate: 'quota',
  not_found: 'upstream',
  client: 'transport',
  server: 'transport',
  upstream: 'upstream',
};
/**
 * 把 transport.classify 的原始 kind 归一成池词汇。
 * IAM token 失效在 transport 里被判成 session_dead（401/403），但它的语义更窄、
 * 且能自动续期，所以先用 isIamTokenError 探一次再回落。
 */
function poolKindOf(rawKind, status, message) {
  const raw = str(rawKind);
  const text = str(message);
  if (isIamTokenError(text)) return 'iam_stale';
  const mapped = KIND_BY_TRANSPORT[raw];
  if (mapped !== undefined) return mapped;
  // 流内帧错误没有 transport kind：按状态码兜底判。
  if (status === 401 || status === 403) return 'session_dead';
  if (status === 402 || status === 429) return 'quota';
  return 'upstream';
}

/** 从 SSE 流里顺手抽出 usage 帧记进本机账本，不改变转发字节。 */
function tapUsage(stream, accountId, model) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const consumeLine = function (rawLine) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1).trim() : rawLine.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') return;
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed.usage === 'object' && parsed.usage !== null) {
        noteUsage(accountId, model, parsed.usage);
      }
    } catch { /* 忽略畸形帧 */ }
  };
  return new ReadableStream({
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) {
        if (buf.length > 0) { consumeLine(buf); buf = ''; }
        controller.close();
        return;
      }
      buf += decoder.decode(chunk.value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        consumeLine(line);
        nl = buf.indexOf('\n');
      }
      if (buf.length > 65536) buf = buf.slice(-4096);
      controller.enqueue(chunk.value);
    },
    cancel(reason) { return reader.cancel(reason); }
  });
}

// 首帧探测：上游把业务错误（如 TM.000010051 未开通）塞进 200 的 SSE 里，
// 直接透传会让池以为是成功、既不换路由也不报错。这里先看第一帧，
// 命中 error 就整条作废、按失败返回，让池走分类/熔断/换路由。
async function peekFirstFrame(stream) {
  const reader = stream.getReader();
  let first;
  try { first = await reader.read(); } catch (error) {
    return { error: { message: safeMessage(error), kind: 'transport' } };
  }
  if (first.done === true) {
    return { stream: new ReadableStream({ start(controller) { controller.close(); } }) };
  }
  const text = typeof first.value === 'string' ? first.value : Buffer.from(first.value).toString('utf8');
  if (text.indexOf('"error"') !== -1) {
    let message = text;
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (parsed && parsed.error) message = parsed.error.message || parsed.error.code || message;
      }
    } catch { /* 保持原文 */ }
    try { await reader.cancel(); } catch { /* 忽略 */ }
    return { error: { message: String(message).slice(0, 300), kind: 'upstream' } };
  }
  const replay = new ReadableStream({
    start(controller) { controller.enqueue(first.value); },
    async pull(controller) {
      const next = await reader.read();
      if (next.done === true) controller.close(); else controller.enqueue(next.value);
    },
    cancel(reason) { return reader.cancel(reason); }
  });
  return { stream: replay };
}

/**
 * 本次请求要用的上下文窗口（来自本地模型目录，与池面板展示的 contextWindow 同源）。
 *
 * ux-v14（T5）：以前这里恒传 0 —— 引擎把 0 解释成「不知道窗口，只钳 max_tokens 上限」，
 * 于是装不下的请求照样签名发到上游，只能等上游回 400；prepareChatBody 里那条
 * 「上下文放不下」的预先拦截分支永远走不到，是死代码。改为按请求里的 model id
 * 查目录后传真窗口：能本地拦下就本地拦下，省一次出网与一次 upstream 冷却。
 *
 * 目录里没有这个 id（未登录 / 上游漂移）时返回 0，退化为原来的行为。
 */
function contextWindowFor(rawJson) {
  let parsed;
  try { parsed = JSON.parse(rawJson); } catch { return 0; }
  const raw = parsed && typeof parsed === 'object' && typeof parsed.model === 'string' ? parsed.model.trim() : '';
  if (raw === '') return 0;
  const id = canonicalModel(raw).trim().toLowerCase();
  for (const model of currentModels) {
    if (String(model.id).toLowerCase() === id) return positiveNum(model.contextWindow);
  }
  return 0;
}

async function codeartsFetch(url, init) {
  const body = init && typeof init.body === 'string' ? init.body : '{}';
  // 真窗口交给引擎做「装不下」预检；引擎只在请求带 max_tokens 时才估 token，
  // 宿主（dsh-llm）每次都会带，所以这条判断在实际流量上是活的。
  const prepared = prepareChatBody(body, contextWindowFor(body));
  if (prepared.error) {
    return jsonResponse(400, {
      error: {
        message: str(prepared.error),
        // 本地预检失败，不是上游拒绝：按「请求体非法」上报，池侧只跳过本条路由、
        // 不记熔断，也不会把这个路由从下次选择里踢掉 —— 换小一点的请求就能用。
        kind: 'invalid',
        code: 'context_overflow',
        status: 400,
      },
    });
  }
  const credential = await pickCredential();
  if (!credential) return jsonResponse(401, { error: { message: 'CodeArts 未登录：请在设置卡片里登录华为云账号或粘贴 security_token' } });
  noteRequest(credential.id, prepared.model || CODEARTS_ROUTE_KEY);
  const result = await chatStreamDirect(credential, prepared, init ? init.signal : undefined, { benefit: isBenefitModel(prepared.model) });
  if (!result.ok) {
    noteFailure(str(result.kind) || 'client', credential.id);
    invalidateCredits();
    const status = result.status && result.status > 0 ? result.status : 502;
    return jsonResponse(status, {
      error: {
        message: upstreamErrorMessage(str(result.message), status),
        // ux-v14（P2-5）：kind 用池词汇，code 保留上游原始分类，池侧优先读 kind。
        kind: poolKindOf(result.kind, status, result.message),
        code: str(result.kind) || undefined,
        status,
      },
    });
  }
  const peeked = await peekFirstFrame(result.stream);
  if (peeked.error) {
    noteFailure('upstream', credential.id);
    invalidateCredits();
    return jsonResponse(400, {
      error: {
        message: upstreamErrorMessage(str(peeked.error.message), 400),
        kind: poolKindOf('upstream', 400, peeked.error.message),
        code: 'stream_frame',
        status: 400,
      },
    });
  }
  const stream = tapUsage(peeked.stream, credential.id, prepared.model || CODEARTS_ROUTE_KEY);
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
}

// —— 积分聚合（逐号明细）——
function signedOutDoc(error) {
  // 刻意**不带** credits 对象：池内核 extractCredits（shared/pool.js:858-892）只要看到
  // doc.credits 就判 signedOut:false，会把未登录的 CodeArts 当成"可用但余额 0"的路由。
  // 未登录就该是扁平 signed-out，与 workbuddy/trae/qoder 的态一致。
  return { status: 'signed-out', ...error ? { error } : {} };
}

export async function codeartsCredits(force = false) {
  const now = Date.now();
  if (!force && creditsCache.doc && now - creditsCache.at < CREDITS_TTL_MS) return creditsCache.doc;
  if (creditsCache.inflight) return creditsCache.inflight;
  creditsCache.inflight = (async function () {
    try {
      const summaries = await store.list();
      const active = summaries.filter(function (s) { return s.paused !== true; });
      if (active.length === 0) {
        creditsCache.doc = signedOutDoc();
        creditsCache.at = Date.now();
        return creditsCache.doc;
      }
      const signal = AbortSignal.timeout(25000);
      const rows = await Promise.all(active.map(async function (s) {
        try {
          const credential = await store.resolve(s.id);
          if (!credential) return placeholderRow(s, '凭据不可用');
          const detail = await fetchAccountCredits(credential, signal);
          return accountRow(s, detail);
        } catch (error) {
          return placeholderRow(s, safeMessage(error));
        }
      }));
      const total = rows.reduce(function (a, r) { return a + (Number(r.size) || 0); }, 0);
      const remain = rows.reduce(function (a, r) { return a + (Number(r.remain) || 0); }, 0);
      const expiries = rows.map(function (r) { return r.endTimeMs; }).filter(function (n) { return typeof n === 'number' && n > 0; });
      const endTime = expiries.length ? Math.min.apply(null, expiries) : undefined;
      // ux-v14：每日签到 100 积分当天午夜过期——把「当日将作废余额」聚合并标注作废时刻
      // （Asia/Shanghai 当日 24:00 = 16:00Z），池内核据此在烧完之前把本路由排到最前。
      const dailyExpiring = rows.reduce(function (a, r) { return a + (Number(r.expiring) || 0); }, 0);
      const dailyExpiryAt = (function () {
        const nowSh = new Date(Date.now() + 8 * 3600 * 1000);
        const dayUtc = Date.UTC(nowSh.getUTCFullYear(), nowSh.getUTCMonth(), nowSh.getUTCDate());
        return new Date(dayUtc + 16 * 3600 * 1000).toISOString();
      })();
      creditsCache.doc = {
        status: 'signed-in',
        credits: {
          remain,
          total,
          accounts: rows,
          ...endTime !== undefined ? { endTime } : {},
          ...dailyExpiring > 0 ? { expiring: Math.round(dailyExpiring * 100) / 100, expiringAt: dailyExpiryAt } : {},
        },
      };
      creditsCache.at = Date.now();
      return creditsCache.doc;
    } catch (error) {
      creditsCache.doc = signedOutDoc(safeMessage(error));
      creditsCache.at = Date.now();
      return creditsCache.doc;
    } finally {
      creditsCache.inflight = null;
    }
  })();
  return creditsCache.inflight;
}

// —— OAuth2 登录会话 ——
const activeLogins = new Map();
const recentLogins = [];
function recordLogin(url, outcome) {
  recentLogins.push({ url, at: Date.now(), ...outcome });
  while (recentLogins.length > 5) recentLogins.shift();
}
export function codeartsLoginInfo() {
  const sessions = [];
  activeLogins.forEach(function (entry) {
    sessions.push({ url: entry.session.url, port: entry.session.port, at: entry.at, ...entry.targetId ? { account: entry.targetId } : {} });
  });
  return { pending: sessions.length, sessions, recent: recentLogins.slice(-5) };
}

async function settleLogin(token, targetId) {
  const probeCred = {
    token: str(token.securityToken),
    securityToken: str(token.securityToken),
    accessKeyId: str(token.accessKeyId),
    secretAccessKey: str(token.secretAccessKey),
  };
  let identity = null;
  try { identity = await fetchCallerIdentity(probeCred, AbortSignal.timeout(15000)); } catch { identity = null; }
  if (targetId) {
    const target = await store.credential(targetId).catch(function () { return undefined; });
    if (target) {
      const known = typeof target.userId === 'string' && target.userId !== '';
      if (!(identity && known && target.userId !== identity.userId)) {
        const cred = credentialFromOAuth(token, target.label);
        cred.userId = cred.userId || target.userId;
        cred.userName = cred.userName || target.userName;
        cred.domainId = cred.domainId || target.domainId;
        const id = await store.upsert(cred, targetId);
        if (identity && identity.userId && identity.userId !== id) {
          await store.adoptIdentity(id, identity);
          return { id: identity.userId, replaced: true };
        }
        return { id, replaced: true };
      }
    }
  }
  const id = await store.upsertFromOAuth(token, undefined, identity || undefined);
  if (identity && identity.userId && id !== identity.userId) await store.adoptIdentity(id, identity);
  return { id, replaced: false };
}

async function startCodeartsLogin(targetId) {
  const session = await startLogin(defaultLoginConfig());
  const at = Date.now();
  activeLogins.set(session.url, { session, targetId, at });
  const timer = setTimeout(function () {
    if (activeLogins.delete(session.url)) {
      try { session.close(); } catch { /* 忽略 */ }
      recordLogin(session.url, { status: 'error', message: '登录超时（5 分钟）' });
    }
  }, 5 * 60 * 1000);
  session.promise.then(async function (token) {
    clearTimeout(timer);
    activeLogins.delete(session.url);
    try {
      const result = await settleLogin(token, targetId);
      invalidateCredits();
      await refreshCodeartsModels();
      recordLogin(session.url, { status: 'done', ...result });
    } catch (error) {
      recordLogin(session.url, { status: 'error', message: safeMessage(error) });
    }
  }, function (error) {
    clearTimeout(timer);
    activeLogins.delete(session.url);
    recordLogin(session.url, { status: 'error', message: safeMessage(error) });
  });
  return { url: session.url, port: session.port };
}

// —— 零密文状态 / 详情 ——
export async function codeartsAuthStatus() {
  const list = await store.list().catch(function () { return []; });
  return {
    loggedIn: list.length > 0,
    accountCount: list.length,
    mode: list.some(function (a) { return a.id === MANUAL_ACCOUNT_ID; }) ? 'paste' : (list.length ? 'oauth' : 'none'),
    accounts: list.map(function (a) {
      return {
        id: str(a.id),
        label: str(a.label) || str(a.userName) || str(a.id),
        userName: str(a.userName),
        signable: a.signable === true,
        stale: a.stale === true,
        paused: a.paused === true,
        pinned: a.pinned === true,
        expiration: str(a.expiration),
        // ux-v40：最近一次自动续期失败的原文。空 = 没失败过。
        // 旧实现续期一失败就把号标成 stale 落盘，用户只看到「又掉了」却不知道为什么；
        // 现在网络类失败不再标 stale，靠这个字段告诉面板「这次是链路问题，自己在重试」。
        ...str(a.refreshError) ? { refreshError: str(a.refreshError).slice(0, 200) } : {},
      };
    }),
  };
}

export async function codeartsDetail() {
  const credits = await codeartsCredits(false);
  const auth = await codeartsAuthStatus();
  const accounts = (credits.credits && Array.isArray(credits.credits.accounts) ? credits.credits.accounts : []).map(function (r) {
    return {
      id: r.id, label: r.label, userName: r.userName,
      size: r.size, remain: r.remain, expiring: r.expiring,
      expireAt: r.expireAt, planName: r.planName, planStatus: r.planStatus,
      basic: r.basic, bonus: r.bonus, onDemand: r.onDemand,
      tokens: r.tokens, checkin: r.checkin,
      signable: r.signable, stale: r.stale, paused: r.paused, pinned: r.pinned, error: r.error,
    };
  });
  return {
    loggedIn: auth.loggedIn,
    mode: auth.mode,
    accountCount: auth.accountCount,
    credits: {
      remain: credits.credits ? credits.credits.remain : 0,
      total: credits.credits ? credits.credits.total : 0,
      accounts,
      endTime: credits.credits ? credits.credits.endTime : undefined,
    },
    checkin: accounts.map(function (r) { return { id: r.id, label: r.label, ...r.checkin }; }),
    queue: lastQueue,
    usage: usageSnapshot(),
    models: modelSource,
    modelCount: currentModels.length,
    fetchedAt: creditsCache.at,
  };
}

// —— 池路由 ——
export function codeartsRoute(readToken) {
  return {
    key: CODEARTS_ROUTE_KEY,
    kind: 'codearts',
    providerId: 'codearts',
    channelId: 'codearts',
    displayName: 'CodeArts 积分池',
    priority: 3,
    voucher: false,
    chatUrl: function () { return SNAP_HOST + CHAT_PATH; },
    token: readToken,
    fetch: codeartsFetch,
    models: function () { return currentModels.slice(); },
    hidden: function () {
      return [...externalHidden(CODEARTS_ROUTE_KEY)];
    },
    credits: function () { return codeartsCredits(false); },
    status: function () { return codeartsCredits(false); },
    // ux-v14：转发层成功服务后调用，让 60s 积分缓存立刻失效（当日桶记账更准）。
    invalidateCredits: function () { invalidateCredits(); },
  };
}

// —— web 路由 ——
async function readBodyJson(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  try { return rec(JSON.parse(raw)); }
  catch { return { action: 'submit', token: raw }; }
}

async function oauthAction(p, action) {
  if (action === 'start') {
    return { ...(await startCodeartsLogin(str(p.account || p.targetId) || undefined)) };
  }
  if (action === 'submit') {
    const token = str(p.token || p.input || p.code || '').trim();
    if (token === '') throw new Error('请粘贴 CodeArts security_token');
    await store.set(token, str(p.label) || '粘贴 token');
    invalidateCredits();
    await refreshCodeartsModels();
    return { pasted: true };
  }
  if (action === 'logout') {
    const id = str(p.account || p.id);
    if (id) await store.remove(id); else await store.clear();
    invalidateCredits();
    return { id: id || '*' };
  }
  if (action === 'pause') {
    const id = str(p.account || p.id);
    const ok = await store.setPaused(id, p.paused !== false);
    return { id, ok };
  }
  if (action === 'pin') {
    const id = str(p.account || p.id);
    const ok = await store.setPinned(id, p.pinned !== false);
    return { id, ok };
  }
  if (action === 'refresh') {
    await store.keepAlive().catch(function () {});
    const result = await refreshCodeartsModels();
    invalidateCredits();
    return { ...result, models: modelSource };
  }
  if (action === 'reload') {
    const ok = await store.reloadFromDisk().catch(function () { return false; });
    invalidateCredits();
    await refreshCodeartsModels();
    return { reloaded: ok === true };
  }
  if (action === 'cancel') {
    activeLogins.forEach(function (entry) { try { entry.session.close(); } catch { /* 忽略 */ } });
    activeLogins.clear();
    return { cancelled: true };
  }
  return { models: modelSource };
}

/** 在 pool 的 ctx.inject([webServer]) 里调一次；返回回收闭包。 */
export function applyCodeartsRoutes(webCtx, ctx) {
  const disposers = [];
  const register = function (path, handler) {
    try {
      const dispose = webCtx.webServer.register({ kind: 'exact', path, handler });
      disposers.push(function () { dispose(); });
    } catch (error) {
      if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('codearts: 路由注册失败 ' + path, safeMessage(error));
    }
  };

  register(CODEARTS_OAUTH_PATH, async function (req, res) {
    if (!loopbackRequest(req)) return writeJson(res, 403, { error: 'request-not-trusted' });
    if (req.method === 'GET') {
      return writeJson(res, 200, { ok: true, auth: await codeartsAuthStatus(), login: codeartsLoginInfo(), models: modelSource });
    }
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' });
    try {
      const payload = await readBodyJson(req, 64 * 1024);
      const action = str(payload.action || 'status').toLowerCase();
      const result = await oauthAction(payload, action);
      return writeJson(res, 200, { ok: true, action, ...result, auth: await codeartsAuthStatus(), login: codeartsLoginInfo() });
    } catch (error) {
      return writeJson(res, 400, { ok: false, error: safeMessage(error), auth: await codeartsAuthStatus() });
    }
  });

  register(CODEARTS_STATUS_PATH, async function (req, res) {
    if (!loopbackRequest(req)) return writeJson(res, 403, { error: 'request-not-trusted' });
    if (req.method !== 'GET') return writeJson(res, 405, { error: 'method not allowed' });
    let force = false;
    try { force = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('refresh') === '1'; } catch { force = false; }
    const doc = await codeartsCredits(force);
    const list = await store.list().catch(function () { return []; });
    return writeJson(res, 200, {
      ...doc,
      account: list.length ? (str(list[0].userName) || str(list[0].label) || str(list[0].id)) : '',
      modelCount: currentModels.length,
      models: currentModels.map(function (m) { return { id: m.id, name: m.name, rate: m.rate }; }),
      // 签到列与 workbuddy / trae 同形：直接来自积分统计里当天的福利活动状态，
      // 不再写死 claimable:false（否则面板永远是灰的）。
      checkin: (function () {
        const accounts = doc && doc.credits && Array.isArray(doc.credits.accounts) ? doc.credits.accounts : [];
        const ci = accounts.length && accounts[0] && accounts[0].checkin ? accounts[0].checkin : undefined;
        if (!ci) return { supported: true, claimable: false };
        return {
          supported: true,
          claimable: ci.claimable === true,
          checkedIn: ci.claimedToday === true,
          claimedToday: ci.claimedToday === true,
          reward: ci.amount,
          amount: ci.amount,
        };
      })(),
      source: modelSource,
    });
  });

  register(CODEARTS_CHECKIN_PATH, async function (req, res) {
    if (!loopbackRequest(req)) return writeJson(res, 403, { error: 'request-not-trusted' });
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' });
    const c = await pickCredential().catch(function () { return undefined; });
    if (!c) return writeJson(res, 200, { claim: { state: 'signed-out', amount: 0, message: '未登录' } });
    let claim;
    try { claim = await claimCheckin(c, AbortSignal.timeout(25000)); }
    catch (error) { claim = { state: 'failed', amount: 0, message: safeMessage(error) }; }
    invalidateCredits();
    return writeJson(res, 200, { claim });
  });

  register(CODEARTS_QUEUE_PATH, async function (req, res) {
    if (!loopbackRequest(req)) return writeJson(res, 403, { error: 'request-not-trusted' });
    if (req.method === 'GET') return writeJson(res, 200, { ok: true, queue: lastQueue });
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' });
    try {
      const payload = await readBodyJson(req, 8 * 1024);
      const model = canonicalModel(str(payload.model) || (currentModels[0] ? currentModels[0].id : 'GLM-5.2'));
      const chatId = str(payload.chatId) || ('probe-' + Date.now());
      const c = await pickCredential();
      if (!c) return writeJson(res, 200, { ok: false, error: '未登录' });
      lastQueue = await probeQueue(c, model, chatId, AbortSignal.timeout(15000));
      return writeJson(res, 200, { ok: true, queue: lastQueue });
    } catch (error) {
      return writeJson(res, 400, { ok: false, error: safeMessage(error) });
    }
  });

  return function () {
    for (const d of disposers) { try { d(); } catch { /* 忽略 */ } }
  };
}
