#!/usr/bin/env node
/**
 * scripts/gh-push.mjs — 把本地提交同步到 GitHub。
 *
 * 背景：本机 github.com:443 常被阻断（TIMEOUT / Connection reset），而 api.github.com 可用。
 * 策略：
 *   1. 先试原生 git push（清空代理环境变量）；成功即结束。
 *   2. 失败则走 GitHub Git Data API：blob -> tree -> commit 链 -> PATCH ref。
 *   3. 提交对象按本地原始字节（git cat-file commit 的 body）重建，因此远端 SHA 与本地一致，
 *      下一次同步可以走增量（rev-list remote..HEAD），不需要强推。
 *
 * token 来源（优先级）：$GH_TOK > ~/.dsh/camel-pool-gh.token（或 $GH_TOKEN_FILE 指定路径）。
 *
 * 用法：
 *   node scripts/gh-push.mjs            # 正常输出
 *   node scripts/gh-push.mjs --quiet    # 静默（git hook 用）
 *   SKIP_GIT_PUSH=1 node scripts/gh-push.mjs   # 跳过 git push，直接走 API
 */
import { execFileSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lookup as dnsLookup, resolve4 } from "node:dns";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const QUIET = process.argv.includes("--quiet");
const log = (...a) => { if (!QUIET) console.log(...a); };
// quiet 模式也要留痕：钩子把输出重定向到 ~/.dsh/gh-sync.log
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
    p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
};
const note = (...a) => console.log(stamp() + "  " + a.join(" "));

const git = (args, opts = {}) => execFileSync("git", args, { cwd: ROOT, maxBuffer: 1 << 28, ...opts }).toString();

function noProxyEnv() {
  const env = { ...process.env };
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NODE_USE_ENV_PROXY"]) delete env[k];
  return env;
}

function readToken() {
  if (process.env.GH_TOK) return process.env.GH_TOK.trim();
  const cands = [process.env.GH_TOKEN_FILE, join(homedir(), ".dsh", "camel-pool-gh.token")].filter(Boolean);
  for (const p of cands) if (existsSync(p)) return readFileSync(p, "utf8").trim();
  throw new Error("缺少 GitHub token：设置 GH_TOK，或写入 ~/.dsh/camel-pool-gh.token");
}

function repoInfo() {
  const url = git(["remote", "get-url", "origin"]).trim();
  const m = /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(url);
  if (!m) throw new Error("origin 不是 GitHub 仓库：" + url);
  return { full: m[1] + "/" + m[2] };
}

/**
 * 直连 api.github.com，**绕开 hosts 文件**。
 *
 * 本机 hosts 被 Steam++（Watt Toolkit）写进了 29 条 `127.0.0.1 api.github.com`
 * 之类的屏蔽项，于是 `fetch("https://api.github.com/...")` 会连到本机 443 ——
 * 表现就是 `同步失败：fetch failed`，看起来像"网络不通"，其实是解析被改写了。
 * Node 的 fetch（undici）没有暴露 custom lookup，所以这里改用手写 https 请求：
 * 用 DNS 服务器重新解析真实 IP，再把它钉进 `lookup`。
 *
 * 解析失败时退回系统解析（等于保持原行为），不会比原来更差。
 */
const resolvedHosts = new Map();
/**
 * 拿真实 IP。**必须用 dns.resolve4**：它直接问 DNS 服务器，不读 hosts；
 * dns.lookup 走 getaddrinfo，会被 hosts 里那 29 条 `127.0.0.1 api.github.com`
 * 带偏 —— 那样虽然拿到了 127.x 我们自己会过滤，但退回 lookup 还是 127，白绕。
 */
function pinAddress(hostname) {
  if (resolvedHosts.has(hostname)) return resolvedHosts.get(hostname);
  const pending = new Promise((resolve) => {
    resolve4(hostname, (error, addresses) => {
      const address = error || !Array.isArray(addresses) ? undefined : addresses.find((item) => !item.startsWith("127."));
      if (address !== undefined) return resolve(address);
      dnsLookup(hostname, { family: 4, all: false }, (fallbackError, fallback) => {
        if (fallbackError || typeof fallback !== "string" || fallback.startsWith("127.")) resolve(undefined);
        else resolve(fallback);
      });
    });
  });
  resolvedHosts.set(hostname, pending);
  return pending;
}

