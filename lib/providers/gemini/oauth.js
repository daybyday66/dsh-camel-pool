// lib/providers/gemini/oauth.js
// Google OAuth2 (Antigravity desktop client, PKCE loopback) + Code Assist project.
// Reuses the Google AI Pro subscription via the Antigravity Cloud Code channel:
// no API key, no billing setup. All Google-bound HTTP goes through geminiFetch's
// CONNECT tunnel. Cloud Code entitlement is keyed on the Antigravity User-Agent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { geminiFetch, geminiProxyInfo } from "./proxy.js";

// Antigravity Hub desktop OAuth client (Google public installed-app client).
// The old gemini-cli client (681255809395-...) was retired for personal AI Pro /
// Ultra accounts (UNSUPPORTED_CLIENT); Antigravity is the supported path.
const OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const OAUTH_CLIENT_SECRET = "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";
// Legacy gemini-cli client: kept ONLY so refresh tokens issued before the switch
// keep working (a refresh_token is bound to the client that issued it).
const LEGACY_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const LEGACY_CLIENT_SECRET = "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";
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SIGN_IN_SUCCESS_URL = "https://developers.google.com/gemini-code-assist/auth_success_gemini";
// Consumer Antigravity Hub clients must use the non-sandbox daily host for
// generate/stream/loadCodeAssist/onboardUser; mixing hosts gives incompatible entitlements.
const CODE_ASSIST_ENDPOINT = process.env.CODE_ASSIST_ENDPOINT || "https://daily-cloudcode-pa.googleapis.com";
const CODE_ASSIST_API_VERSION = process.env.CODE_ASSIST_API_VERSION || "v1internal";
// Cloud Code entitlement checks are keyed on the User-Agent fingerprint: sending
// the gemini-cli UA (or none) yields UNSUPPORTED_CLIENT, the Antigravity UA yields
// the account real standard-tier / Google AI Pro entitlement.
const ANTIGRAVITY_USER_AGENT =
  process.env.ANTIGRAVITY_USER_AGENT ||
  "antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)";
export function antigravityUserAgent() {
  return ANTIGRAVITY_USER_AGENT;
}
// The Hub sends only ideType on loadCodeAssist; MACOS/WINDOWS are not valid platform values.
const CA_METADATA = { ideType: "ANTIGRAVITY" };

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}
function primaryCredPath() {
  return path.join(dshHome(), "gemini-oauth.json");
}
function legacyCredPath() {
  return path.join(os.homedir(), ".gemini", "oauth_creds.json");
}
function projectCachePath() {
  return path.join(dshHome(), "gemini-ca-project.json");
}
function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Credentials: our own file wins, then gemini-cli's oauth_creds.json (read-only).
// Shape: { access_token, refresh_token, expiry_date, scope, token_type }
// ---------------------------------------------------------------------------
export function readOAuthCredentials() {
  const primary = readJsonSafe(primaryCredPath());
  if (primary && primary.access_token) {
    return { ...primary, __source: "dsh", __path: primaryCredPath() };
  }
  const legacy = readJsonSafe(legacyCredPath());
  if (legacy && legacy.access_token) {
    return { ...legacy, __source: "gemini-cli", __path: legacyCredPath() };
  }
  return null;
}

function saveOAuthCredentials(creds) {
  const { __source, __path, ...clean } = creds;
  const p = primaryCredPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(clean, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {}
  return p;
}

export function geminiAuthMode() {
  const forced = String(process.env.GEMINI_AUTH || "").trim().toLowerCase();
  if (forced === "oauth" || forced === "apikey") return forced;
  return readOAuthCredentials() ? "oauth" : "apikey";
}

// ---------------------------------------------------------------------------
// OAuth2 token exchange / refresh (Antigravity PKCE loopback + state)
// ---------------------------------------------------------------------------
async function postToken(params, client) {
  const cid = client?.id || OAUTH_CLIENT_ID;
  const csec = client?.secret || OAUTH_CLIENT_SECRET;
  const body = new URLSearchParams({
    client_id: cid,
    client_secret: csec,
    ...params,
  });
  const r = await geminiFetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  let j = {};
  try {
    j = JSON.parse(text);
  } catch {}
  if (!r.ok || !j.access_token) {
    const msg = j.error_description || j.error || text || r.statusText;
    throw new Error(`Google token 端点返回 ${r.status}: ${String(msg).slice(0, 300)}`);
  }
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expiry_date: Date.now() + Number(j.expires_in || 3600) * 1000,
    scope: j.scope,
    token_type: j.token_type || "Bearer",
  };
}

