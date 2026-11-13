import { c as writeJsonAtomic } from "./auth-CF9XHMX-.mjs";
import { B as setDiscoveredBenefitModels, F as isBenefitModel, L as mergeModelLists, R as modelDisplayName, c as fetchModels } from "./upstream-CVtspzAv.mjs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
//#region src/discovery.ts
/**
* 动态模型发现：把「已登录账号」变成「当前可用模型清单」。
*
* 为什么要单独一层：模型目录是**按账号**授予的（限时福利尤其如此：A 账号有、
* B 账号没有），而插件对外只暴露一份目录。所以这里逐账号发现、取并集，再把
* 结果提交给全局目录与福利集合。
*
* 失败一律不抛出：拉不到就继续用现有目录（冷启动时是种子清单），把失败原因
* 带回去给 CLI / 日志展示。真正「不可用」的信号是 0 个账号。
*
* @module dsh-codearts/discovery
*/
/**
* 逐账号发现并合并（不改全局状态）。
*
* @param store 账号文档；逐个 `resolve()` 以拿到已续期的签名材料
* @param signal 取消信号（宿主关停时用）
*/
async function discoverModels(store, signal) {
	const ids = await store.ids();
	const accounts = [];
	for (const id of ids) {
		if (signal?.aborted === true) break;
		const summary = (await store.list()).find((account) => account.id === id);
		const label = summary?.label ?? summary?.userName;
		const resolved = await store.resolve(id);
		if (resolved === void 0) {
			accounts.push({
				accountId: id,
				...label === void 0 ? {} : { label },
				ok: false,
				models: [],
				sources: [],
				errors: [{
					source: "agent",
					message: "credential unavailable (sign in again)"
				}]
			});
			continue;
		}
		try {
			const result = await fetchModels(resolved, signal);
			accounts.push({
				accountId: id,
				...label === void 0 ? {} : { label },
				ok: true,
				models: result.models,
				sources: result.sources,
				errors: result.errors
			});
		} catch (error) {
			accounts.push({
				accountId: id,
				...label === void 0 ? {} : { label },
				ok: false,
				models: [],
				sources: [],
				errors: [{
					source: "agent",
					message: error instanceof Error ? error.message : String(error)
				}]
			});
		}
	}
	const ok = accounts.filter((account) => account.ok);
	return {
		models: mergeModelLists(ok.map((account) => account.models)),
		accounts,
		anySucceeded: ok.length > 0
	};
}
/**
* 发现并**提交**到全局目录：目录内容 + 福利集合。
*
* @returns 提交后的目录；没有任何账号成功时返回 `undefined`（调用方保留原目录）
*/
async function refreshCatalog(store, catalog, signal) {
	const outcome = await discoverModels(store, signal);
	if (!outcome.anySucceeded || outcome.models.length === 0) return outcome;
	setDiscoveredBenefitModels(outcome.models.filter((model) => model.benefit === true).map((model) => model.id));
	catalog.set(outcome.models.map((model) => {
		const benefit = isBenefitModel(model.id);
		return {
			...model,
			name: modelDisplayName(model.name, benefit, model.ratio)
		};
	}));
	return outcome;
}
//#endregion
//#region src/usage.ts
/**
* 用量账本：把聊天流里的 usage 帧累计成「今天用了多少」。
*
* 为什么还要自己记：账号总额度有积分接口了（见 credits.ts，2026-10 从官方 Agent
* 客户端挖出并实测通过），但**本机经插件发出的请求**仍需自己累计 —— 上游不按
* 「这台机器」维度给统计。能拿到的真实数据有三样：
*   1. 每个请求的 token `usage`（上游在流末尾回一帧 `{choices:[],usage:{...}}`）；
*   2. 插件自己知道的账号会话槽位占用（见 account-pool：每账号 3 个并发会话）；
*   3. 账号积分/额度（见 credits.ts）。
*
* 所以这里累计的是**本机经插件发出的请求**，与卡片上的积分区块互补 —— 一个是本机
* 级、一个是账号级。官方额度明细在 `codearts.huaweicloud.com/portal/settings/personal-usage`。
*
* 落盘在 `$DSH_HOME/.codearts-usage.json`，按天存，保留最近 `RETENTION_DAYS` 天。
*
* @module dsh-codearts/usage
*/
/** 用量账本路径：与账号文档同一层（`$DSH_HOME` 或 `~/.dsh`）。 */
function codeartsUsagePath(home) {
	const base = home ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(base, ".codearts-usage.json");
}
/** 首字延迟分桶的上界（毫秒）；落进最后一档表示「超过 30 秒」。 */
const TTFT_BUCKETS_MS = [
	200,
	500,
	1e3,
	2e3,
	3e3,
	5e3,
	8e3,
	12e3,
	2e4,
	3e4
];
/** 直方图桶数（含溢出档）。 */
const TTFT_BUCKET_COUNT = TTFT_BUCKETS_MS.length + 1;
function emptyTotals() {
	return {
		requests: 0,
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
		reasoningTokens: 0
	};
}
function addTotals(into, add) {
	into.requests += add.requests ?? 0;
	into.promptTokens += add.promptTokens ?? 0;
	into.completionTokens += add.completionTokens ?? 0;
	into.totalTokens += add.totalTokens ?? 0;
	into.cachedTokens += add.cachedTokens ?? 0;
	into.reasoningTokens += add.reasoningTokens ?? 0;
}
function mergeTotals(into, from) {
	addTotals(into, from);
}
/** 本地日期键 YYYY-MM-DD（不用 toISOString：那是 UTC，会把跨零点的用量算到前一天）。 */
function localDateKey(at = Date.now()) {
	const d = new Date(at);
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 本地小时键 `00`..`23`（同样按本地时间切，跨零点的那一小时不会错位）。 */
function localHourKey(at = Date.now()) {
	return localHourKeyOfHour(new Date(at).getHours());
}
/** 0..23 -> `00`..`23`（小时桶的键）。 */
function localHourKeyOfHour(hour) {
	return String(hour).padStart(2, "0");
}
function positiveInt(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
/**
* 从上游 usage 帧里取缓存命中数。
*
* 位置见过两种：OpenAI 的 `prompt_tokens_details.cached_tokens`，以及兼容层直接
* 平铺在顶层的几种别名。取第一个能读到的。缓存输入必然是输入的子集，所以比
* `promptTokens` 还大的脏数据直接钳掉 —— 否则界面上会出现 >100% 的命中率。
*/
function cachedTokensOf(raw, promptTokens) {
	if (promptTokens <= 0) return 0;
	const cached = positiveInt(nestedField(raw.prompt_tokens_details, "cached_tokens") ?? raw.cached_tokens ?? raw.cache_tokens ?? raw.prompt_cache_hit_tokens);
	return Math.min(cached, promptTokens);
}
/**
* 从上游 usage 帧里取思考 token。
*
* 口径与 {@link cachedTokensOf} 对称：嵌套 `completion_tokens_details.reasoning_tokens`
* 优先，顶层 `reasoning_tokens` 兜底，超过输出总量就钳掉（它含在输出里）。
*/
function reasoningTokensOf(raw, completionTokens) {
	if (completionTokens <= 0) return 0;
	const reasoning = positiveInt(nestedField(raw.completion_tokens_details, "reasoning_tokens") ?? raw.reasoning_tokens);
	return Math.min(reasoning, completionTokens);
}
/** 读 `*_tokens_details` 这类嵌套对象里的一个字段；不是对象（或缺字段）给 undefined。 */
function nestedField(details, key) {
	return typeof details === "object" && details !== null ? details[key] : void 0;
}
/** 从上游 usage 帧里取计数（缺哪个算 0，total 缺失时用 prompt+completion 兜底）。 */
function normalizeUsage(raw) {
	if (raw === void 0) return {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
		reasoningTokens: 0
	};
	const promptTokens = positiveInt(raw.prompt_tokens);
	const completionTokens = positiveInt(raw.completion_tokens);
	const total = positiveInt(raw.total_tokens);
	return {
		promptTokens,
		completionTokens,
		totalTokens: total > 0 ? total : promptTokens + completionTokens,
		cachedTokens: cachedTokensOf(raw, promptTokens),
		reasoningTokens: reasoningTokensOf(raw, completionTokens)
	};
}
/** 读一项累计值，缺字段（旧账本没有 cachedTokens / reasoningTokens）就按 0 补齐。 */
function normalizeTotals(raw) {
	return {
		requests: positiveInt(raw?.requests),
		promptTokens: positiveInt(raw?.promptTokens),
		completionTokens: positiveInt(raw?.completionTokens),
		totalTokens: positiveInt(raw?.totalTokens),
		cachedTokens: positiveInt(raw?.cachedTokens),
		reasoningTokens: positiveInt(raw?.reasoningTokens)
	};
}
/** 整张「模型/账号 -> 累计」表补齐字段。 */
function normalizeStore(store) {
	const out = {};
	for (const [key, totals] of Object.entries(store ?? {})) {
		if (typeof totals !== "object" || totals === null) continue;
		out[key] = normalizeTotals(totals);
	}
	return out;
}
/** 计数表（失败类别 / 账号失败数）补齐：只留正数，空表给 undefined。 */
function normalizeCounts(raw) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const out = {};
	for (const [key, value] of Object.entries(raw)) {
		const count = positiveInt(value);
		if (count > 0) out[key] = count;
	}
	return Object.keys(out).length === 0 ? void 0 : out;
}
/** 首字延迟直方图补齐到固定桶数；旧账本/脏数组一律按空表。 */
function normalizeBuckets(raw) {
	if (!Array.isArray(raw)) return void 0;
	const out = Array.from({ length: TTFT_BUCKET_COUNT }, (_, index) => positiveInt(raw[index]));
	return out.some((count) => count > 0) ? out : void 0;
}
/**
* 用量账本。
*
* 记账分两步，因为一次请求可能只有其一：
*  - `noteRequest()` 在请求发出时调用（拿不到 usage 的流也要计入请求数）；
*  - `noteUsage()` 在收到 usage 帧时调用（补 token 数）。
*/
var CodeArtsUsageTracker = class {
	days = /* @__PURE__ */ new Map();
	lastAt;
	loaded = false;
	loading;
	saveTimer;
	saving = Promise.resolve();
	path;
	now;
	saveDebounceMs;
	constructor(options = {}) {
		this.path = options.path;
		this.now = options.now ?? (() => Date.now());
		this.saveDebounceMs = options.saveDebounceMs ?? 2e3;
	}
	/** 读账本（懒加载，只读一次）。 */
	async load() {
		this.loading ??= this.readFile();
		return this.loading;
	}
	async readFile() {
		if (this.loaded || this.path === void 0 || !existsSync(this.path)) {
			this.loaded = true;
			return;
		}
		try {
			const raw = await readFile(this.path, "utf8");
			const parsed = JSON.parse(raw);
			if (parsed.version !== 1 || typeof parsed.days !== "object" || parsed.days === null) return;
			for (const [date, day] of Object.entries(parsed.days)) {
				if (typeof day !== "object" || day === null) continue;
				const stored = day;
				const restored = {
					models: normalizeStore(stored.models),
					accounts: normalizeStore(stored.accounts)
				};
				if (stored.hours !== void 0) restored.hours = normalizeStore(stored.hours);
				const failures = normalizeCounts(stored.failures);
				if (failures !== void 0) restored.failures = failures;
				const failuresByAccount = normalizeCounts(stored.failuresByAccount);
				if (failuresByAccount !== void 0) restored.failuresByAccount = failuresByAccount;
				const ttft = normalizeBuckets(stored.ttft);
				if (ttft !== void 0) restored.ttft = ttft;
				this.days.set(date, restored);
			}
			this.prune(this.now());
		} catch {
			this.days.clear();
		} finally {
			this.loaded = true;
		}
	}
	day(dateKey) {
		let day = this.days.get(dateKey);
		if (day === void 0) {
			day = {
				models: {},
				accounts: {}
			};
			this.days.set(dateKey, day);
		}
		return day;
	}
	bucket(store, key) {
		let totals = store[key];
		if (totals === void 0) {
			totals = emptyTotals();
			store[key] = totals;
		}
		return totals;
	}
	/** 记一次请求（不等到 usage 帧）。 */
	noteRequest(accountId, model, at = this.now()) {
		const day = this.day(localDateKey(at));
		addTotals(this.bucket(day.models, model), { requests: 1 });
		addTotals(this.bucket(day.accounts, accountId), { requests: 1 });
		addTotals(this.bucket(this.hoursOf(day), localHourKey(at)), { requests: 1 });
		this.lastAt = at;
		this.prune(at);
		this.scheduleSave();
	}
	/** 记一次 usage 帧。 */
	noteUsage(accountId, model, raw, at = this.now()) {
		const usage = normalizeUsage(raw);
		if (usage.totalTokens === 0 && usage.promptTokens === 0 && usage.completionTokens === 0) return;
		const day = this.day(localDateKey(at));
		addTotals(this.bucket(day.models, model), usage);
		addTotals(this.bucket(day.accounts, accountId), usage);
		addTotals(this.bucket(this.hoursOf(day), localHourKey(at)), usage);
		this.lastAt = at;
		this.prune(at);
		this.scheduleSave();
	}
	/** 一天里的逐小时桶，第一次写的时候才建（老账本没有这个键）。 */
	hoursOf(day) {
		day.hours ??= {};
		return day.hours;
	}
	/**
	* 记一次失败请求。
	*
	* 只在「这次请求最终回给用户一个错误」时调用一次 —— 插件内部换号重试不算失败，
	* 否则一个排队重试就能把失败率刷成好几倍。`kind` 用 shim 的失败出口标识。
	*/
	noteFailure(kind, accountId, at = this.now()) {
		if (kind === "") return;
		const day = this.day(localDateKey(at));
		day.failures ??= {};
		day.failures[kind] = (day.failures[kind] ?? 0) + 1;
		if (accountId !== void 0 && accountId !== "") {
			day.failuresByAccount ??= {};
			day.failuresByAccount[accountId] = (day.failuresByAccount[accountId] ?? 0) + 1;
		}
		this.lastAt = at;
		this.prune(at);
		this.scheduleSave();
	}
	/**
	* 记一次首字延迟（毫秒），落进直方图。
	*
	* 从请求进入 shim 算起，到上游第一帧真的写给 DSH 为止 —— 排队和换号的时间都算进去，
	* 因为那正是用户盯着转圈等掉的时长。
	*/
	noteLatency(ms, at = this.now()) {
		if (!Number.isFinite(ms) || ms < 0) return;
		const day = this.day(localDateKey(at));
		day.ttft ??= new Array(TTFT_BUCKET_COUNT).fill(0);
		let index = TTFT_BUCKETS_MS.findIndex((limit) => ms <= limit);
		if (index < 0) index = TTFT_BUCKET_COUNT - 1;
		day.ttft[index] += 1;
		this.lastAt = at;
		this.prune(at);
		this.scheduleSave();
	}
	/**
	* 丢弃保留期之外的天（按日期键比较即可，YYYY-MM-DD 是字典序）。
	*
	* 顺带把两天之前的**小时桶**清掉：逐小时数据只有「今天按小时」在画，留着只是
	* 让 60 天的账本多出一个数量级的体积。
	*/
	prune(at) {
		if (this.days.size === 0) return;
		const cutoff = localDateKey(at - 5184e6);
		const hourCutoff = localDateKey(at - 1728e5);
		for (const [date, day] of [...this.days.entries()]) if (date < cutoff) this.days.delete(date);
		else if (date < hourCutoff && day.hours !== void 0) delete day.hours;
	}
	/** 当前快照（卡片与 CLI 都读它）。 */
	snapshot(at = this.now()) {
		const todayKey = localDateKey(at);
		const today = this.days.get(todayKey);
		const cutoff = localDateKey(at - 2592e6);
		const allTime = emptyTotals();
		const last30 = emptyTotals();
		for (const [date, day] of this.days) for (const totals of Object.values(day.models)) {
			mergeTotals(allTime, totals);
			if (date >= cutoff) mergeTotals(last30, totals);
		}
		const models = today?.models ?? {};
		const failuresByKind = today?.failures ?? {};
		const ttft = today?.ttft ?? [];
		const p50 = percentileOf(ttft, .5);
		const p95 = percentileOf(ttft, .95);
		return {
			today: {
				...emptyTotals(),
				...today === void 0 ? {} : sumOf(models)
			},
			allTime,
			last30,
			failuresToday: {
				total: Object.values(failuresByKind).reduce((sum, count) => sum + count, 0),
				byKind: { ...failuresByKind }
			},
			failuresByAccountToday: { ...today?.failuresByAccount ?? {} },
			latencyToday: {
				samples: ttft.reduce((sum, count) => sum + count, 0),
				...p50.value === void 0 ? {} : { p50: p50.value },
				...p95.value === void 0 ? {} : { p95: p95.value },
				overflow: p95.overflow
			},
			byModelToday: Object.entries(models).map(([id, totals]) => ({
				id,
				totals: { ...totals }
			})).sort((a, b) => b.totals.totalTokens - a.totals.totalTokens || (a.id < b.id ? -1 : 1)),
			byAccountToday: Object.fromEntries(Object.entries(today?.accounts ?? {}).map(([id, totals]) => [id, { ...totals }])),
			days: this.days.size,
			recentDays: this.recentDaysOf(at),
			todayByHour: this.todayByHourOf(today, at),
			...this.lastAt === void 0 ? {} : { lastAt: this.lastAt }
		};
	}
	/** 最近 TREND_DAYS 天的每日合计（按日期升序，缺账目的日子补 0）。 */
	recentDaysOf(at) {
		const out = [];
		for (let back = 34; back >= 0; back -= 1) {
			const date = localDateKey(at - back * 864e5);
			const day = this.days.get(date);
			out.push({
				date,
				totals: day === void 0 ? emptyTotals() : sumOf(day.models)
			});
		}
		return out;
	}
	/** 今天 0 点起的 24 个钟点（还没到的小时补 0，横轴才有固定的 24 格）。 */
	todayByHourOf(today, at) {
		const hours = today?.hours ?? {};
		const currentHour = new Date(at).getHours();
		return Array.from({ length: 24 }, (_, hour) => {
			const totals = hours[localHourKeyOfHour(hour)];
			return {
				hour,
				totals: hour > currentHour || totals === void 0 ? emptyTotals() : { ...totals }
			};
		});
	}
	scheduleSave() {
		if (this.path === void 0) return;
		if (this.saveTimer !== void 0) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = void 0;
			this.save();
		}, this.saveDebounceMs);
		this.saveTimer.unref?.();
	}
	/** 立即落盘（关停时调用，别丢最后几秒的账）。 */
	async flush() {
		if (this.saveTimer !== void 0) {
			clearTimeout(this.saveTimer);
			this.saveTimer = void 0;
		}
		await this.save();
	}
	save() {
		if (this.path === void 0) return Promise.resolve();
		const doc = {
			version: 1,
			days: Object.fromEntries(this.days)
		};
		this.saving = this.saving.then(() => writeJsonAtomic(this.path, doc), () => writeJsonAtomic(this.path, doc));
		return this.saving;
	}
};
/** 一批桶的合计。 */
function sumOf(store) {
	const out = emptyTotals();
	for (const totals of Object.values(store)) mergeTotals(out, totals);
	return out;
}
/**
* 直方图分位。
*
* 返回的是「落进的那一档的上界」而不是精确毫秒 —— 界面上显示 `≤200ms` 这种口径，
* 比伪造一个精确值诚实。落进溢出档时 `value` 缺省、`overflow` 为真。
*/
function percentileOf(buckets, ratio) {
	const total = buckets.reduce((sum, count) => sum + count, 0);
	if (total === 0) return { overflow: false };
	const target = Math.ceil(total * ratio);
	let seen = 0;
	for (let index = 0; index < buckets.length; index += 1) {
		seen += buckets[index] ?? 0;
		if (seen < target) continue;
		return index < TTFT_BUCKETS_MS.length ? {
			value: TTFT_BUCKETS_MS[index],
			overflow: false
		} : { overflow: true };
	}
	return { overflow: true };
}
//#endregion
//#region src/version.ts
const CODEARTS_VERSION = "1.3.0";
//#endregion
export { refreshCatalog as a, discoverModels as i, CodeArtsUsageTracker as n, codeartsUsagePath as r, CODEARTS_VERSION as t };
