// lib/providers/gemini/codeassist.js
// Adapts an OpenAI chat/completions request into Code Assist v1internal
// streamGenerateContent and translates the response back into OpenAI SSE/JSON.
// The pool calls this as route.fetch(url, init); Bearer token comes from
// init.headers.authorization and is the OAuth access_token from route.token().
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { geminiFetch } from "./proxy.js";
import { logPoolEvent } from "../../shared/pool.js";
import {
  codeAssistEndpoint,
  codeAssistApiVersion,
  getCodeAssistProjectId,
  antigravityUserAgent,
} from "./oauth.js";

// Static UI model ids -> real Code Assist model names. Override with
// GEMINI_CA_MODEL_MAP='{"gemini-4-argon":"gemini-3-pro-preview",...}'.
const DEFAULT_MODEL_MAP = {
  "gemini-4-argon": "gemini-3.1-pro-high",
  "gemini-3.1-pro-preview": "gemini-3.1-pro-high",
  "gemini-3.8-flash": "gemini-3-flash",
  "gemini-3.5-flash-lite": "gemini-3-flash",
  // ux-v10：宿主下拉里的 pro 档 id 也要有映射，否则 resolveModel 会把裸 id 直接
  // 交给 Code Assist（上游不认，必 404），pro 两档在池里永远是死的。
  "gemini-3.5-pro": "gemini-3.1-pro-high",
  "gemini-3.1-pro-high": "gemini-3.1-pro-high",
};
// Tried in order when a mapped model is rejected by the upstream.
const MODEL_FALLBACKS = ["gemini-3-flash", "gemini-3.1-pro-high", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-pro-preview"];
// ux-v10：候选遍历限时 —— 上游全线 404 时串行走完 5 候选 × 3 次要 30s+，
// 客户端一直「思考」。单次 fetch 5s 硬超时。
// ux-v11：429 RESOURCE_EXHAUSTED 是 project 级时间窗（实测单窗 40s+，06:31:06→06:31:48
// 连续四次 429），换候选模型共享同一 project 配额、换出口也不变，唯一解法是等窗口翻转。
// 所以遍历总预算抬到 95s（池侧 headerTimer 120s 之内），并给 429 一条独立的长退避阶梯；
// 其余错误仍只给 12s 短预算，不让 404/503 抖动把客户端拖住 90 秒。
// ux-v11：单次 fetch 只看「拿到响应头」这一段。原 5s 把 pro 档（实测首字节
// 5–8s，慢时 12s）直接 abort 成 lastStatus=0，五个候选走完仍无状态，最终回
// 400「所有候选模型均被 Code Assist 拒绝」—— 这才是 pro 两档「永远用不了」的
// 直接原因。抬高到 40s（仍远小于 95s 遍历预算），只有真挂死的连接才会被掐。
const CA_FETCH_TIMEOUT_MS = 40000;
const CA_TOTAL_WALK_TIMEOUT_MS = 95000;
// ux-v12：API-key 逃生通道。实测（2026-11-12 16:2x）Code Assist 的 OAuth project 配额
// 与 generativelanguage 的 API-key 配额是**两套独立额度**：OAuth 侧 429 RESOURCE_EXHAUSTED
// 期间，apikey 侧 gemini-3.5-flash-lite / gemini-3.6-flash 仍能 200 秒回。所以 429 不再
// 傻等 86s 阶梯，而是立刻改道 apikey（OpenAI 兼容层，响应本来就是 OpenAI 形状，直通）。
const GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const APIKEY_ATTEMPT_TIMEOUT_MS = 12000;
const APIKEY_CHAIN_BUDGET_MS = 40000;
// 每档首选原生 id（apikey 侧有该档位就用它），再接已知可用的安全阶梯。
// 实测 2026-11-12：3.5-flash-lite 846ms 200 / 3.1-flash-lite 655ms 200 /
// 3.6-flash 3.6s 200；3.8-flash、3.7-flash 在 apikey 免费层会挂住或 503；
// 4-argon / 3.1-pro-preview / pro-latest 免费层 429；2.5-* / 3-flash / 3.1-pro-high 404。
const APIKEY_MODEL_MAP = {
  "gemini-4-argon": ["gemini-4-argon", "gemini-3.1-pro-preview"],
  "gemini-3.1-pro-preview": ["gemini-3.1-pro-preview"],
  "gemini-3.5-pro": ["gemini-3.1-pro-preview"],
  "gemini-3.1-pro-high": ["gemini-3.1-pro-preview"],
  "gemini-3.8-flash": ["gemini-3.8-flash"],
  "gemini-3.5-flash-lite": ["gemini-3.5-flash-lite"],
};
const APIKEY_SAFE_LADDER = ["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.1-flash-lite"];
const CA_SHORT_WALK_BUDGET_MS = 12000;
const CA_QUOTA_BUDGET_MS = 86000;
// 429 阶梯：2+4+8+16+24+32 = 86s 累计。实测窗口 40s（06:31:06→06:31:48 连续四次 429），
// 留一倍余量吸收长窗；86s < 95s 遍历预算 < 120s 池侧 headerTimer，逐级有界。
// 阶梯走完仍 429 就立刻把 429 回池（不再无限复用末级），由熔断 + breaker-probe 接手。
// 离线测试用 GEMINI_CA_QUOTA_LADDER="50,100,200" 把阶梯整体压短，行为逻辑不变。
function quotaLadder() {
  const raw = String(process.env.GEMINI_CA_QUOTA_LADDER ?? "").trim();
  if (raw === "") return [2000, 4000, 8000, 16000, 24000, 32000];
  const out = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);
  return out.length > 0 ? out : [2000, 4000, 8000, 16000, 24000, 32000];
}

