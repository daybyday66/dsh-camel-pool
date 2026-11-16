
import http from 'node:http';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './_paths.mjs';

// 仓库根从本文件位置推导：以前用 process.cwd()，在别的目录执行时静默指向错目录。
const ROOT = repoRoot(process.argv[2]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gemini-verify-'));
fs.writeFileSync(path.join(tmp, 'gemini-ca-project.json'), JSON.stringify({ projectId: 'test-project-429' }));
process.env.DSH_HOME = tmp;
process.env.GEMINI_NO_PROXY = '1';
process.env.CODE_ASSIST_API_VERSION = 'v1internal';
// 离线语义：关掉 apikey 逃生通道（否则会真连 generativelanguage.googleapis.com 等 12s 超时），
// 并把 project 级 429 的长阶梯（2/4/8/16/24/32s）整体压短 —— 只改等待时长，不改分支逻辑。
process.env.GEMINI_NO_APIKEY_ESCAPE = '1';
process.env.GEMINI_CA_QUOTA_LADDER = '50,100,200';

const QUOTA = JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } });
const OK = JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 } } });
const AUTH = JSON.stringify({ error: { code: 403, message: 'The Gemini API free tier is not available', status: 'PERMISSION_DENIED' } });

let mode = 'flaky';
let calls = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => raw += c);
  req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    calls.push({ url: req.url, model: body?.request?.model, project: body?.project });
    let status = 200, payload = OK;
    if (mode === 'flaky' && calls.length <= 2) { status = 429; payload = QUOTA; }
    else if (mode === 'always429') { status = 429; payload = QUOTA; }
    else if (mode === 'auth403') { status = 403; payload = AUTH; }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(payload);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.CODE_ASSIST_ENDPOINT = 'http://127.0.0.1:' + server.address().port;

const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'providers', 'gemini', 'codeassist.js')).href);
const S = await import(pathToFileURL(path.join(ROOT, 'lib', 'shared', 'pool.js')).href);

const req = () => ({
  method: 'POST',
  headers: { authorization: 'Bearer faketoken123456' },
  body: JSON.stringify({ model: 'gemini-3.5-flash-lite', messages: [{ role: 'user', content: 'reply with just OK' }], stream: false, max_tokens: 16 }),
});

const results = [];
function ok(name, detail) { results.push('PASS ' + name + (detail ? ' — ' + detail : '')); }

// ── A1: 偶发 429（前两次 429，第三次 200）→ 在 route.fetch 内消化，池看不到 429 ──
calls = []; mode = 'flaky';
const t0 = Date.now();
const r1 = await mod.codeAssistFetch('http://unused', req());
const j1 = await r1.json();
assert.equal(r1.status, 200, 'A1 最终应 200');
assert.equal(j1.choices[0].message.content, 'OK', 'A1 内容应为 OK');
assert.equal(calls.length, 3, 'A1 应恰好 3 次上游调用（2 次 429 + 1 次 200）');
assert.equal(calls[0].model, calls[2].model, 'A1 重试同一模型');
assert.equal(calls[0].project, 'test-project-429', 'A1 projectId 从 DSH_HOME 缓存解析');
ok('A1 偶发429自愈', calls.length + ' 次调用 / ' + (Date.now() - t0) + 'ms / 最终 200 content=OK');

// ── A2: 持续 429 → 原地长退避把阶梯走完，然后把 429 原样回给池（ux-v11 契约）──
// 项目级 RESOURCE_EXHAUSTED 是 project 级时间窗，换候选模型共享同一配额，换过去只会白烧预算；
// 所以这里断言的是「不换候选 + 重试有界」，不是旧的「应尝试多个候选模型」。
calls = []; mode = 'always429';
const t1 = Date.now();
const r2 = await mod.codeAssistFetch('http://unused', req());
assert.equal(r2.status, 429, 'A2 最终应把 429 原样回池');
const models = [...new Set(calls.map((c) => c.model))];
assert.equal(models.length, 1, 'A2 项目级 429 不应换候选模型: ' + models.join(','));
assert.equal(calls.length, 4, 'A2 应走完 3 格阶梯后收手（1 次首发 + 3 次退避重试）');
const j2 = await r2.json();
assert.equal(j2?.error?.status, 'RESOURCE_EXHAUSTED', 'A2 响应体应保留上游 429 语义');
ok('A2 持续429有界收手', calls.length + ' 次调用 / 1 个候选 [' + models.join(', ') + '] / ' + (Date.now() - t1) + 'ms / 429 回池');

// ── A3: 403 auth 确定性错误 → 不重试、立刻回给池 ──
calls = []; mode = 'auth403';
const r3 = await mod.codeAssistFetch('http://unused', req());
assert.equal(r3.status, 403, 'A3 应回 403');
assert.equal(calls.length, 1, 'A3 不应重试 auth 错误');
ok('A3 auth错误不重试', calls.length + ' 次调用 / 403 原样回池');

// ── B1: ignoreBreakers 兜底 ──
const route = {
  key: 'gemini', kind: 'gemini', displayName: 'Gemini', priority: 0,
  chatUrl: () => 'http://unused/v1internal:streamGenerateContent?alt=sse',
  token: () => 'faketoken', hidden: () => [],
  models: () => [{ id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', thinkingLevelMap: { high: 'high' } }],
};
S.setPoolProviderActive(true);
const release = S.registerPoolRoute(route);
const PID = 'gemini-3.5-flash-lite';
assert.equal(S.orderedRoutesFor(PID, {}).length, 1, 'B1 初始应有 1 条路由');
S.noteRouteFailure('gemini', 'quota');
assert.equal(S.orderedRoutesFor(PID, {}).length, 0, 'B1 quota 熔断后默认应为空（旧行为=402）');
const ignored = S.orderedRoutesFor(PID, { ignoreBreakers: true });
assert.equal(ignored.length, 1, 'B1 ignoreBreakers 应恢复 1 条路由');
assert.equal(ignored[0].routeKey, 'gemini');
ok('B1 quota熔断可探测', '默认 0 条 → ignoreBreakers 1 条 (gemini)');

// ── B2: pool 层守卫条件：auth 冷却不放行 ──
S.clearBreakers('gemini');
S.noteRouteFailure('gemini', 'auth');
const cooling = S.breakerReport();
assert.equal(cooling[0].kind, 'auth');
assert.equal(cooling.length > 0 && cooling.every((x) => x.kind !== 'auth'), false, 'B2 auth 冷却不应触发探测');
S.clearBreakers('gemini');
S.noteRouteFailure('gemini', 'quota');
const cooling2 = S.breakerReport();
assert.equal(cooling2.length > 0 && cooling2.every((x) => x.kind !== 'auth'), true, 'B2 quota 冷却应触发探测');
ok('B2 pool守卫条件', 'auth→false(保留10分钟保护) / quota→true(放行探测)');
S.clearBreakers('gemini');
release();

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join('\n'));
console.log('ALL_ASSERTIONS_PASSED');
