// CodeArts 直连传输层：绕开被 billion-context 接管的全局 fetch。
//
// 为什么需要它：billion-context 会替换 globalThis.fetch，对它识别为
// SDK-HMAC-SHA256 的签名请求做「先压缩改写再重签」。它自己没有 CodeArts 凭据
// （只在 $DSH_HOME/jet-hub/state.json 里找 provider=codearts 的账号），拿不到
// 就本地 403 拒绝，原文是 signed_request_requires_resign /
// bili_resign_unavailable。签名覆盖请求体，任何改写都会让上游 401，所以这里
// 直接走 node:https 出网：body 一个字节都不改，签名就是最终发出的字节。
//
// 本文件只做三件事：
//   1. 华为云 SDK-HMAC-SHA256 签名（AK/SK + STS security token）
//   2. https POST + ReadableStream 响应体
//   3. 上游「累计快照 SSE」→ OpenAI 增量 SSE（与 vendor chatStream 同语义）
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';

const ALGO = 'SDK-HMAC-SHA256';
const enc = new TextEncoder();

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
function hmacHex(key, msg) {
  return createHmac('sha256', key).update(msg).digest('hex');
}
function sdkDate(d) {
  const p = function (n, w) { return String(n).padStart(w === undefined ? 2 : w, '0'); };
  return String(d.getUTCFullYear()) + p(d.getUTCMonth() + 1) + p(d.getUTCDate())
    + 'T' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
}
function canonicalURI(pathname) {
  let out = pathname.split('/').map(function (s) { return encodeURIComponent(s); }).join('/');
  if (!out.endsWith('/')) out += '/';
  return out;
}
function canonicalQuery(raw) {
  if (!raw) return '';
  const params = new URLSearchParams(raw);
  const keys = Array.from(new Set(params.keys())).sort();
  const parts = [];
  for (const k of keys) {
    const vals = params.getAll(k).sort();
    for (const v of vals) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }
  return parts.join('&');
}

/**
 * 就地给 headers（普通对象）补签名头，返回同一对象。
 * 与 vendor signRequest 等价，只是不经过 Request（避免邻居插件换掉 Request 后失配）。
 */
export function signHeaders(method, url, headers, body, cred) {
  const xDate = sdkDate(new Date());
  headers['X-Sdk-Date'] = xDate;
  if (cred.securityToken) headers['X-Security-Token'] = cred.securityToken;
  const payloadHash = sha256Hex(body);
  headers['X-Sdk-Content-Sha256'] = payloadHash;
  const u = new URL(url);
  const all = [];
  for (const k of Object.keys(headers)) all.push([k.toLowerCase(), String(headers[k]).trim()]);
  all.push(['host', u.host]);
  all.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
  let canonicalHeaders = '';
  const signed = [];
  for (const pair of all) {
    canonicalHeaders += pair[0] + ':' + pair[1] + '\n';
    signed.push(pair[0]);
  }
  const signedHeaders = signed.join(';');
  const canonicalRequest = [
    method,
    canonicalURI(u.pathname),
    canonicalQuery(u.search.slice(1)),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const stringToSign = [ALGO, xDate, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmacHex(cred.secretAccessKey, stringToSign);
  headers.Authorization = ALGO + ' Access=' + cred.accessKeyId + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  return headers;
}

/** 直接走 node:https 发一炮，成功返回 {ok:true,status,stream}，失败返回 {ok:false,status,text}。 */
export function httpPost(url, headers, bodyBuf, signal) {
  return new Promise(function (resolve) {
    let settled = false;
    const done = function (value) {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let u;
    try { u = new URL(url); } catch (error) { done({ ok: false, status: 0, text: 'bad url: ' + String(error && error.message || error) }); return; }
    const req = httpsRequest({
      method: 'POST',
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: headers,
    }, function (res) {
      const status = res.statusCode || 0;
      if (status < 200 || status >= 300) {
        const chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () { done({ ok: false, status: status, text: Buffer.concat(chunks).toString('utf8') }); });
        res.on('error', function (error) { done({ ok: false, status: status, text: String(error && error.message || error) }); });
        return;
      }
      const stream = new ReadableStream({
        start: function (controller) {
          res.on('data', function (c) { try { controller.enqueue(new Uint8Array(c)); } catch (error) { /* 下游已关 */ } });
          res.on('end', function () { try { controller.close(); } catch (error) { /* 已关 */ } });
          res.on('error', function (error) { try { controller.error(error); } catch (e2) { /* 已关 */ } });
        },
        cancel: function () { res.destroy(); },
      });
      done({ ok: true, status: status, stream: stream, headers: res.headers });
    });
    req.on('error', function (error) {
      done({ ok: false, status: 0, text: signal && signal.aborted === true ? 'aborted by client' : String(error && error.message || error) });
    });
    if (signal) {
      if (signal.aborted === true) { req.destroy(); }
      else {
        const onAbort = function () { req.destroy(); };
        signal.addEventListener('abort', onAbort, { once: true });
        req.on('close', function () { signal.removeEventListener('abort', onAbort); });
      }
    }
    req.end(bodyBuf);
  });
}

/**
 * 签名 JSON 请求（node:https 直连，仅 POST）。成功 {ok:true,status,json,text}，
 * 失败 {ok:false,status,text}。用于模型目录/思考档位这类控制面查询。
 */
export async function signedJson(credential, url, method, payload, signal, extraHeaders) {
  const bodyBuf = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload));
  const headers = Object.assign({
    'Content-Type': 'application/json',
    'x-auth-token': credential.token,
    'x-snap-traceid': randomBytes(16).toString('hex'),
    'X-Language': 'zh-cn',
    'Agent-Type': 'PromptCenter',
  }, extraHeaders || {});
  if (credential.securityToken) headers['X-Security-Token'] = credential.securityToken;
  if (credential.accessKeyId && credential.secretAccessKey) {
    signHeaders(method || 'POST', url, headers, bodyBuf, {
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      securityToken: credential.securityToken,
    });
  }
  const res = await httpPost(url, headers, bodyBuf, signal);
  if (!res.ok) return { ok: false, status: res.status, text: String(res.text || '') };
  const reader = res.stream.getReader();
  const chunks = [];
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    chunks.push(Buffer.from(step.value));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let json = null;
  try { json = JSON.parse(text); } catch (error) { json = null; }
  return { ok: true, status: res.status, text: text, json: json };
}

