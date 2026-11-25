#!/usr/bin/env node
// check-all.mjs —— 驼峰积分池静态契约检查（T0 工程基座）
// 用法: node scripts/check-all.mjs [ROOT]（默认 process.cwd()）
// 检查: 1) lib 全部 .js 通过 node --check  2) 关键契约串仍在源码中
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.argv[2] || process.cwd();
const LIB = path.join(ROOT, "lib");
let failed = 0;

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.name.endsWith(".js")) out.push(p);
  }
  return out;
}

// ── 1. 语法检查 ──────────────────────────────────────────────
const files = walk(LIB);
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) {
    failed++;
    console.error("SYNTAX FAIL:", path.relative(ROOT, f));
    if (r.stderr) console.error(r.stderr.split("\n").slice(0, 4).join("\n"));
  }
}
console.log(`[syntax] ${files.length - failed}/${files.length} ok`);

// ── 2. 契约断言 ──────────────────────────────────────────────
function mustContain(file, needle, label) {
  const rel = path.relative(ROOT, file).replaceAll("\\", "/");
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(needle)) {
    failed++;
    console.error(`CONTRACT FAIL: ${label} —— ${rel} 缺少 ${JSON.stringify(needle)}`);
  } else {
    console.log(`[contract] ok: ${label} (${rel})`);
  }
}

mustContain(path.join(ROOT, "lib/providers/pool/index.js"), 'POOL_STATUS_PATH = "/plugins/dsh-pool/status"', "对外状态路径");
mustContain(path.join(ROOT, "lib/panel.js"), '"dsh-camel-pool"', "settings 命名空间");
mustContain(path.join(ROOT, "lib/shared/pool.js"), 'export function registerPoolRoute', "池路由注册契约");
mustContain(path.join(ROOT, "lib/shared/pool.js"), 'export function orderedRoutesFor', "排序内核契约");
mustContain(path.join(ROOT, "lib/shared/pool.js"), 'export async function refreshPoolCredits', "积分刷新契约");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "export function sampleUsageCredits", "用量积分采样契约");
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), "sampleUsageCredits(entry.routeKey)", "成功分支接线积分采样");
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), 'BOOT_PLACEHOLDER', "池启动占位模型锚点");
mustContain(path.join(ROOT, "lib/panel.js"), 'autoCheckin', "白名单键 autoCheckin");
mustContain(path.join(ROOT, "lib/panel.js"), 'poolVoucherFirst', "白名单键 poolVoucherFirst");
mustContain(path.join(ROOT, "lib/panel.js"), 'poolBurnExpiringFirst', "白名单键 poolBurnExpiringFirst");
mustContain(path.join(ROOT, "lib/shared/pool.js"), 'expiring', "expiring 信号入池内核");

// ── 3. 负向断言（P2-3 白名单唯一真相源 / 隐藏钩子接线）─────────────
function mustNotContain(file, needle, label) {
  const rel = path.relative(ROOT, file).replaceAll("\\", "/");
  const text = fs.readFileSync(file, "utf8");
  const hit = text.split("\n").findIndex((line) => line.includes(needle));
  if (hit !== -1) {
    failed++;
    console.error(`CONTRACT FAIL: ${label} —— ${rel}:${hit + 1} 仍含 ${JSON.stringify(needle)}`);
  } else {
    console.log(`[contract] ok: ${label} (${rel})`);
  }
}

mustNotContain(path.join(ROOT, "lib/providers/gemini/index.js"), "libraryBypass: true", "gemini 不再绕过白名单");
mustNotContain(path.join(ROOT, "lib/shared/pool.js"), "hasLibraryBypassRoute", "白名单无绕过分支");
mustContain(path.join(ROOT, "lib/providers/gemini/index.js"), "setExternalHidden", "gemini 隐藏钩子已接线");
mustContain(path.join(ROOT, "lib/providers/gemini/index.js"), "externalHidden(GEMINI_ROUTE_KEY)", "gemini hidden 读面板规则");
// ux-v22：Gemini 整组移出驼峰池 —— 反向断言，防止有人把接线又加回来。
mustNotContain(path.join(ROOT, "lib/index.js"), '["gemini", gemini]', "gemini 不再进 HOOKED_PROVIDERS");
mustNotContain(path.join(ROOT, "lib/index.js"), 'providers/gemini/index.js', "lib/index.js 不再 import gemini 模块");
mustNotContain(path.join(ROOT, "lib/providers/pool/index.js"), "geminiRoute(", "池不再注册 gemini 路由");
mustNotContain(path.join(ROOT, "lib/providers/pool/index.js"), "gemini-oauth", "池不再有 gemini OAuth 路由");
mustNotContain(path.join(ROOT, "lib/shared/pool.js"), "gemini-4-argon", "白名单不再含 gemini 模型");