function modelMap() {
  let extra = {};
  try {
    if (process.env.GEMINI_CA_MODEL_MAP) {
      extra = JSON.parse(process.env.GEMINI_CA_MODEL_MAP);
    }
  } catch {}
  return { ...DEFAULT_MODEL_MAP, ...extra };
}

function resolveModel(id) {
  const raw = String(id || "gemini-2.5-pro").replace(/^models\//, "");
  return modelMap()[raw] || raw;
}

function caMethodUrl(method, stream) {
  const base = `${codeAssistEndpoint()}/${codeAssistApiVersion()}:${method}`;
  return stream ? `${base}?alt=sse` : base;
}

// ---------------------------------------------------------------------------
// OpenAI messages -> Vertex/Code Assist contents
// ---------------------------------------------------------------------------
function toParts(content, role) {
  const out = [];
  if (content == null) return out;
  if (typeof content === "string") {
    if (content) out.push({ text: content });
    return out;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item) continue;
      if (typeof item === "string") {
        if (item) out.push({ text: item });
      } else if (item.type === "text" && item.text) {
        out.push({ text: item.text });
      } else if (item.type === "image_url") {
        const url = item.image_url?.url || item.image_url || "";
        const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(url));
        if (m) {
          out.push({ inlineData: { mimeType: m[1], data: m[2] } });
        } else if (url) {
          out.push({ text: `[image] ${url}` });
        }
      } else if (item.type === "input_audio" && item.input_audio?.data) {
        out.push({ inlineData: { mimeType: `audio/${item.input_audio.format || "wav"}`, data: item.input_audio.data } });
      }
    }
  }
  return out;
}

function toContents(messages, systemInstruction) {
  const contents = [];
  let system = systemInstruction || null;
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg) continue;
    const role = msg.role;
    if (role === "system" || role === "developer") {
      const parts = toParts(msg.content, role);
      if (parts.length) {
        system = system || { role: "user", parts: [] };
        system.parts.push(...parts);
      }
      continue;
    }
    if (role === "tool") {
      // tool result -> functionResponse part on a user content
      const name = msg.name || msg.tool_call_id || "tool";
      let response = msg.content;
      if (typeof response === "string") {
        try {
          response = JSON.parse(response);
        } catch {
          response = { output: response };
        }
      }
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name, response: response || {} } }],
      });
      continue;
    }
    const caRole = role === "assistant" ? "model" : "user";
    const parts = toParts(msg.content, role);
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const fn = tc.function || tc;
        let args = fn.arguments || {};
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            args = { input: args };
          }
        }
        parts.push({ functionCall: { name: fn.name || "tool", args } });
      }
    }
    if (parts.length) contents.push({ role: caRole, parts });
  }
  if (!contents.length) contents.push({ role: "user", parts: [{ text: "" }] });
  return { contents, systemInstruction: system };
}

function toTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const decls = [];
  for (const t of tools) {
    if (!t || (t.type && t.type !== "function")) continue;
    const fn = t.function || t;
    if (!fn.name) continue;
    decls.push({
      name: fn.name,
      description: fn.description || "",
      parameters: fn.parameters || { type: "object", properties: {} },
    });
  }
  if (!decls.length) return undefined;
  return [{ functionDeclarations: decls }];
}

function toGenerationConfig(body) {
  const gc = {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const set = (k, v) => {
    if (v !== undefined) gc[k] = v;
  };
  set("temperature", num(body.temperature));
  set("topP", num(body.top_p));
  set("topK", num(body.top_k));
  set("maxOutputTokens", num(body.max_completion_tokens) ?? num(body.max_tokens));
  set("presencePenalty", num(body.presence_penalty));
  set("frequencyPenalty", num(body.frequency_penalty));
  set("seed", num(body.seed));
  const stop = body.stop;
  if (typeof stop === "string") set("stopSequences", [stop]);
  else if (Array.isArray(stop) && stop.length) set("stopSequences", stop.map(String));
  if (body.response_format?.type === "json_object") set("responseMimeType", "application/json");
  if (body.response_format?.json_schema?.schema) set("responseSchema", body.response_format.json_schema.schema);
  const effort = String(body.reasoning_effort || "").toLowerCase();
  if (effort && effort !== "off") {
    // Code Assist honours thinkingConfig; includeThoughts lets us surface
    // reasoning_content deltas back to the OpenAI-shaped stream.
    gc.thinkingConfig = { includeThoughts: true };
    if (body.thinking_budget !== undefined) set("thinkingBudget", num(body.thinking_budget));
  }
  return gc;
}

function toCodeAssistRequest(body, model, projectId) {
  const { contents, systemInstruction } = toContents(body.messages, null);
  const request = {
    model,
    contents,
    generationConfig: toGenerationConfig(body),
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
      { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" },
    ],
  };
  if (systemInstruction) request.systemInstruction = systemInstruction;
  const tools = toTools(body.tools);
  if (tools) request.tools = tools;
  const creditEnv = process.env.GEMINI_CA_CREDIT_TYPES;
  const credits = creditEnv === undefined
    ? ["GOOGLE_ONE_AI"]
    : creditEnv.split(",").map((s) => s.trim()).filter(Boolean);
  // Antigravity Hub envelope: requestType / userAgent / requestId are required
  // for the agentic entitlement, and the inner request repeats model.
  return {
    project: projectId,
    model,
    request,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: "agent-" + randomUUID(),
    user_prompt_id: randomUUID(),
    ...(credits.length ? { enabled_credit_types: credits } : {}),
  };
}

// ---------------------------------------------------------------------------
// Code Assist response -> OpenAI chunks
// ---------------------------------------------------------------------------
function unwrapCaChunk(parsed) {
  // SSE frames may be CaGenerateContentResponse or already-unwrapped.
  if (parsed?.response && typeof parsed.response === "object") {
    return { inner: parsed.response, traceId: parsed.traceId, credits: parsed };
  }
  return { inner: parsed, traceId: parsed?.traceId, credits: parsed };
}

const FINISH_MAP = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  TOOL_CALL: "tool_calls",
  FUNCTION_CALL: "tool_calls",
};

function chunkFromCa(parsed, ctx, isFirst) {
  const { inner, traceId } = unwrapCaChunk(parsed);
  const candidates = Array.isArray(inner?.candidates) ? inner.candidates : [];
  const c0 = candidates[0] || {};
  const parts = Array.isArray(c0.content?.parts) ? c0.content.parts : [];
  const delta = {};
  let hasTool = false;
  for (const p of parts) {
    if (!p) continue;
    if (p.thought === true && typeof p.text === "string") {
      delta.reasoning_content = (delta.reasoning_content || "") + p.text;
    } else if (typeof p.text === "string" && p.text) {
      delta.content = (delta.content || "") + p.text;
    } else if (p.functionCall) {
      hasTool = true;
      const tc = {
        index: ctx.toolIndex++,
        id: `call_${(p.functionCall.id || randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)}`,
        type: "function",
        function: {
          name: p.functionCall.name || "tool",
          arguments: typeof p.functionCall.args === "string"
            ? p.functionCall.args
            : JSON.stringify(p.functionCall.args || {}),
        },
      };
      (delta.tool_calls ||= []).push(tc);
    }
  }
  if (isFirst && !Object.keys(delta).length) delta.content = "";
  const finish = c0.finishReason
    ? FINISH_MAP[c0.finishReason] || "stop"
    : hasTool
      ? "tool_calls"
      : null;
  const chunk = {
    id: ctx.id,
    object: "chat.completion.chunk",
    created: ctx.created,
    model: ctx.model,
    choices: [{ index: c0.index ?? 0, delta, finish_reason: finish }],
  };
  const out = { chunk, traceId: traceId || ctx.traceId };
  const usage = inner?.usageMetadata;
  if (usage) {
    out.usage = {
      prompt_tokens: Number(usage.promptTokenCount || 0),
      completion_tokens: Number(usage.candidatesTokenCount || usage.cachedContentTokenCount || 0),
      total_tokens: Number(usage.totalTokenCount || 0),
    };
  }
  return out;
}

