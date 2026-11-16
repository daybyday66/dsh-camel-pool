/**
 * Qoder CN 桌面 App 登录态读取器 —— qoder 渠道会话凭据的**自动续期**入口。
 *
 * ## 为什么需要它（m00537「为什么总会有挂掉的」的答案）
 *
 * qoder 渠道的凭据有两种：官方 PAT（`pt-`，不过期但要在网页上手工建）与
 * 桌面 App 的会话 token（`dt-`，有 expiresAt）。会话这一路此前只能**手工**灌进
 * `connect-auth/<渠道>-session.json`：一旦 `expiresAt` 过了，`createSessionStore`
 * 直接 `return undefined`，渠道就掉成 `signed-out`，面板那行红字就是这么来的。
 * 而 App 本身好好的 —— 它启动时自己就把 token 续了，只是那个新 token 躺在
 * Electron safeStorage 的密文里，没人去读。
 *
 * 本模块就是那个读取器：把 App 的 `auth.v1.dat` 解成明文会话，交给
 * `createSessionStore` 在本地文件缺失/过期时自动落盘。
 *
 * ## 密文格式（Electron safeStorage，Windows = DPAPI）
 *
 *   Local State -> os_crypt.encrypted_key（base64，解出后前 5 字节是 `DPAPI` 标记）
 *     └─ 去掉 5 字节 → DPAPI(CurrentUser) 解封 → 32 字节 AES-256 主密钥
 *
 *   auth.v1.dat -> `v10`(3) ‖ nonce(12) ‖ AES-256-GCM(明文 ‖ tag(16))
 *
 * 实测（2026-11-16，Qoder CN 0.2.x，Windows 11）：明文是
 * `{schemaVersion, authenticationContext, token, refreshToken, expiresAt,
 *   refreshTokenExpiresAt, user:{id,name,email,phone,avatarUrl}}`。
 *
 * ## 两个不能踩的坑
 *
 * 1. **必须 execFile 传参数数组 / 或 -EncodedCommand**。把含 `$b` 的多行脚本拼进
 *    单行 `-Command` 字符串会被 shell 先吃掉变量名（实测报
 *    `Missing type name after '['`）。这里一律走 `-EncodedCommand`（UTF-16LE + base64），
 *    连引号问题都没有。
 * 2. **AesGcm 在 PowerShell 5.1 里没有**（`New-Object System.Security.Cryptography.AesGcm`
 *    报 Cannot find type），所以只让 PowerShell 干 DPAPI 解封这一件事，
 *    AES-GCM 放 Node 侧做（`node:crypto` 一直有）。
 *
 * ## 失败一律「没有」，不抛给调用方
 *
 * 这里读的是**别人家 App** 的私有文件：App 没装、没登录、换了格式、DPAPI 换了
 * 作用域，全都不该让 qoder 渠道本身失败 —— 上层还有 PAT 兜底。所以对外
 * `readDesktopSession()` 只回 `session | undefined`，原因进日志。
 *
 * @module dsh-qoder-connect/desktop-vault
 */

import { execFile } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 会话文件里 `source` 的取值。判定「这个槽位是不是被桌面 App 占着」要用它。 */
export const DESKTOP_SOURCE = "qoder-cn-desktop:auth.v1.dat";

/** 密文魔数。Electron safeStorage 在 Windows/Linux 上都是这三字节。 */
const MAGIC = "v10";
/** safeStorage 的头长度：魔数 3 + nonce 12。 */
const HEADER_BYTES = 15;
/** GCM tag 长度。 */
const TAG_BYTES = 16;
/** 密钥长度（AES-256）。 */
const KEY_BYTES = 32;
/** DPAPI 解封失败时的提示：宿主上必须有 powershell.exe 或 pwsh。 */
const PS_MISSING = "powershell.exe 与 pwsh 都不可用";

/**
 * 桌面 App 的数据目录候选（按优先级）。
 *
 * 目前只实测过 Windows 那一条（`com.qodercn.app.stable`）；macOS / Linux 按
 * Electron 的 `app.getPath("userData")` 约定给几个候选，没实测过 ——
 * 读不到就是 undefined，不影响使用。
 */