// ── 4. ux-v14 断言（当日额度优先 / 结构化错误分类 / 版本可查）─────────
mustContain(path.join(ROOT, "lib/shared/credit-expiry-policy.js"), "export function policyCreditExpiry", "官网积分政策模块在位");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "policyCreditExpiry", "官网积分政策回退已接入池内核");
mustContain(path.join(ROOT, "lib/panel.js"), "policyCreditExpiryFields", "渠道卡片标注政策估算");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "expiringAtMs", "池内核识别当日过期时刻");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "burnExpiringFirst", "latch 让位开关");
mustContain(path.join(ROOT, "lib/providers/codearts/index.js"), "poolKindOf", "codearts 错误体归一为池词汇");
mustContain(path.join(ROOT, "lib/providers/codearts/index.js"), "iam_stale", "codearts 区分 IAM 失效");
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), "structuredFailureKind", "池侧读结构化错误体");
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), 'patch: "ux-v48"', "内核版本标记已升 ux-v48");
// ux-v42：latch 让位条件必须是两级排序（当日桶 + 更早到期），不能退回只看 expiring 的窄条件。
mustContain(path.join(ROOT, "lib/shared/pool.js"), "function ranksBefore", "两级排序比较器在位（ranksBefore）");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "!burnsToday && !balanceAnchors.has(head.routeKey) && !ranksBefore(head, ordered[at])", "latch 让位同时看当日桶、均衡锚点与更早到期");
// ux-v43：直连通道必须自带非 undici 的 User-Agent。实测 Trae 网关把 undici / curl /
// Go-http-client / python-requests / 空 UA 一律判成裸客户端回 4011（伪装成限流），
// undici.fetch 默认 UA 就是 "undici" —— 缺这两条，trae/trae2 会重新 100% 502。
mustContain(path.join(ROOT, "lib/shared/net-rescue.js"), "const DEFAULT_USER_AGENT =", "直连通道有默认 UA");
mustContain(path.join(ROOT, "lib/shared/net-rescue.js"), "const options = withDefaultUserAgent(input, raw);", "directFetch 两条分支前先补默认 UA");
mustContain(path.join(ROOT, "lib/shared/net-rescue.js"), 'if (headers["user-agent"] === undefined || headers["user-agent"] === "") headers["user-agent"] = DEFAULT_USER_AGENT;', "裸 node:https 分支也补默认 UA");
// ux-v44：Trae 签到设备号与会话 deviceId 分离。撞设备门换号、换号只动签到台账、
// 「code 0 不等于到账」必须比余额；缺任一条，同机两号会互相顶掉签到额度。
mustContain(path.join(ROOT, "lib/providers/trae/index.js"), 'import { createCheckinDevices } from "./checkin-device.js";', "Trae 侧接入签到设备号台账");
mustContain(path.join(ROOT, "lib/providers/trae/index.js"), "const CHECKIN_DEVICE_GATE_CODES = new Set([9074, 9095]);", "设备门业务码在位（9074/9095）");
mustContain(path.join(ROOT, "lib/providers/trae/index.js"), "deviceId = checkinDevices.rotate(accountKey, deviceId);", "撞设备门后换号重试");
mustContain(path.join(ROOT, "lib/providers/trae/index.js"), "const credited = Math.round((remainAfter - remainBefore) * 100) / 100;", "领取后比余额增量（code 0 不等于到账）");
mustContain(path.join(ROOT, "lib/providers/trae/index.js"), "credited === 0", "余额没涨时标注而不是假报成功");
mustContain(path.join(ROOT, "lib/providers/trae/checkin-device.js"), "export function createCheckinDevices", "签到设备号台账模块在位");
mustContain(path.join(ROOT, "lib/providers/trae/checkin-device.js"), "renameSync(tmp, file);", "签到台账原子写");
mustContain(path.join(ROOT, "lib/panel.js"), ".codearts-accounts.json", "渠道页认出 codearts 多账号台账");
// ux-v45：claim 成功后余额读不到不能静默放过 —— 必须显式标「未校验到账」，
// 否则 code 0 但额度没进账的情况会被面板当成已到账。由 check-checkin-claim.mjs 兜底。
mustContain(path.join(ROOT, "lib/providers/trae/index.js"), "本次未校验到账", "余额读不到时标未校验 note");
mustContain(path.join(ROOT, "scripts/check-checkin-claim.mjs"), "claimDailyCheckin", "claim 接线层 mock 闸在位");
// ux-v46：note 必须从服务端一路透到面板。normalizeClaim 旧代码只认 payload.message，
// 把 trae 的「未校验到账 / 余额未增加」（都在 note 里）丢掉；手动签到成功分支也不读 body.note。
mustContain(path.join(ROOT, "lib/panel.js"), 'typeof payload.note === "string"', "normalizeClaim 优先取 payload.note");
mustCount(path.join(ROOT, "lib/client.js"), "setNote(body.note)", 2, "trae/qoder 手动签到成功分支透 note");
mustContain(path.join(ROOT, "scripts/check-checkin-claim.mjs"), "9095", "claim 测试覆盖 9095 设备门");
// ux-v47：同档同类路由的 300 分滞回均衡。缺任一条，两条同日到期的同渠道路由会退化成
// 「注册序靠前的那条被烧穿」或「每轮都切、差值永远卡在 300 内」。
mustContain(path.join(ROOT, "lib/shared/pool.js"), "const CREDIT_BALANCE_GAP = 300;", "300 分滞回阈值在位");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "gap > CREDIT_BALANCE_GAP", "差值超阈值才换手");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "!balanceAnchors.has(head.routeKey)", "latch 不得越过均衡锚点");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "balance: creditBalanceReport()", "状态接口透出当前燃烧目标");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "balanceCurrent.set(balanceTierKeyOf(latchEntry.route, latchCredit), latch)", "latch 播种均衡记忆");
// ux-v48：未换手档也要出现在报告里，且粘性不得越过同档已被均衡换手的锚点（3+ 路由档）。
mustContain(path.join(ROOT, "lib/shared/pool.js"), "tiers.set(tierKey, current)", "均衡返回 tier->首选映射");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "balancedElsewhere", "本档已换手时粘性不抬升");
mustContain(path.join(ROOT, "scripts/check-pool-core.mjs"), "ux-v48 未换手的档也在 balance 报告里", "ux-v48 观测补齐断言在位");
mustContain(path.join(ROOT, "scripts/check-pool-core.mjs"), "ux-v48 差值恰好=300 严格不切", "ux-v48 滞回上沿边界断言");
mustContain(path.join(ROOT, "scripts/check-pool-core.mjs"), "ux-v48 latch 播种 A 后 B 多>300 切走 B", "ux-v48 latch+均衡联动断言");