function makeCtx(model) {
  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    created: Math.floor(Date.now() / 1000),
    model,
    toolIndex: 0,
    traceId: null,
  };
}

function sseLine(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// Build a standard Response whose body is an OpenAI-compatible SSE stream.
function openAISseResponse(upstream, model, ctx) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const body = new ReadableStream({
    async start(controller) {
      let buf = "";
      let first = true;
      let lastUsage = null;
      let pending = null;
      const emit = (parsed) => {
        const { chunk, traceId, usage } = chunkFromCa(parsed, ctx, first);
        if (traceId) ctx.traceId = traceId;
        first = false;
        if (usage) lastUsage = usage;
        controller.enqueue(encoder.encode(sseLine(chunk)));
      };
      try {
        const reader = upstream.body?.getReader();
        if (!reader) {
          controller.enqueue(encoder.encode(sseLine({
            id: ctx.id, object: "chat.completion.chunk", created: ctx.created, model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })));
        } else {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).replace(/\r$/, "");
              buf = buf.slice(nl + 1);
              const t = line.trim();
              if (!t || t.startsWith(":") || t.startsWith("event:")) continue;
              if (!t.startsWith("data:")) continue;
              const data = t.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              try {
                const parsed = JSON.parse(data);
                if (parsed?.error) pending = parsed;
                else emit(parsed);
              } catch {}
            }
          }
          if (buf.trim().startsWith("data:")) {
            const data = buf.trim().slice(5).trim();
            if (data && data !== "[DONE]") {
              try {
                emit(JSON.parse(data));
              } catch {}
            }
          }
        }
        if (pending?.error) {
          const msg = pending.error.message || pending.error.status || JSON.stringify(pending.error);
          controller.enqueue(encoder.encode(sseLine({
            id: ctx.id, object: "chat.completion.chunk", created: ctx.created, model,
            choices: [{ index: 0, delta: { content: `[Code Assist error] ${msg}` }, finish_reason: "stop" }],
          })));
        } else {
          const finalChunk = {
            id: ctx.id,
            object: "chat.completion.chunk",
            created: ctx.created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          };
          if (lastUsage) finalChunk.usage = lastUsage;
          controller.enqueue(encoder.encode(sseLine(finalChunk)));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (e) {
        try {
          controller.enqueue(encoder.encode(sseLine({
            id: ctx.id, object: "chat.completion.chunk", created: ctx.created, model,
            choices: [{ index: 0, delta: { content: `[Code Assist stream error] ${e.message}` }, finish_reason: "stop" }],
          })));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch {}
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function openAICompletionResponse(ca, model, ctx) {
  const { inner, traceId } = unwrapCaChunk(ca);
  const c0 = (Array.isArray(inner?.candidates) ? inner.candidates : [])[0] || {};
  const parts = Array.isArray(c0.content?.parts) ? c0.content.parts : [];
  let text = "";
  let reasoning = "";
  const tool_calls = [];
  for (const p of parts) {
    if (p?.thought === true && typeof p.text === "string") reasoning += p.text;
    else if (typeof p?.text === "string") text += p.text;
    else if (p?.functionCall) {
      tool_calls.push({
        id: `call_${(p.functionCall.id || randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)}`,
        type: "function",
        function: {
          name: p.functionCall.name || "tool",
          arguments: typeof p.functionCall.args === "string"
            ? p.functionCall.args
            : JSON.stringify(p.functionCall.args || {}),
        },
      });
    }
  }
  const finish = c0.finishReason ? FINISH_MAP[c0.finishReason] || "stop" : tool_calls.length ? "tool_calls" : "stop";
  const message = { role: "assistant", content: text };
  if (reasoning) message.reasoning_content = reasoning;
  if (tool_calls.length) message.tool_calls = tool_calls;
  const usage = inner?.usageMetadata;
  const out = {
    id: traceId || ctx.id,
    object: "chat.completion",
    created: ctx.created,
    model,
    choices: [{ index: c0.index ?? 0, message, finish_reason: finish }],
  };
  if (usage) {
    out.usage = {
      prompt_tokens: Number(usage.promptTokenCount || 0),
      completion_tokens: Number(usage.candidatesTokenCount || 0),
      total_tokens: Number(usage.totalTokenCount || 0),
    };
  }
  return new Response(JSON.stringify(out), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(status, text) {
  return new Response(text, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function looksLikeModelError(status, text) {
  const s = String(text ?? "").slice(0, 2000);
  // ux-v10：旧版把 /not supported/ 与 /not found/ 当「模型名非法」，于是
  //   400 "User location is not supported for the API use."（地域拒绝）
  //   404 "Requested entity was not found."（账号级拒绝窗口的通用文案，5 个候选同时返回）
  // 都被判成「换模型」→ 立刻 break → 候选耗尽 → 把 404 回给池 → 60s 熔断锁死。
  // 现在只有「上游明确点名某个 model id 不认」才算模型错误，其余交给重试/换候选。
  if (/location|region|country|FAILED_PRECONDITION|RESOURCE_EXHAUSTED/i.test(s)) return false;
  if (/Requested entity was not found/i.test(s)) return false;
  const namesModel = /\bmodel\b|models\//i.test(s);
  if (!namesModel) return false;
  if (status === 404) return /not found|not supported|does not exist|unknown|unsupported/i.test(s);
  if (status === 400) return /not supported|does not exist|unknown|invalid|unsupported|not found/i.test(s);
  return false;
}

// 项目级 429 RESOURCE_EXHAUSTED / 5xx 是 Code Assist 的间歇限流，实测 60 秒内自愈。
// 以前 route.fetch 直接把 429 原样回给池 → 池标 quota 熔断 60 秒 → 单路由的 gemini
// 组（routes:["gemini"]）立刻 pool-empty→402，用户撞上一次偶发限流就被锁死一分钟。
// 现在在 route.fetch 内部用短退避重试消化掉：池根本看不到 429、不会触发熔断。
// 重试耗尽后换下一个候选模型（不同容量池有时能绕开），仍失败才把状态回给池。
const MAX_STATUS_RETRIES = 2;   // 每个候选模型额外重试次数（每个候选最多 3 次请求）
const RETRY_BASE_MS = 350;      // 退避 350ms / 700ms，总开销 < 1.1s，远小于 120s 头超时
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function looksLikeRetryable(status, text) {
  const s = String(text ?? "").slice(0, 2000);
  if (RETRYABLE_STATUS.has(status)) return true;
  // ux-v10：Code Assist 的「拒绝窗口」也按可重试处理，短退避后再撞一次，
  // 窗口正好翻转时这一轮就能直接成功；全窗口拒绝时由 walk 超时封顶，不会死等。
  if (status === 400 && /FAILED_PRECONDITION|not supported for the API use|location/i.test(s)) return true;
  if (status === 404 && /Requested entity was not found/i.test(s)) return true;
  return /RESOURCE_EXHAUSTED|resource has been exhausted|rate[_ ]?limit|quota|too many requests|UNAVAILABLE|No capacity available/iu.test(s);
}

/**
 * ux-v11：项目级额度耗尽判定。Code Assist 的 429 "RESOURCE_EXHAUSTED / Resource has been
 * exhausted (e.g. check quota)." 不是账号失效、也不是请求体非法，而是同一 project 的
 * 时间窗配额被别处（Antigravity 客户端、其他会话）吃掉了 —— 换 model、换 candidate、
 * 换隧道全部无效，只有等待。故单独走长退避，不浪费候选预算。
 */
function isProjectQuota(status, text) {
  if (status === 429) return true;
  const s = String(text ?? "").slice(0, 2000);
  return /RESOURCE_EXHAUSTED|resource has been exhausted|quota (?:exceeded|exhausted)|rate[_ ]?limit|too many requests/iu.test(s);
}

/** 可被 init.signal 取消的短退避；abort 时立即 resolve，由下一次 fetch 抛出 AbortError。 */
function delay(ms, signal) {
  return new Promise((resolve) => {
    // ux-v11：无 signal 时必须照常等满 ms。旧写法 `if (!signal) return resolve()`
    // 让「没有 AbortSignal 的调用方」把 2/4/8/16/24s 的额度退避全部变成 0ms 空转，
    // 429 窗口内瞬间把阶梯烧完 —— 这是 502 反复出现的第二个直接原因。
    if (signal?.aborted) return resolve();
    let timer;
    const onAbort = () => { clearTimeout(timer); resolve(); };
    timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// ux-v12：API-key 逃生通道
// ---------------------------------------------------------------------------
// Code Assist（OAuth, project 配额）与 generativelanguage（API key, 免费层配额）
// 是两套独立额度。OAuth 429 时改道 apikey，flash-lite 档仍能 200 秒回。
// 响应本来就是 OpenAI 形状（SSE 或 JSON），直接原样交回池，无需翻译。
let apiKeyCache = { value: "", at: 0 };

async function readApiKey() {
  for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
    const v = String(process.env[name] ?? "").trim();
    if (v !== "") return v;
  }
  const now = Date.now();
  if (apiKeyCache.value !== "" && now - apiKeyCache.at < 60_000) return apiKeyCache.value;
  const dshHome = String(process.env.DSH_HOME ?? "").trim();
  const homes = [];
  if (dshHome !== "") homes.push(join(dshHome, "gemini-api-key"));
  try { homes.push(join(homedir(), ".dsh", "gemini-api-key")); } catch { /* 没有 home */ }
  for (const file of homes) {
    try {
      const text = (await readFile(file, "utf8")).trim();
      if (text !== "") {
        apiKeyCache = { value: text, at: now };
        return text;
      }
    } catch { /* 试下一个位置 */ }
  }
  return "";
}

function apiKeyChain(modelId) {
  const raw = String(modelId || "").replace(/^models\//, "");
  const preferred = APIKEY_MODEL_MAP[raw] || [];
  const out = [];
  for (const m of [...preferred, ...APIKEY_SAFE_LADDER]) {
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

/** 把 OpenAI 请求原样投给 apikey 的 OpenAI 兼容层；2xx 直接返回，其余返回最后状态。 */
async function apiKeyFetch(body, modelId, init) {
  // 离线测试/排障可用 GEMINI_NO_APIKEY_ESCAPE=1 关掉逃生通道，纯走 OAuth 语义。
  if (String(process.env.GEMINI_NO_APIKEY_ESCAPE ?? "").trim() === "1") return null;
  const key = await readApiKey();
  if (key === "") return null;
  const chain = apiKeyChain(modelId);
  const startedAt = Date.now();
  let lastStatus = 0;
  let lastText = "";
  for (const candidate of chain) {
    if (Date.now() - startedAt > APIKEY_CHAIN_BUDGET_MS) break;
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    // 归属明确：body.stream 省略时上游会回非 SSE 的 JSON，而池按 SSE 探测/转发。
    // 这里显式定 stream，与 codeAssistFetch 的 stream = body.stream === true 保持一致。
    const payload = { ...body, model: candidate, stream: body.stream === true };
    // apikey 兼容层不认 max/xhigh 这类 Code Assist 档位名，落成 high。
    const effort = String(payload.reasoning_effort ?? "").toLowerCase();
    if (effort === "max" || effort === "xhigh") payload.reasoning_effort = "high";
    else if (effort === "" || effort === "off") delete payload.reasoning_effort;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), APIKEY_ATTEMPT_TIMEOUT_MS);
    let signal = controller.signal;
    try { signal = AbortSignal.any([init.signal, controller.signal]); } catch { /* 老运行时 */ }
    try {
      const res = await geminiFetch(GEMINI_OPENAI_BASE + "/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: body.stream === false ? "application/json" : "text/event-stream",
          authorization: "Bearer " + key,
          "x-goog-api-key": key,
        },
        body: JSON.stringify(payload),
        signal,
      });
      if (res.ok) {
        logPoolEvent({ ev: "apikey-served", model: modelId, apikeyModel: candidate, stream: body.stream !== false });
        return res;
      }
      lastStatus = res.status;
      try { lastText = (await res.text()).slice(0, 2000); } catch { lastText = ""; }
      logPoolEvent({ ev: "apikey-fail", model: modelId, apikeyModel: candidate, status: res.status, error: lastText.slice(0, 160) });
      // 401/403 = key 本身不可用，换模型没有意义。
      if (res.status === 401 || res.status === 403) break;
    } catch (error) {
      if (init.signal?.aborted) throw error;
      lastText = String(error?.message || error);
      lastStatus = 0;
      logPoolEvent({ ev: "apikey-fail", model: modelId, apikeyModel: candidate, status: 0, error: lastText.slice(0, 160) });
    } finally {
      clearTimeout(timer);
    }
  }
  return lastStatus ? errorResponse(lastStatus, lastText) : null;
}

// ---------------------------------------------------------------------------
// route.fetch entry point
// ---------------------------------------------------------------------------
export async function codeAssistFetch(url, init = {}) {
  const headers = init.headers || {};
  const auth = headers.authorization || headers.Authorization || "";
  const accessToken = String(auth).replace(/^Bearer\s+/i, "").trim();
  if (!accessToken) {
    return errorResponse(401, JSON.stringify({ error: { message: "Code Assist 缺少 OAuth Bearer token", type: "authentication_error" } }));
  }
  let body;
  try {
    body = typeof init.body === "string" ? JSON.parse(init.body) : (init.body || {});
  } catch {
    return errorResponse(400, JSON.stringify({ error: { message: "invalid chat/completions body", type: "invalid_request_error" } }));
  }
  // OpenAI 规范：省略 stream 即非流式。ux-v13 —— 以前写 `!== false`，省略 stream 时
  // 仍按流式上游转 SSE 透传，任何期望 JSON 的调用方（标题生成/后台抽取/第三方 SDK）
  // 会 JSON.parse 失败。DSH 聊天显式带 stream:true，不受影响。
  const stream = body.stream === true;
  const model = resolveModel(body.model);
  let projectId;
  try {
    projectId = await getCodeAssistProjectId(accessToken);
  } catch (e) {
    return errorResponse(502, JSON.stringify({
      error: { message: `Code Assist 项目解析失败: ${e.message}`, type: "upstream_error" },
    }));
  }

  const method = stream ? "streamGenerateContent" : "generateContent";
  const candidates = [model, ...MODEL_FALLBACKS.filter((m) => m !== model)];
  const walkStartedAt = Date.now();
  let quotaWaitedMs = 0;
  let quotaStage = 0;
  let apiKeyTried = false;
  let apiKeyFailed = false;
  // 总预算 95s（池侧 headerTimer 120s 之内）；短预算 12s 只约束非 429 的抖动重试，
  // 429 的等待从短预算里扣除，这样「一个 40s 窗口 + 一次正常请求」不会被 12s 掐断。
  const walkTimedOut = () => Date.now() - walkStartedAt > CA_TOTAL_WALK_TIMEOUT_MS;
  const shortTimedOut = () => Date.now() - walkStartedAt - quotaWaitedMs > CA_SHORT_WALK_BUDGET_MS;
  let lastStatus = 0;
  let lastText = "";

  for (let i = 0; i < candidates.length; i++) {
    const caModel = candidates[i];
    let attempt = 0;
    for (;;) {
      if (walkTimedOut()) break;
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const fetchController = new AbortController();
      const fetchTimer = setTimeout(() => fetchController.abort(), CA_FETCH_TIMEOUT_MS);
      let perFetchSignal = init.signal;
      try { perFetchSignal = AbortSignal.any([init.signal, fetchController.signal]); } catch { /* 老运行时退回 */ }
      let upstream;
      try {
        upstream = await geminiFetch(caMethodUrl(method, stream), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: stream ? "text/event-stream" : "application/json",
            authorization: `Bearer ${accessToken}`,
            "user-agent": antigravityUserAgent(),
          },
          body: JSON.stringify(toCodeAssistRequest(body, caModel, projectId)),
          signal: perFetchSignal,
        });
      } catch (error) {
        clearTimeout(fetchTimer);
        if (init.signal?.aborted) throw error;
        if (walkTimedOut() || shortTimedOut()) break;
        lastStatus = 0;
        lastText = String(error?.message || error);
        continue;
      }
      clearTimeout(fetchTimer);
      if (upstream.ok) {
        const ctx = makeCtx(body.model || model);
        if (stream) return openAISseResponse(upstream, body.model || model, ctx);
        let ca = {};
        try {
          ca = await upstream.json();
        } catch {
          return errorResponse(502, JSON.stringify({ error: { message: "Code Assist 返回非 JSON 响应", type: "upstream_error" } }));
        }
        return openAICompletionResponse(ca, body.model || model, ctx);
      }
      const text = await upstream.text();
      lastStatus = upstream.status;
      lastText = text;
      // 模型名被上游拒绝（400/404）：立刻换下一个已知可用模型名，不浪费重试。
      if (looksLikeModelError(upstream.status, text)) break;
      // ux-v11：project 级 429 —— 换候选共享同一配额，换过去只会浪费预算。
      // 原地长退避（2/4/8/16/24s）等窗口翻转；阶梯走完或超 60s 才把 429 回池，
      // 由池标 quota 冷却 + 下一次 breaker-probe 兜底，不再把 429 立刻抛成 502。
      if (isProjectQuota(upstream.status, text)) {
        // ux-v12：OAuth project 配额耗尽 ≠ apikey 配额耗尽。先改道 apikey 的
        // OpenAI 兼容层（flash-lite 档实测 200/846ms），成功就直通返回，
        // 客户端根本看不到 429；apikey 也不通时才回到长阶梯等窗口翻转。
        if (!apiKeyTried) {
          apiKeyTried = true;
          logPoolEvent({ ev: "apikey-escape", model: body.model || model, reason: "oauth-429" });
          const escaped = await apiKeyFetch(body, body.model || model, init);
          if (escaped !== null && escaped.ok) return escaped;
          apiKeyFailed = escaped !== null;
        }
        // 已经试过 apikey 且失败：OAuth 再等 86s 收益极低，只留前两格（2+4s）
        // 给窗口翻转留一次机会，然后立刻把 429 回池交熔断处理，别让客户端干等一分半。
        const ladder = apiKeyFailed ? quotaLadder().slice(0, 2) : quotaLadder();
        // 阶梯走完就收手：以前 min() 会把最后一级无限复用，429 会把 60s 预算一格一格
        // 烧干净，客户端看到的仍是「转圈一分多钟再失败」。现在 54s（离线压短后 4.65s）
        // 一到就把 429 原样回池，交给熔断 + breaker-probe 处理。
        const wait = ladder[quotaStage];
        if (wait === undefined || quotaWaitedMs + wait > CA_QUOTA_BUDGET_MS || walkTimedOut()) {
          return errorResponse(upstream.status, text);
        }
        quotaStage += 1;
        quotaWaitedMs += wait;
        await delay(wait, init.signal);
        continue;
      }
      // 间歇性限流/上游抖动：短退避后重试同一模型；重试耗尽换下一个候选模型。
      if (looksLikeRetryable(upstream.status, text)) {
        if (attempt < MAX_STATUS_RETRIES && !shortTimedOut()) {
          attempt += 1;
          await delay(RETRY_BASE_MS * attempt, init.signal);
          continue;
        }
        break;
      }
      // 确定性错误（401/403/请求体非法等）：原样回给池做 auth/invalid 分流。
      return errorResponse(upstream.status, text);
    }
  }
  // 所有候选都试过：把最后一次非 2xx 原样回给池（此时已尽力重试），
  // 由池决定 quota 熔断；配合 pool 侧的 breaker-probe 兜底，不会再直接 402。
  // ux-v12：OAuth 候选全败（404/400/超时等）时，apikey 再兜一次底 ——
  // 这是 pro 档「首字节 5–8s 被掐 / 上游全 404」时的最后一条活路。
  if (!apiKeyTried) {
    apiKeyTried = true;
    logPoolEvent({ ev: "apikey-escape", model: body.model || model, reason: "oauth-exhausted", lastStatus });
    const escaped = await apiKeyFetch(body, body.model || model, init);
    if (escaped !== null && escaped.ok) return escaped;
    if (escaped !== null && lastStatus === 0) return escaped;
  }
  if (lastStatus) return errorResponse(lastStatus, lastText);
  return errorResponse(400, JSON.stringify({ error: { message: "所有候选模型均被 Code Assist 拒绝", type: "invalid_request_error" } }));
}

export function codeAssistChatUrl() {
  return caMethodUrl("streamGenerateContent", true);
}