export async function exchangeGeminiCode(code, redirectUri, verifier) {
  return postToken({
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    ...(verifier ? { code_verifier: verifier } : {}),
  });
}

function clientFor(creds) {
  return creds && creds.oauth_client === "antigravity"
    ? { id: OAUTH_CLIENT_ID, secret: OAUTH_CLIENT_SECRET }
    : { id: LEGACY_CLIENT_ID, secret: LEGACY_CLIENT_SECRET };
}
async function refreshTokens(refreshToken, creds) {
  return postToken(
    { refresh_token: refreshToken, grant_type: "refresh_token" },
    clientFor(creds),
  );
}

let refreshInflight = null;
let projectCache = null;

async function ensureFresh(c) {
  const exp = Number(c.expiry_date || 0);
  if (exp && exp - Date.now() > 60_000) return c;
  if (!c.refresh_token) {
    throw new Error("Google 登录已过期且没有 refresh_token。Gemini 路由已于 ux-v22 移出积分池，登录脚本已删除，如需恢复先把 gemini 路由重新注册进池。");
  }
  if (!refreshInflight) {
    refreshInflight = refreshTokens(c.refresh_token, c).finally(() => {
      refreshInflight = null;
    });
  }
  const fresh = await refreshInflight;
  const merged = {
    ...c,
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token || c.refresh_token,
    expiry_date: fresh.expiry_date,
    scope: fresh.scope || c.scope,
    token_type: fresh.token_type || c.token_type,
  };
  saveOAuthCredentials(merged);
  projectCache = null;
  return merged;
}

// route.token() lands here. Returns a bare OAuth access_token; the pool wraps it
// into "Bearer <token>" in upstreamHeaders().
export async function readOAuthAccessToken() {
  const c = readOAuthCredentials();
  if (!c || !c.access_token) {
    throw new Error(
      "尚未登录 Google 账号。Gemini 路由已于 ux-v22 整组移出积分池（Google 账号被封后停用），" +
        "`scripts/gemini-oauth-login.mjs` 已随 ux-v29 从包里删除，不要再按旧提示运行它；" +
        "如需恢复 Gemini，先把 gemini 路由重新注册进池。",
    );
  }
  const fresh = await ensureFresh(c);
  return fresh.access_token;
}

// ---------------------------------------------------------------------------
// Loopback login session (browser callback + manual code fallback)
// ---------------------------------------------------------------------------
// Antigravity requires PKCE S256 on the installed-app authorization-code flow.
function makePkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
let loginSession = null;

function closeLoginSession(s) {
  if (!s) return;
  try {
    s.server?.close();
  } catch {}
  if (loginSession === s) loginSession = null;
}

async function completeLogin(session, code) {
  if (session.settled) return session.result;
  const creds = await exchangeGeminiCode(code, session.redirectUri, session.verifier);
  creds.oauth_client = "antigravity";
  saveOAuthCredentials(creds);
  projectCache = null;
  try { fs.unlinkSync(projectCachePath()); } catch {}
  session.settled = true;
  session.result = { ok: true, source: "dsh", expiresAt: creds.expiry_date };
  session.resolve(session.result);
  closeLoginSession(session);
  return session.result;
}

function failLogin(session, err) {
  if (session.settled) return;
  session.settled = true;
  session.error = err.message;
  session.reject(err);
  closeLoginSession(session);
}

async function handleCallback(session, req, res) {
  let u;
  try {
    u = new URL(req.url, `http://127.0.0.1:${session.port}`);
  } catch {
    res.writeHead(400);
    res.end("bad request");
    return;
  }
  if (u.pathname !== "/oauth2callback") {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const err = u.searchParams.get("error");
  if (err) {
    failLogin(session, new Error(`Google 授权被拒绝: ${err}`));
    res.writeHead(302, { Location: `${SIGN_IN_SUCCESS_URL}?error=${encodeURIComponent(err)}` });
    res.end();
    return;
  }
  const state = u.searchParams.get("state");
  const code = u.searchParams.get("code");
  if (state !== session.state || !code) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("state 不匹配或缺少 code");
    return;
  }
  try {
    await completeLogin(session, code);
    res.writeHead(302, { Location: SIGN_IN_SUCCESS_URL });
    res.end();
  } catch (e) {
    failLogin(session, e);
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`登录失败: ${e.message}`);
  }
}

