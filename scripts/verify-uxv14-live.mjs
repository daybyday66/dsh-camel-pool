#!/usr/bin/env node
// verify-uxv14-live.mjs —— 宿主重启后的实机回归（只在真有账号/宿主时跑）。
//
// 用法: node scripts/verify-uxv14-live.mjs [PORT]（默认 13836，从 GUI 地址栏取当前值）
//
// 与 check-pool-core.mjs 的分工：那个用假路由证明内核逻辑对，这个证明
// 「宿主真的加载了新代码」——静态断言全绿也可能只是磁盘改了、进程还跑着旧模块。
import http from "node:http";

const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 13836;
const PATH = "/plugins/dsh-pool/status";

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

let res;
try {
  res = await get(PORT, PATH);
} catch (error) {
  console.error("[live] 连不上 http://127.0.0.1:" + PORT + PATH + " —— " + error.message);
  console.error("       宿主没开，或端口变了（从 GUI 地址栏取；13347 / 6854 / 10233 / 13836 都出现过）");
  process.exit(2);
}
ok("状态接口可达 (" + res.status + ")", res.status === 200, res.body.slice(0, 200));

let doc;
try {
  doc = JSON.parse(res.body);
} catch {
  console.error("[live] 响应不是 JSON");
  process.exit(2);
}

ok("内核标记已是 ux-v14（否则宿主仍在跑旧模块，重启后再验）", doc.patch === "ux-v14", doc.patch);

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
console.log("\nverify-uxv14-live: 全部通过（内核 ux-v14 已在线）");