// ux-v29：路由「莫名其妙掉了」的三处根因回归闸。
mustContain(path.join(ROOT, "lib/shared/pool.js"), "deepseek-v4-flash-official", "Trae 兜底 id 进白名单（不再静默过滤）");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "export function routeModelDiagnostics", "路由掉线诊断函数在位");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "droppedModels", "状态文档透出被白名单丢掉的 id");
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), 'entry.route.kind === "trae" ? 12000 : 6000', "Trae 首字节探测 12s（冷启动不再记熔断）");
mustContain(path.join(ROOT, "lib/providers/trae/index.js"), "clearBreakers(instanceId)", "Trae 登录/续期成功清熔断");
mustNotContain(path.join(ROOT, "lib/index.js"), "models-trae2.json", "trae2 不再读不存在的目录快照");
mustNotContain(path.join(ROOT, "lib/client.js"), "geminiQuotaSec", "客户端已删 Gemini 死代码");
mustContain(path.join(ROOT, "lib/client.js"), "showAllRoutes", "路由默认折叠开关在位");
// ux-v30：DeepSeek 审计的四条补丁回归闸。
mustContain(path.join(ROOT, "lib/client.js"), "const filteredRoutes = routes.filter", "折叠计数与展开态无关（按钮不会消失）");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "routeDiagnostics.delete(key)", "注销路由清诊断（不留幽灵条目）");
mustNotContain(path.join(ROOT, "lib/client.js"), ".dcp-gq-grid", "Gemini 限额 CSS 已删干净");
mustNotContain(path.join(ROOT, "lib/providers/gemini/oauth.js"), "请运行 `node scripts/gemini-oauth-login.mjs`", "Gemini 登录提示不再指已删脚本");
mustNotContain(path.join(ROOT, "lib/shared/pool.js"), '["deepseek-v4-flash-official", "deepseek-v4-flash"]', "误导性别名已删（official id 本身已在白名单）");
// ux-v31：DeepSeek 第二轮审计的回归闸。
mustContain(path.join(ROOT, "lib/shared/pool.js"), "modelList = Array.isArray(models)", "models() 返回值先归一化（P0：脏路由不打挂整池，ux-v32 起展开也在 try 内）");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "hiddenModelCount: diag.hiddenModelCount ?? 0", "hiddenModelCount 透出到 status（不再是死字段）");
mustContain(path.join(ROOT, "lib/client.js"), "r.syntheticBalance === true", "无限量路由首屏可见（七牛）");
mustContain(path.join(ROOT, "lib/client.js"), "accounts.length > positiveCount ? react.createElement", "全零余额时账号区按钮不消失");
mustContain(path.join(ROOT, "lib/providers/trae/index.js"), "tickResult?.renewed === true", "Trae 只在凭据真变时清熔断");
// ux-v32：DeepSeek 第三轮审计的回归闸。
mustContain(path.join(ROOT, "lib/shared/pool.js"), "modelList = Array.isArray(models)", "归一化展开包在 try 里（迭代器抛错不打穿 status）");
mustContain(path.join(ROOT, "lib/client.js"), "const hasSynthetic = routes.some", "只剩 synthetic 路由时顶部不判不可用");
mustContain(path.join(ROOT, "lib/client.js"), "noRoutes: '暂无路由'", "无路由时不再永远显示加载中");
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), 'if (qiniuKey !== "")', "七牛有 key 才注册");
mustContain(path.join(ROOT, "lib/providers/pool/routes-builtin.js"), 'if (key === "") throw new Error("QINIU_API_KEY 未配置', "七牛 credits() 没 key 不谎报 synthetic ok");
// ux-v33：界面优化回归闸（截图复审）。
mustContain(path.join(ROOT, "lib/client.js"), "unlimitedQuota: '不限额'", "unlimitedQuota 在面板自己的文案表里（不再原样泄漏 key）");
mustContain(path.join(ROOT, "lib/client.js"), "const groupedAccounts = (() => {", "同名套餐聚合");
mustContain(path.join(ROOT, "lib/client.js"), "const [showIdle, setShowIdle] = react.useState(false)", "零活动平台默认折叠");
mustContain(path.join(ROOT, "lib/client.js"), "t('usageSuccess'", "用量行显示成功率而非裸占比");
mustContain(path.join(ROOT, "lib/client.js"), "dcp-usage__trend-labels", "趋势图带起止日期");
// ux-v36：自定义 OpenAI 兼容路由（面板直接加任意 API 路由）。这条链路跨五个文件，
// 少任何一环都表现为「表单能填、模型不出现」—— 所以逐环上闸。
mustContain(path.join(ROOT, "lib/channel-registry.js"), "custom: { multi: true }", "注册表认 custom 这个 kind");
mustContain(path.join(ROOT, "lib/channel-registry.js"), "export function normalizeCustomBaseUrl", "上游地址归一化单一事实源");
mustContain(path.join(ROOT, "lib/channel-registry.js"), "if (kind === \"custom\" && customBaseUrl === undefined) return undefined;", "custom 条目缺 baseUrl 直接丢弃");
mustContain(path.join(ROOT, "lib/channel-registry.js"), 'kind: "custom",', "channelOf 有 custom 支（否则 allChannels 过滤掉、面板无行）");
mustContain(path.join(ROOT, "lib/panel.js"), "return probeCustomChannel(channel);", "custom 探活走本地合成（不打空 statusPath）");
mustContain(path.join(ROOT, "lib/panel.js"), "await readBody(req)", "hub 端点仍走统一 readBody");
mustContain(path.join(ROOT, "lib/providers/pool/custom-routes.js"), "export function createCustomRoute", "注册表条目 → 池路由的转换器在位");
mustContain(path.join(ROOT, "lib/providers/pool/custom-routes.js"), "export async function refreshCustomModels", "面板「更新模型」有实现");
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), "const releases = await registerCustomRoutes({", "start() 里真的调用了自定义路由装载");
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), "for (const release of releases) disposers.push(release);", "自定义路由随热重载回收（release 进 disposers）");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "const hasCustom = [...group.candidates.keys()].some", "白名单旁路：自定义模型不被静默过滤");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "customRouteKeys.add(route.key)", "旁路按 route.kind 收集自定义 key");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "synthetic: true", "旁路给合成 curated 条目（比较器读 c.tier 不抛）");
// ux-v38：Trae 多槽被自动 adopt 成同一个号。这条链每一环缺了都会退回事故态，逐环上闸。
// 根因：桌面端同一时刻只能登一个 Trae 号，而 tick() 在该槽 localStale 时无条件 adopt 桌面身份，
// 把「救活这个槽」变成了「替这个槽决定用哪个号」，于是所有槽在 30s 内统一成桌面端那个号。
mustContain(path.join(ROOT, "lib/providers/trae/keepalive.js"), 'code: "other-account"', "adopt 换号保护：本槽已有别的账号时拒绝自动覆盖");
mustContain(path.join(ROOT, "lib/providers/trae/keepalive.js"), "let adoptBlocked;", "adoptBlocked 记录被挡下的换号（面板据此解释为什么没采用桌面号）");
mustContain(path.join(ROOT, "lib/providers/trae/keepalive.js"), "localUserId: typeof doc?.userId === \"string\"", "status() 透出本槽账号，界面才能判同号");
mustContain(path.join(ROOT, "lib/providers/trae/keepalive.js"), "desktopUserId: (() => {", "status() 透出桌面端当前账号");
mustContain(path.join(ROOT, "lib/providers/trae/index.js"), "identity: {", "trae 池路由上报账号归属（同号判定的唯一数据源）");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "identity: credit?.identity,", "池状态文档把 identity 带到每条路由");
mustContain(path.join(ROOT, "lib/panel.js"), "...typeof raw.userId === \"string\" && raw.userId !== \"\" ? { userId: raw.userId } : {},", "normalizeChannel 透出 userId（同号判定 + 登录守卫都要）");
mustContain(path.join(ROOT, "lib/panel.js"), "userId: row === undefined ? undefined : row.userId,", "auth 端点把 userId 返回给前端");
mustContain(path.join(ROOT, "lib/client.js"), "expectUserId: wanted", "前端登录带 expectUserId，让后端账号守卫生效");
mustContain(path.join(ROOT, "lib/client.js"), "const rebind = options !== undefined", "「换号」是显式动作，不是默认行为");
mustContain(path.join(ROOT, "lib/client.js"), "const sameAccountKeys = (() => {", "池浮层同号检测");
mustContain(path.join(ROOT, "lib/client.js"), "sameAccountHint:", "同号时给出人话解释（中英各一份）");
mustNotContain(path.join(ROOT, "lib/client.js"), "const wanted = String(channel.userId || '');\n\t\t\t\t\treturn {\n\t\t\t\t\t\tstart: () => postJson(path, { action: 'start' })", "重新登录不再无条件不传 expectUserId");
// ux-v39：Trae 多槽设备身份隔离。ux-v38 只挡住了「自动 adopt 换号」，但两个槽仍可能
// 共用同一个 deviceId —— 桌面端那把。共用设备号而账号不同时，谁先续期都把对方判成 20403，
// 表现就是「路由莫名其妙掉」。这条链每一环缺了都会退回撞车态，逐环上闸。
mustContain(path.join(ROOT, "lib/providers/trae/keepalive.js"), "if (desktopDeviceId !== \"\" && local.deviceId === desktopDeviceId) return undefined;", "slotIdentity 不再复用桌面身份，撞车时强制新造");
mustContain(path.join(ROOT, "lib/providers/trae/keepalive.js"), "const conflictsWithDesktop = (doc, deviceId, desktop) => {", "撞车判定抽成单一函数（renew / status / 池文档共用）");
mustContain(path.join(ROOT, "lib/providers/trae/keepalive.js"), "deviceCollision = {", "keyMaterial 撞车时拒签并留下证据");
mustContain(path.join(ROOT, "lib/providers/trae/keepalive.js"), 'code: "device-collision"', "renew 遇撞车直接早退，不再拿桌面设备号签别人的链");
mustContain(path.join(ROOT, "lib/providers/trae/keepalive.js"), "写回会让桌面端拿到不属于它设备的 refreshToken", "writeBackToDesktop 拒绝把独立设备的 refreshToken 投毒桌面端");
mustContain(path.join(ROOT, "lib/providers/trae/keepalive.js"), "deviceCollision: (() => {", "status() 透出撞车结论，面板才能解释为什么要换号");
mustContain(path.join(ROOT, "lib/providers/trae/index.js"), "slotIdentity(doc, { deviceId: desktop.deviceId })", "登录侧只按设备号判撞车，不再按账号复用桌面身份");
mustContain(path.join(ROOT, "lib/providers/trae/index.js"), "deviceCollision: (() => {", "池路由 identity 带撞车结论");
mustContain(path.join(ROOT, "lib/client.js"), "r.identity.deviceCollision === true", "池浮层显示「撞设备号」告警");
mustContain(path.join(ROOT, "lib/client.js"), "deviceCollisionHint:", "撞车提示给出可执行动作（中英各一份）");
// ux-v40：CodeArts 反复掉线。三条真 bug 各有独立现场证据，逐条上闸，缺一条就退回「总是掉」。
// ① 续期 POST 没有超时 → 一次挂住就让 _inflight 永久占位，该号在进程存活期内再也不会续期；
// ② catch 一律标 stale 落盘 → 一次网络抖动就把号判成「必须重新登录」；
// ③ 先落盘再更新内存 → 写盘抛错会丢掉上游刚轮换出的 refresh_token，之后每次续期都是 invalid_grant。
const AUTH_VENDOR = path.join(ROOT, "lib/providers/codearts/vendor/auth-CF9XHMX-.mjs");
mustContain(AUTH_VENDOR, "const REFRESH_TIMEOUT_MS = 25e3;", "续期请求带硬超时（否则 _inflight 会被永久占死）");
mustContain(AUTH_VENDOR, "function isDefinitiveRefreshRejection(text) {", "续期失败区分「上游明确拒绝」与「链路问题」");
mustContain(AUTH_VENDOR, "invalid_grant|invalid_token|invalid_request|InvalidDPoPHeader|use_dpop_nonce", "明确拒绝的判定覆盖 invalid_grant 家族");
mustContain(AUTH_VENDOR, "AbortSignal.timeout(REFRESH_TIMEOUT_MS)), cred.label);", "两处 refresh() 都把超时信号传给 refreshToken");
mustNotContain(AUTH_VENDOR, "\t\t} catch {\n\t\t\tcred.stale = true;", "续期 catch 不再无条件标 stale");
mustContain(AUTH_VENDOR, "if (!isDefinitiveRefreshRejection(text)) {", "只有明确拒绝才走 stale 分支");
mustContain(AUTH_VENDOR, "this._cred = next;\n\t\t\t\tthis._refreshFailedAt = void 0;", "AccountSlot 先落内存再落盘，写盘失败不丢新 token");
mustContain(AUTH_VENDOR, "if (cred.stale !== true && this._refreshFailedAt !== void 0 && Date.now() - this._refreshFailedAt < REFRESH_RETRY_GAP_MS) return cred;", "非 stale 失败留最短重试间隔，不乱撞一次性 refreshToken");
mustContain(AUTH_VENDOR, "const error = this._slots.get(id)?.lastRefreshError;", "账号摘要透出最近一次续期失败原因");
mustContain(path.join(ROOT, "lib/providers/codearts/index.js"), "refreshError: str(a.refreshError).slice(0, 200)", "状态接口把续期失败原因带给面板");
// ux-v41：ux-v40 之后仍剩下的两条「续期成功却掉线」通道。
// ① 续期 POST 已让上游轮换掉那枚一次性 refresh_token，但槽位在等响应期间被
//    invalidate()（重读磁盘 / 暂停 / 置顶 / 重登）→ stillCurrent() 为假 → 结果被直接
//    丢弃，磁盘还留着已作废的旧 token → 之后每次续期都是 invalid_grant，整个 family 判死。
// ② 保活用 `void store.keepAlive().catch(function () {})` 静默吞掉一切失败，日志里
//    连一条 stale 都没有，用户说「又掉了」时无从查证。
mustContain(AUTH_VENDOR, "if (typeof expectRefreshToken === \"string\" && expectRefreshToken !== \"\") {", "落库支持「文档里仍是本次消费的那一枚」守卫");
mustContain(AUTH_VENDOR, "await this.persist(next, mat.refreshToken);", "槽位被 invalidate 后仍把轮换结果补落盘");
mustContain(path.join(ROOT, "lib/providers/codearts/index.js"), "function reportAlive(logger, text, warn) {", "保活结果有可观测性，失败不再无声");
mustContain(path.join(ROOT, "lib/providers/codearts/index.js"), "startCodeartsRefresh(intervalMs = 30 * 60 * 1000, keepAliveMs = 5 * 60 * 1000, logger)", "保活定时器接宿主 logger");
mustNotContain(path.join(ROOT, "lib/providers/codearts/index.js"), "const aliveTick = function () { void store.keepAlive().catch(function () {}); };", "保活失败不再被空 catch 吞掉");
mustContain(path.join(ROOT, "lib/providers/codearts/index.js"), "logPoolEvent({ ev: 'keepalive', kind: 'codearts'", "保活结果落 ~/.dsh/.pool-route.log，事后可查");
// ux-v19：池转发的兜底抓取必须是 directFetch，不能回落 globalThis.fetch。
// billion-context 用 defineProperty 接管全局 fetch 并把自己重链到最外层，未声明
// route.fetch 的路由（trae/trae2/qoder/workbuddy/bailian/qiniu）于是被它的
// silent-direct 闸门本地 422 掉 —— 上游一次没被打到，池却报「所有路由都失败」。
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), 'entry.route.fetch === "function" ? entry.route.fetch : directFetch', "池转发兜底走直连（不回落全局 fetch）");
mustNotContain(path.join(ROOT, "lib/providers/pool/index.js"), "? entry.route.fetch : fetch;", "池转发不再回落 globalThis.fetch");
mustContain(path.join(ROOT, "lib/providers/pool/classifier.js"), "function localGateRefusal(status, text)", "本机拦截层（bili gate）单独可辨识");
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), 'type: "pool_gate_blocked"', "全池被闸门拦时不再误报 pool_exhausted");
// 闸门分支绝不能记熔断：进程级闸门会把十条路由一起冷却 60s，下一个请求照样全灭。
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), 'kind: "gate", gate', "闸门失败带 gate 分类但不进熔断");
// hy4 家族：同名不同 id 的模型各自被白名单点名时，不能按 name key 合并成一组。
// 合并的后果是 hy4flash 整个消失（一组只产出一个 poolId），请求直接 402 pool_exhausted。
mustContain(path.join(ROOT, "lib/shared/pool.js"), "function curatedEntryOfId(raw)", "白名单条目按 id 反查（供合并判定）");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "const nameKeyUsable =", "同名合并不许跨白名单条目");
mustContain(path.join(ROOT, "lib/shared/pool.js"), "if (nameKeyUsable) keys.push(nameGroupKey);", "name key 按判定条件才登记");
// 目录只声明 supportedEfforts=["high"]，但上游实测接受 low/medium/high/xhigh/max。
// 不补这张表，translateEffort 会把用户选的 medium 距离匹配改写成 high。
mustContain(path.join(ROOT, "lib/providers/workbuddy/index.js"), "MEASURED_EFFORT_ACCEPTANCE", "实测 effort 接受表在位");
mustContain(path.join(ROOT, "lib/providers/workbuddy/index.js"), "const measured = measuredEfforts(info.id);", "声明前先查实测表");
// 跨模块裸调用防线：structuredFailureKind 用的 str 曾在别处才有定义，运行时才炸。
mustContain(path.join(ROOT, "lib/providers/pool/classifier.js"), "function str(value) {", "池内核自带 str 助手（不再借用 codearts 的）");
mustContain(path.join(ROOT, "scripts/check-imports.mjs"), "findLeakedHelpers", "跨模块裸调用静态闸在位");
// 设置写入白名单必须覆盖 schema 里所有可切换键 —— 漏一个的后果是面板开关点了 400
// no-whitelisted-field，而客户端把 400 当"失败保留原值"，用户看到开关弹回去、
// 却没有任何错误提示。这类漏键只能靠静态比对。
mustContain(path.join(ROOT, "lib/panel.js"), 'safe.poolAutoBoostEffort = patch.poolAutoBoostEffort', "白名单含 poolAutoBoostEffort");
mustContain(path.join(ROOT, "lib/panel.js"), 'safe.disabledChannels = patch.disabledChannels', "白名单含 disabledChannels");
mustContain(path.join(ROOT, "lib/panel.js"), 'safe.disabledModels = patch.disabledModels', "白名单含 disabledModels");
mustContain(path.join(ROOT, "lib/panel.js"), "poolBurnExpiringFirst", "面板暴露当日优先开关");
// 漏导入防线：codearts 适配层必须真的导入 isIamTokenError（曾漏过，运行时才炸）。
mustContain(path.join(ROOT, "lib/providers/codearts/index.js"), "  isIamTokenError,", "codearts 导入 isIamTokenError 判定式");
if (!fs.existsSync(path.join(ROOT, "scripts/check-imports.mjs"))) {
  failed++;
  console.error("CONTRACT FAIL: 缺少 scripts/check-imports.mjs —— 漏导入无静态防线");
} else {
  console.log("[contract] ok: 漏导入静态检查在位 (scripts/check-imports.mjs)");
}

