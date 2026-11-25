#!/usr/bin/env node
/**
 * check-checkin-claim.mjs -- claimDailyCheckin 接线层运行时闸（ux-v45）。
 *
 * check-checkin-device.mjs 只覆盖台账模块本身；本脚本起一个本地 HTTP 服务器
 * 伪装 Trae 账号网关，喂脚本化响应，断言：
 *   A 全链路用签到设备号（不是会话 deviceId）；B 9074 设备门恰好触发一次 rotate；
 *   C code 0 但余额未增 -> credited===0 + note；D 余额读不到 -> 标「未校验到账」；
 *   E 已签过 -> already-claimed 且不打 claim。
 *
 * 宿主包（@deepseek-ai/*, @earendil-works/*）在独立 node 下解析不到，
 * 用 module.register 注册 resolve 钩子把它们换成临时目录里的最小替身。
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIBDIR = join(import.meta.dirname, '..', 'lib');
const INDEX_URL = pathToFileURL(join(LIBDIR, 'providers', 'trae', 'index.js')).href;
const PROBE_SPECS = [
  '@deepseek-ai/schemastery',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-ai/api/openai-completions.lazy',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-home-paths',
];

const stubDir = mkdtempSync(join(tmpdir(), 'claim-test-'));
const failed = [];
for (const spec of PROBE_SPECS) {
  try { await import.meta.resolve(spec, INDEX_URL); } catch { failed.push(spec); }
}
if (failed.length) {
  // 全部用单引号，避免在主文件双引号数组元素里转义。
  const generic = [
    'const f = function () {};',
    'const p = new Proxy(f, {',
    '  get(t, k) {',
    '    if (k in t) return t[k];',
    '    if (k === Symbol.toPrimitive) return () => \'\';',
    "    if (k === 'then' || k === 'catch' || k === 'finally') return undefined;",
    '    return p;',
    '  },',
    '  apply() { return p; },',
    '  construct() { return p; },',
    '});',
    'export default p;',
    'export const createProvider = p;',
    'export const openAICompletionsApi = p;',
    'export const PiAiAdapter = p;',
    'export const resolveRetryPolicy = p;',
  ].join('\n') + '\n';
  writeFileSync(join(stubDir, 'stub-generic.mjs'), generic, 'utf8');
  writeFileSync(join(stubDir, 'stub-home.mjs'), 'export function resolveDshHome(){ return process.cwd(); }\n', 'utf8');
  const loaderLines = [
    "import { join } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    'const DIR = import.meta.dirname;',
    'export async function resolve(specifier, context, nextResolve) {',
    '  try { return await nextResolve(specifier, context); }',
    '  catch (error) {',
    "    if (specifier === '@deepseek-ai/dsh-home-paths') {",
    "      return { url: pathToFileURL(join(DIR, 'stub-home.mjs')).href, shortCircuit: true };",
    '    }',
    "    if (specifier.indexOf('@deepseek-ai/') === 0 || specifier.indexOf('@earendil-works/') === 0) {",
    "      return { url: pathToFileURL(join(DIR, 'stub-generic.mjs')).href, shortCircuit: true };",
    '    }',
    '    throw error;',
    '  }',
    '}',
  ].join('\n') + '\n';
  writeFileSync(join(stubDir, 'loader.mjs'), loaderLines, 'utf8');
  register(pathToFileURL(join(stubDir, 'loader.mjs')).href, import.meta.url);
  console.error('info 宿主包替身：' + failed.join(', '));
}

const { createTraeAccountClient } = await import(INDEX_URL);
const { createCheckinDevices } = await import(pathToFileURL(join(LIBDIR, 'providers', 'trae', 'checkin-device.js')).href);

const STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status';
const CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim';
const USAGE_PATH = '/trae/api/v2/pay/ide_user_ent_usage';

let assertions = 0;
const assert = (cond, label) => {
  assertions += 1;
  if (!cond) { console.error('FAIL ' + label); process.exitCode = 1; }
};

function startMock(script) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const deviceId = req.headers['x-device-id'];
      calls.push({ path: req.url, deviceId: deviceId, body: body });
      const answer = script(req.url, deviceId, body) || { status: 200, json: {} };
      res.writeHead(answer.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer.json === undefined ? {} : answer.json));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server: server, calls: calls, port: server.address().port }));
  });
}

const ledgerPath = () => join(stubDir, '.trae-checkin-devices.json');
function readLedger() {
  try { return JSON.parse(readFileSync(ledgerPath(), 'utf8')); } catch { return {}; }
}

function makeClient(port, ledger) {
  writeFileSync(ledgerPath(), JSON.stringify(ledger || {}, null, 2) + '\n');
  const logger = { warn() {}, info() {}, error() {} };
  const checkinDevices = createCheckinDevices({ file: ledgerPath(), logger: logger });
  return { client: createTraeAccountClient({ logger: logger, checkinDevices: checkinDevices }), checkinDevices: checkinDevices };
}

const baseCredential = (port, deviceId) => ({
  token: 'fake-token', userId: 'user-1', deviceId: deviceId,
  accountBase: 'http://127.0.0.1:' + port, product: { reqSource: 'cn' },
});

// A：正常签到 +100，全链路用签到设备号（台账登记 fallback）
{
  let consumed = 2700;
  const { server, calls, port } = await startMock((path) => {
    if (path === STATUS_PATH) return { json: { enable: true, checked_in: false, credits: 100 } };
    if (path === USAGE_PATH) return { json: { usage_summary: { total_amount: 4700, consumed_amount: consumed } } };
    if (path === CLAIM_PATH) { consumed = 2600; return { json: { code: 0, message: 'ok' } }; }
    return { json: {} };
  });
  try {
    const made = makeClient(port, {});
    const res = await made.client.claimDailyCheckin(baseCredential(port, 'DEV_FALLBACK'));
    assert(res.state === 'claimed', 'A state claimed');
    assert(res.credited === 100, 'A credited === 100');
    assert(!res.note, 'A 无 note');
    const claimCalls = calls.filter((c) => c.path === CLAIM_PATH);
    assert(claimCalls.length === 1, 'A claim 只打一次');
    assert(claimCalls[0].deviceId === 'DEV_FALLBACK', 'A claim 用登记的签到设备号');
    assert(calls.every((c) => c.deviceId === 'DEV_FALLBACK'), 'A 全链路都用签到设备号');
    assert(readLedger()['user-1'] === 'DEV_FALLBACK', 'A fallback 已落盘');
  } finally { server.close(); }
}

// B：9074 设备门 -> rotate 换号一次 -> 成功
{
  let sawGate = false;
  const { server, calls, port } = await startMock((path, deviceId) => {
    if (path === CLAIM_PATH) {
      if (deviceId === 'DEV_A') { sawGate = true; return { json: { code: 9074, message: 'gate' } }; }
      return { json: { code: 0 } };
    }
    if (path === STATUS_PATH) return { json: { enable: true, checked_in: deviceId !== 'DEV_A', credits: 100 } };
    if (path === USAGE_PATH) return { json: { usage_summary: { total_amount: 4700, consumed_amount: deviceId === 'DEV_A' ? 2700 : 2600 } } };
    return { json: {} };
  });
  try {
    const made = makeClient(port, { 'user-1': 'DEV_A' });
    const res = await made.client.claimDailyCheckin(baseCredential(port, 'DEV_A'));
    assert(res.state === 'claimed', 'B state claimed');
    assert(res.credited === 100, 'B credited === 100');
    const claimCalls = calls.filter((c) => c.path === CLAIM_PATH);
    assert(claimCalls.length === 2, 'B 9074 后只重试一次（共两次 claim）');
    assert(claimCalls[0].deviceId === 'DEV_A', 'B 第一次用旧号');
    assert(claimCalls[1].deviceId !== 'DEV_A', 'B rotate 后换新号');
    assert(typeof claimCalls[1].deviceId === 'string' && claimCalls[1].deviceId.length > 0, 'B 新号非空');
    assert(sawGate === true, 'B 确实撞到 9074');
    assert(readLedger()['user-1'] === claimCalls[1].deviceId, 'B 台账更新为新号');
  } finally { server.close(); }
}

// C：code 0 但余额没增加 -> credited===0 + note
{
  const { server, port } = await startMock((path) => {
    if (path === STATUS_PATH) return { json: { enable: true, checked_in: false, credits: 100 } };
    if (path === USAGE_PATH) return { json: { usage_summary: { total_amount: 4700, consumed_amount: 2700 } } };
    if (path === CLAIM_PATH) return { json: { code: 0 } };
    return { json: {} };
  });
  try {
    const made = makeClient(port, { 'user-1': 'DEV_A' });
    const res = await made.client.claimDailyCheckin(baseCredential(port, 'DEV_A'));
    assert(res.state === 'claimed', 'C state claimed');
    assert(res.credited === 0, 'C credited === 0（余额未变）');
    assert(typeof res.note === 'string' && res.note.indexOf('余额未增加') !== -1, 'C 标「余额未增加」note');
  } finally { server.close(); }
}

// D：余额接口读不到 -> 标「未校验到账」（ux-v45 修复点）
{
  const { server, port } = await startMock((path) => {
    if (path === STATUS_PATH) return { json: { enable: true, checked_in: false, credits: 100 } };
    if (path === USAGE_PATH) return { status: 500, json: { error: 'boom' } };
    if (path === CLAIM_PATH) return { json: { code: 0 } };
    return { json: {} };
  });
  try {
    const made = makeClient(port, { 'user-1': 'DEV_A' });
    const res = await made.client.claimDailyCheckin(baseCredential(port, 'DEV_A'));
    assert(res.state === 'claimed', 'D state 仍 claimed（签到确实成功）');
    assert(res.credited === undefined, 'D 无 credited（余额读不到）');
    assert(typeof res.note === 'string' && res.note.indexOf('未校验') !== -1, 'D 标「未校验到账」note');
  } finally { server.close(); }
}

// E：before 已 checkedIn -> already-claimed，不打 claim
{
  const { server, calls, port } = await startMock((path) => {
    if (path === STATUS_PATH) return { json: { enable: true, checked_in: true, credits: 100 } };
    if (path === CLAIM_PATH) return { json: { code: 0 } };
    return { json: {} };
  });
  try {
    const made = makeClient(port, { 'user-1': 'DEV_A' });
    const res = await made.client.claimDailyCheckin(baseCredential(port, 'DEV_A'));
    assert(res.state === 'already-claimed', 'E already-claimed');
    assert(calls.filter((c) => c.path === CLAIM_PATH).length === 0, 'E 不打 claim');
  } finally { server.close(); }
}

if (process.exitCode) {
  console.error('CHECKIN_CLAIM_ASSERTIONS_FAILED');
  process.exit(1);
}
console.log('CHECKIN_CLAIM_ASSERTIONS_PASSED (' + assertions + ' assertions)');
