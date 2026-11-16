import { n as __exportAll } from "./rolldown-runtime-B4iAMlE-.mjs";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { directFetch } from "../../../shared/net-rescue.js";
//#region src/catalog.ts
/**
* 参数表（不是模型名单）：只给**发现到的**模型补 `contextWindow` / `maxTokens` /
* `supportsImages`，绝不会因为这里有条目就把模型塞进目录。
*
* maxTokens 注记（2026-09-30 实测，scripts/param-probe.mjs 直连上游二分验证）：
* 福利 DeepSeek 模型的 max_tokens 服务端硬上限是 **65536**，更大的值
* （73728 / 98304 / 131072 / 384000 / 393216）一律流内报
* InferHub.001001005.400 "The request param is invalid, Please check it"。
* 此前的 384000/393216 是占位值：DSH 会把 catalog 的 maxTokens 作为
* max_tokens 原样发给上游，导致所有请求直接失败。
*/
const FALLBACK_CODEARTS_MODELS = [
	{
		id: "GLM-5.2",
		name: "GLM-5.2",
		contextWindow: 128e3,
		maxTokens: 8e3,
		supportsImages: true
	},
	{
		id: "GLM-5.1",
		name: "GLM-5.1",
		contextWindow: 128e3,
		maxTokens: 8e3,
		supportsImages: false
	},
	{
		id: "GLM-4.7",
		name: "GLM-4.7",
		contextWindow: 128e3,
		maxTokens: 8e3,
		supportsImages: true
	},
	{
		id: "OpenPangu-2.0-Pro",
		name: "OpenPangu 2.0 Pro",
		contextWindow: 32e3,
		maxTokens: 4e3,
		supportsImages: true
	},
	{
		id: "OpenPangu-2.0-Flash",
		name: "OpenPangu 2.0 Flash",
		contextWindow: 32e3,
		maxTokens: 4e3,
		supportsImages: true
	},
	{
		id: "Qwen3-VL-235B",
		name: "Qwen3-VL-235B",
		contextWindow: 128e3,
		maxTokens: 8e3,
		supportsImages: true
	},
	{
		id: "Qwen3.5-397B-A17B-VL",
		name: "Qwen3.5-397B-A17B-VL",
		contextWindow: 128e3,
		maxTokens: 8e3,
		supportsImages: true
	},
	{
		id: "Qwen3.6-27B-VL",
		name: "Qwen3.6-27B-VL",
		contextWindow: 128e3,
		maxTokens: 8e3,
		supportsImages: true
	},
	{
		id: "deepseek-v4-flash-0731",
		name: "DeepSeek-V4-Flash (福利)",
		contextWindow: 131072,
		maxTokens: 65536,
		supportsImages: true
	},
	{
		id: "deepseek-v4-pro-0813",
		name: "DeepSeek-V4-Pro (福利)",
		contextWindow: 131072,
		maxTokens: 65536,
		supportsImages: true
	},
	{
		id: "deepseek-v4.1-flash",
		name: "DeepSeek-V4.1-Flash",
		contextWindow: 131072,
		maxTokens: 65536,
		supportsImages: false
	},
	{
		id: "deepseek-v4.1-flash-1017",
		name: "DeepSeek-V4.1-Flash-1017",
		contextWindow: 1048576,
		maxTokens: 65536,
		supportsImages: true
	},
	{
		id: "glm-5.3-flash",
		name: "GLM-5.3-Flash (福利)",
		contextWindow: 128e3,
		maxTokens: 8e3,
		supportsImages: true
	}
];
/**
* 倍率的展示写法：福利恒为 `x0.00`，其余用上游的数值，拿不到就不显示。
*
* 福利模型不走积分，倍率显示成 0 比显示上游某个残留 credit 更接近事实。
*/
function creditRatioLabel(ratio, benefit) {
	if (benefit) return "x0.00";
	const value = (ratio ?? "").trim().replace(/x$/i, "").trim();
	return /^\d+(?:\.\d+)?$/.test(value) ? `x${Number(value).toFixed(2)}` : void 0;
}
/**
* 模型在宿主下拉里的**名字**带一个标记尾巴：` · x0.18`、` · x0.00 · 福利`。
*
* 写法照搬 dsh-codebuddy-cli 的 provider：倍率在前、上游徽章措辞在后，统一用
* ` · ` 连接（`Name · x0.71 · 限时免费`）。宿主自己的模型下拉只渲染文字，
* 插不进 Tag，所以那是用户唯一能看见标记的地方；插件卡片会反过来把尾巴剥掉、
* 改挂 Tag（见 client 的 modelName），两边都不会重复。
*/
function modelDisplayName(name, benefit, ratio) {
	const base = stripModelSuffixes(name);
	const parts = [creditRatioLabel(ratio, benefit), benefit ? "福利" : void 0].filter((part) => part !== void 0);
	return parts.length === 0 ? base : `${base} · ${parts.join(" · ")}`;
}
/**
* 剥掉模型名尾巴上的标记：` · x0.18`、` · x0.00 · 福利`、`(福利)`、`(免费)`、
* `(x0.18)` 等（兼容旧格式）。
*/
function stripModelSuffixes(name) {
	let base = name;
	for (;;) {
		const next = base.replace(/\s*·\s*(?:x\d+(?:\.\d+)?|(?:限时)?(?:免费|福利)(?:\s+x\d+(?:\.\d+)?)?)\s*$/, "");
		if (next === base) break;
		base = next;
	}
	return base.replace(/\s*[（(]\s*(?:(?:免费|福利)(?:\s+x\d+(?:\.\d+)?)?|x\d+(?:\.\d+)?)\s*[)）]\s*$/, "").trim();
}
/** Mutable catalog shared by the shim's `/v1/models` and the adapter. */
var CodeArtsCatalog = class {
	/** 空目录起步：没发现过就是没有模型，不拿历史名单冒充。 */
	models = [];
	current() {
		return this.models;
	}
	set(models) {
		this.models = [...models];
	}
};
/**
* Narrow a catalog to the user's enabled selection (allowlist of model ids).
* Same semantics as the codebuddy plugin: absent or empty => serve all.
*/
function filterEnabledModels(models, enabled) {
	if (enabled === void 0 || enabled.length === 0) return models;
	const allow = new Set(enabled);
	const kept = models.filter((model) => allow.has(model.id));
	return kept.length === 0 ? models : kept;
}
/**
* 动态发现确认的福利模型（小写 id）—— 这是「是不是福利」的**唯一**依据。
*
* 只认 `gateway/config` 给过的名单，没有静态兜底：猜错一次的代价不对称 ——
* 漏带 `maas_type: benefit` 是福利模型报 404（它本来就不可用），多带一次却是把
* 一个正常能用的积分模型推进一条不存在的渠道，直接 benefit not found。
*
* 与 codearts2api 的差别：那边按账号隔离目录，本插件的聊天链路（shim → upstream）
* 拿不到账号上下文，所以这里取所有成功账号的并集。
*/
const discoveredBenefit = /* @__PURE__ */ new Set();
/** 用一次发现的结果替换动态福利集合（传空数组表示「本轮确认没有福利模型」）。 */
function setDiscoveredBenefitModels(ids) {
	discoveredBenefit.clear();
	for (const id of ids) {
		const key = id.trim().toLowerCase();
		if (key !== "") discoveredBenefit.add(key);
	}
}
/**
* 该模型是否走限时福利路由（按小写 ID 判定）。
*
* 只认发现结果：`gateway/config` 没给过的模型一律不算福利，没有静态兜底。
*/
function isBenefitModel(id) {
	return discoveredBenefit.has(id.trim().toLowerCase());
}
/**
* 今天被上游判定「没有福利权益」的模型（小写 id -> 本地日期键）。
*
* 判据只有一个：聊天回 `InferHub.4004.200 benefit not found`。上游没有任何接口能
* 提前告诉我们福利余量（`statistics/plugin` 的 `model_quota_num` 实测恒为 -1，
* 唯一能给数的 opengw balance 也不覆盖福利池），所以只能「失败一次才知道」。
*
* 按本地日期存：福利是每天发的，昨天的失败不代表今天。卡片据此把模型标成
* 「福利今日不可用」，但**不**替用户取消勾选 —— 那是改他的设置。
*/
const benefitBlocked = /* @__PURE__ */ new Map();
function localDayKey(at = Date.now()) {
	const d = new Date(at);
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${month}-${day}`;
}
/** 记一次「这个模型今天没有福利权益」。 */
function markBenefitBlocked(id) {
	const key = id.trim().toLowerCase();
	if (key !== "") benefitBlocked.set(key, localDayKey());
}
/** 该模型今天是否已经因为福利权益缺失失败过。 */
function isBenefitBlocked(id) {
	const key = id.trim().toLowerCase();
	const day = benefitBlocked.get(key);
	if (day === void 0) return false;
	if (day === localDayKey()) return true;
	benefitBlocked.delete(key);
	return false;
}
/** 清空福利缺失记录 —— 手动刷新模型列表时调，给用户一个自救出口。 */
function clearBenefitBlocked() {
	benefitBlocked.clear();
}
/**
* 今天被上游明确拒绝「模型不存在 / 本账号无权限」的模型（小写 id -> 原因）。
*
* 判据只有聊天回的 `InferHub.ModelArts.81003.401`。上游的模型发现**照样列出它**
* （2026-11-02 实测 `deepseek-v4.1-flash` 两路都在清单里），所以刷新模型列表救不了 ——
* 只能等上游修好，或第二天再看。这也是「刷新清单 ≠ 验证可调用」的落点。
*
* 与福利缺失标记同口径：**只标记，不替用户取消勾选**。多账号下这个错误只有在
* 所有号都试过之后才会浮上来，所以按模型记全局（不按账号）。
*/
const unavailableModels = /* @__PURE__ */ new Map();
/** 记一次「上游判定这个模型不可用」。 */
function markModelUnavailable(id, reason) {
	const key = id.trim().toLowerCase();
	if (key !== "") unavailableModels.set(key, {
		day: localDayKey(),
		reason
	});
}
/** 该模型今天是否已被上游判定不可用；是则返回原因（卡片悬浮显示）。 */
function modelUnavailableReason(id) {
	const key = id.trim().toLowerCase();
	const entry = unavailableModels.get(key);
	if (entry === void 0) return void 0;
	if (entry.day === localDayKey()) return entry.reason;
	unavailableModels.delete(key);
}
/** 单独清掉一个模型的不可用标记（手动测试成功后调）。 */
function forgetModelUnavailable(id) {
	unavailableModels.delete(id.trim().toLowerCase());
}
/**
* 合并多路来源的模型清单（内置 / 限时福利 / agent-center）。
*
* 规则对齐 codearts2api 的 `MergeModels`：
*  - 按小写 id 去重（上游注册名大小写敏感，但同一模型的书写可能不一致）；
*  - `benefit` 取或：漏标一次就是一次 404；
*  - 参数更全的一条优先（有 contextWindow > 没有，supportsImages 为真优先）；
*  - 输出按小写 id 排序，保证 `/v1/models` 在刷新前后顺序稳定。
*/
function mergeModelLists(sets) {
	const merged = /* @__PURE__ */ new Map();
	for (const set of sets) for (const model of set) {
		const id = model.id.trim();
		if (id === "") continue;
		const key = id.toLowerCase();
		const normalized = {
			...model,
			id
		};
		const current = merged.get(key);
		merged.set(key, current === void 0 ? normalized : richerModel(current, normalized));
	}
	return [...merged.values()].sort((a, b) => {
		const la = a.id.toLowerCase();
		const lb = b.id.toLowerCase();
		return la === lb ? a.id < b.id ? -1 : 1 : la < lb ? -1 : 1;
	});
}
/**
* 同一模型两条记录取更全的一条；`benefit` 永远取或。
*
* 基底用 `{ ...keep }` 而不是逐字段手抄：以前这里只抄自己想到的几个字段，
* `contextWindowKnown` 被静默丢掉 —— 多账号时每个 id 都要过一次这条函数，卡片的
* 「上下文」整列就成了「—」，而上游其实给了值。以后新增可选字段不用再记得改这里。
*/
function richerModel(current, next) {
	const benefit = current.benefit === true || next.benefit === true;
	const keep = richerThan(next, current) ? next : current;
	const drop = keep === next ? current : next;
	const ratio = keep.ratio ?? drop.ratio;
	const thinking = keep.thinking ?? drop.thinking;
	const ctxFrom = keep.contextWindow > 0 ? keep : drop;
	const merged = {
		...keep,
		id: keep.id,
		name: keep.name || drop.name || keep.id,
		contextWindow: ctxFrom.contextWindow,
		maxTokens: keep.maxTokens > 0 ? keep.maxTokens : drop.maxTokens,
		supportsImages: keep.supportsImages || drop.supportsImages,
		...ratio === void 0 ? {} : { ratio },
		...thinking === void 0 ? {} : { thinking },
		...benefit ? { benefit: true } : {}
	};
	if (ctxFrom.contextWindowKnown === true) merged.contextWindowKnown = true;
	else delete merged.contextWindowKnown;
	return merged;
}
/** a 是否比 b 更值得保留：先认「上游真给的上下文窗口」，再比参数，最后比大小写。 */
function richerThan(a, b) {
	const aKnown = a.contextWindowKnown === true;
	if (aKnown !== (b.contextWindowKnown === true)) return aKnown;
	if (a.contextWindow > 0 !== b.contextWindow > 0) return a.contextWindow > 0;
	if (a.maxTokens > 0 !== b.maxTokens > 0) return a.maxTokens > 0;
	return a.id !== a.id.toLowerCase() && b.id === b.id.toLowerCase();
}
/**
* 用参数表给**发现结果**补 0 值字段。参数表里有、上游这次没返回的模型 —— 不塞进目录。
*
* 为什么不能把参数表一起丢进 `mergeModelLists`：那个函数按「参数更全/大小写更像注册名」
* 选记录，表里的占位值（例如 OpenPangu 的 ctx 32000 / max 4000）会凭大小写规则
* 压过上游返回的真实值（ctx 524288 / max 131072）。所以顺序必须是
* 「先合并发现结果 → 再用参数表补 0 值字段」。
*/
function backfillParams(discovered, params = FALLBACK_CODEARTS_MODELS) {
	const byId = /* @__PURE__ */ new Map();
	for (const model of discovered) byId.set(model.id.toLowerCase(), { ...model });
	for (const fallback of params) {
		const current = byId.get(fallback.id.toLowerCase());
		if (current === void 0) continue;
		byId.set(fallback.id.toLowerCase(), {
			id: current.id,
			name: current.name || fallback.name,
			contextWindow: current.contextWindow > 0 ? current.contextWindow : fallback.contextWindow,
			maxTokens: current.maxTokens > 0 ? current.maxTokens : fallback.maxTokens,
			supportsImages: current.supportsImages || fallback.supportsImages,
			...current.ratio === void 0 ? {} : { ratio: current.ratio },
			...current.thinking === void 0 ? {} : { thinking: current.thinking },
			...current.benefit === true ? { benefit: true } : {}
		});
	}
	return [...byId.values()].sort((a, b) => {
		const la = a.id.toLowerCase();
		const lb = b.id.toLowerCase();
		return la === lb ? a.id < b.id ? -1 : 1 : la < lb ? -1 : 1;
	});
}
//#endregion
//#region src/signer.ts
/**
* 华为云 SDK-HMAC-SHA256 请求签名（AK/SK + 可选 STS security token）。
* 翻译自 codearts2api 的 internal/upstream/signer.go，对齐华为云 AKSKSigner。
*
* 在 CodeArts 桌面端实测：聊天请求必须用 AK/SK 签名，光传 x-auth-token 会被
* APIG 拒（APIG.0301 decrypt token fail）。
*
* @module dsh-codearts/signer
*/
const ALGO = "SDK-HMAC-SHA256";
function sha256Hex(buf) {
	return createHash("sha256").update(buf).digest("hex");
}
function hmacHex(key, msg) {
	return createHmac("sha256", key).update(msg).digest("hex");
}
/** 华为云 X-Sdk-Date 格式：20060102T150405Z（UTC，无分隔符、无毫秒）。 */
function sdkDate(d) {
	const p = (n, w = 2) => String(n).padStart(w, "0");
	return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
function canonicalURI(path) {
	let out = path.split("/").map((s) => encodeURIComponent(s)).join("/");
	if (!out.endsWith("/")) out += "/";
	return out;
}
function canonicalQuery(raw) {
	if (!raw) return "";
	const params = new URLSearchParams(raw);
	const keys = [...new Set(params.keys())].sort();
	const parts = [];
	for (const k of keys) {
		const vals = params.getAll(k).sort();
		for (const v of vals) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
	}
	return parts.join("&");
}
/**
* 给一个 fetch Request 加上 X-Sdk-Date / X-Security-Token / X-Sdk-Content-Sha256
* / Authorization 头。body 为请求体（用于 payload hash）。
*
* 注意：Host 头 fetch 不允许手动 set，但签名必须包含 host，所以我们在签名计算
* 里从 URL 取 host 补一个虚拟 host 行，Authorization 写回即可（fetch 实际发出的
* Host 与 URL.host 一致）。
*/
function signRequest(req, body, cred) {
	const xDate = sdkDate(/* @__PURE__ */ new Date());
	req.headers.set("X-Sdk-Date", xDate);
	if (cred.securityToken) req.headers.set("X-Security-Token", cred.securityToken);
	const payloadHash = sha256Hex(body);
	req.headers.set("X-Sdk-Content-Sha256", payloadHash);
	const url = new URL(req.url);
	const host = url.host;
	const all = [];
	req.headers.forEach((v, k) => all.push([k.toLowerCase(), v.trim()]));
	all.push(["host", host]);
	all.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
	let canonicalHeaders = "";
	const signed = [];
	for (const [k, v] of all) {
		canonicalHeaders += `${k}:${v}\n`;
		signed.push(k);
	}
	const signedHeaders = signed.join(";");
	const canonicalRequest = [
		req.method,
		canonicalURI(url.pathname),
		canonicalQuery(url.search.slice(1)),
		canonicalHeaders,
		signedHeaders,
		payloadHash
	].join("\n");
	const stringToSign = [
		ALGO,
		xDate,
		sha256Hex(canonicalRequest)
	].join("\n");
	const signature = hmacHex(cred.secretAccessKey, stringToSign);
	req.headers.set("Authorization", `${ALGO} Access=${cred.accessKeyId}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
}
//#endregion
//#region src/upstream.ts
/**
* CodeArts 真实聊天协议（翻译自 codearts2api 逆向，consumer 版 cn-north-4）。
*
* 聊天走 OpenAI 兼容端点：
*   POST /api/v2/chat/completions  （snap-access.cn-north-4.myhuaweicloud.com）
* 鉴权为 x-auth-token = STS security_token，并叠加华为云 AK/SK SDK-HMAC-SHA256
* 签名（与官方 AgentKernel 一致）。请求体是标准 OpenAI 形状（role/content），
* 响应 SSE 也是 OpenAI 增量（choices[].delta.content），但含有华为特有事件
* （累计全文快照 + 结束态 error_code），本模块做兼容转换。
*
* @module dsh-codearts/upstream
*/
var upstream_exports = /* @__PURE__ */ __exportAll({
	BENEFIT_MISSING_CODE: () => BENEFIT_MISSING_CODE,
	CONCURRENCY_CAP_CODE: () => CONCURRENCY_CAP_CODE,
	MAX_TOKENS_CEILING: () => MAX_TOKENS_CEILING,
	PARAM_INVALID_CODE: () => PARAM_INVALID_CODE,
	SNAP_HOST: () => SNAP_HOST,
	TPM_LIMIT_CODE: () => TPM_LIMIT_CODE,
	canonicalModel: () => canonicalModel,
	chatStream: () => chatStream,
	claimBenefit: () => claimBenefit,
	claimDailyWelfare: () => claimDailyWelfare,
	clearQueueStatus: () => clearQueueStatus,
	degradeTokenCeiling: () => degradeTokenCeiling,
	estimateImageTokens: () => estimateImageTokens,
	estimatePromptTokens: () => estimatePromptTokens,
	estimateTokens: () => estimateTokens,
	fetchCallerIdentity: () => fetchCallerIdentity,
	fetchModels: () => fetchModels,
	fetchQueueStatus: () => fetchQueueStatus,
	fetchWelfareCampaigns: () => fetchWelfareCampaigns,
	firstFrameError: () => firstFrameError,
	isBenefitMissing: () => isBenefitMissing,
	isConcurrencyCap: () => isConcurrencyCap,
	isIamTokenError: () => isIamTokenError,
	isModelNotAccessible: () => isModelNotAccessible,
	isNotMultimodal: () => isNotMultimodal,
	isParamInvalidFrame: () => isParamInvalidFrame,
	isQueueableRate: () => isQueueableRate,
	isResignRefusal: () => isResignRefusal,
	isTpmLimit: () => isTpmLimit,
	isWelfareClaimedStatus: () => isWelfareClaimedStatus,
	maxTokensCeilingFor: () => maxTokensCeilingFor,
	modelUnavailableReasonText: () => modelUnavailableReasonText,
	pickDailyWelfareCampaign: () => pickDailyWelfareCampaign,
	prepareChatBody: () => prepareChatBody,
	rateLimitFrame: () => rateLimitFrame,
	signedGet: () => signedGet,
	upstreamErrorMessage: () => upstreamErrorMessage
});
const SNAP_HOST = "https://snap-access.cn-north-4.myhuaweicloud.com";
const EP_CHAT = "/api/v2/chat/completions";
const BENEFIT_HOST = "https://opengw.developer.huaweicloud.com";
const EP_BENEFIT_CLAIM = "/api/v1/benefit/claim";
const EP_MODEL_BUILTIN = "/v1/model/builtin";
const EP_BENEFIT_CONFIG = "/api/v1/gateway/config";
const EP_AGENT_LIST = "/v1/agent-center/agents/useragents";
const EP_AGENT_DETAIL = "/v1/agent-center/agents/detail";
/**
* 模型的思考强度清单（26.10.0 新增）。**必须带 `Agent-Type: PromptCenter`**：
* 不带头时上游回 `TM.00001001 请求头Agent-Type为空`（实测）。
*/
const EP_THINKING_VARIANTS = "/v1/model/thinking-variants";
/** 排队位置（26.10.0 新增）：按 chat_id 查这条请求在上游队里的排位。 */
const EP_QUEUE_STATUS = "/api/v1/queue/status";
/**
* 当前登录身份。**必须带 `/snap-manager` 前缀**：2026-09-30 实测
* `/v1/current/user` 是 APIG.0101（未发布），`/snap-manager/v1/current/user`
* 才返回 `{user_id, user_name, domain_id}`。codearts2api 的 const.go 里少了这段前缀
* （它另有 STS 的 `/v5/caller-identity`，但那条对 STS 临时凭证返回 401）。
*/
const EP_CURRENT_USER = "/snap-manager/v1/current/user";
const STATIC_MODEL_MAP = {
	"snap-chat": "GLM-5.2",
	"glm-5.2": "GLM-5.2",
	"glm-5.1": "GLM-5.1",
	"glm-4.7": "GLM-4.7",
	"openpangu-2.0-pro": "OpenPangu-2.0-Pro",
	"openpangu-2.0-flash": "OpenPangu-2.0-Flash",
	"qwen3-vl-235b": "Qwen3-VL-235B",
	"qwen3.5-397b-a17b-vl": "Qwen3.5-397B-A17B-VL",
	"qwen3.6-27b-vl": "Qwen3.6-27B-VL",
	"deepseek-v4-flash": "deepseek-v4-flash-0731",
	"deepseek-v4-pro": "deepseek-v4-pro-0813",
	"glm-5.3-flash": "glm-5.3-flash"
};
function canonicalModel(id) {
	return STATIC_MODEL_MAP[id.toLowerCase()] ?? id;
}
function hex32() {
	return randomBytes(16).toString("hex");
}
function randomTraceId() {
	return hex32();
}
/** 上游对 max_tokens 的服务端硬上限（2026-09-30 直连二分实测）。 */
const MAX_TOKENS_CEILING = 65536;
/** token 估算的余量：混排误差 + 上游自己注入的会话头，宁可少给也别整轮失败。 */
const PROMPT_ESTIMATE_MARGIN = 2048;
/** 短于此的生成长度就没有实际意义了，此时直接报具体错误而不是硬挤。 */
const MIN_USEFUL_OUTPUT_TOKENS = 1024;
/**
* 实测过的、**按模型**的 max_tokens 上限（小写 id → 上限）。
*
* 这个上限是模型相关的，不能用一个全局值：
*  - 免费（限时福利）DeepSeek 系列：> 65536 会被流内 InferHub.001001005.400
*    "The request param is invalid" 拒掉，而福利网关标称的是 393216 / 384000；
*  - GLM-5.2：2026-09-30 逐值直连验证过 8000/65536/131072 均正常，但
*    **2026-10-10 复测 131072 已经被拒**（同一个 InferHub.001001005.400），
*    65536 仍然正常。也就是说这条上限由服务端控制、会漂，目录里留着的旧实测值
*    不会报错，只会让该模型的每一轮在流的第一帧就失败 —— 所以复测要按日期记。
*
* 没测过的模型一律退回 `MAX_TOKENS_CEILING`（保守但可用），而不是照抄标称值 ——
* DSH 会把 catalog 的 maxTokens 原样当 max_tokens 发出去，照抄标称值等于让请求失败。
* 新增实测结果时往这里加一行即可（scripts/param-probe.mjs 与
* scripts/probe-models.ts 是得到这些数字的工具）。
*/
const MEASURED_MAX_TOKENS = {
	"deepseek-v4-flash-0731": 65536,
	"deepseek-v4-pro-0813": 65536,
	"deepseek-v4.1-flash": 65536,
	"glm-5.3-flash": 65536,
	"glm-5.2": 65536
};
/** 该模型可用的 max_tokens 上限（实测值与会话内学到的更低值取小）。 */
function maxTokensCeilingFor(id) {
	const measured = measuredCeilingFor(id);
	const learned = learnedMaxTokens.get(ceilingKey(id));
	return learned === void 0 ? measured : Math.min(measured, learned);
}
/**
* 上游的「参数非法」错误码。它是**流内**帧（HTTP 仍是 200），所以既不走
* classify()，也不会告诉我们是哪个参数错、更不区分「max_tokens 太大」和
* 「prompt 装不下」—— 一切得我们自己判。
*/
const PARAM_INVALID_CODE = "InferHub.001001005.400";
/** 一帧（chatStream 已把上游 error_code 转成 OpenAI error 帧）是不是那条「参数非法」。 */
function isParamInvalidFrame(text) {
	return text.includes("InferHub.001001005.400") || text.includes("The request param is invalid");
}
/**
* 本次进程内学到的上限（小写 id → 上限）。
*
* 上游会把「实测过」的值悄悄调低（GLM-5.2 的 131072 于 2026-10-10 被收），
* 手工表必然滞后。所以撞到「参数非法」时就地折半降档重试，并把结果记在这里，
* 免得该模型后面每一轮都先白撞一次。
*/
const learnedMaxTokens = /* @__PURE__ */ new Map();
/** 降档下限：再低就没有可用的生成长度了，此时宁可把具体错误报给用户。 */
const MAX_TOKENS_FLOOR = 8192;
function ceilingKey(id) {
	return id.trim().toLowerCase();
}
function measuredCeilingFor(id) {
	return MEASURED_MAX_TOKENS[ceilingKey(id)] ?? 65536;
}
/**
* 把该模型的上限折半降一档（收到「参数非法」后重发之前调用）。
* @returns 新的上限；已经降到底则返回 0，表示别再试了。
*/
function degradeTokenCeiling(id) {
	const next = Math.floor(maxTokensCeilingFor(id) / 2);
	if (next < MAX_TOKENS_FLOOR) return 0;
	learnedMaxTokens.set(ceilingKey(id), next);
	return next;
}
/**
* 粗估一段**文本**占多少 token：CJK 每字约 1，其余每 4 字符约 1。
*
* 只要保守就够用 —— 它的用途是「在我们这边就把装不下的情况判掉」，
* 而不是精确计费（上游不会告诉我们超没超，只会回一句参数非法）。
*
* **不要拿它去量带图的 content。** 图片在请求里是 base64 字面量，按字符折算会
* 虚报两个数量级；整条 prompt 的估算走 `estimatePromptTokens`。
*/
function estimateTokens(text) {
	let cjk = 0;
	for (let i = 0; i < text.length; i += 1) {
		const code = text.charCodeAt(i);
		if (code >= 12352 && code <= 40959 || code >= 44032 && code <= 64511 || code >= 65280 && code <= 65376) cjk += 1;
	}
	return Math.ceil(cjk + (text.length - cjk) / 4);
}
/** 单张图 token 的下限/上限：防止极端尺寸把整个估算拉飞。 */
const IMAGE_TOKEN_MIN = 85;
const IMAGE_TOKEN_MAX = 8e3;
/**
* 视觉编码器把图切成 28×28 的块，每块约 1 token —— 所以图片的代价随**像素面积**
* 走，和它在请求里编码成多少字符无关。
*/
const IMAGE_PATCH_AREA = 784;
/** 读不出图片尺寸时的保守兜底（≈ 一张 1024×1024）。 */
const IMAGE_TOKEN_FALLBACK = 1600;
/** 解析图片头最多解码这么多 base64 字符（≈72 KB）：够覆盖 PNG IHDR 与 JPEG 的 SOF。 */
const IMAGE_HEAD_BASE64_CHARS = 98304;
function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}
function be32(bytes, offset) {
	return (bytes[offset] << 24 | bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]) >>> 0;
}
/** 从图片头读宽高（不解码像素）。认不出格式返回 undefined。 */
function imageDimensions(bytes) {
	if (bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return {
		width: be32(bytes, 16),
		height: be32(bytes, 20)
	};
	if (bytes.length >= 10 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) return {
		width: bytes[6] | bytes[7] << 8,
		height: bytes[8] | bytes[9] << 8
	};
	if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
		let i = 2;
		while (i + 9 < bytes.length) {
			if (bytes[i] !== 255) {
				i += 1;
				continue;
			}
			const marker = bytes[i + 1];
			if (marker === 216 || marker === 1 || marker >= 208 && marker <= 215) {
				i += 2;
				continue;
			}
			const length = bytes[i + 2] << 8 | bytes[i + 3];
			if (length <= 0) break;
			if (marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) return {
				height: bytes[i + 5] << 8 | bytes[i + 6],
				width: bytes[i + 7] << 8 | bytes[i + 8]
			};
			i += 2 + length;
		}
	}
}
/**
* 一张 `data:image/...;base64,...` 占多少 token。
*
* **不能拿 estimateTokens 去量 base64。** 一张 400 KB 的 A4 页渲染图 base64 后约
* 55 万字符，按「4 字符 1 token」会算成 13.7 万 token —— 比真实视觉编码器的读数
* 大两个数量级（同一张图通常 1~3 千）。后果是宿主那边上下文还很空、插件这边已经
* 报「上下文放不下」，用户只看到一句让他新建会话的错，实际上一次都没发出去。
*
* 所以图片单独走面积估算：读图片头拿宽高，按 28×28 的块数折算。
*/
function estimateImageTokens(url) {
	const comma = url.indexOf(",");
	if (comma === -1 || !/^data:image\//i.test(url.slice(0, comma))) return IMAGE_TOKEN_FALLBACK;
	const base64 = url.slice(comma + 1, comma + 1 + IMAGE_HEAD_BASE64_CHARS);
	let bytes;
	try {
		bytes = new Uint8Array(Buffer.from(base64, "base64"));
	} catch {
		return IMAGE_TOKEN_FALLBACK;
	}
	const size = imageDimensions(bytes);
	if (!size || size.width <= 0 || size.height <= 0) return IMAGE_TOKEN_FALLBACK;
	return clamp(Math.ceil(size.width * size.height / IMAGE_PATCH_AREA), IMAGE_TOKEN_MIN, IMAGE_TOKEN_MAX);
}
/** 一条消息 content 的 token 数：文本走 estimateTokens，图片走面积估算。 */
function estimateContentTokens(content) {
	if (typeof content === "string") return estimateTokens(content);
	if (content === void 0 || content === null) return 0;
	if (!Array.isArray(content)) return estimateTokens(JSON.stringify(content));
	let total = 0;
	for (const part of content) {
		if (!part || typeof part !== "object") {
			total += estimateTokens(JSON.stringify(part ?? ""));
			continue;
		}
		const block = part;
		if (block.type === "image_url") {
			const image = block.image_url;
			const url = typeof image === "string" ? image : typeof image?.url === "string" ? image.url : "";
			total += estimateImageTokens(url);
			continue;
		}
		if (block.type === "text" && typeof block.text === "string") {
			total += estimateTokens(block.text);
			continue;
		}
		total += estimateTokens(JSON.stringify(block));
	}
	return total;
}
/**
* 整个 prompt 的 token 数（messages + tools）。
*
* 逐条走 `estimateContentTokens`，而不是 `estimateTokens(JSON.stringify(messages))`：
* 后者会把图片的 base64 当成正文去量，一条带图的请求就能虚报出几十万 token。
* 非 content 的结构化字段（role / tool_calls / tool_call_id / name）照旧按 JSON 量。
*/
function estimatePromptTokens(messages, tools) {
	let total = 0;
	if (Array.isArray(messages)) for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const record = message;
		total += estimateContentTokens(record.content);
		const { content: _content, ...rest } = record;
		if (Object.keys(rest).length > 0) total += estimateTokens(JSON.stringify(rest));
	}
	else if (messages !== void 0) total += estimateTokens(JSON.stringify(messages));
	if (tools !== void 0) total += estimateTokens(JSON.stringify(tools));
	return total;
}
/** 上游要求 chat_id 为 32 位小写十六进制。 */
const CHAT_ID_RE = /^[0-9a-f]{32}$/;
/** 稳定地把消息内容序列化成锚点文本（字符串原样，多模态数组走 JSON）。 */
function canonicalContent(content) {
	if (typeof content === "string") return content;
	if (content === void 0 || content === null) return "";
	try {
		return JSON.stringify(content);
	} catch {
		return String(content);
	}
}
/**
* 为一次对话派生稳定的 chat_id。
*
* 上游按 chat_id 计会话，而并发会话数有上限且回收很慢。若每个请求都新开一个
* chat_id，多轮对话几轮之后就会撞上「并发会话数已达上限」——历史在增长，但
* **首条 user 消息始终不变**，所以拿它当会话锚点：同一次对话的每一轮共用同一个
* chat_id，只占一个会话。
*
* 客户端若显式给了 conversation_id（32 位 hex）则优先用它。
*/
function conversationChatId(parsed) {
	const explicit = typeof parsed.conversation_id === "string" ? parsed.conversation_id.trim().toLowerCase() : "";
	if (CHAT_ID_RE.test(explicit)) return explicit;
	const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
	for (const raw of messages) {
		const message = raw;
		if (message?.role !== "user") continue;
		let anchor = `${message.role}\u0000${canonicalContent(message.content)}`;
		if (Array.isArray(parsed.tools) && parsed.tools.length > 0) anchor += "\0tools";
		return createHash("sha256").update(anchor).digest("hex").slice(0, 32);
	}
	return hex32();
}
/**
* 由 chat_id 派生稳定的会话标识，作为 `Session-Id` 头发给上游。
* 与参考实现 codearts2api 的 sessionIDFor 一致（sha256 前 16 字节）。
*/
function sessionIdFor(chatId) {
	return createHash("sha256").update(`codearts-session:${chatId}`).digest("hex").slice(0, 32);
}
/**
* 把 OpenAI 风格 chat body 适配给 CodeArts /api/v2/chat/completions。
* 该端点虽是 OpenAI 兼容，但网关按自己的 schema 严格校验参数。所以这里
* 不做原样透传，而是：
*  1. model 走 canonicalModel（大小写敏感）
*  2. max_completion_tokens → max_tokens（华为只认后者），并钳到该模型的上限；
*     再按 contextWindow 扣掉 prompt 估算，保证 prompt + max_tokens 装得下
*     （两者任一超限，上游都只会流内回 InferHub.001001005.400
*     "The request param is invalid, Please check it"，不告诉我们是哪一个）
*  3. 丢弃非白名单字段（stream_options / store / logprobs 等虽实测可容忍，
*     但按 codearts2api 观察到的真实流量收窄，避免网关后续收紧）；
*     例外是 `reasoning_effort`（DSH 的思考档位）：官方内核同样以这个顶层字段
*     透传 variant，见 kernel 的 `inferhub getArgs`。
*  4. tools[].function 去掉 strict（OpenAI 专有）
*  5. 注入 CodeArts 特有字段：chat_id（按对话派生，见 conversationChatId）、
*     prompt_cache_key、tool_stream
*
* @param contextWindow 该模型的上下文窗口（来自 catalog）。传 0 表示不知道，
*   此时只做上限钳制、不做「装不下」判断。
*/
function prepareChatBody(rawJson, contextWindow = 0) {
	let parsed = {};
	try {
		parsed = JSON.parse(rawJson);
	} catch {
		return {
			url: `${SNAP_HOST}${EP_CHAT}`,
			body: rawJson,
			model: "",
			chatId: ""
		};
	}
	const model = typeof parsed.model === "string" ? canonicalModel(parsed.model) : "";
	const chatId = conversationChatId(parsed);
	const body = {};
	for (const key of [
		"messages",
		"temperature",
		"top_p",
		"max_tokens",
		"stop",
		"presence_penalty",
		"frequency_penalty",
		"tools",
		"tool_choice",
		"user",
		"stream_options",
		"reasoning_effort"
	]) if (parsed[key] !== void 0) body[key] = parsed[key];
	if (Array.isArray(body.messages)) body.messages = body.messages.map((message) => message?.role === "developer" ? {
		...message,
		role: "system"
	} : message);
	if (body.stream_options === void 0 || typeof body.stream_options !== "object") body.stream_options = { include_usage: true };
	else body.stream_options.include_usage = true;
	if (body.max_tokens === void 0 && typeof parsed.max_completion_tokens === "number") body.max_tokens = parsed.max_completion_tokens;
	const ceiling = maxTokensCeilingFor(model);
	if (typeof body.max_tokens === "number") {
		let maxTokens = Math.min(body.max_tokens, ceiling);
		if (contextWindow > 0) {
			const promptTokens = estimatePromptTokens(body.messages, body.tools);
			const room = contextWindow - promptTokens - PROMPT_ESTIMATE_MARGIN;
			if (room < MIN_USEFUL_OUTPUT_TOKENS) {
				body.max_tokens = maxTokens;
				return {
					url: `${SNAP_HOST}${EP_CHAT}`,
					body: JSON.stringify(body),
					model,
					chatId,
					error: `上下文放不下：${model} 的窗口是 ${contextWindow} tokens，本次请求（含 ${Array.isArray(body.messages) ? body.messages.length : 0} 条消息与工具定义）估算约 ${promptTokens} tokens，剩余不足 ${MIN_USEFUL_OUTPUT_TOKENS} tokens 的生成余量。请新建会话或改用上下文更大的模型。`
				};
			}
			maxTokens = Math.min(maxTokens, room);
		}
		body.max_tokens = maxTokens;
	}
	if (Array.isArray(body.tools)) body.tools = body.tools.map((tool) => {
		if (tool && typeof tool === "object" && tool.function && typeof tool.function === "object") {
			const fn = { ...tool.function };
			delete fn.strict;
			return {
				...tool,
				function: fn
			};
		}
		return tool;
	});
	body.model = model;
	body.stream = true;
	body.chat_id = chatId;
	body.prompt_cache_key = chatId;
	body.tool_stream = true;
	return {
		url: `${SNAP_HOST}${EP_CHAT}`,
		body: JSON.stringify(body),
		model,
		chatId
	};
}
/**
* 免费档的「并发会话数已达上限」。实测 HTTP 400 + 这个错误码，上限是 3 个会话，
* 而且被掐断/挂起的流要约 2 分钟才被网关回收。它不是请求错误，重发就有机会，
* 所以 shim 要在本地排队重等，而不是把它变成 pi-ai 的重试风暴。
*/
const CONCURRENCY_CAP_CODE = "TM.00001041";
function isConcurrencyCap(result) {
	return !result.ok && result.message.includes("TM.00001041");
}
/**
* 模型级 TPM（tokens per minute）配额超限。2026-10-21 实测：它和并发上限不同，
* 是**流内首帧**（HTTP 200）回的，所以照样绕过了 classify；换号也没用（配额按
* 模型共享），能做的只有本地排队等窗口滑过去。
*
* 上游的码并不固定：同一小时内见过 `InferHub.ModelArts.81111.429`（"The model TPM
* limit has been significantly exceeded."）和 `InferHub.ModelArts.81114.429`
* （"Too many requests, the rate limit is 50000000 tokens per minute."）。所以按
* 形状认（ModelArts.*.429）而不是按某一个常量认。
*/
const TPM_LIMIT_CODE = "InferHub.ModelArts.81111.429";
const MODEL_RATE_CODE = /InferHub\.ModelArts\.\d+\.429/;
const MODEL_RATE_TEXT = /tpm limit|rate limit|too many requests/i;
function isTpmLimit(result) {
	if (result.ok) return false;
	return MODEL_RATE_CODE.test(result.message) || MODEL_RATE_TEXT.test(result.message);
}
/** 撞到这两类限流都值得原地等，而不是直接甩给 pi-ai 重试。 */
function isQueueableRate(result) {
	return isConcurrencyCap(result) || isTpmLimit(result);
}
/**
* 从一帧已转成 OpenAI 形状的 SSE 里认出「可排队限流」。
*
* 只在**还没有任何内容产出**的首帧上使用：此时重发是安全的；一旦下游已经收到
* 字节，HTTP 头也发出去了，就只能把错误帧原样交出去。
*/
function rateLimitFrame(text) {
	if (!text.includes("error")) return void 0;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const payload = trimmed.slice(5).trim();
		if (payload === "" || payload === "[DONE]") continue;
		let ev;
		try {
			ev = JSON.parse(payload);
		} catch {
			continue;
		}
		const code = String(ev.error?.code ?? ev.error_code ?? "");
		const message = String(ev.error?.message ?? ev.error_msg ?? "");
		const probe = {
			ok: false,
			kind: "soft_rate",
			status: 429,
			message: `${code}: ${message}`
		};
		if (code === "TM.00001041" || isTpmLimit(probe)) return {
			code: code === "" ? TPM_LIMIT_CODE : code,
			message
		};
	}
}
/**
* 把上游错误翻译成用户能看懂的一句话。
*
* 这些错误都发生在「账号、插件都正常」的时候 —— 原样把英文码甩给用户，只会
* 让人以为是自己配错了。默认分支仍保留原始信息，便于排查。
*/
function upstreamErrorMessage(message, status = 0) {
	if (isResignRefusal(message)) return "本地代理 billion-context 拦下了这条签名请求（它拿不到 CodeArts 凭据做重签，在本地直接拒了），不是你的账号问题：请在 ~/.config/billion-context/billion-context.json 加上 \"resign\": { \"sdk-hmac-sha256\": { \"passthrough\": true } } 后重启 DSH，或为它配置重签凭据。";
	if (MODEL_RATE_CODE.test(message) || MODEL_RATE_TEXT.test(message)) return "华为侧该模型当前请求过多（共享 TPM 超限），不是你的账号或插件问题。稍后重试，或临时改用 GLM-5.2 / GLM-5.3。";
	if (message.includes("TM.00001041")) return "CodeArts 免费档同时只允许 3 个会话，当前槽位一直占满（被打断的会话约 1 分钟才释放）。请稍后重试。";
	if (isBenefitMissing("", message)) return "这个模型属于限时福利，当前福利通道不可用（不是账号问题）。可以刷新模型列表，改用非福利模型。";
	if (isIamTokenError(message)) return "上游判定本次登录凭据（IAM token）已失效。插件已尝试自动续期；若反复出现，请到设置卡片重新登录。";
	if (isModelNotAccessible(message)) return "上游说这个模型不存在或当前账号没有权限（可能已下线或改名）。请刷新模型列表后换一个模型；换号没有用，这是模型级的限制。";
	if (isNotMultimodal(message)) return "这个模型不支持图片输入（上游 406）。请移除消息里的图片，或改用支持识图的模型。";
	if (message.toLowerCase().includes("model is not registered")) return "上游没有注册这个模型，它可能已经下线；请刷新模型列表后重选。";
	return `codearts 上游错误 (http ${status}): ${message.slice(0, 400)}`;
}
/**
* 「这个账号当前没有该模型的限时福利权益」。2026-10-21 实测：上游回 HTTP 200，
* 错误在**流内帧**里（不在状态码上），所以它既不走 retry 也不走换号，用户看到的
* 就是正文里裸裸一句 `benefit not found`。
*
* 这条不是请求写错了，重发也不会好：福利模型只有福利路由，去掉 `maas_type: benefit`
* 就变成 InferHub.002002009.404 model is not registered。唯一出路是等活动回来。
*/
const BENEFIT_MISSING_CODE = "InferHub.4004.200";
function isBenefitMissing(code, message) {
	return code === "InferHub.4004.200" || message.toLowerCase().includes("benefit not found");
}
/**
* 上游判定本次请求的 IAM 凭据无效。
*
* 2026-11-02 实测：它会以**流内首帧**（HTTP 200）的形式回来，内容只有一句
* `invalid_iam_token`，所以既不走 classify() 也不会触发换号 —— 之前只能干等到
* 凭证自然过期（距过期不足 5 分钟才刷新），期间每条消息都撞同一堵墙。
* 这些写法都见过：IAM 自身 / APIG 网关 / 非法 Token 三条链路各有一套措辞。
*/
const IAM_TOKEN_ERROR = /invalid_iam_token|incorrect iam authentication|apig\.0301|iam token is invalid|iam token (?:has )?expired|decrypt token fail/i;
function isIamTokenError(message) {
	return IAM_TOKEN_ERROR.test(message);
}
/**
* 「模型不存在或当前账号没权限」。
*
* 上游一边把它列进模型发现（`builtin` / `agent` 两路都有），一边在聊天时回
* `InferHub.ModelArts.81003.401`。2026-11-02 实测 `deepseek-v4.1-flash`
* 当天就是这种状态：列表里有、调用必拒，且换号也一样 —— 所以换号无意义。
*/
function isModelNotAccessible(message) {
	return message.includes("InferHub.ModelArts.81003.401") || message.toLowerCase().includes("the model does not exist or you do not have access to it");
}
/** 上游实际不吃图（模型级检查，与图片格式无关）。 */
function isNotMultimodal(message) {
	return message.includes("InferHub.001001020.406") || message.toLowerCase().includes("the request model is not multimodal");
}
/** 记进目录的原因文案（卡片「异常」Tag 的悬浮说明）。 */
function modelUnavailableReasonText(detail) {
	const trimmed = detail.trim();
	const prefix = "上游判定该模型当前不可用（模型不存在或当前账号没有权限，换号也无效）";
	return trimmed === "" ? prefix : `${prefix}：${trimmed}`;
}
/**
* 从**首帧**（已转成 OpenAI 形状）里取出上游错误码与文本；没有错误返回 undefined。
*
* 只用于「还没产出任何内容」的判断：此时重发是安全的。帧可能被 TCP 切断，解析
* 不出来就当没有错误，绝不影响转发。
*/
function firstFrameError(text) {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const payload = trimmed.slice(5).trim();
		if (payload === "" || payload === "[DONE]") continue;
		let ev;
		try {
			ev = JSON.parse(payload);
		} catch {
			continue;
		}
		const code = String(ev.error?.code ?? ev.error_code ?? "");
		const message = String(ev.error?.message ?? ev.error_msg ?? "");
		if (code === "" && message === "") continue;
		return {
			code,
			message
		};
	}
}
/**
* 本地代理「拒签」标记：billion-context 这类宿主层代理拦截出站请求做上下文压缩，
* 碰到 SDK-HMAC-SHA256 签名请求要用 CodeArts 凭据重签；找不到凭据时在**本地**回
* 403（根本没出网），body 里带这两个标记。这不是凭据失效 —— 归 session_dead 会把
* 账号永久禁用（见 issue #1）。
*/
function isResignRefusal(message) {
	return message.includes("signed_request_requires_resign") || message.includes("bili_resign_unavailable");
}
function classify(status, message) {
	const m = message.toLowerCase();
	if (isResignRefusal(message)) return "client";
	if (isIamTokenError(message)) return "iam_stale";
	if (isModelNotAccessible(message)) return "not_found";
	if (status === 401 || status === 403) return "session_dead";
	if (status === 402) return "hard_credit";
	if (status === 429) return "soft_rate";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	if (m.includes("not registered") || m.includes("benefit not found")) return "not_found";
	if (m.includes("tpm") || m.includes("并发")) return "soft_rate";
	return "client";
}
/**
* 出网唯一入口：**只把 URL 字符串和普通 init 交给 fetch，绝不把 Request 对象交出去**。
*
* 邻居插件会换掉 `globalThis.fetch`（例如 IP 池出口路由直接把 undici 模块自带的
* fetch 装成全局）。这时 `globalThis.Request` 还是另一份实例，而 undici 的 fetch
* 用 `instanceof` 认自己的 Request：不是自己那份就当 URL 字符串处理，报
* `Failed to parse URL from [object Request]`，而且是 HTTP 0（根本没出网）。
* 所以 Request 只当签名的载体（signer 要读写它的头部），发出去时拆回纯数据。
*
* 头部按 forEach 展开会全部变成小写名 —— 签名侧本来也按小写规范化，HTTP 头大小写
* 不敏感，上游不受影响。
*
* @param req 已签好名的请求
* @param body 原始请求体；GET/DELETE 传 undefined（带空 body 的 GET 会被 fetch 直接拒）
* @param signal 中止信号
*/
async function dispatch(req, body, signal) {
	const headers = {};
	req.headers.forEach((value, key) => {
		headers[key] = value;
	});
	return directFetch(req.url, {
		method: req.method,
		headers,
		...body === void 0 ? {} : { body },
		...signal === void 0 ? {} : { signal }
	});
}
const enc = new TextEncoder();
function openAIData(obj) {
	return enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
}
/** OpenAI 流的终止帧是裸 `data: [DONE]`，不能走 JSON.stringify（否则会带引号）。 */
function openAIDone() {
	return enc.encode("data: [DONE]\n\n");
}
/**
* 把上游累计快照 SSE 转换成 OpenAI 增量流。
*
* 上游行为（reverse-engineering.md §5）：
*  - {"type":"answer", ...} 起始
*  - {"text": "<累计全文>"} 全文快照（用替换语义）
*  - {"delta":{"content":"..."}} 真增量
*  - {"text":"[DONE]","error_code":"0"} 结束；error_code != 0 为错误
*/
async function chatStream(credential, prepared, signal) {
	const traceId = randomTraceId();
	const bodyBuf = Buffer.from(prepared.body);
	const benefit = isBenefitModel(prepared.model);
	const req = new Request(prepared.url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "text/event-stream",
			"x-auth-token": credential.token,
			"X-Security-Token": credential.securityToken,
			"x-snap-traceid": traceId,
			"X-Language": "zh-cn",
			"app-id": "CodeAgent3.0",
			"is_confidential": "false",
			...benefit ? { "maas_type": "benefit" } : {}
		},
		body: bodyBuf
	});
	if (credential.accessKeyId && credential.secretAccessKey) signRequest(req, bodyBuf, {
		accessKeyId: credential.accessKeyId,
		secretAccessKey: credential.secretAccessKey,
		securityToken: credential.securityToken
	});
	if (prepared.chatId) {
		req.headers.set("Chat-Id", prepared.chatId);
		req.headers.set("Session-Id", sessionIdFor(prepared.chatId));
	}
	let resp;
	try {
		resp = await dispatch(req, bodyBuf, signal);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (signal?.aborted === true) return {
			ok: false,
			kind: "client",
			status: 0,
			message: "aborted by client"
		};
		return {
			ok: false,
			kind: "server",
			status: 0,
			message
		};
	}
	if (!resp.ok) {
		const text = await resp.text().catch(() => "");
		if (isBenefitMissing("", text)) markBenefitBlocked(prepared.model);
		if (isModelNotAccessible(text)) markModelUnavailable(prepared.model, modelUnavailableReasonText(text.slice(0, 200)));
		return {
			ok: false,
			kind: classify(resp.status, text),
			status: resp.status,
			message: text.slice(0, 400)
		};
	}
	const model = prepared.model;
	const upstream = resp.body;
	if (!upstream) return {
		ok: false,
		kind: "server",
		status: 0,
		message: "dsh-codearts: 上游无响应体"
	};
	const reader = upstream.getReader();
	const decoder = new TextDecoder();
	let lastText = "";
	let sentAny = false;
	let doneSent = false;
	let sseBuf = "";
	return {
		ok: true,
		stream: new ReadableStream({
			async pull(controller) {
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) {
							if (sentAny && !doneSent) controller.enqueue(openAIDone());
							controller.close();
							return;
						}
						sseBuf += decoder.decode(value, { stream: true });
						const lines = sseBuf.split("\n");
						sseBuf = lines.pop() ?? "";
						let emitted = false;
						for (const raw of lines) {
							const trimmed = raw.trim();
							if (!trimmed.startsWith("data:")) continue;
							const payload = trimmed.slice(5).trim();
							if (payload === "[DONE]") {
								sentAny = true;
								if (!doneSent) {
									doneSent = true;
									controller.enqueue(openAIDone());
									emitted = true;
								}
								continue;
							}
							if (!payload) continue;
							let ev;
							try {
								ev = JSON.parse(payload);
							} catch {
								continue;
							}
							if (ev.error_code && ev.error_code !== "0" && ev.error_code !== 0) {
								if (isBenefitMissing(String(ev.error_code), String(ev.error_msg ?? ""))) markBenefitBlocked(model);
								const errorDetail = `${String(ev.error_code)}: ${String(ev.error_msg ?? "upstream error")}`;
								if (isModelNotAccessible(errorDetail)) markModelUnavailable(model, modelUnavailableReasonText(errorDetail));
								controller.enqueue(openAIData({
									choices: [{
										delta: { content: "" },
										finish_reason: "stop"
									}],
									error: {
										code: ev.error_code,
										message: ev.error_msg ?? "upstream error"
									}
								}));
								controller.enqueue(openAIDone());
								controller.close();
								return;
							}
							if (Array.isArray(ev.choices)) {
								sentAny = true;
								controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
								emitted = true;
								continue;
							}
							if (ev.delta?.content) {
								sentAny = true;
								controller.enqueue(openAIData({
									model,
									choices: [{
										delta: { content: ev.delta.content },
										finish_reason: null
									}]
								}));
								emitted = true;
							}
							if (typeof ev.text === "string" && ev.text !== "[DONE]") {
								const cur = ev.text;
								if (cur.length > lastText.length && cur.startsWith(lastText)) {
									const delta = cur.slice(lastText.length);
									sentAny = true;
									controller.enqueue(openAIData({
										model,
										choices: [{
											delta: { content: delta },
											finish_reason: null
										}]
									}));
									emitted = true;
								}
								lastText = cur;
							}
						}
						if (emitted) return;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					controller.enqueue(openAIData({ error: { message } }));
					controller.close();
				}
			},
			cancel() {
				reader.cancel().catch(() => {});
			}
		})
	};
}
/**
* 查当前凭证对应的账号身份。
*
* 为什么需要它：登录响应里 `user_id` / `user_name` 都是空串（实测），所以插件原先
* 只能拿 DPoP 公钥当账号标识 —— 代价是**对同一个账号重新登录会被当成新账号**。
* 这个端点给出上游的稳定 `user_id`，重新登录就能命中同一条账号记录。
*
* 失败不应阻断登录：调用方按「拿不到身份就退回旧行为」处理。
*/
async function fetchCallerIdentity(credential, signal) {
	const resp = await signedGet(`${SNAP_HOST}${EP_CURRENT_USER}`, credential, void 0, signal);
	if (!resp.ok) throw new Error(`identity HTTP ${resp.status} ${resp.message}`);
	const body = asRecord(parseJson(resp.text));
	const userId = firstString(body.user_id);
	if (userId === "") throw new Error("identity response carries no user_id");
	return {
		userId,
		userName: firstString(body.user_name),
		domainId: firstString(body.domain_id)
	};
}
/** 发现不到 contextWindow 时的保守默认值：只影响 DSH 的上下文计量条与截断余量。 */
const UNKNOWN_CONTEXT_WINDOW = 32768;
/** 发现不到 maxTokens 时的默认值（低于服务端上限，保证请求能过）。 */
const UNKNOWN_MAX_TOKENS = 8e3;
/** 带 AK/SK 签名的 GET；body 为空（签名按空载荷算）。 */
async function signedGet(url, credential, agentType, signal) {
	const req = new Request(url, {
		method: "GET",
		headers: {
			"Content-Type": "application/json",
			"X-Language": "zh-cn",
			...agentType === void 0 ? {} : { "Agent-Type": agentType },
			"X-Security-Token": credential.securityToken
		}
	});
	if (credential.accessKeyId && credential.secretAccessKey) signRequest(req, Buffer.from(""), {
		accessKeyId: credential.accessKeyId,
		secretAccessKey: credential.secretAccessKey,
		securityToken: credential.securityToken
	});
	let resp;
	try {
		resp = await dispatch(req, void 0, signal);
	} catch (error) {
		return {
			ok: false,
			status: 0,
			message: error instanceof Error ? error.message : String(error)
		};
	}
	const text = await resp.text().catch(() => "");
	if (!resp.ok) return {
		ok: false,
		status: resp.status,
		message: text.slice(0, 300)
	};
	return {
		ok: true,
		text
	};
}
function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return;
	}
}
function positive(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
function firstString(...values) {
	for (const value of values) if (typeof value === "string" && value.trim() !== "") return value.trim();
	return "";
}
function asRecord(value) {
	return typeof value === "object" && value !== null ? value : {};
}
function asArray(value) {
	return Array.isArray(value) ? value : [];
}
/**
* 从 `credit[]` 里取常规时段的展示倍率（原样 `0.18x`）。
*
* 上游给每个时段一条（`default` / `off_peak`，实测 2026-10-21）。这里只取
* `default`：尖峰价才是用户平时付的，低峰 0.09x 属于额外优惠，拿来当标题会低估。
* 没有 credit 的模型（如 Qwen3-VL）返回 undefined —— 界面上就不显示倍率。
*/
function creditRatioOf(record) {
	const credits = asArray(record.credit).map(asRecord);
	if (credits.length === 0) return void 0;
	const pick = credits.find((entry) => entry.time_slot_id === "default") ?? credits.find((entry) => entry.time_slot_id === null || entry.time_slot_id === void 0) ?? credits[0];
	if (pick === void 0) return void 0;
	const match = /^\s*(\d+(?:\.\d+)?)\s*x\s*$/i.exec(firstString(pick.ratio_display));
	return match === null ? void 0 : `${match[1]}x`;
}
/**
* 内置模型：`GET /v1/model/builtin`（`Agent-Type: PromptCenter`）。
* 实测响应 `{ count, builtinModels: [{ model_id, model_name, model_desc,
* enable, display_enabled, supports_images, ... }] }` —— 注意它**不带**
* context_window / max_tokens，那两项要靠合并种子或福利来源补。
*/
async function fetchBuiltinModels(credential, signal) {
	const resp = await signedGet(`${SNAP_HOST}${EP_MODEL_BUILTIN}`, credential, "PromptCenter", signal);
	if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.message}`);
	const body = asRecord(parseJson(resp.text));
	const out = [];
	for (const raw of asArray(body.builtinModels)) {
		const model = asRecord(raw);
		if (model.enable === false) continue;
		const id = firstString(model.model_id, model.model_name);
		if (id === "") continue;
		const ratio = creditRatioOf(model);
		out.push({
			id,
			name: firstString(model.model_name, id),
			contextWindow: positive(model.context_window),
			maxTokens: positive(model.max_tokens),
			supportsImages: model.supports_images === true,
			...ratio === void 0 ? {} : { ratio }
		});
	}
	return out;
}
/**
* 限时福利模型：`GET {opengw}/api/v1/gateway/config`。
* 实测响应 `{ error_code: '0000', result: { base_url, models: [{ model_id,
* model_name, context_window, max_tokens, sort }] } }`，整份标记福利。
*/
async function fetchBenefitModels(credential, signal) {
	const resp = await signedGet(`${BENEFIT_HOST}${EP_BENEFIT_CONFIG}`, credential, void 0, signal);
	if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.message}`);
	const body = asRecord(parseJson(resp.text));
	const code = firstString(body.error_code);
	if (code !== "" && code !== "0000") throw new Error(`gateway/config error_code=${code} ${firstString(body.error_msg)}`);
	const out = [];
	for (const raw of asArray(asRecord(body.result).models)) {
		const model = asRecord(raw);
		const id = firstString(model.model_id, model.model_name);
		if (id === "") continue;
		const ratio = creditRatioOf(model);
		out.push({
			id,
			name: firstString(model.model_name, id),
			contextWindow: positive(model.context_window),
			maxTokens: positive(model.max_tokens),
			supportsImages: model.supports_images === true,
			...ratio === void 0 ? {} : { ratio },
			benefit: true
		});
	}
	return out;
}
/**
* agent-center 的模型清单：先 `useragents` 找一个 CodeAgent，再取 detail 的
* `gpts.models`。过滤条件与官方客户端一致（`agent_name === 'CodeAgent'` 且
* IDE 可见），退化为 primary，再退化为第一个。
*/
async function fetchAgentModels(credential, signal) {
	const listResp = await signedGet(`${SNAP_HOST}${EP_AGENT_LIST}?offset=0&limit=100&is_primary_agent=true`, credential, "AgentCenter", signal);
	if (!listResp.ok) throw new Error(`agent list HTTP ${listResp.status} ${listResp.message}`);
	const agents = asArray(asRecord(parseJson(listResp.text)).agents).map(asRecord);
	let agentId = "";
	for (const agent of agents) {
		const alias = asRecord(agent.alias);
		if (firstString(agent.agent_name) === "CodeAgent" && firstString(alias.alias_zh_cn) === "智能体" && agent.show_in_ide === true) {
			agentId = firstString(agent.agent_id);
			if (agentId !== "") break;
		}
	}
	if (agentId === "") {
		for (const agent of agents) if (agent.is_primary_agent === true) {
			agentId = firstString(agent.agent_id);
			if (agentId !== "") break;
		}
	}
	if (agentId === "" && agents.length > 0) agentId = firstString(agents[0]?.agent_id);
	if (agentId === "") throw new Error("no agent found to read gpts.models from");
	const detailResp = await signedGet(`${SNAP_HOST}${EP_AGENT_DETAIL}?agent_id=${encodeURIComponent(agentId)}`, credential, "AgentCenter", signal);
	if (!detailResp.ok) throw new Error(`agent detail HTTP ${detailResp.status} ${detailResp.message}`);
	const gpts = asRecord(asRecord(parseJson(detailResp.text)).gpts);
	const out = [];
	for (const raw of asArray(gpts.models)) {
		const model = asRecord(raw);
		const params = asRecord(model.model_parameters);
		const id = firstString(params.model_id, model.model_id, model.model_alias, model.model_name);
		if (id === "") continue;
		const ratio = creditRatioOf(model) ?? creditRatioOf(params);
		out.push({
			id,
			name: firstString(model.model_name, model.model_alias, id),
			contextWindow: positive(params.context_window),
			maxTokens: positive(params.max_tokens),
			supportsImages: model.supports_images === true,
			...ratio === void 0 ? {} : { ratio }
		});
	}
	return out;
}
/**
* 思考强度清单：`POST /v1/model/thinking-variants`，body `{ model_names }`。
*
* 实测响应 `{ variants: { "GLM-5.2": { strengths: ["high","max"],
* default_strength: "high" }, ... } }`，键是请求里的名字（大小写原样），
* 不支持的模型给空 `strengths`。官方客户端限 50 个名字，这里照搬。
*
* 这是**可选增强**：上游没给（旧账号/接口漂移）时模型照常可用，只是宿主不显示
* 推理档位选择器。失败由调用方记进 errors，不抛断发现。
*/
async function fetchThinkingVariants(credential, modelIds, signal) {
	const out = /* @__PURE__ */ new Map();
	const modelNames = modelIds.slice(0, 50);
	if (modelNames.length === 0) return out;
	const bodyBuf = Buffer.from(JSON.stringify({ model_names: modelNames }));
	const req = new Request(`${SNAP_HOST}${EP_THINKING_VARIANTS}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-auth-token": credential.token,
			"X-Security-Token": credential.securityToken,
			"x-snap-traceid": randomTraceId(),
			"X-Language": "zh-cn",
			"Agent-Type": "PromptCenter"
		},
		body: bodyBuf
	});
	if (credential.accessKeyId && credential.secretAccessKey) signRequest(req, bodyBuf, {
		accessKeyId: credential.accessKeyId,
		secretAccessKey: credential.secretAccessKey,
		securityToken: credential.securityToken
	});
	const resp = await dispatch(req, bodyBuf, signal);
	if (!resp.ok) {
		const text = await resp.text().catch(() => "");
		throw new Error(`thinking-variants HTTP ${resp.status} ${text.slice(0, 200)}`);
	}
	const body = asRecord(parseJson(await resp.text()));
	for (const [name, raw] of Object.entries(asRecord(body.variants))) {
		const variant = asRecord(raw);
		const strengths = asArray(variant.strengths).map((value) => firstString(value)).filter((value) => value !== "");
		if (strengths.length === 0) continue;
		const fallback = firstString(variant.default_strength);
		out.set(name.trim().toLowerCase(), {
			strengths,
			...fallback === "" ? {} : { default: fallback }
		});
	}
	return out;
}
/**
* 查一条请求的排队位置：`GET /api/v1/queue/status?task_id=<chat_id>&model=<model>`。
*
* ⚠ 这个 GET 是**占号**，不是只读查询：每次调用都会把 task 挂进队列、返回队尾位置，
* 用 `clearQueueStatus` 才清得掉（2026-10-21 实测）。队列空闲的模型（如 GLM）直接
* 回 `status:"working"`、位置 0；拥堵的模型（如 deepseek-v4.1-flash）对新号一律
* 回 `waiting` + 当前队尾。真正的 chat 请求不看这张票，所以要不要等由调用方决定
* （见 `src/queue.ts`）。
*/
async function fetchQueueStatus(credential, chatId, model, signal) {
	const url = new URL(`${SNAP_HOST}${EP_QUEUE_STATUS}`);
	url.searchParams.set("task_id", chatId);
	url.searchParams.set("model", model);
	const req = new Request(url, {
		method: "GET",
		headers: {
			"Content-Type": "application/json",
			"x-auth-token": credential.token,
			"X-Security-Token": credential.securityToken,
			"x-snap-traceid": randomTraceId(),
			"X-Language": "zh-cn"
		}
	});
	if (credential.accessKeyId && credential.secretAccessKey) signRequest(req, Buffer.alloc(0), {
		accessKeyId: credential.accessKeyId,
		secretAccessKey: credential.secretAccessKey,
		securityToken: credential.securityToken
	});
	const resp = await dispatch(req, void 0, signal);
	if (!resp.ok) {
		const text = await resp.text().catch(() => "");
		throw new Error(`queue status HTTP ${resp.status} ${text.slice(0, 200)}`);
	}
	const body = asRecord(parseJson(await resp.text()));
	return {
		status: firstString(body.status),
		queueLength: positive(body.queue_length),
		queuePosition: positive(body.queue_position),
		message: firstString(body.message)
	};
}
/**
* 清掉 `fetchQueueStatus` 挂上去的占号：`DELETE /api/v1/queue/status?task_id=&model=`。
*
* 官方客户端在回答结束、用户取消、排队出错时都会调；不清的话每次查询都会在上游
* 队列里留一个幽灵任务，队列只会越来越长。
*/
async function clearQueueStatus(credential, chatId, model, signal) {
	const url = new URL(`${SNAP_HOST}${EP_QUEUE_STATUS}`);
	url.searchParams.set("task_id", chatId);
	url.searchParams.set("model", model);
	const req = new Request(url, {
		method: "DELETE",
		headers: {
			"Content-Type": "application/json",
			"x-auth-token": credential.token,
			"X-Security-Token": credential.securityToken,
			"x-snap-traceid": randomTraceId(),
			"X-Language": "zh-cn"
		}
	});
	if (credential.accessKeyId && credential.secretAccessKey) signRequest(req, Buffer.alloc(0), {
		accessKeyId: credential.accessKeyId,
		secretAccessKey: credential.secretAccessKey,
		securityToken: credential.securityToken
	});
	const resp = await dispatch(req, void 0, signal);
	if (!resp.ok) {
		const text = await resp.text().catch(() => "");
		throw new Error(`queue clear HTTP ${resp.status} ${text.slice(0, 200)}`);
	}
}
/**
* 动态发现当前账号可用的模型清单（三路合并）。
*
* 与 codearts2api 的 `Client.FetchModels` 等价：内置、限时福利、agent-center 三路
* 各自独立，任一路失败只记进 `errors` 不阻断 —— 福利网关抖动时仍能拿到内置模型。
*
* 上标的两个「实测 vs 标称」处理（很重要，别照搬标称值）：
*  - **maxTokens 钳到该模型的实测上限**（`MEASURED_MAX_TOKENS`）。上游
*    `gateway/config` 给福利模型标的是 393216 / 384000，而聊天端点实测超过 65536
*    就流内报 InferHub.001001005.400；DSH 会把 catalog 的 maxTokens 原样当
*    max_tokens 发出去，照抄标称值等于让每个请求都失败。
*  - contextWindow 用发现值（只影响 DSH 的上下文计量与截断余量，不影响路由）。
*
* @throws 三路全失败，或合并结果为空。
*/
async function fetchModels(credential, signal) {
	const settled = await Promise.all([
		fetchBuiltinModels(credential, signal).then((models) => ({
			source: "builtin",
			models
		}), (error) => ({
			source: "builtin",
			error
		})),
		fetchBenefitModels(credential, signal).then((models) => ({
			source: "benefit",
			models
		}), (error) => ({
			source: "benefit",
			error
		})),
		fetchAgentModels(credential, signal).then((models) => ({
			source: "agent",
			models
		}), (error) => ({
			source: "agent",
			error
		}))
	]);
	const sources = [];
	const errors = [];
	const discovered = [];
	for (const item of settled) if ("error" in item) errors.push({
		source: item.source,
		message: item.error.message
	});
	else {
		sources.push(item.source);
		discovered.push(item.models);
	}
	if (sources.length === 0) throw new Error(`model discovery failed on every source: ${errors.map((e) => `${e.source}: ${e.message}`).join("; ")}`);
	const merged = backfillParams(mergeModelLists(discovered));
	if (merged.length === 0) throw new Error("model discovery returned an empty catalog");
	let variants = /* @__PURE__ */ new Map();
	try {
		variants = await fetchThinkingVariants(credential, merged.map((model) => model.id), signal);
	} catch (error) {
		errors.push({
			source: "thinking",
			message: error instanceof Error ? error.message : String(error)
		});
	}
	return {
		models: merged.map((model) => {
			const thinking = variants.get(model.id.toLowerCase());
			return {
				...model,
				...thinking === void 0 ? {} : { thinking },
				contextWindowKnown: model.contextWindow > 0,
				contextWindow: model.contextWindow > 0 ? model.contextWindow : UNKNOWN_CONTEXT_WINDOW,
				maxTokens: Math.min(model.maxTokens > 0 ? model.maxTokens : UNKNOWN_MAX_TOKENS, maxTokensCeilingFor(model.id))
			};
		}),
		sources,
		errors
	};
}
/**
* 开通「限时福利」（免费模型）渠道，幂等：已开通就原样返回。官方客户端打开模型菜单
* 即调用（GET），用户点「领取」时也调（POST）——两种方法实测都返回 200/0000。
* 不开通时福利模型调用必报 InferHub.4004.200 benefit not found。
* 需要 AK/SK 签名（凭证要带 accessKeyId/secretAccessKey）。
*
* **它不发积分。** 返回体只是一条渠道开通记录（channel / create_time / update_time，
* 幂等所以时间戳是旧的），账号积分由套餐决定（见 credits.ts），领取动作在官网签到页。
* 别把它当「领取积分」用 —— 早先卡片这么用，结果就是「点了显示已领取、积分没变」。
*/
async function claimBenefit(credential, abort) {
	if (!credential.accessKeyId || !credential.secretAccessKey) return;
	const url = `${BENEFIT_HOST}${EP_BENEFIT_CLAIM}`;
	const bodyBuf = Buffer.from("{}");
	const req = new Request(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Language": "zh-cn",
			"X-Security-Token": credential.securityToken
		},
		body: bodyBuf
	});
	signRequest(req, bodyBuf, {
		accessKeyId: credential.accessKeyId,
		secretAccessKey: credential.secretAccessKey,
		securityToken: credential.securityToken
	});
	const resp = await dispatch(req, bodyBuf, abort);
	const raw = await resp.text().catch(() => "");
	if (!resp.ok) throw new Error(`claim benefit failed: ${resp.status} ${raw.slice(0, 200)}`);
	let json;
	try {
		json = JSON.parse(raw);
	} catch {
		throw new Error(`claim benefit: unexpected non-JSON response: ${raw.slice(0, 200)}`);
	}
	if (json.error_code !== "0000") throw new Error(`claim benefit rejected: ${json.error_code ?? "(no error_code)"} ${json.error_msg ?? ""}`.trim());
}
/**
* 福利中心（活动积分）接口：26.9.901 起应用内「每日签到领 1000 积分」走这套。
*
* host 与积分统计是同一个 snap-access 网关，路径前缀 `/v1/ops`，鉴权头对齐官方客户端
* 的 `Pz()`（`x-auth-token` + `Agent-Type: PromptCenter`），再补上我们直连必须的
* AK/SK 签名。三个实测出来的坑：
*
*  1. bundle 里 URL 有两套变体，带前缀的 `/PromptCenterService/v1/ops/*` 在这个网关上
*     回 **404 APIG.0101（未发布）** —— 只有裸 `/v1/ops/*` 能用；
*  2. 只带 `x-auth-token` 会被拒（`APIG.0301 decrypt token fail`）；
*  3. **业务失败也回 HTTP 200**，成败只看 body 的 `code`（0 才是成功）。
*     今天已领时是 `code:40001 尚未到达权益刷新时间，暂时无法领取`。
*
* 领的是「活动」而不是额度：`/ops/delivery` 给活动清单（含 campaignId / status /
* claimable），`/ops/claim` 按 campaignId 领。`idempotentKey` 上游不返回，官方客户端
* 自己生成随机串（与 `x-snap-traceid` 同一个生成器），按天去重落在服务端。
*/
const EP_OPS_DELIVERY = "/v1/ops/delivery";
const EP_OPS_CLAIM = "/v1/ops/claim";
/** 每日签到活动的 type（实测为 campaignId 1，benefitAmount 1000 CREDIT）。 */
const WELFARE_DAILY_TYPE = "USER_LOGIN";
/** 上游按钮文案的状态机：这几个都表示「今天已经领过了」。 */
const WELFARE_ALREADY_STATES = /* @__PURE__ */ new Set([
	"CLAIMED",
	"CONFIRMED",
	"CONSUMED"
]);
/** 活动状态是不是「今天已经领过了」（区别于「要先登录」「没资格」这些同样不可领的情况）。 */
function isWelfareClaimedStatus(status) {
	return WELFARE_ALREADY_STATES.has(status);
}
/**
* 「今日已领」的业务码。
*
* 这个分支不是冗余的：领取成功后的几十秒里 delivery 有可能还回一份**陈旧**的
* `claimable:true / ELIGIBLE`（实测 2026-10-16，领完立刻读会看到），于是会真的
* POST 第二次 —— 服务端按天去重回这个码，所以按「已领」处理，不能当失败。
*/
const WELFARE_CODE_NOT_YET = 40001;
/** 福利接口的请求：签名 + 官方那套头，返回解析后的 body。 */
async function welfareRequest(url, method, credential, body, signal) {
	const req = new Request(url, {
		method,
		headers: {
			"Content-Type": "application/json",
			"X-Language": "zh-cn",
			"x-snap-traceid": hex32(),
			"x-auth-token": credential.token,
			"Agent-Type": "PromptCenter",
			"X-Security-Token": credential.securityToken
		},
		...body === void 0 ? {} : { body }
	});
	const bodyBuf = Buffer.from(body ?? "");
	if (credential.accessKeyId !== void 0 && credential.secretAccessKey !== void 0) signRequest(req, bodyBuf, {
		accessKeyId: credential.accessKeyId,
		secretAccessKey: credential.secretAccessKey,
		securityToken: credential.securityToken
	});
	let resp;
	try {
		resp = await dispatch(req, body === void 0 ? void 0 : bodyBuf, signal);
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : String(error)
		};
	}
	const text = await resp.text().catch(() => "");
	if (!resp.ok) return {
		ok: false,
		message: `HTTP ${resp.status} ${text.slice(0, 200)}`
	};
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {
			ok: false,
			message: `unexpected non-JSON response: ${text.slice(0, 200)}`
		};
	}
	const envelope = asRecord(parsed);
	return {
		ok: true,
		code: typeof envelope.code === "number" ? envelope.code : -1,
		message: firstString(envelope.message),
		data: envelope.data
	};
}
/** 活动清单（`GET /v1/ops/delivery?channel=IDE`）。 */
async function fetchWelfareCampaigns(credential, signal) {
	const resp = await welfareRequest(`${SNAP_HOST}${EP_OPS_DELIVERY}?channel=IDE`, "GET", credential, void 0, signal);
	if (!resp.ok) throw new Error(`welfare delivery: ${resp.message}`);
	return asArray(asRecord(resp.data).items).flatMap((item) => {
		const raw = asRecord(item);
		const campaignId = typeof raw.campaignId === "number" ? raw.campaignId : NaN;
		if (Number.isFinite(campaignId) === false) return [];
		return [{
			campaignId,
			title: firstString(raw.title),
			type: firstString(raw.type),
			amount: typeof raw.benefitAmount === "number" ? raw.benefitAmount : 0,
			unit: firstString(raw.benefitUnit),
			claimable: raw.claimable === true,
			status: firstString(raw.status)
		}];
	});
}
/**
* 从活动清单里挑「每日签到」那条。
*
* 同一个 type 理论上可能有多条（上游换活动的时候），优先挑当前可领的那条。
*/
function pickDailyWelfareCampaign(campaigns) {
	const daily = campaigns.filter((c) => c.type === WELFARE_DAILY_TYPE && c.unit === "CREDIT");
	return daily.find((c) => c.claimable) ?? daily[0];
}
/**
* 领一次每日签到积分。
*
* 不抛异常：这是卡片上一个按钮的后续，失败要变成能显示的文案而不是断掉的请求。
*/
async function claimDailyWelfare(credential, signal) {
	if (credential.accessKeyId === void 0 || credential.secretAccessKey === void 0) return {
		state: "failed",
		amount: 0,
		message: "no AK/SK to sign"
	};
	let campaigns;
	try {
		campaigns = await fetchWelfareCampaigns(credential, signal);
	} catch (error) {
		return {
			state: "failed",
			amount: 0,
			message: error instanceof Error ? error.message : String(error)
		};
	}
	const target = pickDailyWelfareCampaign(campaigns);
	if (target === void 0) return {
		state: "unavailable",
		amount: 0,
		message: "no daily check-in campaign"
	};
	if (!target.claimable) return isWelfareClaimedStatus(target.status) ? {
		state: "already",
		amount: 0,
		message: ""
	} : {
		state: "unavailable",
		amount: 0,
		message: target.status
	};
	const resp = await welfareRequest(`${SNAP_HOST}${EP_OPS_CLAIM}`, "POST", credential, JSON.stringify({
		campaignId: target.campaignId,
		idempotentKey: hex32(),
		channel: "IDE"
	}), signal);
	if (!resp.ok) return {
		state: "failed",
		amount: 0,
		message: resp.message
	};
	if (resp.code === 0) return {
		state: "claimed",
		amount: target.amount,
		message: resp.message
	};
	return {
		state: resp.code === WELFARE_CODE_NOT_YET ? "already" : "failed",
		amount: 0,
		message: resp.message
	};
}
//#endregion
export { clearBenefitBlocked as A, setDiscoveredBenefitModels as B, prepareChatBody as C, upstream_exports as D, upstreamErrorMessage as E, isBenefitModel as F, markModelUnavailable as I, mergeModelLists as L, filterEnabledModels as M, forgetModelUnavailable as N, CodeArtsCatalog as O, isBenefitBlocked as P, modelDisplayName as R, pickDailyWelfareCampaign as S, signedGet as T, isQueueableRate as _, clearQueueStatus as a, maxTokensCeilingFor as b, fetchModels as c, firstFrameError as d, isConcurrencyCap as f, isParamInvalidFrame as g, isNotMultimodal as h, claimDailyWelfare as i, creditRatioLabel as j, FALLBACK_CODEARTS_MODELS as k, fetchQueueStatus as l, isModelNotAccessible as m, canonicalModel as n, degradeTokenCeiling as o, isIamTokenError as p, chatStream as r, fetchCallerIdentity as s, SNAP_HOST as t, fetchWelfareCampaigns as u, isTpmLimit as v, rateLimitFrame as w, modelUnavailableReasonText as x, isWelfareClaimedStatus as y, modelUnavailableReason as z };