// CHANGELOG 必须存在且覆盖当前内核版本。
const changelogPath = path.join(ROOT, "CHANGELOG.md");
if (!fs.existsSync(changelogPath)) {
  failed++;
  console.error("CONTRACT FAIL: 缺少 CHANGELOG.md —— 内核版本无处可查");
} else {
  const log = fs.readFileSync(changelogPath, "utf8");
  if (!log.includes("ux-v19")) {
    failed++;
    console.error("CONTRACT FAIL: CHANGELOG.md 未记录 ux-v19");
  } else {
    console.log("[contract] ok: CHANGELOG 覆盖当前内核版本 (CHANGELOG.md)");
  }
}

// ── 5. ux-v14 断言（表驱动 id 校验 / 真窗口预检 / 结构化 invalid）─────────
// 这三条都是「同一个事实写在两处就会漂移」的收敛点：id 形状只在 CHANNEL_KINDS、
// 上下文窗口只在模型目录、错误分类只在适配层 —— 断言负向失守即为回归。
mustContain(path.join(ROOT, "lib/channel-registry.js"), "export function channelIdMatches", "id 形状单一事实源");
// （原 mustNotContain '/^workbuddy[1-9]' 已移到下方 mustCount：表里保留唯一一份才叫表驱动）
mustNotContain(path.join(ROOT, "lib/panel.js"), '/^workbuddy[1-9]', "面板不再内联 workbuddy 正则");
mustNotContain(path.join(ROOT, "lib/panel.js"), 'id !== kind', "面板不再内联单例判断");
mustContain(path.join(ROOT, "lib/panel.js"), "channelIdMatches(kind, id)", "面板走共享 id 校验");
mustContain(path.join(ROOT, "lib/providers/codearts/index.js"), "contextWindowFor", "codearts 用目录窗口做预检");
mustNotContain(path.join(ROOT, "lib/providers/codearts/index.js"), "prepareChatBody(body, 0)", "codearts 不再把窗口写成 0");
mustContain(path.join(ROOT, "lib/providers/pool/index.js"), 'declared === "invalid"', "池侧认适配层声明的 invalid");

