/**
 * dsh-pool —— 上游错误与流内异常纯函数分类器。
 *
 * 从 lib/providers/pool/index.js 抽离的零状态纯函数：
 * 识别配额耗尽、流内假 200 额度错误、上游时间窗拒绝、结构化错误体（error.kind）、
 * 本机拦截层（bili_gate_*）与账号级鉴权失败。
 */

/** 上游是不是在说"没额度了"（各家文案不同，认几个稳定特征）。 */
export function looksLikeQuota(text) {
  if (typeof text !== "string" || text === "") return false;
  return /insufficient[_ ]?(quota|balance|credit)|quota[_ ]?exceed|rate[_ ]?limit|too many requests|积分不足|额度不足|余额不足|配额不足|限流|频率限制|usage limit/iu.test(text);
}

/**
 * 流内额度错误判定：有些渠道 HTTP 200 但 SSE/JSON body 里才吐额度错误。
 * 必须排除正常的 completion chunk（含 "choices" / [DONE]），并要求带错误字段，
 * 否则模型正好聊到「限流」两个字就会被误判成配额耗尽。
 */
export function streamQuotaError(text) {
  if (!looksLikeQuota(text)) return false;
  // 错误字段优先：有的上游会同时回 "choices": [] 与 "error": {...}，先判 choices 就把额度耗尽漏成正常开流。
  if (/"error"\s*:|event:\s*error/iu.test(text)) return true;
  if (text.includes('"choices"') || text.includes("[DONE]")) return false;
  return /"code"|"message"|"type"\s*:\s*"/iu.test(text);
}

/**
 * 「上游拒绝窗口」判定：Code Assist 这个 standard-tier 账号会按时间窗整段拒 generate，
 * 三种文案轮着来 ——
 *   400 FAILED_PRECONDITION "User location is not supported for the API use."
 *   404 NOT_FOUND       "Requested entity was not found."
 *   503 UNAVAILABLE     "No capacity available for model ..."
 * 它们既不是账号失效（不记 10 分钟 auth），也不是额度耗尽（不该清 latch / 记 60s），
 * 而是上游短时波动：窗口一翻转请求就通。故单独归一类 upstream，只冷却 15 秒，
 * 下一请求立刻 probe，避免 60s 硬锁死把用户按在 402/502 上。
 */
export function looksLikeUpstreamRejection(status, text) {
  const s = typeof text === "string" ? text.slice(0, 2000) : "";
  // 503 不等于「上游拒绝窗口」：过载/限流的空正文按 transport 处理，只有明确的容量文案才进 15s upstream。
  if (status === 503) return s === "" ? true : /no capacity|capacity available|UNAVAILABLE|overloaded|service unavailable/iu.test(s);
  if (s === "") return false;
  if (status === 400) return /FAILED_PRECONDITION|not supported for the API use|User location is not supported/iu.test(s);
  if (status === 404) return /Requested entity was not found|NOT_FOUND/iu.test(s);
  return false;
}


/**
 * ux-v14（P2-5）：优先读结构化错误体。
 *
 * 各适配层现在都会在错误体里挂 error.kind（池内核词汇：session_dead / iam_stale /
 * quota / upstream / transport / invalid）。以前池只能拿正文跑英文正则，而 codearts 适配层回的是
 * 中文人话（upstreamErrorMessage 的产物），「IAM token 已失效」永远匹配不上
 * looksLikeAuthFailure，被降级成 60 秒 transport 冷却 —— 掉登录的号每 60 秒白撞一次上游。
 *
 * 返回池内核四类之一或 invalid；没有结构化 kind 时返回 null，交回正则兜底。
 *
 * invalid 是「这个请求本身不合法」——典型是 codearts 适配层用本地窗口预检
 * 判定装不下（code=context_overflow）。它必须跟 auth / transport 分开：
 * 记熔断会把一条完全健康的路由冷却 60 秒，而换个更小的请求本来就能成功。
 */
