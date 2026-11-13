#!/usr/bin/env node
/**
 * Gemini OAuth2 登录 CLI —— 复用 Google AI Pro 订阅（Code Assist 通道），完全不绑卡。
 *
 * 用法：
 *   node scripts/gemini-oauth-login.mjs                 # 起 loopback、自动开浏览器、等待回调
 *   node scripts/gemini-oauth-login.mjs --no-browser   # 只打印链接，手动打开/粘贴回调 URL
 *   node scripts/gemini-oauth-login.mjs --port 11365   # 指定 DSH GUI 端口（登录后清熔断用）
 *   node scripts/gemini-oauth-login.mjs --logout       # 删除本地 OAuth 凭据，回到 apikey 模式
 *
 * 流程：
 *   startGeminiLogin() 起本机随机端口 loopback + PKCE，拼 Google 授权 URL
 *   → 自动开浏览器（Windows start / macOS open / xdg-open），用户登录 Google 账号
 *   → 回调 http://127.0.0.1:<port>/oauth2callback?code=…&state=… 自动换取 token
 *   → 凭据写入 ~/.dsh/gemini-oauth.json（refresh_token 长期有效，自动刷新）
 *   → getCodeAssistProjectId() 确认账号确有 Code Assist 额度并解析 project
 *   → 清 gemini 路由熔断（若 GUI 在线），无需等 10 分钟冷却
 *
 * 无浏览器兜底：脚本也监听 stdin，把回调 URL 或授权 code 粘贴进来回车即可。
 *
 * 凭证零输出：全程不打印 access_token / refresh_token / client_secret / code。
 */
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_DIR = "C:/Users/00/Documents/the coding assistant/驼峰插件/dsh-camel-pool/lib/providers/gemini";
const {
  startGeminiLogin,
  submitGeminiLoginCode,
  cancelGeminiLogin,
  waitForGeminiLogin,
  geminiAuthStatus,
  readOAuthAccessToken,
} = await import("file:///" + PLUGIN_DIR + "/index.js");
const { getCodeAssistProjectId } = await import("file:///" + PLUGIN_DIR + "/oauth.js");

const args = process.argv.slice(2);
const noBrowser = args.includes("--no-browser");
const logout = args.includes("--logout");
const portFlag = args.indexOf("--port");
const guiPort = portFlag !== -1 ? Number(args[portFlag + 1]) : Number(process.env.DSH_GUI_PORT || 11365);

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

if (logout) {
  const p = path.join(dshHome(), "gemini-oauth.json");
  const pj = path.join(dshHome(), "gemini-ca-project.json");
  try { fs.unlinkSync(p); } catch {}
  try { fs.unlinkSync(pj); } catch {}
  console.log("已删除本地 Gemini OAuth 凭据与项目缓存，回到 apikey 模式。");
  console.log("（apikey 模式需项目绑卡；重新运行本脚本可再次用订阅登录。）");
  process.exit(0);
}

function openBrowser(url) {
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const argv = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    execFile(cmd, argv, { detached: true, stdio: "ignore" }, () => {});
  } catch {}
}

async function clearBreakers() {
  try {
    const r = await fetch(`http://127.0.0.1:${guiPort}/plugins/dsh-pool/breakers?route=gemini`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      console.log("[OK]  已清 gemini 路由熔断（cleared=" + (j.cleared ?? "?") + "），无需等 10 分钟冷却。");
    } else {
      console.log("[..]  GUI 未在线或端点未加载，跳过清熔断（可稍后手动 POST breakers?route=gemini）。");
    }
  } catch {
    console.log("[..]  GUI 未在线（端口 " + guiPort + " 不通或已重启换端口），跳过清熔断。");
  }
}

console.log("=== Gemini OAuth2 登录（复用 Google AI Pro 订阅，不绑卡）===");
const info = await startGeminiLogin();
console.log("\n1) 在浏览器打开下面链接，登录你的 Google 账号并授权：\n");
console.log(info.authUrl);
console.log("\n   本地回调：" + info.redirectUri + "（state 已内置校验，PKCE S256）");
console.log("   代理隧道：" + (info.proxy?.mode === "proxy" ? info.proxy.host + ":" + info.proxy.port : "直连"));
if (!noBrowser) {
  openBrowser(info.authUrl);
  console.log("   （已尝试自动打开默认浏览器）");
}
console.log("\n2) 授权后浏览器会跳到 Google 成功页；若浏览器没起来/回调被拦，");
console.log("   把完整回调 URL 或授权 code 复制到这里回车即可（手输兜底）：\n");

// Browser callback and manual stdin paste race each other.
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const manual = new Promise((resolve) => {
  rl.once("line", (line) => resolve({ type: "manual", line }));
});

let outcome = null;
try {
  const race = await Promise.race([
    waitForGeminiLogin(15 * 60 * 1000).then((v) => ({ type: "callback", v })),
    manual,
  ]);
  if (race.type === "manual") {
    const line = race.line.trim();
    if (line) {
      const res = await submitGeminiLoginCode(line);
      outcome = { ok: res.ok };
    } else {
      outcome = { ok: false, reason: "empty-input" };
    }
  } else {
    outcome = race.v;
  }
} catch (e) {
  outcome = { ok: false, reason: e.message };
} finally {
  rl.close();
}

if (!outcome?.ok) {
  cancelGeminiLogin();
  console.error("\n[BAD] 登录未完成：" + (outcome?.reason || "未知原因"));
  console.error("      重新运行本脚本再试；账号需有 Google AI Pro / Code Assist 订阅资格。");
  process.exit(1);
}

console.log("\n[OK]  Google 授权完成，凭据已写入 " + path.join(dshHome(), "gemini-oauth.json"));

// Verify the account actually has Code Assist access and resolve the project.
try {
  const token = await readOAuthAccessToken();
  const projectId = await getCodeAssistProjectId(token);
  console.log("[OK]  Code Assist 通道可用，cloudaicompanionProject=" + projectId);
} catch (e) {
  console.error("[BAD] Code Assist 解析失败：" + String(e.message).slice(0, 400));
  console.error("      账号可能没有 Gemini Code Assist / Google AI Pro 资格，或未同意相关条款。");
  process.exit(1);
}

await clearBreakers();

const st = geminiAuthStatus();
console.log("\n=== 登录态（零密文）===");
console.log(JSON.stringify(st, null, 2));
console.log("\n完成。现在 DSH 模型下拉选 gemini-* 即走订阅通道；用 gemini-oauth-check.mjs 端到端复验。");
process.exit(0);
