#!/usr/bin/env node
// verify-uxv14-live.mjs —— 宿主重启后的实机回归（只在真有账号/宿主时跑）。
//
// 用法: node scripts/verify-uxv14-live.mjs [PORT]
//   不传 PORT 时自动在最近出现过的宿主端口里找活的那个（宿主每次重启端口都会变，
//   13836 / 10679 / 13347 / 6854 / 10233 都当过端口，写死一个必然过两天就失效）。
//
// 与 check-pool-core.mjs 的分工：那个用假路由证明内核逻辑对，这个证明
// 「宿主真的加载了新代码」——静态断言全绿也可能只是磁盘改了、进程还跑着旧模块。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./_paths.mjs";

const PATH = "/plugins/dsh-pool/status";
// 期望的 patch 从源码里读，不写死：写死的话每次升 patch 都要回来改一行，
// 忘了改就是「脚本红了但其实一切正常」——和它要防的「磁盘改了进程还是旧的」一样糟。
const ROOT = repoRoot(process.argv[3]);
function expectedPatch() {
  try {
    const src = fs.readFileSync(path.join(ROOT, "lib", "providers", "pool", "index.js"), "utf8");
    return (src.match(/patch:\s*"(ux-v\d+)"/) || [])[1] || "";
  } catch { return ""; }
}
const EXPECTED_PATCH = expectedPatch();
const KNOWN_PORTS = [13836, 10679, 13347, 6854, 10233, 9229];
const EXPLICIT = Number(process.argv[2]) || Number(process.env.PORT) || 0;

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, timeout: 15000 }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

let failed = 0;
function ok(label, cond, extra) {
  if (cond) { console.log("[live] ok: " + label); return; }
  failed += 1;
  console.error("[live] FAIL: " + label + (extra === undefined ? "" : "  " + JSON.stringify(extra)));
}

/** 先从当前 GUI 地址栏传的端口取，没传就扫已知端口找活的池端点。 */
async function connect() {
  const tried = [];
  for (const port of EXPLICIT ? [EXPLICIT] : KNOWN_PORTS) {
    try {
      const res = await get(port, PATH);
      if (res.status === 200) {
        if (!EXPLICIT) console.log("[live] 自动发现宿主端口 " + port);
        return { port, res };
      }
      tried.push(port + "→HTTP " + res.status);
    } catch (error) {
      tried.push(port + "→" + (error.code || error.message));
    }
  }
  console.error("[live] 找不到活着的宿主端点：" + tried.join(", "));
  console.error("       要么宿主没开，要么端口在别处 —— 从 GUI 地址栏取端口后作为第一个参数传入。");
  process.exit(2);
}

const { port: PORT, res } = await connect();
ok("状态接口可达 (" + res.status + " @ " + PORT + ")", res.status === 200, res.body.slice(0, 200));

let doc;
try {
  doc = JSON.parse(res.body);
} catch {
  console.error("[live] 响应不是 JSON");
  process.exit(2);
}

ok(
  "内核标记与源码一致（源码 " + (EXPECTED_PATCH || "?") + "，宿主 " + (doc.patch || "?") + "）" +
    (doc.patch === EXPECTED_PATCH ? "" : " —— 宿主仍在跑旧模块，重启宿主后再验"),
  Boolean(EXPECTED_PATCH) && doc.patch === EXPECTED_PATCH,
  { live: doc.patch, source: EXPECTED_PATCH },
);

const routes = doc.pool?.routes ?? [];
ok("路由表非空", routes.length > 0, routes.length);

// ① 每一条有当日桶的路由都必须把 expiring / expiringAt 报出来
for (const row of routes) {
  if (typeof row.expiring !== "number") continue;
  ok(row.key + " expiring=" + row.expiring + " 带 expiringAt", typeof row.expiringAt === "string" && row.expiringAt.length > 0, row.expiringAt);
  ok(row.key + " 有当日桶时 expiry 应等于当日过期时刻", row.expiry === row.expiringAt, { expiry: row.expiry, expiringAt: row.expiringAt });
}

// ② 排序不在这里断言。pool.routes[] 是注册表顺序（按 priority 排的静态表），
//    真正的派发顺序是 orderedRoutesFor(modelId) 每个模型各算一次，状态接口不暴露。
//    那一层由 check-pool-core.mjs 用假路由验（确定性、可复现），实机这里只验字段。
for (const row of routes) {
  if (typeof row.expiring === "number" && row.expiring <= 0) {
    ok(row.key + " expiring<=0 时不应带该字段", false, row.expiring);
  }
}

if (failed > 0) {
  console.error("\nverify-uxv14-live: " + failed + " 项失败");
  process.exit(1);
}
console.log("\nverify-uxv14-live: 全部通过（内核 " + doc.patch + " 已在线，与源码一致）");