export function desktopAppDirs() {
  const out = [];
  const appData = process.env.APPDATA;
  if (typeof appData === "string" && appData.length > 0) {
    out.push(join(appData, "com.qodercn.app.stable"));
    out.push(join(appData, "Qoder CN"));
    out.push(join(appData, "com.qoder.cn.app.stable"));
  }
  if (process.platform === "darwin") {
    const base = join(homedir(), "Library", "Application Support");
    out.push(join(base, "com.qodercn.app.stable"));
    out.push(join(base, "Qoder CN"));
  } else if (process.platform === "linux") {
    const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    out.push(join(base, "com.qodercn.app.stable"));
    out.push(join(base, "Qoder CN"));
  }
  return out;
}

/** 找到第一个含 `auth.v1.dat` 的 App 数据目录。 */
export function findDesktopVault() {
  for (const dir of desktopAppDirs()) {
    const authFile = join(dir, "auth.v1.dat");
    if (existsSync(authFile)) return { dir, authFile, localState: join(dir, "Local State") };
  }
  return undefined;
}

/** 把 `Local State` 里的 `os_crypt.encrypted_key` 读成 Buffer（含 5 字节 `DPAPI` 标记）。 */
export function readEncryptedKey(localStatePath) {
  const doc = JSON.parse(readFileSync(localStatePath, "utf8"));
  const encoded = doc?.os_crypt?.encrypted_key;
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new Error(`${localStatePath} 里没有 os_crypt.encrypted_key（App 可能还没登录过）`);
  }
  return Buffer.from(encoded, "base64");
}

/**
 * 用 DPAPI（CurrentUser）解封 32 字节 AES 主密钥。
 *
 * @param {Buffer} blob `os_crypt.encrypted_key` 的原文，**已含** `DPAPI` 标记
 * @returns {Promise<Buffer>} 32 字节密钥
 */
