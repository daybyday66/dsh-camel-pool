#!/usr/bin/env node
/**
 * qoder 桌面会话导入的离线自检。
 *
 * 覆盖四件事：
 * 1. `decryptAuthBlob` 的密文格式（自造 v10 密文往返，不需要真 App）
 * 2. `sessionFromDesktopDoc` 的字段收敛与拒绝条件
 * 3. `desktopClaimedBy` 的「同号不许占两个槽位」判定
 * 4. `writeSessionFile` 的原子写 + `desktopUid` 落盘
 *
 * 不碰真实 App 目录（那是 `verify-qoder-live.mjs` 的事），所以在任何机器上都能跑。
 */
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DESKTOP_SOURCE,
  decryptAuthBlob,
  desktopClaimedBy,
  sessionFromDesktopDoc,
  writeSessionFile,
} from "../lib/providers/qoder/desktop-vault.js";

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  [vault] ok: ${label}`);
}

/** 按 Electron safeStorage 的格式造密文：v10 ‖ nonce(12) ‖ AES-256-GCM(明文) ‖ tag(16)。 */
function seal(plain, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(plain), "utf8")), cipher.final()]);
  return Buffer.concat([Buffer.from("v10", "latin1"), nonce, body, cipher.getAuthTag()]);
}

const key = randomBytes(32);
const doc = {
  schemaVersion: 1,
  authenticationContext: ["https://qoder.cn", "https://openapi.qoder.com.cn"],
  token: "dt-selftest-token",
  refreshToken: "drt-selftest-refresh",
  expiresAt: "2027-01-02T03:04:05Z",
  refreshTokenExpiresAt: "2028-01-02T03:04:05Z",
  user: { id: "uid-selftest", name: "selftest-user", email: "", phone: "19000000000" },
};

// 1. 往返
{
  const blob = seal(doc, key);
  const back = decryptAuthBlob(blob, key);
  assert.equal(back.token, doc.token);
  assert.equal(back.user.id, doc.user.id);
  ok("decryptAuthBlob 能解回自造的 v10 密文");
}

// 1b. 错密钥必须抛（GCM 校验），不能静默返回垃圾
{
  const blob = seal(doc, key);
  assert.throws(() => decryptAuthBlob(blob, randomBytes(32)), /unable to authenticate|bad decrypt|Unsupported state/i);
  ok("错密钥被 GCM tag 拦住（不是静默失败）");
}

// 1c. 魔数不对要给出可读错误
{
  const blob = seal(doc, key);
  const broken = Buffer.from(blob);
  broken.write("v11", 0, "latin1");
  assert.throws(() => decryptAuthBlob(broken, key), /魔数是/);
  ok("魔数不是 v10 时报错含实际值");
}

// 1d. 太短要报错
assert.throws(() => decryptAuthBlob(Buffer.alloc(20), key), /太短/);
ok("密文过短时报错而不是崩溃");

// 2. 字段收敛
{
  const session = sessionFromDesktopDoc(doc);
  assert.equal(session.uid, "uid-selftest");
  assert.equal(session.name, "selftest-user");
  assert.equal(session.source, DESKTOP_SOURCE);
  assert.equal(session.expiresAt, "2027-01-02T03:04:05Z");
  ok("sessionFromDesktopDoc 收敛出插件会话结构");
}
assert.equal(sessionFromDesktopDoc({ user: { id: "u" } }), undefined);
assert.equal(sessionFromDesktopDoc({ token: "dt-x" }), undefined);
ok("缺 token 或 user.id 时返回 undefined");

// 3. 占位判定 + 4. 原子写（共用临时目录）
const dir = mkdtempSync(join(tmpdir(), "qoder-vault-"));
try {
  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();

  // 未落盘时不算占用
  assert.equal(desktopClaimedBy({ authDir: dir, channelId: "qoder2", uid: "uid-selftest" }), undefined);
  ok("没有会话文件时不算被占用");

  // qoder1 用桌面会话占住 uid-selftest
  const q1 = join(dir, "qoder1-session.json");
  const written = writeSessionFile(q1, { ...sessionFromDesktopDoc(doc), expiresAt: future });
  assert.equal(written.desktopUid, "uid-selftest");
  const onDisk = JSON.parse(readFileSync(q1, "utf8"));
  assert.equal(onDisk.desktopUid, "uid-selftest");
  assert.equal(onDisk.uid, "uid-selftest");
  assert.equal(onDisk.source, DESKTOP_SOURCE);
  assert.ok(typeof onDisk.installedAt === "string" && onDisk.installedAt.length > 0);
  ok("writeSessionFile 落盘含 desktopUid / installedAt");

  assert.equal(desktopClaimedBy({ authDir: dir, channelId: "qoder2", uid: "uid-selftest" }), "qoder1");
  ok("同 uid 的另一个槽位被判为已占用");

  assert.equal(desktopClaimedBy({ authDir: dir, channelId: "qoder1", uid: "uid-selftest" }), undefined);
  ok("自己槽位不算占用（不会被自己拦住）");

  assert.equal(desktopClaimedBy({ authDir: dir, channelId: "qoder2", uid: "uid-other" }), undefined);
  ok("不同 uid 不互相占用");

  // 手工 PAT 换来的会话（无 desktopUid / 无 desktop source）不算占用
  const q2 = join(dir, "qoder2-session.json");
  writeFileSync(q2, JSON.stringify({ token: "dt-pat", uid: "uid-patsession", expiresAt: future }), "utf8");
  assert.equal(desktopClaimedBy({ authDir: dir, channelId: "qoder1", uid: "uid-patsession" }), undefined);
  ok("手工 PAT 会话不参与桌面号占用判定");

  // 对方过期了就不算占用
  writeFileSync(q1, JSON.stringify({ token: "dt-x", uid: "uid-expired", expiresAt: past, desktopUid: "uid-expired", source: DESKTOP_SOURCE }), "utf8");
  assert.equal(desktopClaimedBy({ authDir: dir, channelId: "qoder2", uid: "uid-expired" }), undefined);
  ok("对方已过期时不占用（让它自己去重建）");

  // 目录不存在时静默返回 undefined（不是抛）
  assert.equal(desktopClaimedBy({ authDir: join(dir, "nope"), channelId: "qoder2", uid: "uid-selftest" }), undefined);
  ok("authDir 不存在时返回 undefined 而不是抛");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\ncheck-qoder-vault: 全部通过（${passed} 项）`);