function openAIData(obj) { return enc.encode('data: ' + JSON.stringify(obj) + '\n\n'); }
function openAIDone() { return enc.encode('data: [DONE]\n\n'); }
function sessionIdFor(chatId) { return sha256Hex('codearts-session:' + chatId).slice(0, 32); }

function classify(status, message) {
  const text = String(message || '');
  if (status === 401 || status === 403) return 'session_dead';
  if (status === 402) return 'hard_credit';
  if (status === 429) return 'soft_rate';
  if (/InferHub\.ModelArts\.81003/.test(text)) return 'not_found';
  return 'upstream';
}

/**
 * 与 vendor chatStream 同签名同语义，但出网走 node:https，不经过任何被接管的 fetch。
 * @param credential {token, securityToken, accessKeyId, secretAccessKey}
 * @param prepared {url, body, model, chatId}
 */
export async function chatStreamDirect(credential, prepared, signal, options) {
  const opts = options || {};
  const traceId = randomBytes(16).toString('hex');
  const bodyBuf = Buffer.from(prepared.body);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'x-auth-token': credential.token,
    'X-Security-Token': credential.securityToken,
    'x-snap-traceid': traceId,
    'X-Language': 'zh-cn',
    'app-id': 'CodeAgent3.0',
    'is_confidential': 'false',
    'Content-Length': String(bodyBuf.length),
  };
  if (opts.benefit === true) headers.maas_type = 'benefit';
  if (credential.accessKeyId && credential.secretAccessKey) {
    signHeaders('POST', prepared.url, headers, bodyBuf, {
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      securityToken: credential.securityToken,
    });
  }
  if (prepared.chatId) {
    headers['Chat-Id'] = prepared.chatId;
    headers['Session-Id'] = sessionIdFor(prepared.chatId);
  }
  const resp = await httpPost(prepared.url, headers, bodyBuf, signal);
  if (!resp.ok) {
    if (signal && signal.aborted === true) return { ok: false, kind: 'client', status: 0, message: 'aborted by client' };
    return { ok: false, kind: classify(resp.status, resp.text), status: resp.status, message: String(resp.text || '').slice(0, 400) };
  }
  if (!resp.stream) return { ok: false, kind: 'server', status: 0, message: 'codearts: 上游无响应体' };
  const model = prepared.model;
  const reader = resp.stream.getReader();
  const decoder = new TextDecoder();
  let lastText = '';
  let sentAny = false;
  let doneSent = false;
  let sseBuf = '';
  return {
    ok: true,
    stream: new ReadableStream({
      async pull(controller) {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) {
              if (sentAny && !doneSent) controller.enqueue(openAIDone());
              controller.close();
              return;
            }
            sseBuf += decoder.decode(chunk.value, { stream: true });
            const lines = sseBuf.split('\n');
            const tail = lines.pop();
            sseBuf = tail === undefined ? '' : tail;
            let emitted = false;
            for (const raw of lines) {
              const trimmed = String(raw).trim();
              if (!trimmed.startsWith('data:')) continue;
              const payload = trimmed.slice(5).trim();
              if (payload === '[DONE]') {
                sentAny = true;
                if (!doneSent) { doneSent = true; controller.enqueue(openAIDone()); emitted = true; }
                continue;
              }
              if (!payload) continue;
              let ev;
              try { ev = JSON.parse(payload); } catch (error) { continue; }
              if (ev.error_code && ev.error_code !== '0' && ev.error_code !== 0) {
                controller.enqueue(openAIData({
                  choices: [{ delta: { content: '' }, finish_reason: 'stop' }],
                  error: { code: ev.error_code, message: ev.error_msg === undefined ? 'upstream error' : ev.error_msg },
                }));
                controller.enqueue(openAIDone());
                controller.close();
                return;
              }
              if (Array.isArray(ev.choices)) {
                sentAny = true;
                controller.enqueue(enc.encode('data: ' + JSON.stringify(ev) + '\n\n'));
                emitted = true;
                continue;
              }
              if (ev.delta && ev.delta.content) {
                sentAny = true;
                controller.enqueue(openAIData({ model: model, choices: [{ delta: { content: ev.delta.content }, finish_reason: null }] }));
                emitted = true;
              }
              if (typeof ev.text === 'string' && ev.text !== '[DONE]') {
                const cur = ev.text;
                if (cur.length > lastText.length && cur.startsWith(lastText)) {
                  sentAny = true;
                  controller.enqueue(openAIData({ model: model, choices: [{ delta: { content: cur.slice(lastText.length) }, finish_reason: null }] }));
                  emitted = true;
                }
                lastText = cur;
              }
            }
            if (emitted) return;
          }
        } catch (error) {
          try { controller.error(error); } catch (e2) { /* 已关 */ }
        }
      },
      cancel() { try { reader.cancel(); } catch (error) { /* ignore */ } },
    }),
  };
}