export async function unwrapKey(blob) {
  const marker = blob.subarray(0, 5).toString("latin1");
  if (marker !== "DPAPI") {
    // 不是 DPAPI 封装的（Linux basic_text，或已解封的裸密钥）—— 直接当密钥用。
    if (blob.length === KEY_BYTES) return blob;
    throw new Error(`os_crypt 密钥不是 DPAPI 封装（前 5 字节 = ${JSON.stringify(marker)}），也不是 ${KEY_BYTES} 字节裸密钥`);
  }
  const payload = blob.subarray(5).toString("base64");
  // 只让 PowerShell 解 DPAPI；AesGcm 在 PS 5.1 里不存在，所以密文解密留在 Node。
  const script = [
    "Add-Type -AssemblyName System.Security",
    `$b = [Convert]::FromBase64String('${payload}')`,
    `$raw = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')`,
    `[Convert]::ToBase64String($raw)`,
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
  let stdout;
  let lastError;
  for (const exe of ["powershell.exe", "pwsh"]) {
    try {
      ({ stdout } = await execFileAsync(exe, args, { timeout: 15000, windowsHide: true, encoding: "utf8" }));
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError !== undefined) {
    throw new Error(`DPAPI 解封失败（${PS_MISSING}）：${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
  const key = Buffer.from(String(stdout).trim(), "base64");
  if (key.length !== KEY_BYTES) throw new Error(`DPAPI 解出的密钥长度是 ${key.length}，期望 ${KEY_BYTES}`);
  return key;
}

/**
 * 解 `auth.v1.dat`：`v10`(3) ‖ nonce(12) ‖ ciphertext ‖ tag(16)。
 *
 * 纯函数，不碰文件系统 —— 自检脚本会拿它做加解密往返。
 */
export function decryptAuthBlob(blob, key) {
  if (!Buffer.isBuffer(blob)) throw new Error("auth.v1.dat 读出来不是 Buffer");
  if (blob.length <= HEADER_BYTES + TAG_BYTES) throw new Error(`auth.v1.dat 太短（${blob.length} 字节）`);
  const magic = blob.subarray(0, 3).toString("latin1");
  if (magic !== MAGIC) {
    throw new Error(`auth.v1.dat 魔数是 ${JSON.stringify(magic)}，只认 ${JSON.stringify(MAGIC)}`);
  }
  if (key.length !== KEY_BYTES) throw new Error(`AES 密钥长度是 ${key.length}，期望 ${KEY_BYTES}`);
  const nonce = blob.subarray(3, HEADER_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const body = blob.subarray(HEADER_BYTES, blob.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

/** 把 App 的明文文档收敛成插件自己的会话文件结构。 */
export function sessionFromDesktopDoc(doc) {
  const token = typeof doc?.token === "string" ? doc.token.trim() : "";
  const uid = typeof doc?.user?.id === "string" ? doc.user.id.trim() : "";
  if (token === "" || uid === "") return undefined;
  return {
    schemaVersion: 1,
    token,
    refreshToken: typeof doc?.refreshToken === "string" ? doc.refreshToken : "",
    refreshTokenExpiresAt: typeof doc?.refreshTokenExpiresAt === "string" ? doc.refreshTokenExpiresAt : "",
    expiresAt: typeof doc?.expiresAt === "string" ? doc.expiresAt : "",
    uid,
    name: typeof doc?.user?.name === "string" ? doc.user.name : "",
    email: typeof doc?.user?.email === "string" ? doc.user.email : "",
    source: DESKTOP_SOURCE,
  };
}

/**
 * 读桌面 App 的会话。读不到/解不开都返回 undefined（原因进日志）。
 *
 * 过期与否**不在这里判断** —— 交给 `createSessionStore` 用同一套 skew 规则，
 * 免得两处阈值漂移。
 *
 * @param {{logger?: {info?: Function, debug?: Function, warn?: Function}}} [options]
 */
export async function readDesktopSession(options = {}) {
  const { logger } = options;
  const vault = findDesktopVault();
  if (vault === undefined) {
    logger?.debug?.("dsh-qoder-connect: 没找到 Qoder CN 桌面 App 的 auth.v1.dat，跳过会话自动导入");
    return undefined;
  }
  let doc;
  try {
    const key = await unwrapKey(readEncryptedKey(vault.localState));
    doc = decryptAuthBlob(readFileSync(vault.authFile), key);
  } catch (error) {
    logger?.warn?.(`dsh-qoder-connect: 桌面 App 会话解密失败（可继续用 PAT）：${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  const session = sessionFromDesktopDoc(doc);
  if (session === undefined) {
    logger?.warn?.(`dsh-qoder-connect: ${vault.authFile} 里没有 token/user.id`);
    return undefined;
  }
  return { ...session, appDir: vault.dir };
}

/**
 * 这个 uid 是否已经被**另一个** qoder 槽位用桌面会话占着。
 *
 * 为什么要拦：桌面 App 只登一个号。若 qoder1 与 qoder2 都去导入，两个槽位会变成
 * **同一个账号** —— 池子里看着两份余额，实际上游并发限制按账号算，一个号被两个
 * 渠道同时打反而更容易撞限额。所以「谁先导入谁占」，后到的继续用自己的凭据。
 *
 * @param {{authDir: string, channelId: string, uid: string, now?: number}} options
 * @returns {string|undefined} 占用者渠道 id（没有就是 undefined）
 */
export function desktopClaimedBy(options) {
  const { authDir, channelId, uid } = options;
  const now = options.now ?? Date.now();
  let entries;
  try {
    entries = readdirSync(authDir);
  } catch {
    return undefined;
  }
  for (const file of entries) {
    const match = /^(qoder\d+)-session\.json$/.exec(file);
    if (match === null) continue;
    const otherId = match[1];
    if (otherId === channelId) continue;
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(authDir, file), "utf8"));
    } catch {
      continue;
    }
    if (doc?.uid !== uid) continue;
    // 只有「从桌面 App 导入的」才算占用：用户手工粘的 PAT 换来的会话不算。
    const fromDesktop = doc?.desktopUid === uid || (typeof doc?.source === "string" && doc.source.startsWith("qoder-cn-desktop"));
    if (!fromDesktop) continue;
    const expiresAt = typeof doc?.expiresAt === "string" ? Date.parse(doc.expiresAt) : Number.NaN;
    if (Number.isFinite(expiresAt) && expiresAt <= now) continue; // 对方也过期了，不算占用
    return otherId;
  }
  return undefined;
}

/**
 * 原子写会话文件（与 `shared/node.js` 的 writeState 同一套路：临时名 + rename）。
 *
 * 带上 `desktopUid` 字段：其它槽位靠它判定「这个桌面号已经有主了」。
 */
export function writeSessionFile(targetPath, session) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const doc = { ...session, desktopUid: session.uid, installedAt: new Date().toISOString() };
  const tmp = `${targetPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  renameSync(tmp, targetPath);
  return doc;
}