function httpsJson(url, init) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    pinAddress(target.hostname).then((address) => {
      const headers = { ...(init && init.headers ? init.headers : {}) };
      /**
       * 拿到真实 IP 时用 `host: <ip>` + `servername: <域名>` 的写法，
       * 而不是给 Agent 传 `lookup` 回调。
       *
       * 实测（Node 22 + Windows schannel）：走 lookup 回调会报
       * `Invalid IP address: undefined` —— 那个三参回调在 TLS 建立路径上拿到的
       * options 里 family/all 混着传，返回值被丢掉。改成直接把 IP 当 host，
       * 用 servername 做 SNI + 证书校验，等价且不碰那套回调。
       */
      const req = httpsRequest({
        host: address === undefined ? target.hostname : address,
        port: Number(target.port === "" ? 443 : target.port),
        path: target.pathname + target.search,
        method: (init && init.method) || "GET",
        servername: target.hostname,
        headers: { ...headers, host: target.hostname },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.setTimeout(60000, () => req.destroy(new Error("api.github.com 请求超时（60s）")));
      if (init && init.body !== undefined) req.write(init.body);
      req.end();
    }, reject);
  });
}

async function api(path, init, token) {
  const res = await httpsJson("https://api.github.com" + path, {
    method: (init && init.method) || "GET",
    body: init && init.body,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "dsh-camel-pool-sync",
      ...(init && init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const text = res.text;
  let doc;
  try { doc = JSON.parse(text); } catch { doc = text; }
  if (res.status < 200 || res.status >= 300) throw new Error(path + " -> " + res.status + " " + JSON.stringify(doc).slice(0, 300));
  return doc;
}

function tryGitPush() {
  if (process.env.SKIP_GIT_PUSH === "1") return false;
  try {
    execFileSync("git", ["-c", "http.proxy=", "-c", "https.proxy=", "push", "origin", "HEAD:main"], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], timeout: 25000, env: {
        ...noProxyEnv(),
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        GIT_ASKPASS: "echo",
        SSH_ASKPASS: "echo",
      },
    });
    return true;
  } catch {
    return false;
  }
}

function splitCommit(sha) {
  const raw = execFileSync("git", ["cat-file", "commit", sha], { cwd: ROOT, maxBuffer: 1 << 28 }).toString();
  const i = raw.indexOf("\n\n");
  const meta = raw.slice(0, i);
  const body = raw.slice(i + 2);
  const pick = (re) => { const m = re.exec(meta); return m ? m[1] : undefined; };
  return {
    body,
    tree: pick(/^tree ([0-9a-f]+)$/m),
    authorName: pick(/^author ([^<]*) </m)?.trim(),
    authorEmail: pick(/^author [^<]*<([^>]*)>/m),
    authorDate: pick(/^author .*> (\d+ [+-]\d{4})$/m),
    committerName: pick(/^committer ([^<]*) </m)?.trim(),
    committerEmail: pick(/^committer [^<]*<([^>]*)>/m),
    committerDate: pick(/^committer .*> (\d+ [+-]\d{4})$/m),
  };
}

const toIso = (gitDate) => {
  const [secs, tz] = gitDate.split(" ");
  const sign = tz[0] === "-" ? -1 : 1;
  const offMin = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  const utc = (Number(secs) - offMin * 60) * 1000;
  const local = new Date(utc + offMin * 60 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return local.getFullYear() + "-" + p(local.getMonth() + 1) + "-" + p(local.getDate()) + "T" +
    p(local.getHours()) + ":" + p(local.getMinutes()) + ":" + p(local.getSeconds()) +
    (offMin >= 0 ? "+" : "-") + p(Math.floor(Math.abs(offMin) / 60)) + ":" + p(Math.abs(offMin) % 60);
};

const modeOf = (sha, path) => {
  const out = git(["ls-tree", sha, "--", path]).trim();
  return out ? out.split(" ")[0] : "100644";
};

async function uploadBlob(sha, token, full, cache) {
  if (cache.has(sha)) return cache.get(sha);
  const buf = execFileSync("git", ["cat-file", "blob", sha], { cwd: ROOT, maxBuffer: 1 << 28 });
  const made = await api("/repos/" + full + "/git/blobs", { method: "POST", body: JSON.stringify({ content: buf.toString("base64"), encoding: "base64" }) }, token);
  cache.set(sha, made.sha);
  return made.sha;
}

async function buildTree(commitSha, parentSha, baseTree, token, full, cache) {
  if (baseTree === null) {
    const rows = git(["ls-tree", "-r", commitSha]).trim().split("\n").filter(Boolean);
    const entries = [];
    for (const row of rows) {
      const tab = row.indexOf("\t");
      const [mode, type, sha] = row.slice(0, tab).split(" ");
      const path = row.slice(tab + 1);
      entries.push({ path, mode, type, sha: type === "blob" ? await uploadBlob(sha, token, full, cache) : sha });
    }
    return (await api("/repos/" + full + "/git/trees", { method: "POST", body: JSON.stringify({ tree: entries }) }, token)).sha;
  }
  const diff = git(["diff", "--name-status", parentSha, commitSha]).trim();
  if (!diff) return baseTree;
  const entries = [];
  for (const line of diff.split("\n")) {
    const [status, ...rest] = line.split("\t");
    if (status.startsWith("R") || status.startsWith("C")) {
      const [from, to] = rest;
      entries.push({ path: from, mode: "100644", type: "blob", sha: null });
      const sha = git(["rev-parse", commitSha + ":" + to]).trim();
      entries.push({ path: to, mode: modeOf(commitSha, to), type: "blob", sha: await uploadBlob(sha, token, full, cache) });
      continue;
    }
    const path = rest[0];
    if (status === "D") { entries.push({ path, mode: "100644", type: "blob", sha: null }); continue; }
    const sha = git(["rev-parse", commitSha + ":" + path]).trim();
    entries.push({ path, mode: modeOf(commitSha, path), type: "blob", sha: await uploadBlob(sha, token, full, cache) });
  }
  if (!entries.length) return baseTree;
  return (await api("/repos/" + full + "/git/trees", { method: "POST", body: JSON.stringify({ base_tree: baseTree, tree: entries }) }, token)).sha;
}

/**
 * 远端有本地没有的提交（别处推过、或远端被强推过）时的快速路径：
 * 把本地 HEAD 的完整树挂到远端最新提交上，做成一个 graft 提交，避免把本地全部历史重建成根提交链。
 * 只上传与远端内容不同的 blob，其余按内容寻址直接复用，因此耗时与改动量成正比，而不是仓库体积。
 */
async function graftHead({ full, token, headSha, remoteSha }) {
  log("远端有本地没有的提交，按 HEAD 内容 graft 到 " + remoteSha.slice(0, 8) + "…");
  /**
   * 必须用 commit 的 tree.sha，不能用 commit sha 去请求 /git/trees：GitHub 对
   * `/git/trees/<commit>` 会把对象的 sha 原样回显成 commit sha，拿这个值当
   * base_tree / 新提交的 tree 就报 422 "Tree SHA is not a tree object"。
   */
  const remoteCommit = await api("/repos/" + full + "/git/commits/" + remoteSha, {}, token);
  const remoteTreeSha = remoteCommit.tree.sha;
  const remoteTree = await api("/repos/" + full + "/git/trees/" + remoteTreeSha + "?recursive=1", {}, token);
  /**
   * GitHub 的 recursive=1 在大仓库上会截断（truncated: true）。截断时 remoteBlobs 不全，
   * 「远端有、本地没有」的判定就会漏掉真实存在的路径 —— 表现出来是远端残留旧文件而脚本
   * 自称同步成功。宁可中止，也不要把不完整的树当完整树用。
   */
  if (remoteTree.truncated) {
    throw new Error("远端树被 GitHub 截断（truncated=true），无法可靠判定待删除路径；请先在本机 git fetch origin 取回远端历史后重试");
  }
  const remoteBlobs = new Map();
  for (const item of remoteTree.tree ?? []) {
    if (item.type === "blob") remoteBlobs.set(item.path, item.sha);
  }
  const local = new Map();
  for (const row of git(["ls-tree", "-r", headSha]).trim().split("\n").filter(Boolean)) {
    const tab = row.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, sha] = row.slice(0, tab).split(" ");
    if (type === "blob") local.set(row.slice(tab + 1), { mode, sha });
  }
  const entries = [];
  const cache = new Map();
  let reused = 0;
  let uploaded = 0;
  for (const [path, info] of local) {
    if (remoteBlobs.get(path) === info.sha) {
      reused += 1;
      continue;
    }
    entries.push({ path, mode: info.mode, type: "blob", sha: await uploadBlob(info.sha, token, full, cache) });
    uploaded += 1;
  }
  /**
   * 删除条目（sha: null）**必须配 base_tree**。GitHub 的 create-tree 接口在没有
   * base_tree 时把所有条目当成「从空树新建」，遇到 sha: null 就报
   * 422 GitRPC::BadObjectState —— 历史 graft 全是「只加不改不删」所以从没暴露，
   * 直到有一次提交删掉了误提交的临时文件才炸。
   * 带上 base_tree 之后复用条目也可以省略，graft 只发差量。
   */
  for (const path of remoteBlobs.keys()) {
    if (!local.has(path)) entries.push({ path, mode: "100644", type: "blob", sha: null });
  }
  const tree = entries.length === 0
    ? remoteTreeSha
    : (await api("/repos/" + full + "/git/trees", {
      method: "POST",
      body: JSON.stringify({ base_tree: remoteTreeSha, tree: entries }),
    }, token)).sha;
  const parts = splitCommit(headSha);
  const made = await api("/repos/" + full + "/git/commits", {
    method: "POST",
    body: JSON.stringify({
      message: parts.body,
      tree,
      parents: [remoteSha],
      author: { name: parts.authorName, email: parts.authorEmail, date: toIso(parts.authorDate) },
      committer: { name: parts.committerName, email: parts.committerEmail, date: toIso(parts.committerDate) },
    }),
  }, token);
  await api("/repos/" + full + "/git/refs/heads/main", { method: "PATCH", body: JSON.stringify({ sha: made.sha, force: true }) }, token);
  note("main -> " + made.sha.slice(0, 8) + "（graft：复用 " + reused + " 个 blob，上传 " + uploaded + " 个）");
}

/**
 * 推前硬闸：git 说干净、盘上却与 HEAD 不同（等长编辑触发 stat-cache racy）时，
 * 直接推会把**旧内容**发出去 —— 本轮 ux-v49 就是这么丢的 patch 标记与版本号。
 * 由 check-index-fresh.mjs --strict 判定，失败即中止同步。
 */
function assertIndexFresh() {
  execFileSync(process.execPath, [join(ROOT, "scripts", "check-index-fresh.mjs"), "--strict"], {
    cwd: ROOT, stdio: "inherit",
  });
}

async function main() {
  assertIndexFresh();
  const { full } = repoInfo();
  const token = readToken();
  const headSha = git(["rev-parse", "HEAD"]).trim();
  // graft 用 git cat-file 读本地 blob；浅 clone 里缺失的历史 blob 会让上传报 not our ref。
  if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    note("提示：当前是浅 clone，graft 需要的历史 blob 可能取不到；建议先 git fetch --unshallow 再同步");
  }

  if (tryGitPush()) {
    note("同步完成（git push）：" + headSha.slice(0, 8));
    try { git(["update-ref", "refs/remotes/origin/main", headSha]); } catch {}
    return;
  }
  log("git push 不可用，改走 GitHub API…");

  const ref = await api("/repos/" + full + "/git/ref/heads/main", {}, token);
  const remoteSha = ref.object.sha;
  if (remoteSha === headSha) { note("远端已是最新：" + headSha.slice(0, 8)); return; }

  let known = false;
  try { git(["cat-file", "-e", remoteSha + "^{commit}"], { stdio: ["pipe", "pipe", "pipe"] }); known = true; } catch { known = false; }
  if (!known) {
    // 本地没有远端最新提交（别处推过 / 远端被强推）：先看内容是否已经一致
    // —— graft 出来的提交 SHA 必然与本地不同，内容相同还要再建一棵相同的树纯属浪费。
    const headTree = git(["rev-parse", headSha + "^{tree}"]).trim();
    const remoteTreeNow = (await api("/repos/" + full + "/git/commits/" + remoteSha, {}, token)).tree.sha;
    if (remoteTreeNow === headTree) {
      try { git(["update-ref", "refs/remotes/origin/main", remoteSha]); } catch {}
      note("远端内容已与本地一致（SHA 分叉：远端 " + remoteSha.slice(0, 8) + "，本地 " + headSha.slice(0, 8) + "），无需再 graft");
      return;
    }
    // 重建整条历史既慢又会在根提交上崩，直接把 HEAD 的树 graft 到远端 HEAD 上，只上传有差异的 blob。
    await graftHead({ full, token, headSha, remoteSha });
    const after = await api("/repos/" + full + "/git/ref/heads/main", {}, token);
    if (after.object.sha === headSha) {
      try { git(["update-ref", "refs/remotes/origin/main", headSha]); } catch {}
      note("本地/远端 SHA 一致，下次可增量同步");
    } else {
      log("提示：远端 SHA 与本地不同（graft 提交），下次仍走 graft 快速路径");
    }
    return;
  }
  const range = [remoteSha + "..HEAD"];
  const commits = git(["rev-list", "--reverse", ...range]).trim().split("\n").filter(Boolean);
  if (!commits.length) { log("没有需要同步的提交"); return; }

  let parentRemote = remoteSha;
  let baseTree = (await api("/repos/" + full + "/git/commits/" + remoteSha, {}, token)).tree.sha;

  const cache = new Map();
  const remoteShas = [];
  for (const sha of commits) {
    const parts = splitCommit(sha);
    let parentLocalSha = null;
    try { parentLocalSha = git(["rev-parse", sha + "^"]).trim(); } catch { parentLocalSha = null; }
    const tree = await buildTree(sha, parentLocalSha, baseTree === null ? null : baseTree, token, full, cache);
    const made = await api("/repos/" + full + "/git/commits", {
      method: "POST",
      body: JSON.stringify({
        message: parts.body,
        tree,
        parents: parentRemote ? [parentRemote] : [],
        author: { name: parts.authorName, email: parts.authorEmail, date: toIso(parts.authorDate) },
        committer: { name: parts.committerName, email: parts.committerEmail, date: toIso(parts.committerDate) },
      }),
    }, token);
    if (made.sha !== sha) log("  注意：" + sha.slice(0, 8) + " -> " + made.sha.slice(0, 8) + "（远端 SHA 与本地不同）");
    parentRemote = made.sha;
    baseTree = tree;
    remoteShas.push([sha, made.sha]);
    log("  已上传 " + sha.slice(0, 8) + "  " + parts.body.split("\n")[0].slice(0, 48));
  }

  await api("/repos/" + full + "/git/refs/heads/main", { method: "PATCH", body: JSON.stringify({ sha: parentRemote, force: false }) }, token);
  note("main -> " + parentRemote.slice(0, 8) + "（" + commits.length + " 个提交）");

  const aligned = remoteShas.every(([l, r]) => l === r);
  if (aligned) {
    try { git(["update-ref", "refs/remotes/origin/main", parentRemote]); } catch {}
    note("本地/远端 SHA 一致，下次可增量同步");
  } else {
    log("提示：本地与远端 SHA 有差异（提交消息字节不同），下次将回退为全量重建");
  }
}

main().catch((e) => { console.error("同步失败：" + (e && e.message ? e.message : e)); process.exitCode = 1; });