export async function startGeminiLogin() {
  if (loginSession) {
    if (!loginSession.settled) return loginSession.publicInfo();
    closeLoginSession(loginSession);
  }
  const state = randomBytes(24).toString("base64url");
  const { verifier, challenge } = makePkce();
  let resolve, reject;
  const done = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  done.catch(() => {}); // avoid unhandled rejection when nobody awaits
  const server = http.createServer();
  const session = {
    state,
    server,
    done,
    resolve,
    reject,
    settled: false,
    result: null,
    error: null,
    port: 0,
    redirectUri: null,
    authUrl: null,
    verifier,
  };
  await new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rej);
      res();
    });
  });
  session.port = server.address().port;
  session.redirectUri = `http://127.0.0.1:${session.port}/oauth2callback`;
  const q = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: session.redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    include_granted_scopes: "true",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  session.authUrl = `${AUTH_URL}?${q.toString()}`;
  session.publicInfo = () => ({
    authUrl: session.authUrl,
    state: session.state,
    redirectUri: session.redirectUri,
    port: session.port,
    proxy: geminiProxyInfo(),
  });
  server.on("request", (req, res) => handleCallback(session, req, res));
  loginSession = session;
  return session.publicInfo();
}

export function parseLoginInput(input) {
  const raw = String(input || "").trim();
  let code = null;
  let state = null;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      code = u.searchParams.get("code");
      state = u.searchParams.get("state");
    } catch {}
  }
  if (!code) {
    const q = new URLSearchParams(raw.replace(/^\?/, ""));
    code = q.get("code");
    state = q.get("state");
    if (!code) {
      code = raw.split(/[&#\s]/)[0] || null;
      state = null;
    }
  }
  return { code, state };
}

export async function submitGeminiLoginCode(input) {
  if (!loginSession || loginSession.settled) {
    throw new Error("没有进行中的登录会话，请先调用 start");
  }
  const { code, state } = parseLoginInput(input);
  if (!code) throw new Error("未解析到授权 code，请粘贴完整回调 URL 或 code");
  if (state && state !== loginSession.state) {
    throw new Error("state 校验失败，请重新发起登录");
  }
  return completeLogin(loginSession, code);
}

export function cancelGeminiLogin() {
  if (!loginSession) return { ok: true, cancelled: false };
  const s = loginSession;
  if (!s.settled) {
    s.settled = true;
    s.reject(new Error("登录已取消"));
  }
  closeLoginSession(s);
  return { ok: true, cancelled: true };
}

export function geminiLoginInfo() {
  return loginSession && !loginSession.settled ? loginSession.publicInfo() : null;
}

export function waitForGeminiLogin(timeoutMs = 180000) {
  if (!loginSession) return Promise.resolve({ ok: false, reason: "no-session" });
  const s = loginSession;
  return Promise.race([
    s.done,
    new Promise((res) => setTimeout(() => res({ ok: false, reason: "timeout" }), timeoutMs)),
  ]);
}

// ---------------------------------------------------------------------------
// Code Assist project discovery (loadCodeAssist / onboardUser LRO)
// ---------------------------------------------------------------------------
export function codeAssistEndpoint() {
  return CODE_ASSIST_ENDPOINT;
}
export function codeAssistApiVersion() {
  return CODE_ASSIST_API_VERSION;
}
function caMethodUrl(method) {
  return `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`;
}
function envProject() {
  return process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || undefined;
}

async function caPost(method, payload, accessToken) {
  const r = await geminiFetch(caMethodUrl(method), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": ANTIGRAVITY_USER_AGENT,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  let j = {};
  try {
    j = JSON.parse(text);
  } catch {}
  if (!r.ok) {
    throw new Error(`Code Assist ${method} 返回 ${r.status}: ${String(text).slice(0, 400)}`);
  }
  return j;
}

async function caGetOperation(name, accessToken) {
  const r = await geminiFetch(
    `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}/${name}`,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": ANTIGRAVITY_USER_AGENT,
      },
      signal: AbortSignal.timeout(60000),
    },
  );
  const text = await r.text();
  let j = {};
  try {
    j = JSON.parse(text);
  } catch {}
  if (!r.ok) {
    throw new Error(`getOperation 返回 ${r.status}: ${String(text).slice(0, 300)}`);
  }
  return j;
}

