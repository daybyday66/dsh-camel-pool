/**
 * Trae 桌面端登录态的读取与凭据落盘 —— 纯 node:crypto，无外部依赖。
 *
 * 为什么插件自己也要实现一份（scripts/trae-vault.mjs 里已经有一份）：
 * 脚本是离线工具，只能在宿主机上手工跑；而 keepalive 需要在插件进程里
 * 随时把桌面端的活登录态读出来（自动 adopt）。把加密内核搬进 lib/ 之后，
 * 插件不再依赖「用户记得去跑脚本」这个前提。
 *
 * 与 scripts/trae-vault.mjs 的常量逐字一致（同一份 byteCrypto 表），
 * 两边任何一处漂移都会让 unseal 返回 null 而不是解析失败的明文。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// ── byteCrypto 常量（来自 main.js 的 out-build/vs/base/common/byteCrypto.js）──
const JOE = Buffer.from([191,192,216,250,122,246,220,97,31,254,98,27,8,72,71,176,135,99,96,18,127,101,203,104,211,102,191,125,37,72,150,156,51,229,121,35,17,153,141,177,110,131,150,128,172,255,254,6,18,140,55,62,236,249,135,64,135,12,117,4,89,149,168,209]);
const HOE = Buffer.from([246,204,26,232,232,70,129,109,223,146,169,242,23,241,105,145,50,196,165,42,254,120,3,54,244,207,209,85,53,6,138,106,175,148,31,204,186,186,165,182,87,142,49,10,39,110,26,154,86,56,173,125,18,64,198,225,99,99,83,82,191,134,76,170]);
const WOE = Buffer.from([82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37]);
const VOE = Buffer.from([31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125]);

const HDR = Buffer.from([116, 99, 5, 16, 0, 0]);
const MAGIC = "dGMF";
const U_LEN = 32;
const H_LEN = 64;
const MODE_AES = 1;

const sha512 = (b) => createHash("sha512").update(b).digest();

function mask(n, mode) {
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = mode === MODE_AES ? WOE[i] ^ VOE[i] : JOE[i] ^ HOE[i];
  return out;
}

function kdf(key32, mode = MODE_AES) {
  const n = Buffer.alloc(H_LEN + 64);
  n.set(sha512(key32), 0);
  n.set(mask(64, mode), H_LEN);
  n.set(sha512(n), 0);
  return { aesKey: n.subarray(0, 16), iv: n.subarray(16, 32) };
}

export function seal(plain) {
  const pt = Buffer.from(plain, "utf8");
  const key32 = randomBytes(U_LEN);
  const { aesKey, iv } = kdf(key32);
  const body = Buffer.alloc(H_LEN + pt.length);
  body.set(sha512(pt), 0);
  body.set(pt, H_LEN);
  const c = createCipheriv("aes-128-cbc", aesKey, iv);
  return Buffer.concat([HDR, key32, c.update(body), c.final()]).toString("base64");
}

export function unseal(b64) {
  if (typeof b64 !== "string" || !b64.startsWith(MAGIC)) return null;
  const blob = Buffer.from(b64, "base64");
  if (blob.length < HDR.length + U_LEN + 16 || !blob.subarray(0, 6).equals(HDR)) return null;
  const { aesKey, iv } = kdf(blob.subarray(6, 6 + U_LEN));
  let pt;
  try {
    const d = createDecipheriv("aes-128-cbc", aesKey, iv);
    pt = Buffer.concat([d.update(blob.subarray(6 + U_LEN)), d.final()]);
  } catch {
    return null;
  }
  return sha512(pt.subarray(H_LEN)).equals(pt.subarray(0, H_LEN)) ? pt.subarray(H_LEN).toString("utf8") : null;
}

/** 桌面端数据目录（win32 用 APPDATA，其它平台按 Electron 的约定）。 */
export function appSupportDir(dirName) {
  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(base, dirName);
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", dirName);
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, dirName);
}

/** Trae 两个产品变体的数据目录名。 */
export const DESKTOP_APP_DIRS = { cn: "Trae CN", solo: "TRAE SOLO CN" };

export function storagePath(appDir) {
  return join(appSupportDir(appDir), "User", "globalStorage", "storage.json");
}

/**
 * 读出桌面端 storage.json 里的登录态。
 *
 * 失败时返回 { file, error }，成功时返回 { file, session, deviceId, keyPair, machineId }。
 * 调用方要靠 error 文案区分「这台机器没装 Trae」与「装了但从没登录」，
 * 这两种情况的处理完全不同（前者永远 adopt 不到，后者只需去登一次）。
 */
export function readDesktopSession(appDir) {
  const file = storagePath(appDir);
  if (!existsSync(file)) return { file, error: "找不到 storage.json（该产品未安装或从未登录过）" };
  let vault;
  try {
    vault = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { file, error: "storage.json 不是合法 JSON：" + (error instanceof Error ? error.message : String(error)) };
  }
  const entry = vault["iCubeAuthInfo://icube.cloudide"];
  if (typeof entry !== "string") return { file, error: "storage.json 里没有 iCubeAuthInfo://icube.cloudide 条目" };
  let session;
  try {
    const plain = unseal(entry);
    if (plain === null) throw new Error("unseal 返回 null（校验位不通过）");
    session = JSON.parse(plain);
  } catch (error) {
    return { file, error: "桌面登录态解密失败（byteCrypto 常量表可能已随版本变化）：" + (error instanceof Error ? error.message : String(error)) };
  }
  if (typeof session.token !== "string" || session.token.length === 0) return { file, error: "解密结果里没有 token" };
  let deviceId;
  let keyPair;
  for (const key of Object.keys(vault)) {
    const match = /^iCubeAuthInfo:\/\/icube-dc:(.+)$/.exec(key);
    if (!match) continue;
    deviceId = match[1];
    const plain = unseal(vault[key]);
    if (plain === null) continue;
    try {
      const pair = JSON.parse(plain);
      if (typeof pair.privateKeyPEM === "string" && typeof pair.publicKeyPEM === "string") keyPair = pair;
    } catch { /* 这一条不是密钥对，跳过 */ }
  }
  const machineId = typeof vault["telemetry.machineId"] === "string" ? vault["telemetry.machineId"] : undefined;
  return { file, session, deviceId, keyPair, machineId };
}

/**
 * 原子写凭据快照（0600）。
 *
 * 为什么必须原子：巡检每 30 秒重读一次这个文件，直接覆盖会让对方读到半截
 * JSON —— 那会被 store.resolve() 判成「未登录」，面板上就是一次假掉线。
 */
export function writeCredentialFile(path, doc) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + "." + process.pid + "." + Date.now() + ".tmp";
  writeFileSync(tmp, JSON.stringify(doc, null, 1) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}
