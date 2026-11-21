/**
 * Trae 浏览器登录（PKCE 授权码流程）。
 *
 * ## 为什么必须有这个模块
 *
 * Trae 的 refreshToken 是**一次性**的：谁先用掉，链就归谁。这条链只有 14 天，
 * 而桌面端与插件共用同一份 storage.json —— 插件续期后桌面端手里那条就废了。
 * 一旦链断（服务端回 20101），任何"再交换一次"的尝试都不可能成功，
 * 唯一出路是重新走一次授权码登录，拿一条全新的链。
 *
 * 所以本模块的定位是**造链**，keepalive.js 的定位是**续链**。二者合起来才让
 * Trae 渠道不再每隔两周掉一次。
 *
 * ## 协议（逐字来自 Trae CN 客户端 main.js）
 *
 *   1. 生成 PKCE：codeVerifier 随机，codeChallenge = base64url(SHA-256(verifier))，
 *      方法 S256。
 *   2. 打开 `${loginHost}/authorization?...&auth_callback_url=http://127.0.0.1:PORT/authorize`。
 *      页面登录完成后由**浏览器**把 `{authCodeInfo, codeVerifier}` 回投到回调地址。
 *   3. 拿 AuthCode 调 `POST /trae/api/v3/oauth/ExchangeToken`，body 换成
 *      `{ClientID, AuthCode, CodeVerifier, DeviceInfo, IDEVersion}` —— 注意这条路径
 *      **没有 DeviceProof**，设备信任是在这一步由 DeviceInfo.DevicePublicKey 建立的。
 *   4. `POST /cloudide/api/v3/trae/GetUserInfo` 补账号昵称。
 *
 * 第 3 步建立的绑定就是以后 refresh 能不能过的关键：DevicePublicKey 必须与
 * 私钥配套，而且私钥要跟着凭据一起存下来（keepalive 读 doc.device）。
 *
 * ## 为什么选项是函数而不是值
 *
 * 产品（cn / solo）可以在两次登录之间被用户换掉，而 ClientID、PlatformCode、
 * appType 全都跟着产品走。把选项做成 `resolve()` 每次 start 现算，避免
 * "插件启动时是 CN，用户切到 SOLO 后登录仍用 CN 的 ClientID"这类幽灵故障。
 */

import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { directFetch } from "../../shared/net-rescue.js";
import { deviceInfoOf, jwtPayload } from "./keepalive.js";

const EXCHANGE_PATH = "/trae/api/v3/oauth/ExchangeToken";
const USER_INFO_PATH = "/cloudide/api/v3/trae/GetUserInfo";
const LOGIN_TTL_MS = 10 * 60 * 1000;
const EXCHANGE_TIMEOUT_MS = 20000;