export async function getCodeAssistProjectId(accessToken) {
  const tokenKey = accessToken ? accessToken.slice(-12) : "";
  if (projectCache && projectCache.tokenKey === tokenKey && projectCache.id) {
    return projectCache.id;
  }
  const cached = readJsonSafe(projectCachePath());
  if (cached && cached.projectId) {
    projectCache = { id: cached.projectId, tokenKey };
    return cached.projectId;
  }
  const creds = readOAuthCredentials();
  if (creds && creds.cloudaicompanionProject) {
    projectCache = { id: creds.cloudaicompanionProject, tokenKey };
    return creds.cloudaicompanionProject;
  }

  const load = await caPost(
    "loadCodeAssist",
    {
      ...(envProject() ? { cloudaicompanionProject: envProject() } : {}),
      metadata: { ...CA_METADATA },
    },
    accessToken,
  );

  let projectId =
    load.cloudaicompanionProject ||
    (load.currentTier ? envProject() : undefined) ||
    (typeof load.response?.cloudaicompanionProject === "string"
      ? load.response.cloudaicompanionProject
      : undefined);

  if (!projectId) {
    const allowed = Array.isArray(load.allowedTiers) ? load.allowedTiers : [];
    let tier = allowed.find((t) => t && t.isDefault);
    if (!tier) tier = { id: "legacy-tier", userDefinedCloudaicompanionProject: true };
    const onboardReq = {
      tierId: tier.id,
      metadata: { ...CA_METADATA, duetProject: envProject() },
      ...(tier.userDefinedCloudaicompanionProject && envProject()
        ? { cloudaicompanionProject: envProject() }
        : {}),
    };
    let lro = await caPost("onboardUser", onboardReq, accessToken);
    let tries = 0;
    while (lro && !lro.done && lro.name && tries < 24) {
      await new Promise((r) => setTimeout(r, 5000));
      lro = await caGetOperation(lro.name, accessToken);
      tries++;
    }
    const cp = lro?.response?.cloudaicompanionProject;
    projectId = (cp && (cp.id || cp.name)) || (typeof cp === "string" ? cp : undefined);
  }

  if (!projectId) {
    throw new Error(
      `未能解析 cloudaicompanionProject（loadCodeAssist currentTier=${
        load.currentTier?.id || load.currentTier || "none"
      }）。可设置 GOOGLE_CLOUD_PROJECT 指定项目后重试。`,
    );
  }
  try {
    fs.mkdirSync(path.dirname(projectCachePath()), { recursive: true });
    fs.writeFileSync(
      projectCachePath(),
      JSON.stringify({ projectId, updatedAt: Date.now() }, null, 2) + "\n",
      { mode: 0o600 },
    );
  } catch {}
  projectCache = { id: projectId, tokenKey };
  return projectId;
}

// Diagnostic view. Never emits access_token / refresh_token / client_secret.
export function geminiAuthStatus() {
  const c = readOAuthCredentials();
  const pending = geminiLoginInfo();
  const exp = c ? Number(c.expiry_date || 0) : 0;
  let projectId = null;
  const pc = readJsonSafe(projectCachePath());
  if (pc?.projectId) projectId = pc.projectId;
  if (!projectId && c?.cloudaicompanionProject) projectId = c.cloudaicompanionProject;
  return {
    mode: geminiAuthMode(),
    loggedIn: !!c?.access_token,
    credentialSource: c?.__source || null,
    hasRefreshToken: !!c?.refresh_token,
    expiresAt: exp || null,
    accessTokenExpired: exp ? exp <= Date.now() : null,
    needsRefresh: c ? !(exp && exp - Date.now() > 60_000) : null,
    projectId,
    loginPending: !!pending,
    authUrl: pending?.authUrl || null,
    loginPort: pending?.port || null,
    proxy: geminiProxyInfo(),
    codeAssistEndpoint: CODE_ASSIST_ENDPOINT,
    codeAssistApiVersion: CODE_ASSIST_API_VERSION,
    userAgent: ANTIGRAVITY_USER_AGENT,
    credentialClient: c?.oauth_client || "gemini-cli (legacy)",
  };
}