// 表驱动的意思不是「正则消失」，而是「同一个正则只出现一次」。
// 写成 mustNotContain 会把 CHANNEL_KINDS 里的那一份也算成回归 —— 断言本身先错。
function mustCount(file, needle, expected, label) {
  const rel = path.relative(ROOT, file).replaceAll("\\", "/");
  const text = fs.readFileSync(file, "utf8");
  const count = text.split(needle).length - 1;
  if (count !== expected) {
    failed++;
    console.error(`CONTRACT FAIL: ${label} —— ${rel} 命中 ${count} 次，应为 ${expected} 次：${JSON.stringify(needle)}`);
  } else {
    console.log(`[contract] ok: ${label} (${rel})`);
  }
}

mustCount(path.join(ROOT, "lib/channel-registry.js"), "idPattern: /^workbuddy[1-9]", 1, "workbuddy 正则只以 idPattern 形式出现一次");
mustCount(path.join(ROOT, "lib/channel-registry.js"), "export function channelIdMatches", 1, "channelIdMatches 定义唯一");
mustContain(path.join(ROOT, "lib/channel-registry.js"), "if (!channelIdMatches(kind, id)) return undefined;", "注册表读取走共享校验");

if (failed > 0) {
  console.error(`\ncheck-all: ${failed} 项失败`);
  process.exit(1);
}
console.log("\ncheck-all: 全部通过");
