#!/usr/bin/env node
/**
 * check-checkin-device.mjs —— Trae 签到设备号台账的运行时闸。
 *
 * 为什么要真跑：checkin-device.js 是唯一持有「userId ↦ 签到 deviceId」映射的模块。
 * 一旦 get/rotate 把两个号写串，症状是「签到 +100 落到别人号上」或者「换号换掉了
 * 会话身份把另一条链顶成 20403」—— 静态字符串断言一个都抓不到，只有真 import
 * 真写盘才能验。
 *
 * 宿主包 @deepseek-ai/dsh-home-paths 在独立 node 下可能解析不到：profile 里的
 * symlink 指向 resources/app，而 dsh 升级后这个目录已经不存在（改成了
 * resources/runtime/primary-runtime）。探测不到就注册一个 resolve 钩子把它换成
 * 空模块 —— 被测的 get/rotate 只用 node:fs 与 node:crypto，不调用宿主 API。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = join(ROOT, "lib", "providers", "trae", "checkin-device.js");
const HOST_PACKAGE = "@deepseek-ai/dsh-home-paths";

let stubbed = false;
try {
  await import.meta.resolve(HOST_PACKAGE, pathToFileURL(MODULE).href);
} catch {
  const stub = "export function resolveDshHome() { return process.cwd(); }";
  const loader = [
    "export async function resolve(specifier, context, nextResolve) {",
    "  try {",
    "    return await nextResolve(specifier, context);",
    "  } catch (error) {",
    "    if (specifier.startsWith(\"@deepseek-ai/\")) {",
    "      return { url: \"data:text/javascript,\" + encodeURIComponent(" + JSON.stringify(stub) + "), shortCircuit: true };",
    "    }",
    "    throw error;",
    "  }",
    "}",
  ].join("\n");
  register("data:text/javascript," + encodeURIComponent(loader), import.meta.url);
  stubbed = true;
}

let mod;
try {
  mod = await import(pathToFileURL(MODULE).href);
} catch (error) {
  console.error("FAIL 无法加载 lib/providers/trae/checkin-device.js: " + (error && error.message));
  process.exit(1);
}

if (stubbed) {
  console.log("info 宿主包 " + HOST_PACKAGE + " 在本机解析不到，已用空模块替身（只影响 checkinDeviceFile 的默认目录）");
}

let failed = 0;
let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    console.log("FAIL " + label + " :: " + (error && error.message ? error.message : error));
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function readMap(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

const dir = mkdtempSync(join(tmpdir(), "dsh-checkin-device-"));
const file = join(dir, "devices.json");
const A = "2539239213373945";
const B = "322633674791738";
const devices = mod.createCheckinDevices({ file });

check("导出面: checkinDeviceFile / createCheckinDevices", () => {
  assert(typeof mod.checkinDeviceFile === "function", "缺 checkinDeviceFile 导出");
  assert(typeof mod.createCheckinDevices === "function", "缺 createCheckinDevices 导出");
  assert(typeof devices.get === "function", "createCheckinDevices 缺 get");
  assert(typeof devices.rotate === "function", "createCheckinDevices 缺 rotate");
});

check("checkinDeviceFile 指向 .trae-checkin-devices.json", () => {
  const path = mod.checkinDeviceFile();
  assert(typeof path === "string" && path.endsWith(".trae-checkin-devices.json"), "路径不对: " + path);
});

check("首次 get 登记 fallback 并落盘", () => {
  const got = devices.get(A, "dev-a");
  assert(got === "dev-a", "首次 get 应返回 fallback，得到 " + got);
  const map = readMap(file);
  assert(map[A] === "dev-a", "首次 get 应把 fallback 写进台账，实际 " + JSON.stringify(map));
});

check("已有台账值不被新 fallback 覆盖", () => {
  const got = devices.get(A, "dev-other");
  assert(got === "dev-a", "已有值应优先，得到 " + got);
  assert(readMap(file)[A] === "dev-a", "台账不该被改写");
});

check("两账号映射互不干扰", () => {
  const got = devices.get(B, "dev-b");
  assert(got === "dev-b", "B 首次 get 应返回 dev-b，得到 " + got);
  const map = readMap(file);
  assert(map[A] === "dev-a" && map[B] === "dev-b", "两账号应各存一条，实际 " + JSON.stringify(map));
});

check("rotate 换新号、落盘、且不动别的账号", () => {
  const fresh = devices.rotate(A, "dev-a");
  assert(typeof fresh === "string" && fresh !== "", "rotate 应返回非空字符串");
  assert(fresh !== "dev-a", "rotate 应换掉旧号");
  const map = readMap(file);
  assert(map[A] === fresh, "rotate 结果应落盘");
  assert(map[B] === "dev-b", "rotate 不该动别的账号，实际 " + JSON.stringify(map));
});

check("rotate 结果不与生成前台账里任何号重复", () => {
  const seen = Object.values(readMap(file)).filter((v) => typeof v === "string" && v !== "");
  const fresh = devices.rotate(B, "dev-b");
  const collisions = seen.filter((v) => v === fresh);
  assert(collisions.length === 0, "rotate 撞上了已有号 " + fresh);
});

check("同账号两次 rotate 结果不同", () => {
  const first = devices.rotate(A, "");
  const second = devices.rotate(A, "");
  assert(first !== second, "连续 rotate 应给出不同的号");
  assert(readMap(file)[A] === second, "台账应停在最后一次 rotate 的结果");
});

check("空 key 直通：不查表、不写表", () => {
  const before = readFileSync(file, "utf8");
  const got = devices.get("", "dev-x");
  assert(got === "dev-x", "空 key 应直接返回 fallback，得到 " + got);
  assert(readFileSync(file, "utf8") === before, "空 key 不该写台账");
  const fresh = devices.rotate("", "dev-x");
  assert(typeof fresh === "string" && fresh !== "dev-x", "空 key 的 rotate 也应换新号");
  assert(readFileSync(file, "utf8") === before, "空 key 的 rotate 不该写台账");
});

check("坏台账容错：当空表重建", () => {
  const corrupt = "{ this is not json";
  writeFileSync(file, corrupt, "utf8");
  const got = devices.get(A, "recovered");
  assert(got === "recovered", "坏表应被当空表，get 返回 fallback，得到 " + got);
  const map = readMap(file);
  assert(map[A] === "recovered", "坏表应被重建为只含本次登记，实际 " + JSON.stringify(map));
});

check("写盘是 tmp+rename：不留临时文件", () => {
  const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp-"));
  assert(leftovers.length === 0, "残留临时文件: " + leftovers.join(", "));
});

check("台账权限 0600（非 win32 才验）", () => {
  if (process.platform === "win32") return;
  const mode = statSync(file).mode & 0o777;
  assert(mode === 0o600, "台账权限应为 0600，实际 " + mode.toString(8));
});

rmSync(dir, { recursive: true, force: true });

if (failed > 0) {
  console.error("CHECKIN_DEVICE_ASSERTIONS_FAILED (" + failed + " failed, " + passed + " passed)");
  process.exit(1);
}
console.log("CHECKIN_DEVICE_ASSERTIONS_PASSED (" + passed + " assertions)");