export function str(value) {
  return typeof value === "string" ? value : "";
}

/**
 * 从任意错误正文里挖出第一个完整 JSON 对象。
 * 兼容 BOM、SSE 的 data: 前缀、以及后面跟着的日志尾巴 —— 以前只认整段纯 JSON，
 * 于是 "data: {...}" 或截断到 4000 字节内但后面还有内容时直接失效，auth 被降级成 60s transport。
 */
export function firstJsonObject(text) {
  const stripped = text.replace(/^\uFEFF/u, "").replace(/^\s*data:\s*/u, "");
  const start = stripped.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  const limit = Math.min(stripped.length, start + 40000);
  for (let i = start; i < limit; i += 1) {
    const ch = stripped[i];
    if (inString) {
      if (ch === String.fromCharCode(92)) i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(stripped.slice(start, i + 1)); } catch { return undefined; }
      }
    }
  }
  return undefined;
}

export function structuredFailureKind(status, text) {
  if (typeof text !== "string" || text === "") return null;
  const doc = firstJsonObject(text);
  if (doc === undefined || doc === null || typeof doc !== "object") return null;
  const error = doc.error;
  const raw = error && typeof error === "object" ? str(error.kind) || str(error.type) || str(error.code) : "";
  // 兼容多种写法：error.kind / error.type / error.code，或顶层 kind。
  const kind = raw !== "" ? raw : str(doc.kind);
  if (kind === "session_dead" || kind === "iam_stale") return "auth";
  if (kind === "quota") return "quota";
  if (kind === "upstream") return "upstream";
  if (kind === "transport") return "transport";
  if (kind === "invalid") return "invalid";
  if (kind === "capacity") return "capacity";
  return null;
}

/**
 * 本机拦截层（billion-context 的 silent-direct 闸门）拒绝掉的请求。
 *
 * 它不是上游的错：请求根本没出网，上游一次都没被打到。响应体形如
 * {"error":{"code":"bili_gate_oversize_refusal_unattributed_bytes",...}}，
 * code 前缀 bili_gate_ 是稳定契约，正文里还有
 * "billion-context refused this request locally"。
 *
 * 为什么不并进 transport：transport 会记 60s 熔断，而这是进程级闸门 ——
 * 每条路由都会以同样方式失败，冷却它们只会让下一次请求同样全灭，还掩盖真因。
 * 单独归类后 502 的文案能直接指到拦截层，而不是「十个渠道都挂了」。
 */
export function localGateRefusal(status, text) {
  if (status !== 422) return null;
  if (typeof text !== "string" || text === "") return null;
  const hit = /bili_gate_[a-z0-9_]+/u.exec(text);
  if (hit !== null) return hit[0];
  return /billion-context refused this request locally/iu.test(text) ? "bili_gate_local_refusal" : null;
}

/**
 * 账号层失败判定（和「请求体非法」严格区分）。
 *
 * 渠道 shim 会把上游的 401/403 包成 HTTP 400，正文里留着 "http 403"、code 11140、
 * "request illegal"、"account has been ... disabled" 之类的痕迹。这类错误跟请求内容
 * 无关：换一条路由就能活，而且短时间不会自愈。以前把它当成 invalid_request 直接回
 * 400 结束整轮，于是一个被封的号能把整个模型打死。
 */
export function looksLikeAuthFailure(status, text) {
  if (status === 401 || status === 403) return true;
  if (typeof text !== "string" || text === "") return false;
  return /http\s*40[13]|unauthoriz|invalid[_ ]?(token|api[_ ]?key)|api[_ ]?key[^.]{0,24}(invalid|expired)|token[^.]{0,24}(expired|revoked|invalid)|not (?:logged|signed) in|login required|please (?:log ?in|sign ?in) again|account[^.]{0,48}(?:banned|disabled|suspended|blocked|frozen|illegal)|request illegal|permission denied|access denied|未授权|无权限|账号[^。]{0,20}(?:封|禁用|冻结)/iu.test(text);
}

