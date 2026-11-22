/**
 * Trae 凭据保活 —— 自动 adopt 桌面端登录态 + 用 ExchangeToken 自续期。
 *
 * 为什么需要这个模块：Trae 的 token 只活 14 天，插件此前完全不会续期
 * （`createCredentialStore` 只按 JWT 的 exp 判过期，过期就抛），所以每到
 * 第 14 天渠道必然掉一次，用户必须回桌面端重新登录 + 重跑导出脚本。
 *
 * 续期协议是逆向 main.js 得到的（out-build/vs/code/electron-main/oauth/
 * marscode/request.js 的 exchangeTokenByRefreshToken）：
 *
 *   POST {host}/trae/api/v3/oauth/ExchangeToken
 *   headers: { "Content-Type": "application/json", "x-cloudide-token": <当前 token> }
 *   body: { ClientID, ClientSecret: "", RefreshToken, DeviceInfo, DeviceProof, IDEVersion }
 *
 * 三个**必须逐字复刻**的细节，任何一处错都会被服务端判成 20403「device not match」：
 *
 *   1. DeviceProof 的三个键是**大写开头**（Signature/Timestamp/Nonce）。
 *      客户端内部 RFe() 返回的是小写字段名，组装时显式改名 —— 直接传小写
 *      会得到 20405「Device proof required」，看上去像"少了参数"，实际是字段名不对。
 *   2. 签名串用 **\n** 分隔：`POST\n{path}\n{clientId}\n{refreshToken}\n{ts}\n{nonce}`；
 *      用空格拼会得到 20403（签名对不上，但错误码指向设备不匹配）。
 *   3. DevicePublicKey 必须是**登录时注册的那把**，且私钥与它配对；
 *      每次新生成密钥对同样得到 20403。
 *
 * 另外 refreshToken 是**一次性**的：换一次就作废，必须把返回的新 refreshToken
 * 立刻落盘，否则下一次（包括桌面端自己）就只剩 20101。
 */

