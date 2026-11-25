/**
 * Trae 签到设备号台账。
 *
 * ## 为什么要第二套设备号
 *
 * 凭据里的 deviceId 是**会话身份**：它和 device.privateKeyPEM 一把钥匙配对，
 * 换号或换钥都会把同机的另一条链顶成 20403（登录态互踢）。所以会话身份不能动。
 *
 * 但签到接口的 x-device-id 是**设备门**：
 *   - checked_in     是账号级 —— 该号今天领没领过（每人每天封顶 100）；
 *   - did_checked_in 是设备级 —— 这台设备今天签没签过。
 *
 * 实测（2026-11-25）：同一个 token 换成当天没用过的 deviceId，9074「当前参与用户太多」
 * 立刻变 code 0 并 +100 到账；而同一个号当天第二次领，即使再换新号也只是 code 0 空转，
 * 余额一分不涨。也就是说换号能过**设备门**，过不了**账号日封顶**。
 *
 * 结论：给每个账号单独记一个「签到专用设备号」，与登录设备号彻底分离。
 * 遇到 9074 / 9095 就换一个新号重试一次 —— 这是同机多号都能签到的前提。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { newDeviceId } from "./keepalive.js";

/** 台账文件：$DSH_HOME/.trae-checkin-devices.json，形如 {"<userId>":"<deviceId>"}。 */
export function checkinDeviceFile() {
  return join(resolveDshHome(), ".trae-checkin-devices.json");
}

export function createCheckinDevices(options = {}) {
  const file = options.file ?? checkinDeviceFile();
  const logger = options.logger;

  /** 读坏文件不该让签到整体失败：拿不到就当空表，本次用内存值。 */
  function readMap() {
    try {
      const doc = JSON.parse(readFileSync(file, "utf8"));
      return doc !== null && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
    } catch {
      return {};
    }
  }

  /** 原子写：tmp + rename，0600。写不进去只 warn —— 设备号可再生，不值得让签到失败。 */
  function writeMap(map) {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = file + ".tmp-" + process.pid;
      writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, file);
    } catch (error) {
      logger?.warn("dsh-trae-connect: 签到设备号台账写盘失败（本次仍用内存值）", error);
    }
  }

  return {
    file,

    /** 取该账号的签到设备号；没有就登记 fallback（会话设备号）并落盘。 */
    get(accountKey, fallback) {
      const key = typeof accountKey === "string" ? accountKey : "";
      if (key === "") return typeof fallback === "string" ? fallback : "";
      const saved = readMap()[key];
      if (typeof saved === "string" && saved !== "") return saved;
      if (typeof fallback === "string" && fallback !== "") {
        const map = readMap();
        map[key] = fallback;
        writeMap(map);
        return fallback;
      }
      return "";
    },

    /** 换一个当天没用过的新设备号并登记。表里的旧号一并参与去重，避免换回同一台。 */
    rotate(accountKey, fallback) {
      const key = typeof accountKey === "string" ? accountKey : "";
      const map = readMap();
      const used = new Set(Object.values(map).filter((v) => typeof v === "string" && v !== ""));
      if (typeof fallback === "string" && fallback !== "") used.add(fallback);
      let fresh = newDeviceId();
      for (let guard = 0; used.has(fresh) && guard < 32; guard += 1) fresh = newDeviceId();
      if (key !== "") {
        map[key] = fresh;
        writeMap(map);
      }
      return fresh;
    },
  };
}