/** base64url，PKCE 规范要求的无填充变体。 */
function b64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 生成一对 PKCE 参数。 */
export function createPkce() {
  const codeVerifier = b64url(randomBytes(32));
  const codeChallenge = b64url(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

/**
 * 生成一把 P-256 设备密钥。
 *
 * 这把密钥就是本槽以后的**设备身份**：AuthCode 交换时服务端把它记成
 * DevicePublicKey，之后每次 refresh 的 DeviceProof 都必须由它对签。
 * 丢了它就等于丢设备绑定（回 20403），所以登录成功后必须连同凭据一起落盘。
 */
export function createDeviceKeyPair() {
  return generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

/** 拼登录地址，字段与客户端 buildLoginUrl 对齐（顺序本身不参与校验，便于对日志）。 */
export function buildLoginUrl(options) {
  const {
    loginHost, clientId, callbackUrl, machineId, deviceId,
    codeChallenge, deviceModel, osName, osVersion, appVersion, appType,
  } = options;
  const query = new URLSearchParams({
    login_version: "1",
    auth_from: "trae",
    login_channel: "native_ide",
    plugin_version: "local",
    auth_type: "local",
    client_id: clientId,
    redirect: "0",
    login_trace_id: randomUUID(),
    auth_callback_url: callbackUrl,
    machine_id: machineId ?? "",
    device_id: deviceId ?? "",
    x_device_id: deviceId ?? "",
    x_machine_id: machineId ?? "",
    x_device_brand: deviceModel ?? "",
    x_device_type: osName ?? "windows",
    x_os_version: osVersion ?? "",
    x_env: "",
    x_app_version: appVersion ?? "",
    x_app_type: appType ?? "TRAE_CN",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return String(loginHost).replace(/\/+$/, "") + "/authorization?" + query.toString();
}

/** 用 AuthCode 换凭据（与 refresh 共用同一个端点，body 不同、无 DeviceProof）。 */
export async function exchangeAuthCode(options) {
  const base = String(options.host || "https://api.trae.cn").replace(/\/+$/, "");
  const body = {
    ClientID: options.clientId,
    AuthCode: options.authCode,
    CodeVerifier: options.codeVerifier,
    DeviceInfo: deviceInfoOf({
      appKey: options.appKey,
      deviceId: options.deviceId,
      machineId: options.machineId,
      publicKeyPEM: options.publicKeyPEM,
      clipboard: options.clipboard,
    }),
    IDEVersion: options.ideVersion ?? "",
  };
  let response;
  try {
    response = await directFetch(base + EXCHANGE_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cloudide-token": "" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, code: "network", message: error instanceof Error ? error.message : String(error) };
  }
  const text = await response.text().catch(() => "");
  let doc;
  try { doc = JSON.parse(text); } catch { doc = undefined; }
  if (response.ok && typeof doc?.Result?.Token === "string") return { ok: true, result: doc.Result };
  const code = doc?.ResponseMetadata?.Error?.Code;
  const message = doc?.ResponseMetadata?.Error?.Message;
  return { ok: false, code: code ?? String(response.status), message: message ?? text.slice(0, 160) };
}

/** 取账号昵称（失败不致命 —— 登录本身已经成功了）。 */
export async function fetchUserInfo(options) {
  const base = String(options.host || "https://api.trae.cn").replace(/\/+$/, "");
  try {
    const response = await directFetch(base + USER_INFO_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cloudide-token": options.token ?? "" },
      body: JSON.stringify({ ReqSource: "IDE", IDEVersion: options.ideVersion ?? "" }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
    const doc = await response.json().catch(() => undefined);
    return doc?.Result;
  } catch { return undefined; }
}

/**
 * 一次登录会话。
 *
 * 状态机：idle → pending（回调服务已起、URL 待打开）→ done / failed / cancelled。
 * 同一实例同时只允许一个会话；再调 start() 会把上一个换掉（端口随之释放）。
 *
 * `options.resolve()` 在**每次 start 时**被调用，返回本次会话需要的上下文：
 *   { host, loginHost, appKey, clientId, deviceId, machineId, clipboard, ideVersion,
 *     appVersion, appType, deviceModel, osName, osVersion, onCredential }
 * `options.logger` 固定不变。
 */
export function createTraeLogin(options) {
  const logger = options?.logger;
  let session;
  let server;
  let timer;
  /** 本次会话的上下文：submit() 手动投递时要重放同一份（host/clientId/回调）。 */
  let currentContext;

  const cleanup = () => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    if (server !== undefined) { try { server.close(); } catch { /* 已关闭 */ } server = undefined; }
  };

  const finish = (result) => {
    if (session === undefined) return;
    session.state = result.ok === true ? "done" : "failed";
    session.result = result;
    session.finishedAt = new Date().toISOString();
    cleanup();
  };

  const html = (text) => "<html><body style=\"font-family:sans-serif;padding:32px\">" + text + "</body></html>";

  const handleCallback = async (context, payload) => {
    if (session === undefined || session.state !== "pending") return { ok: false, message: "没有待完成的登录" };
    let authCode = payload.AuthCode;
    if (typeof payload.authCodeInfo === "string") {
      try { authCode = JSON.parse(payload.authCodeInfo)?.AuthCode ?? authCode; } catch { /* 非 JSON 就当没有 */ }
    }
    const codeVerifier = typeof payload.codeVerifier === "string" && payload.codeVerifier !== "" ? payload.codeVerifier : session.codeVerifier;
    if (typeof authCode !== "string" || authCode === "") return { ok: false, message: "回调里没有 AuthCode" };
    const exchanged = await exchangeAuthCode({
      host: context.host,
      appKey: context.appKey,
      clientId: context.clientId,
      authCode,
      codeVerifier,
      deviceId: session.deviceId,
      machineId: context.machineId,
      publicKeyPEM: session.keyPair.publicKey,
      clipboard: context.clipboard,
      ideVersion: context.ideVersion,
    });
    if (exchanged.ok !== true) {
      finish({ ok: false, code: exchanged.code, message: exchanged.message });
      return { ok: false, message: exchanged.message ?? "交换失败" };
    }
    const result = exchanged.result;
    const info = await fetchUserInfo({ host: context.host, token: result.Token, ideVersion: context.ideVersion });
    /**
     * 账号守卫：发起时点名了要哪个号，登录回来不是那个号就直接作废这次登录。
     *
     * 多槽场景（trae=特依安、trae2=小号）下必须有这一关。没有它的时候，浏览器
     * 记着上一个号，用户在「使用其他账号登录」那一步点回原号也照样能登完，结果是
     * 把另一个槽的凭据静默覆盖成同一个号 —— 症状就是「两个 Trae 显示一模一样的额度」。
     */
    const wantedUser = session.userIdWanted;
    const arrivedUser = String(result.UserID ?? jwtPayload(result.Token)?.data?.id ?? "");
    if (typeof wantedUser === "string" && wantedUser !== "" && arrivedUser !== wantedUser) {
      const name = info?.ScreenName ?? info?.Username ?? "未知账号";
      const message = "登录的是 " + name + "（" + (arrivedUser || "?") + "），不是预期的账号 " + wantedUser;
      finish({ ok: false, code: "wrong-account", message });
      return { ok: false, code: "wrong-account", message };
    }
    const credential = {
      token: result.Token,
      refreshToken: result.RefreshToken,
      tokenExpireAt: result.TokenExpireAt,
      refreshExpireAt: result.RefreshExpireAt,
      userId: result.UserID ?? jwtPayload(result.Token)?.data?.id,
      account: info === undefined ? undefined : {
        /**
         * GetUserInfo 回的是 `ScreenName`（实测 2026-11-20：Result 里根本没有
         * Username/username 字段，只有 ScreenName="用户85948247380"）。
         * 取错字段的后果是快照里 account.username 恒为 undefined —— 面板上
         * "是谁登的"整格消失，两个 Trae 槽位看起来一模一样。
         */
        username: info.ScreenName ?? info.Username ?? info.username,
        nonPlainTextMobile: info.NonPlainTextMobile ?? info.nonPlainTextMobile,
      },
      device: {
        deviceId: session.deviceId,
        machineId: context.machineId,
        privateKeyPEM: session.keyPair.privateKey,
        publicKeyPEM: session.keyPair.publicKey,
      },
    };
    let written;
    try {
      written = await context.onCredential(credential);
    } catch (error) {
      finish({ ok: false, code: "persist", message: error instanceof Error ? error.message : String(error) });
      return { ok: false, message: "凭据落盘失败" };
    }
    finish({
      ok: true,
      credential: {
        userId: credential.userId,
        account: credential.account,
        tokenExpireAt: credential.tokenExpireAt,
        refreshExpireAt: credential.refreshExpireAt,
      },
      written,
    });
    return { ok: true };
  };

  /**
   * 起一次登录。
   *
   * `request.expectUserId` 非空时这次登录只认那个号（见 handleCallback 的账号守卫）——
   * 面板上给 trae/trae2 分别固定归属时用它，避免浏览器记住旧号把另一个槽覆盖掉。
   */
  const start = async (request) => {
    cleanup();
    const context = options.resolve();
    const expectUserId = request?.expectUserId ?? request?.userId;
    if (typeof expectUserId === "string" && expectUserId !== "") context.expectedUserId = expectUserId;
    currentContext = context;
    const pkce = createPkce();
    /**
     * 设备密钥对：**能复用就复用**。
     *
     * 服务端按 deviceId 只认一把公钥 —— AuthCode 登录会把 DeviceInfo.DevicePublicKey
     * 重新注册成这一次签的那把。若每次登录都新生成密钥对，同一个 deviceId 上的
     * 旧链（包括 Trae 桌面端自己存的那把）会在登录成功的瞬间全部作废，症状是
     * 桌面端和其它槽位随后续期一律 20403「Token device not match」。
     * 所以 context.keyPair 有值时必须原样使用（见 index.js 的 resolve()）。
     */
    const keyPair = context.keyPair ?? createDeviceKeyPair();
    session = {
      state: "pending",
      startedAt: new Date().toISOString(),
      codeChallenge: pkce.codeChallenge,
      codeVerifier: pkce.codeVerifier,
      keyPair,
      deviceId: context.deviceId ?? "",
      userIdWanted: context.expectedUserId,
    };
    await new Promise((resolveListening, rejectListening) => {
      const httpServer = createServer(async (req, res) => {
        const headers = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        };
        if (req.method === "OPTIONS") { res.writeHead(204, headers); res.end(); return; }
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/authorize") { res.writeHead(404, headers); res.end("not found"); return; }
        if (req.method === "GET") {
          const query = Object.fromEntries(url.searchParams.entries());
          if (query.AuthCode !== undefined || query.authCodeInfo !== undefined) {
            const done = await handleCallback(context, query);
            res.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
            res.end(html(done.ok === true ? "登录成功，可以关闭此页。" : "登录失败：" + String(done.message)));
            return;
          }
          res.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
          res.end(html("等待 Trae 授权回调…"));
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString("utf8");
        let payload = {};
        try {
          payload = JSON.parse(raw);
        } catch {
          try { payload = Object.fromEntries(new URLSearchParams(raw).entries()); } catch { payload = {}; }
        }
        const done = await handleCallback(context, payload);
        res.writeHead(200, { ...headers, "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(done));
      });
      server = httpServer;
      httpServer.once("error", rejectListening);
      httpServer.listen(0, "127.0.0.1", () => {
        session.port = httpServer.address().port;
        resolveListening();
      });
    });
    const callbackUrl = "http://127.0.0.1:" + session.port + "/authorize";
    session.url = buildLoginUrl({
      loginHost: context.loginHost ?? context.host,
      clientId: context.clientId,
      callbackUrl,
      machineId: context.machineId ?? "",
      deviceId: session.deviceId,
      codeChallenge: session.codeChallenge,
      deviceModel: context.deviceModel,
      osName: context.osName,
      osVersion: context.osVersion,
      appVersion: context.appVersion,
      appType: context.appType,
    });
    timer = setTimeout(() => { finish({ ok: false, code: "timeout", message: "登录超时（10 分钟）" }); }, LOGIN_TTL_MS);
    timer.unref?.();
    logger?.info?.(`dsh-trae-connect: 登录会话已就绪（回调 ${callbackUrl}）`);
    return { url: session.url, port: session.port, deviceId: session.deviceId };
  };

  return {
    start,
    /**
     * 手动投递授权码。
     *
     * 给两种场景兜底：①浏览器把回调打在别的 host（反代、端口转发）；②用户直接
     * 从地址栏复制了 `?AuthCode=...&codeVerifier=...`。走的还是同一条 handleCallback，
     * 所以校验、落盘、状态机完全一致。
     */
    async submit(payload) {
      if (currentContext === undefined) return { ok: false, message: "还没有发起过登录" };
      return handleCallback(currentContext, payload ?? {});
    },
    cancel() {
      if (session === undefined) return { cancelled: false };
      finish({ ok: false, code: "cancelled", message: "已取消" });
      return { cancelled: true };
    },
    status() {
      if (session === undefined) return { state: "idle" };
      return {
        state: session.state,
        url: session.state === "pending" ? session.url : undefined,
        port: session.port,
        deviceId: session.deviceId,
        expectUserId: session.userIdWanted,
        startedAt: session.startedAt,
        finishedAt: session.finishedAt,
        result: session.result,
      };
    },
  };
}