import { createSign, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { directFetch } from "../../shared/net-rescue.js";
import { DESKTOP_APP_DIRS, readDesktopSession, seal, storagePath, unseal, writeCredentialFile } from "./vault.js";

//#region 协议常量

/** 交换端点。auth_code 与 refresh_token 两条路共用它。 */
const EXCHANGE_PATH = "/trae/api/v3/oauth/ExchangeToken";
/** 产品级 ClientID（main.js 的 Ny()：TRAE 默认 / SOLO 默认）。 */
/** 浏览器登录与 refresh 共用同一套 ClientID；导出给 login.js 用。 */
export const TRAE_CLIENT_IDS = { cn: "ono9krqynydwx5", solo: "en1oxy7wnw8j9n" };
const CLIENT_IDS = TRAE_CLIENT_IDS;
/** PlatformCode：IDE 产品是 IDE_PC，SOLO 是 SOLO_PC。 */
const PLATFORM_CODES = { cn: "IDE_PC", solo: "SOLO_PC" };
/** 签名串分隔符 —— 必须是换行（main.js 的 RFe 用 join("\n")）。 */
const PROOF_SEPARATOR = "\n";
/** 这三个码意味着「这条 refresh 已经不能用了」，重试只会更糟。 */
const REFRESH_DEAD_CODES = new Set(["20101", "20315", "20324", "20125", "20126", "20401", "20403"]);
/** 过期前多久开始续期：14 天寿命，提前 3 天换新，留足重试余量。 */
const DEFAULT_LEAD_MS = 3 * 24 * 3600 * 1000;
/** 续期失败后的冷却：这段时间内不再打上游（避免把账号打进风控）。 */
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
/** 交换请求超时。 */
const EXCHANGE_TIMEOUT_MS = 20000;

//#endregion
//#region 设备身份

let cachedDeviceName;

/**
 * 设备名（DeviceInfo.DeviceName）。
 *
 * main.js 的 MFe() 在 win32 上取 `net.exe user <用户>` 的 Full Name，取不到才回落到
 * hostname。这不是"装饰字段"—— 服务端把它算进设备指纹，我们回放时最好与登录时一致。
 * 拿不到也无所谓（实测不影响），所以整个过程吞异常、只算一次。
 */
export function detectDeviceName() {
  if (cachedDeviceName !== undefined) return cachedDeviceName;
  let name = "";
  try {
    if (process.platform === "win32") {
      const user = process.env.USERNAME || userInfo().username;
      const out = execFileSync("net.exe", ["user", user], { encoding: "utf8", timeout: 3000, windowsHide: true });
      const match = /Full Name\s+(.*)/.exec(out);
      if (match !== null && match[1].trim() !== "") name = match[1].trim();
    }
  } catch { /* 拿不到就回落 */ }
  cachedDeviceName = name === "" ? hostname() : name;
  return cachedDeviceName;
}

/**
 * 一组 DeviceInfo —— 逐字段对应 main.js 的 i()。
 *
 * `DevicePublicKey` 由调用方覆盖成本次签名用的那把（客户端也是这么做的：
 * 缓存整份 DeviceInfo，每次只把公钥换成当前密钥对）。
 */
export function deviceInfoOf(options) {
  const { appKey, deviceId, machineId, publicKeyPEM, clipboard } = options;
  return {
    DeviceID: deviceId,
    MachineID: machineId ?? "",
    PlatformCode: PLATFORM_CODES[appKey] ?? PLATFORM_CODES.cn,
    DeviceType: "PC",
    DeviceName: clipboard?.deviceName ?? detectDeviceName(),
    DeviceModel: clipboard?.deviceModel ?? "",
    ClientVersion: clipboard?.appVersion ?? "",
    DevicePublicKey: publicKeyPEM,
    DeviceBrand: clipboard?.deviceBrand ?? "",
    DeviceCPU: clipboard?.deviceCpu ?? "",
    OSInfo: clipboard?.osName ?? (process.platform === "win32" ? "windows" : process.platform),
    OSVersion: clipboard?.osVersion ?? "",
  };
}

/**
 * 生成一个 Trae 形状的设备号（16 位数字）。
 *
 * 为什么需要「插槽自有设备号」：服务端对**同一个 DeviceID 只保留最近一次 AuthCode
 * 登录注册的那把设备公钥**。桌面端、trae 槽、trae2 槽若共用一个 DeviceID，任何一方
 * 登录都会把另外两条链判成 20403「Token device not match」—— 实测矩阵：
 *   特依安链 + 特依安钥 → OK；特依安链 + 桌面钥 → 20403；桌面链 + 特依安钥 → 20403。
 * 所以每个槽必须自带 deviceId + 配对密钥，与桌面端彻底分开。
 */
export function newDeviceId() {
  let digits = String(1 + Math.floor(Math.random() * 8));
  while (digits.length < 16) digits += String(Math.floor(Math.random() * 10));
  return digits;
}

/**
 * 读快照里该槽自己的设备身份。
 *
 * 返回 undefined 的两种情况都意味着「没有可用身份、必须新造一个」：
 *   1. 快照里没有 device 段（老导出脚本写的快照就只有 token）；
 *   2. device.deviceId 与桌面端相同 —— 那是借用桌面身份的历史遗留，继续用会与
 *      桌面端互相顶掉，必须换成本槽专属设备号。
 */
export function slotIdentity(doc, desktop) {
  const desktopDeviceId = typeof desktop?.deviceId === "string" ? desktop.deviceId : "";
  const desktopUser = desktop?.userId === undefined || desktop.userId === null ? "" : String(desktop.userId);
  const ourUser = doc?.userId === undefined || doc.userId === null ? "" : String(doc.userId);
  /**
   * 与桌面端**同号**的槽刻意复用桌面身份。
   *
   * 这种槽和桌面端本来就是同一个账号、同一条 refresh 链（refreshToken 一次性，
   * 任何一方用掉另一方就废）。keepalive 的 writeBackToDesktop 会把续期结果同步回
   * storage.json，两边共链反而是唯一能让桌面端活下去的形态。
   */
  if (desktopUser !== "" && ourUser !== "" && ourUser === desktopUser
    && desktopDeviceId !== "" && typeof desktop?.keyPair?.privateKeyPEM === "string") {
    return {
      deviceId: desktopDeviceId,
      keyPair: { privateKey: desktop.keyPair.privateKeyPEM, publicKey: desktop.keyPair.publicKeyPEM },
      sharedWithDesktop: true,
    };
  }
  const local = doc?.device;
  const usable = typeof local?.privateKeyPEM === "string" && typeof local?.publicKeyPEM === "string"
    && typeof local?.deviceId === "string" && local.deviceId !== "";
  if (!usable) return undefined;
  /** 借用了桌面 deviceId 却又不是同号 —— 继续用会把桌面端顶掉，必须换新身份。 */
  if (desktopDeviceId !== "" && local.deviceId === desktopDeviceId) return undefined;
  return {
    deviceId: local.deviceId,
    keyPair: { privateKey: local.privateKeyPEM, publicKey: local.publicKeyPEM },
  };
}
/**
 * DeviceProof：ES256 签名。
 *
 * 返回的键名**必须是首字母大写**（见文件头 1.）—— 这是整件事最容易踩的坑：
 * 小写会被服务端当成"没有 DeviceProof"，报 20405 而不是签名错误。
 */
export function buildDeviceProof(options) {
  const { method, path, clientId, refreshToken, privateKeyPEM } = options;
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString("hex");
  const message = [method, path, clientId, refreshToken, String(timestamp), nonce].join(PROOF_SEPARATOR);
  const signer = createSign("SHA256");
  signer.update(Buffer.from(message, "utf8"));
  return {
    Signature: signer.sign({ key: privateKeyPEM, dsaEncoding: "der" }).toString("base64"),
    Timestamp: timestamp,
    Nonce: nonce,
  };
}

//#endregion
//#region JWT

/** 读 JWT 的 payload（不验签，只取 exp / userId）。 */
export function jwtPayload(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch { return undefined; }
}

//#endregion
//#region ExchangeToken

/**
 * 用 refreshToken 换一对新凭据。
 *
 * 返回 { ok: true, result } 或 { ok: false, code, message, dead }。
 * `dead` 为真表示这条 refresh 已经被服务端作废（20101 系）—— 只能重新登录。
 */
export async function exchangeRefreshToken(options) {
  const { host, appKey, clientId, refreshToken, privateKeyPEM, publicKeyPEM, deviceId, machineId } = options;
  const base = String(host || "https://api.trae.cn").replace(/\/+$/, "");
  const proof = buildDeviceProof({ method: "POST", path: EXCHANGE_PATH, clientId, refreshToken, privateKeyPEM });
  const body = {
    ClientID: clientId,
    ClientSecret: "",
    RefreshToken: refreshToken,
    DeviceInfo: deviceInfoOf({
      appKey, deviceId, machineId, publicKeyPEM,
      clipboard: options.clipboard,
    }),
    DeviceProof: proof,
    IDEVersion: options.ideVersion ?? "",
  };
  let response;
  try {
    response = await directFetch(base + EXCHANGE_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cloudide-token": options.cloudToken ?? "" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, code: "network", message: error instanceof Error ? error.message : String(error), dead: false };
  }
  const text = await response.text().catch(() => "");
  let doc;
  try { doc = JSON.parse(text); } catch { doc = undefined; }
  const code = doc?.ResponseMetadata?.Error?.Code;
  const message = doc?.ResponseMetadata?.Error?.Message;
  if (response.ok && typeof doc?.Result?.Token === "string") return { ok: true, result: doc.Result };
  const dead = typeof code === "string" && REFRESH_DEAD_CODES.has(code);
  return { ok: false, code: code ?? String(response.status), message: message ?? text.slice(0, 160), dead };
}

//#endregion
//#region 快照演进

/**
 * 把一次成功的交换结果写回凭据文档。
 *
 * ⚠️ 新 refreshToken 必须**立刻**落盘：它是单次有效的，丢了这个响应就等于
 * 把账号的续期链烧断（桌面端自己也会因此掉线）。
 */
export function applyExchangeResult(doc, result) {
  const tokenExp = Number.isFinite(result.TokenExpireAt) ? new Date(result.TokenExpireAt) : undefined;
  const refreshExp = Number.isFinite(result.RefreshExpireAt) ? new Date(result.RefreshExpireAt) : undefined;
  return {
    ...doc,
    token: result.Token,
    refreshToken: typeof result.RefreshToken === "string" ? result.RefreshToken : doc.refreshToken,
    expiredAt: tokenExp !== undefined ? tokenExp.toISOString() : doc.expiredAt,
    refreshExpiredAt: refreshExp !== undefined ? refreshExp.toISOString() : doc.refreshExpiredAt,
    userId: doc.userId || String(result.UserID ?? ""),
    renewedAt: new Date().toISOString(),
    renewSource: "exchange-token",
  };
}

//#endregion
//#region 保活器

/**
 * 保活器：把「桌面端有没有新登录」与「这条凭据还能活多久」两件事收敛到一处。
 *
 * 三个动作：
 *   adopt()   读桌面端 storage.json，若账号与本地槽不同（或本地槽根本没号）就整份搬过来；
 *   renew()   用 ExchangeToken 换新 token 并落盘；
 *   tick()    按需跑上面两个 —— 巡检每轮调一次，幂等。
 *
 * 设计取舍：**不主动 adopt 同账号的桌面会话**。桌面端与插件共用同一条 refresh 链，
 * 两边各自续期会互相把对方烧掉；所以只在「本地槽没有号」或「桌面端换了账号」时搬。
 * 同账号的情况下，续期权归插件（它每次换完都把新 refresh 写回快照，桌面端下次启动读到的就是新的）。
 */
/**
 * 把插件续期出来的凭据写回桌面端 storage.json。
 *
 * 为什么必须写回：桌面端与插件共用同一条 refresh 链，refresh 是一次性的 ——
 * 插件换走之后桌面端手里那条就废了。写回让它下次启动直接拿到新链。
 *
 * 保守策略：
 *   - 只在桌面端当前 token 的 exp **不晚于**我们这份时写（绝不覆盖更新的登录态）；
 *   - 只改 iCubeAuthInfo://icube.cloudide 这一条，其它键原样带过，且写完复核键集不变；
 *   - 覆盖前把原文件另存为 storage.json.bak-<ISO 时间戳>；
 *   - 保持 Trae 自己的 4 空格缩进排版（紧凑化会让体积从 10188B 掉到 7596B）；
 *   - 整份 storage.json 原子替换，失败只记一笔，不影响插件。
 */
function writeBackToDesktop(doc) {
  const appKey = doc?.product === "solo" ? "solo" : "cn";
  const appDir = DESKTOP_APP_DIRS[appKey] ?? DESKTOP_APP_DIRS.cn;
  const file = storagePath(appDir);
  try {
    if (!existsSync(file)) return { wrote: false, reason: "桌面端 storage.json 不存在" };
    const raw = readFileSync(file, "utf8");
    const vault = JSON.parse(raw);
    const entry = vault["iCubeAuthInfo://icube.cloudide"];
    if (typeof entry !== "string") return { wrote: false, reason: "桌面端没有登录态条目" };
    const plain = unseal(entry);
    if (plain === null) return { wrote: false, reason: "桌面登录态解不开" };
    const session = JSON.parse(plain);
    /**
     * 账号必须一致才写回。
     *
     * 写回只搬 token/refreshToken，userId 留在桌面端那份 session 里不动 —— 若两边不是
     * 同一个号，写回去就是"小号的 userId 配特依安的 token"，桌面端下次启动直接不可用。
     * 多槽场景（trae=特依安、trae2=小号）下这条守卫是必须的，不是保险。
     */
    const liveUser = String(session.userId ?? jwtPayload(session.token)?.data?.id ?? "");
    const ourUser = String(doc.userId ?? jwtPayload(doc.token)?.data?.id ?? "");
    if (liveUser !== "" && ourUser !== "" && liveUser !== ourUser) {
      return { wrote: false, reason: "桌面端登录的是另一个账号，未覆盖" };
    }
    const liveExp = Number.isFinite(jwtPayload(session.token)?.exp) ? jwtPayload(session.token).exp : Number.NaN;
    const ourExp = Number.isFinite(jwtPayload(doc.token)?.exp) ? jwtPayload(doc.token).exp : Number.NaN;
    if (Number.isFinite(liveExp) && Number.isFinite(ourExp) && ourExp <= liveExp) {
      return { wrote: false, reason: "桌面端凭据更新，未覆盖" };
    }
    const merged = {
      ...session,
      token: doc.token,
      refreshToken: doc.refreshToken,
      expiredAt: doc.expiredAt,
      refreshExpiredAt: doc.refreshExpiredAt,
    };
    vault["iCubeAuthInfo://icube.cloudide"] = seal(JSON.stringify(merged));
    // 键集必须与读到的完全一致：这是 Electron 的 globalStorage，少一个键就等于替用户删了设置。
    if (JSON.stringify(Object.keys(vault).sort()) !== JSON.stringify(Object.keys(JSON.parse(raw)).sort())) {
      return { wrote: false, reason: "键集发生变化，放弃写回" };
    }
    // Trae 自己写这份文件用 4 空格缩进（原始 10188B 正是同一份内容 indent=4 的长度；
    // 紧凑 JSON 只有 7596B）。内容等价但体积差 26%，没必要给下一次排查留这个差异。
    const text = JSON.stringify(vault, null, 4);
    const backup = file + ".bak-" + new Date().toISOString().replace(/[:.]/g, "-");
    try {
      writeFileSync(backup, raw, { mode: 0o600 });
    } catch {
      /* 备份失败不阻止写回：留着旧链不写，反而会丢掉刚换来的续期结果 */
    }
    const tmp = file + "." + process.pid + ".tmp";
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
    return { wrote: true, file, backup };
  } catch (error) {
    return { wrote: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 从一次浏览器登录的产物组装凭据快照。
 *
 * 字段表与 credentialFromDesktop（以及 scripts/export-trae-plain.mjs）逐字对齐 ——
 * 登录换来的 token 与"从桌面端搬来的 token"在插件看来必须是同一种东西，
 * 否则 resolveProduct/签到/目录会缺字段，症状是"能连上但签到 9004"。
 *
 * 与 adopt 不同的是这里**带上了登录时新生成的设备密钥对**：AuthCode 那一步就是用
 * 这把公钥建立设备绑定的，以后每次 refresh 都必须用它签名（换一把就 20403）。
 */
export function credentialFromLogin(input) {
  const { credential, template, product, appKey } = input;
  const payload = jwtPayload(credential.token);
  const expiresAt = Number.isFinite(credential.tokenExpireAt)
    ? new Date(credential.tokenExpireAt).toISOString()
    : (Number.isFinite(payload?.exp) ? new Date(payload.exp * 1000).toISOString() : "");
  const refreshAt = Number.isFinite(credential.refreshExpireAt)
    ? new Date(credential.refreshExpireAt).toISOString()
    : "";
  return {
    ...(template ?? {}),
    formatVersion: 2,
    product: appKey,
    packageType: product?.packageType ?? (appKey === "solo" ? "SOLO_CN" : "TRAE_CN"),
    reqSource: product?.reqSource ?? (appKey === "solo" ? 2 : 1),
    exportedAt: new Date().toISOString(),
    gateway: template?.gateway ?? "https://trae-api-cn.mchost.guru",
    appId: template?.appId ?? "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
    appVersionCode: product?.appVersionCode ?? template?.appVersionCode,
    appVersion: product?.appVersion ?? template?.appVersion,
    functions: product?.functions ?? template?.functions,
    catalogGroups: product?.catalogGroups ?? template?.catalogGroups,
    defaultFunction: product?.defaultFunction ?? template?.defaultFunction,
    token: credential.token,
    refreshToken: typeof credential.refreshToken === "string" ? credential.refreshToken : "",
    expiredAt: expiresAt,
    refreshExpiredAt: refreshAt,
    userId: credential.userId === undefined ? "" : String(credential.userId),
    host: template?.host ?? "https://api.trae.cn",
    deviceId: credential.device?.deviceId ?? template?.deviceId ?? "",
    account: credential.account ?? template?.account ?? {},
    device: credential.device === undefined ? template?.device : {
      deviceId: credential.device.deviceId,
      machineId: credential.device.machineId,
      privateKeyPEM: credential.device.privateKeyPEM,
      publicKeyPEM: credential.device.publicKeyPEM,
    },
    loggedInAt: new Date().toISOString(),
    loggedInFrom: "browser-pkce",
  };
}

export function createTraeKeepalive(options) {
  const { store, logger, config, instanceId } = options;
  const current = typeof config === "function" ? config : () => ({});
  const appKeyOf = () => (options.productId?.() === "solo" ? "solo" : "cn");
  /** 单飞：同一时刻只允许一次交换（重复调用拿同一个 promise）。 */
  let inflight;
  let lastError;
  let lastAttemptAt = 0;
  let lastOkAt = 0;
  let lastAction = "idle";
  let needsLogin;
  /** 上一次自动 adopt 被「不静默换号」保护挡下的记录（桌面端登的是另一个号）。 */
  let adoptBlocked;
  /** 上一次「桌面端是别的号」warn 时的桌面 userId，用来给这条日志去重（见 adopt）。 */
  let lastBlockedDesktopUserId;

  const leadMs = () => {
    const override = current()?.tokenRefreshLeadMs;
    return Number.isFinite(override) && override >= 0 ? override : DEFAULT_LEAD_MS;
  };
  const cooldownMs = () => {
    const override = current()?.tokenRefreshCooldownMs;
    return Number.isFinite(override) && override >= 0 ? override : DEFAULT_COOLDOWN_MS;
  };

  /** 读快照原文（不走 store.resolve，因为它会因为过期直接抛）。 */
  const readDoc = () => {
    try {
      const text = readFileSync(store.path(), "utf8");
      const doc = JSON.parse(text);
      return typeof doc === "object" && doc !== null ? doc : undefined;
    } catch { return undefined; }
  };

  /**
   * 设备密钥对。
   *
   * 优先用快照里存的（adopt 时从桌面端搬过来的那把），其次读桌面端 storage.json ——
   * 必须与 `deviceId` 配套：换了设备号的密钥对签出来的签名一定 20403。
   */
  const keyMaterial = (doc) => {
    if (typeof doc?.device?.privateKeyPEM === "string" && typeof doc?.device?.publicKeyPEM === "string"
      && (doc.device.deviceId === undefined || doc.device.deviceId === doc.deviceId)) {
      return { privateKeyPEM: doc.device.privateKeyPEM, publicKeyPEM: doc.device.publicKeyPEM };
    }
    const desktop = readDesktopSession(DESKTOP_APP_DIRS[appKeyOf()] ?? DESKTOP_APP_DIRS.cn);
    if (desktop.keyPair !== undefined && (doc?.deviceId === undefined || desktop.deviceId === doc.deviceId)) {
      return { privateKeyPEM: desktop.keyPair.privateKeyPEM, publicKeyPEM: desktop.keyPair.publicKeyPEM, deviceId: desktop.deviceId, machineId: desktop.machineId };
    }
    return undefined;
  };

  /**
   * 从桌面端登录态生成一份凭据快照。
   *
   * 字段表与 scripts/export-trae-plain.mjs 的组装段逐字对齐 —— 那份是插件的
   * 既有契约（resolveProduct 靠 product、签到靠 deviceId、目录靠 catalogGroups），
   * 少一个字段就会出现"能连上但签到 9004"这类偏门故障。
   */
  const credentialFromDesktop = (desktop, template) => {
    const appKey = appKeyOf();
    const product = options.productOf?.() ?? options.productId?.();
    const payload = jwtPayload(desktop.session.token);
    return {
      ...(template ?? {}),
      formatVersion: 2,
      product: appKey,
      packageType: product?.packageType ?? (appKey === "solo" ? "SOLO_CN" : "TRAE_CN"),
      reqSource: product?.reqSource ?? (appKey === "solo" ? 2 : 1),
      exportedAt: new Date().toISOString(),
      gateway: template?.gateway ?? "https://trae-api-cn.mchost.guru",
      appId: template?.appId ?? "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
      appVersionCode: product?.appVersionCode ?? template?.appVersionCode,
      appVersion: product?.appVersion ?? template?.appVersion,
      functions: product?.functions ?? template?.functions,
      catalogGroups: product?.catalogGroups ?? template?.catalogGroups,
      defaultFunction: product?.defaultFunction ?? template?.defaultFunction,
      token: desktop.session.token,
      refreshToken: typeof desktop.session.refreshToken === "string" ? desktop.session.refreshToken : "",
      expiredAt: desktop.session.expiredAt ?? (payload?.exp ? new Date(payload.exp * 1000).toISOString() : ""),
      refreshExpiredAt: desktop.session.refreshExpiredAt ?? "",
      userId: desktop.session.userId ?? String(payload?.data?.id ?? ""),
      host: desktop.session.host ?? "https://api.trae.cn",
      deviceId: desktop.deviceId ?? "",
      account: desktop.session.account ?? {},
      device: desktop.keyPair === undefined ? undefined : {
        deviceId: desktop.deviceId,
        privateKeyPEM: desktop.keyPair.privateKeyPEM,
        publicKeyPEM: desktop.keyPair.publicKeyPEM,
        machineId: desktop.machineId,
      },
      adoptedAt: new Date().toISOString(),
      adoptedFrom: desktop.file,
    };
  };

  /** 桌面端当前登录的账号（读不到就是 undefined）。 */
  const desktopAccount = () => {
    const desktop = readDesktopSession(DESKTOP_APP_DIRS[appKeyOf()] ?? DESKTOP_APP_DIRS.cn);
    if (desktop.session === undefined) return { desktop, userId: undefined };
    const payload = jwtPayload(desktop.session.token);
    return { desktop, userId: String(desktop.session.userId ?? payload?.data?.id ?? "") };
  };

  /**
   * 从桌面端搬登录态。
   *
   * 触发条件（`force` 为真时跳过判定，供面板按钮用）：
   *   - 本地槽读不到快照 / 没有 token；
   *   - 本地槽的账号与桌面端**不同**（用户在桌面端换了号）。
   * 同账号不搬 —— 见 createTraeKeepalive 的注释（共用一条 refresh 链）。
   */
  /**
   * 「谁更新」判定。
   *
   * 桌面端与插件共用同一条 refresh 链，任何一方续期都会把对方的 refresh 作废。
   * 用 token 的 exp 当版本号：**到期更晚的那份一定是更新的**（服务端签发时
   * 要么是全新登录、要么是续期，两者都会把 exp 往后推）。
   * 这条规则同时解决了「桌面端退出时把内存里的旧 session 写回磁盘」这个竞态：
   * 旧 token 的 exp 更早，会被判成过期版本，不会被采纳。
   */
  const newerThan = (candidateExp, localExp) => {
    if (!Number.isFinite(candidateExp)) return false;
    if (!Number.isFinite(localExp)) return true;
    return candidateExp > localExp;
  };

  const expOf = (token) => {
    const exp = jwtPayload(token)?.exp;
    return Number.isFinite(exp) ? exp : Number.NaN;
  };

  const adopt = async (force = false) => {
    const doc = readDoc();
    const { desktop, userId } = desktopAccount();
    if (desktop.session === undefined) {
      return { adopted: false, reason: desktop.error ?? "桌面端没有登录态" };
    }
    const localUserId = typeof doc?.userId === "string" ? doc.userId : "";
    const localExp = doc?.token === undefined ? Number.NaN : expOf(doc.token);
    const remoteExp = expOf(desktop.session.token);
    /**
     * 同账号且本地不更旧 → 不 adopt（本地可能就是刚续期出来的那份）。
     * 换账号 → 一律 adopt（用户明确在桌面端换了号）。
     */
    if (localUserId === userId && !force && !newerThan(remoteExp, localExp)) {
      return { adopted: false, reason: "本地凭据不比桌面端旧，续期权在本地" };
    }
    if (localUserId === userId && force && !newerThan(remoteExp, localExp)) {
      return { adopted: false, reason: "已经是桌面端当前账号的最新凭据" };
    }
    /**
     * 「不静默换号」：本槽已经绑定了自己的账号，桌面端登的却是另一个号。
     *
     * 这是 2026-11-22 的真实事故。trae2 本来是小号，桌面端登着特依安；某一轮
     * tick 判出 localStale（token 到期 / 快照读不到），于是 adopt(false) 把桌面
     * 身份**整份**搬进 trae2 —— 两个槽变成同一个号，用户看到的是
     * 「我两个 Trae 怎么显示一模一样的额度」。
     *
     * 自动 adopt 的职责是「把本槽救活」，不是「替本槽决定用哪个号」。所以分三档：
     *   - 本槽没有账号（新槽 / 快照损坏 / userId 为空）→ 放行，这是唯一合理的首次导入；
     *   - 本槽有自己的账号，且与桌面端**相同** → 由上面的 newerThan 决定（共链续期）；
     *   - 本槽有自己的账号，且与桌面端**不同** → 拒绝，把选择权留给用户：
     *     面板上显式 POST {"action":"adopt","force":true} 才会换号。
     *
     * 少了这一条，桌面端只要换一次号，所有 Trae 槽就会在 30 秒内被统一成那个号。
     */
    if (!force && localUserId !== "" && userId !== "" && localUserId !== userId) {
      adoptBlocked = { at: new Date().toISOString(), localUserId, desktopUserId: userId };
      /**
       * 只在「桌面端换成了另一个号」的第一次 warn。
       *
       * 这条路径的重灾区是 refresh 已经作废的槽：它每轮都 localStale，每 30 秒都会
       * 走到这里。不设闸的话日志会被同一句话刷满，真正的错误反而被埋掉。
       */
      if (lastBlockedDesktopUserId !== userId) {
        lastBlockedDesktopUserId = userId;
        logger?.warn?.(
          "dsh-trae-connect[" + instanceId + "]: 桌面端登录的是另一个账号（" + userId
          + "），本槽是 " + localUserId + " —— 已拒绝自动覆盖（要换号请在面板里手动 adopt）",
        );
      }
      return {
        adopted: false,
        code: "other-account",
        reason: "桌面端登录的是另一个账号（" + userId + "），本槽绑定的是 " + localUserId + "，已拒绝自动覆盖",
        localUserId,
        desktopUserId: userId,
      };
    }
    const next = credentialFromDesktop(desktop, doc);
    writeCredentialFile(store.path(), next);
    lastAction = "adopted";
    lastOkAt = Date.now();
    needsLogin = undefined;
    adoptBlocked = undefined;
    lastBlockedDesktopUserId = undefined;
    logger?.info?.(`dsh-trae-connect[${instanceId}]: 已 adopt 桌面端登录态（user=${next.userId}，device=${next.deviceId || "?"}）`);
    return { adopted: true, userId: next.userId, account: next.account?.username, file: store.path() };
  };

  /**
   * 用 refreshToken 换新凭据并落盘。
   *
   * 失败分两类：
   *   - `dead`（20101 系）：这条 refresh 已经废了，标记 needsLogin，别再用它重试；
   *   - 其它（网络/5xx）：进冷却，下一轮再试。
   */
  const renew = async () => {
    if (inflight !== undefined) return inflight;
    inflight = (async () => {
      const doc = readDoc();
      if (doc === undefined || typeof doc.refreshToken !== "string" || doc.refreshToken === "") {
        return { renewed: false, reason: "快照里没有 refreshToken" };
      }
      const keys = keyMaterial(doc);
      if (keys === undefined) return { renewed: false, reason: "找不到与 deviceId 配套的设备密钥对（需要桌面端登录过一次）" };
      const appKey = appKeyOf();
      const result = await exchangeRefreshToken({
        host: doc.host,
        appKey,
        clientId: doc.clientId ?? CLIENT_IDS[appKey] ?? CLIENT_IDS.cn,
        refreshToken: doc.refreshToken,
        privateKeyPEM: keys.privateKeyPEM,
        publicKeyPEM: keys.publicKeyPEM,
        deviceId: doc.deviceId ?? keys.deviceId,
        machineId: doc.device?.machineId ?? keys.machineId,
        ideVersion: doc.appVersion ?? "",
        cloudToken: doc.token,
        clipboard: options.clipboard?.(),
      });
      lastAttemptAt = Date.now();
      if (!result.ok) {
        lastError = `${result.code} ${result.message}`;
        lastAction = "renew-failed";
        if (result.dead) needsLogin = true;
        logger?.warn?.(`dsh-trae-connect[${instanceId}]: 续期失败（${result.code}）${result.dead ? " —— 这条 refresh 已作废，需要在桌面端重新登录一次" : ""}`);
        return { renewed: false, reason: result.message, code: result.code, dead: result.dead };
      }
      const next = applyExchangeResult(doc, result.result);
      writeCredentialFile(store.path(), next);
      /**
       * 把新 refreshToken 也写回桌面端 storage.json。
       *
       * 不写的话，桌面端下次启动读到的是**已被我们烧掉的**旧 refresh —— 它一续期
       * 就 20101，用户看到的是"桌面端莫名要求重新登录"。写回是让两边共用同一条链
       * 的唯一办法；写失败不影响插件自身（只是桌面端需要重新登录）。
       */
      const back = writeBackToDesktop(next);
      lastOkAt = Date.now();
      lastError = undefined;
      lastAction = back.wrote === true ? "renewed+writeback" : "renewed";
      needsLogin = undefined;
      logger?.info?.(`dsh-trae-connect[${instanceId}]: token 已续期（新 token 到 ${next.expiredAt}）`);
      return { renewed: true, expiresAt: next.expiredAt };
    })().finally(() => { inflight = undefined; });
    return inflight;
  };

  /**
   * 一轮保活。巡检每轮调一次，幂等、可并发（内部单飞）。
   *
   * 顺序很重要：**先 adopt 再 renew** —— adopt 会换掉整份快照，先 renew 等于白换一次
   * （还会把旧号的 refresh 烧掉）。
   */
  const tick = async () => {
    if (current()?.keepalive === false) return { skipped: "keepalive 已关闭" };
    const doc = readDoc();
    const exp = doc === undefined ? Number.NaN : jwtPayload(doc.token)?.exp;
    const expiresAtMs = Number.isFinite(exp) ? exp * 1000 : Number.NaN;
    /**
     * 自动 adopt 只在「本槽自己已经不能用」时才跑。
     *
     * 这条门槛是血的教训：桌面端同一时刻只登着一个号，而 adopt 会把**身份**
     * 一起搬过来。若不设门槛，每 30 秒一轮的巡检会把所有 Trae 槽统一成桌面端
     * 当前那个号 —— trae2 明明还有 3 天有效期，却在一轮巡检后变成 trae 的复制品，
     * 用户看到的就是「我两个号怎么变成一个了」。
     *
     * 要主动换号，走 POST {"action":"adopt"} 手动指定槽位。
     */
    const localStale = doc === undefined || !Number.isFinite(exp) || expiresAtMs - Date.now() <= 0;
    if (localStale) {
      const adopted = await adopt(false);
      if (adopted.adopted === true) return { ...adopted, action: "adopt" };
    }
    if (doc === undefined) return { skipped: "没有凭据快照" };
    const due = !Number.isFinite(expiresAtMs) || expiresAtMs - Date.now() <= leadMs();
    if (!due) return { skipped: "token 还新" };
    if (needsLogin === true) return { skipped: "等待重新登录" };
    if (Date.now() - lastAttemptAt < cooldownMs()) return { skipped: "冷却中" };
    return renew();
  };

  /**
   * 浏览器登录刚写完一份新快照时清掉「等登录」标记。
   *
   * 不清的话 needsLogin 会一直为真，巡检每轮都跳过 renew —— 明明手里已经是一条
   * 全新的活链，插件却还停在"等你自己去登录"的状态，直到进程重启。
   */
  const noteLogin = (credential) => {
    needsLogin = undefined;
    lastError = undefined;
    adoptBlocked = undefined;
    lastBlockedDesktopUserId = undefined;
    lastAction = "logged-in";
    lastOkAt = Date.now();
    logger?.info?.(`dsh-trae-connect[${instanceId}]: 浏览器登录完成（user=${credential?.userId ?? "?"}）`);
    return { ok: true };
  };

  return {
    tick,
    adopt,
    renew,
    noteLogin,
    status() {
      const doc = readDoc();
      const exp = doc === undefined ? undefined : jwtPayload(doc.token)?.exp;
      return {
        instance: instanceId,
        enabled: current()?.keepalive !== false,
        needsLogin: needsLogin === true,
        lastAction,
        lastOkAt: lastOkAt === 0 ? undefined : new Date(lastOkAt).toISOString(),
        lastAttemptAt: lastAttemptAt === 0 ? undefined : new Date(lastAttemptAt).toISOString(),
        lastError,
        tokenExpiresAt: Number.isFinite(exp) ? new Date(exp * 1000).toISOString() : undefined,
        refreshExpiresAt: doc?.refreshExpiredAt,
        adoptedAt: doc?.adoptedAt,
        renewedAt: doc?.renewedAt,
        /**
         * 账号归属：本槽当前绑的是谁、桌面端现在登的是谁。
         *
         * 面板靠这两个字段判断「两个 Trae 槽是不是同一个号」——以前两条路由的
         * account 都显示「特依安」，界面上完全看不出已经塌成一个号。
         */
        localUserId: typeof doc?.userId === "string" ? doc.userId : undefined,
        localAccount: typeof doc?.account?.username === "string" ? doc.account.username : undefined,
        desktopUserId: (() => {
          const current = desktopAccount();
          return current.userId === "" ? undefined : current.userId;
        })(),
        /** 自动 adopt 被换号保护挡下的记录；非空即表示「本槽与桌面端不是同一个号」。 */
        adoptBlocked,
        hasDeviceKey: doc?.device?.privateKeyPEM !== undefined,
      };
    },
  };
}

//#endregion
