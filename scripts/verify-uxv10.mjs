
import { pathToFileURL } from 'node:url';
import { repoRoot } from './_paths.mjs';
// 以前把仓库根硬编码成这台机器的绝对路径（换目录/换机就崩），改成从本文件位置推导。
const ROOT = repoRoot(process.argv[2]);
const u = (p) => pathToFileURL(ROOT + '\\' + p).href;
const shared = await import(u('lib/shared/pool.js'));
const gem = await import(u('lib/providers/gemini/index.js'));

const route = gem.geminiRoute(async () => 'dummy-token');
const models = route.models();
console.log('GEMINI route models (' + models.length + '): ' + models.map(m => m.id).join(', '));

const off = shared.registerPoolRoute(route);
const groups = shared.mergedModelGroups({});
const ids = groups.map(g => g.poolId);
console.log('MERGED groups=' + groups.length);
for (const want of ['gemini-4-argon','gemini-3.1-pro-preview','gemini-3.8-flash','gemini-3.5-flash-lite','gemini-3.5-pro','gemini-3.1-pro-high']) {
  const g = groups.find(x => x.poolId === want);
  console.log('  ' + want.padEnd(24) + (g ? 'PRESENT candidates=[' + [...g.candidates.keys()].join(',') + ']' : 'MISSING'));
}
const order = shared.orderedRoutesFor('gemini-3.5-pro', {});
console.log('orderedRoutesFor(gemini-3.5-pro) len=' + order.length + (order[0] ? ' route=' + order[0].routeKey + ' cand=' + order[0].candidate.id : ''));
const order2 = shared.orderedRoutesFor('gemini-3.1-pro-high', {});
console.log('orderedRoutesFor(gemini-3.1-pro-high) len=' + order2.length + (order2[0] ? ' route=' + order2[0].routeKey + ' cand=' + order2[0].candidate.id : ''));

// breaker kinds
shared.noteRouteFailure('probe:upstream', 'upstream');
shared.noteRouteFailure('probe:transport', 'transport');
shared.noteRouteFailure('probe:quota', 'quota');
console.log('breakers=' + JSON.stringify(shared.breakerReport()));

// dedupe check: no duplicate poolIds from new ids
const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
console.log('duplicate poolIds=' + JSON.stringify(dup));
off();
