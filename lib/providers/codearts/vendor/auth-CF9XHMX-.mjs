import { createHash, createPrivateKey, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import http from "node:http";
import { directFetch } from "../../../shared/net-rescue.js";
//#region src/dpop.ts
/**
* DPoP（RFC 9449）证明 JWT：ES256 + P-256，供 oauth2/tokens 请求头使用。
* 翻译自 codearts2api 的 internal/upstream/dpop.go。
*
* 关键约束：refresh_token 与首次换取时的 DPoP 公钥绑定，刷新时必须复用同一
* 私钥，否则 STS 报 InvalidDPoPHeader。因此该私钥必须随 refresh_token 一起落盘。
*
* @module dsh-codearts/dpop
*/
const P256_ORDER = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
const P256_HALF = P256_ORDER >> 1n;
/** 生成新的 DPoP 私钥（JWK）。 */
function newDPoPPrivateJWK() {
	const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const jwk = privateKey.export({ format: "jwk" });
	return {
		kty: jwk.kty,
		crv: jwk.crv,
		x: jwk.x,
		y: jwk.y,
		d: jwk.d
	};
}
function privateKeyFromJWK(jwk) {
	return createPrivateKey({
		key: jwk,
		format: "jwk"
	});
}
function b64u(buf) {
	return Buffer.from(buf).toString("base64url");
}
/**
* 生成 DPoP proof JWT（htm=POST，htu=token 端点）。
* 低 S 归一化以兼容服务端校验。
*/
function signDpopProof(jwk, htu) {
	const key = privateKeyFromJWK(jwk);
	const header = {
		alg: "ES256",
		typ: "dpop+jwt",
		jwk: {
			kty: "EC",
			crv: "P-256",
			x: jwk.x,
			y: jwk.y
		}
	};
	const headerJSON = Buffer.from(JSON.stringify(header));
	const payload = {
		htm: "POST",
		htu,
		iat: Math.floor(Date.now() / 1e3),
		jti: randomBytes(16).toString("hex")
	};
	const payloadJSON = Buffer.from(JSON.stringify(payload));
	const input = `${b64u(headerJSON)}.${b64u(payloadJSON)}`;
	const sig = createSign("SHA256").update(input).sign({
		key,
		dsaEncoding: "ieee-p1363"
	});
	let s = sig.subarray(32, 64);
	let sBig = BigInt(`0x${s.toString("hex")}`);
	if (sBig > P256_HALF) {
		sBig = P256_ORDER - sBig;
		s = Buffer.from(sBig.toString(16).padStart(64, "0"), "hex");
	}
	return `${input}.${b64u(Buffer.concat([sig.subarray(0, 32), s]))}`;
}
//#endregion
//#region src/oauth.ts
/**
* CodeArts OAuth2（PKCE）登录 + 刷新，翻译自 codearts2api 的
* internal/server/oauth.go / cmd/login/main.go / internal/upstream/client.go。
*
* 登录：本地起 127.0.0.1 回调服务 → 浏览器跳 codearts.huaweicloud.com/authorize
* → 用户登录 → 华为回调带 code → 用 code + PKCE verifier + DPoP 私钥换
* security_token + 临时 AK/SK + refresh_token。
*
* 刷新：refresh_token 与 client_id、DPoP 私钥三者绑定，刷新时原样复用。
*
* @module dsh-codearts/oauth
*/
const CLIENT_ID = "codearts-agent";
const PLUGIN_NAME = "snap_AIIDE";
const PLUGIN_VERSION = "5.2.0";
const SNAP_HOST = "https://snap-access.cn-north-4.myhuaweicloud.com";
const STS_HOST = "https://sts.cn-north-4.myhuaweicloud.com";
const PORTAL = "https://codearts.huaweicloud.com/portal";
const REDIRECT_PATH = "/oauth/callback";
function defaultLoginConfig() {
	return {
		clientId: CLIENT_ID,
		snapHost: SNAP_HOST,
		stsHost: STS_HOST,
		portal: PORTAL
	};
}
function randomHex(n) {
	return randomBytes(n).toString("hex");
}
function pkce() {
	const verifier = base64url(randomBytes(64));
	return {
		verifier,
		challenge: createHash("sha256").update(verifier).digest("base64url"),
		method: "S256"
	};
}
function base64url(buf) {
	return buf.toString("base64url");
}
/** 构造华为授权页 URL（浏览器打开，用户登录后回调本机）。 */
function buildAuthorizeURL(cfg, ticketId, challenge, method, port) {
	const q = new URLSearchParams();
	q.set("theme", "2");
	q.set("locale", "zh-cn");
	q.set("uri_scheme", cfg.clientId);
	q.set("client_id", cfg.clientId);
	q.set("port", String(port));
	q.set("code_challenge", challenge);
	q.set("code_challenge_method", "SHA-256");
	q.set("ticket_id", ticketId);
	q.set("plugin-name", PLUGIN_NAME);
	q.set("plugin-version", PLUGIN_VERSION);
	return `${cfg.portal}/authorize?${q.toString()}`;
}
/** 换 token 请求体：application/x-www-form-urlencoded（与华为 STS 一致）。 */
function buildTokenBody(cfg, params) {
	return new URLSearchParams({
		client_id: cfg.clientId,
		...params
	}).toString();
}
/** 用授权 code 换 token。 */
async function exchangeCode(cfg, code, verifier, port, dpopJWK, abort) {
	const htu = `${cfg.stsHost}/v1/oauth2/tokens`;
	const dpop = signDpopProof(dpopJWK, htu);
	const body = buildTokenBody(cfg, {
		code,
		code_verifier: verifier,
		grant_type: "authorization_code",
		redirect_uri: `http://127.0.0.1:${port}${REDIRECT_PATH}`
	});
	const res = await directFetch(`${htu}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"DPoP": dpop,
			"plugin-name": PLUGIN_NAME,
			"plugin-version": PLUGIN_VERSION
		},
		body,
		signal: abort
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`exchange code failed: ${res.status} ${text}`);
	}
	return parseToken(await res.json(), dpopJWK, cfg.clientId);
}
/** 用 refresh_token 续期。 */
async function refreshToken(cfg, prev, abort) {
	const htu = `${cfg.stsHost}/v1/oauth2/tokens`;
	const dpop = signDpopProof(prev.dpopPrivateKey, htu);
	const body = buildTokenBody(cfg, {
		grant_type: "refresh_token",
		refresh_token: prev.refreshToken
	});
	const res = await directFetch(`${htu}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"DPoP": dpop,
			"plugin-name": PLUGIN_NAME,
			"plugin-version": PLUGIN_VERSION
		},
		body,
		signal: abort
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`refresh token failed: ${res.status} ${text}`);
	}
	return parseToken(await res.json(), prev.dpopPrivateKey, prev.clientId, prev);
}
function parseToken(json, dpopJWK, clientId, prev) {
	const cred = json.credentials ?? {};
	return {
		userId: json.user_id ?? prev?.userId ?? "",
		userName: json.user_name ?? prev?.userName ?? "",
		domainId: json.domain_id ?? prev?.domainId ?? "",
		securityToken: cred.security_token ?? cred.SecurityToken ?? "",
		accessKeyId: cred.access_key_id ?? cred.AccessKeyID ?? "",
		secretAccessKey: cred.secret_access_key ?? cred.SecretAccessKey ?? "",
		expiration: cred.expiration ?? cred.Expiration ?? "",
		refreshToken: json.refresh_token ?? json.RefreshToken ?? prev?.refreshToken ?? "",
		clientId,
		dpopPrivateKey: dpopJWK
	};
}
/**
* 华为登录后浏览器落回本机回调的落地页。
*
* 这一页本身没有任何后续逻辑：`code` 在响应发出的同一时刻就已交给等待队列
* （见 startLogin 里的 finish），token 交换完全在服务端做，页面关不关都不影响
* 登录结果。它只是 redirect_uri 必然要渲染的一个落点 —— 华为侧没有「登录成功」
* 页可停留，成功标志就是这一次 302 到 127.0.0.1。
*
* 卡片用 `window.open` 打开授权页，所以这个标签页能自己关掉；用户从卡片的
* 手动链接打开、或浏览器拦脚本关窗时 close 会失败，1.2s 后把提示换成「可关闭」。
*/
const CALLBACK_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeArts 登录</title>
<style>
  html,body{height:100%}
  body{margin:0;display:flex;align-items:center;justify-content:center;background:#fff;color:#1f2329;
    font:15px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  p{margin:0;padding:24px;text-align:center}
</style>
</head>
<body>
<p id="msg">正在返回 DeepSeek Harness…</p>
<script>
  setTimeout(function () { try { window.close() } catch (e) {} }, 300)
  setTimeout(function () {
    var el = document.getElementById('msg')
    if (el) el.textContent = 'CodeArts 登录成功，本页可关闭，请回到 DeepSeek Harness。'
  }, 1200)
<\/script>
</body>
</html>`;
async function startLogin(cfg = defaultLoginConfig()) {
	const ticketId = randomHex(16);
	const { verifier, challenge, method } = pkce();
	const dpopJWK = newDPoPPrivateJWK();
	const codeCh = await new Promise((resolve) => {
		const server = http.createServer();
		const waiters = [];
		server.on("request", (req, res) => {
			const u = new URL(req.url ?? "/", "http://127.0.0.1");
			if (u.pathname !== REDIRECT_PATH) {
				res.writeHead(404).end();
				return;
			}
			const code = u.searchParams.get("code");
			const redirect = u.searchParams.get("redirect");
			if (!code && redirect) {
				res.writeHead(307, { Location: redirect }).end();
				return;
			}
			if (!code) {
				let body = "";
				req.on("data", (c) => body += c);
				req.on("end", () => {
					finish(new URLSearchParams(body).get("code"));
				});
				return;
			}
			finish(code);
			function finish(c) {
				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store"
				});
				res.end(CALLBACK_HTML);
				if (c) for (const w of waiters.splice(0)) w(c);
			}
		});
		server.listen(0, "127.0.0.1", () => {
			const port = server.address().port;
			resolve({
				port,
				server,
				take: () => new Promise((r) => waiters.push(r))
			});
		});
	});
	const url = buildAuthorizeURL(cfg, ticketId, challenge, method, codeCh.port);
	const promise = (async () => {
		const timer = setTimeout(() => codeCh.server.close(), 3e5);
		try {
			return await exchangeCode(cfg, await codeCh.take(), verifier, codeCh.port, dpopJWK);
		} finally {
			clearTimeout(timer);
			codeCh.server.close();
		}
	})();
	return {
		url,
		port: codeCh.port,
		promise,
		close: () => codeCh.server.close()
	};
}
//#endregion
//#region src/auth.ts
/**
* CodeArts credential store.
*
* 真实 CodeArts 桌面端聊天需要：STS `security_token` + 临时 AK/SK（HMAC 签名）
* + refresh_token（绑定 DPoP 私钥用于续期）。本模块持久化这全套 OAuth 凭证，
* 并提供自动续期。同时也保留"手动粘贴 security_token"的兜底（但无 AK/SK 时只能
* 作为降级态，聊天会被 APIG 拒）。
*
* @module dsh-codearts/auth
*/
/** 福利领取的上限；失败无所谓，卡住登录才是问题。 */
const CLAIM_TIMEOUT_MS = 15e3;
/** 两条凭证里较新的一条（`storedAt` 缺失视为最旧）。 */
function newerCredential(a, b) {
	const at = typeof a.storedAt === "number" ? a.storedAt : 0;
	return (typeof b.storedAt === "number" ? b.storedAt : 0) > at ? b : a;
}
/** 从 OAuthToken 落库。 */
function credentialFromOAuth(t, label) {
	return {
		token: t.securityToken,
		accessKeyId: t.accessKeyId,
		secretAccessKey: t.secretAccessKey,
		refreshToken: t.refreshToken,
		dpopPrivateKey: t.dpopPrivateKey,
		clientId: t.clientId,
		expiration: t.expiration,
		userId: t.userId,
		userName: t.userName,
		domainId: t.domainId,
		label: label ?? t.userName ?? t.userId,
		storedAt: Date.now()
	};
}
function codeartsAuthPath(home) {
	const base = home ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(base, ".codearts-auth.json");
}
async function loadCredential(path) {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed.token !== "string" || parsed.token.length === 0) return void 0;
		return {
			...parsed,
			token: parsed.token
		};
	} catch {
		return;
	}
}
/** 原子写一个 JSON 文件（0600）。 */
async function writeJsonAtomic(path, value) {
	await mkdir(dirname(path), { recursive: true });
	const body = JSON.stringify(value, null, 2);
	const tmp = `${path}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.tmp`;
	try {
		await writeFile(tmp, body, { mode: 384 });
		await chmod(tmp, 384).catch(() => {});
		await rename(tmp, path);
	} catch {
		await unlink(tmp).catch(() => {});
		await writeFile(path, body, { mode: 384 });
	}
}
async function saveCredential(path, cred) {
	await writeJsonAtomic(path, cred);
}
async function clearCredential(path) {
	try {
		await unlink(path);
	} catch {}
}
/**
* 领取限时福利（幂等）；无 AK/SK 时静默跳过。
*
* 必须带超时：领取失败不该拖住登录/续期。早先没传 signal，claimBenefit 的
* fetch 就没有任何超时 —— 福利接口一旦不响应，ensureFresh() 永远不返回，
* 跟着卡死的是整个聊天请求。
*/
async function claimIfPossible(cred) {
	if (!cred.accessKeyId || !cred.secretAccessKey) return;
	try {
		const { claimBenefit } = await import("./upstream-CVtspzAv.mjs").then((n) => n.D);
		await claimBenefit({
			token: cred.token,
			accessKeyId: cred.accessKeyId,
			secretAccessKey: cred.secretAccessKey,
			securityToken: cred.token
		}, AbortSignal.timeout(CLAIM_TIMEOUT_MS));
	} catch {}
}
/**
* 续期判定：距过期不足这个时长就去刷。
*
* 上游签发的 token 有效期是**固定的 2 小时**（实测 2026-11-10：落库 09:44:01、
* 过期 11:44:00），不会因为「一直在用」而顺延。所以「能连续十几天不用登录」
* 的前提是**总有人在过期前把它续掉**，一旦长时间没有请求进来（比如晚上关了 DSH
* 超过两小时），第二天必然过期 —— 表现就是「隔天就要重新登录」。
*
* 原先这里是 5 分钟，等于只在最后一刻才补救：进程稍一停顿、或者那 5 分钟里恰好
* 没有请求，这次续期窗口就整个错过了。放宽到 30 分钟，配合后台保活定时器
* （见 index.ts 的 keepAliveLoop），只要 DSH 开着就几乎不可能真的到期。
*/
const REFRESH_SKEW_MS = 18e5;
/**
 * stale 账号的重试冷却：一次续期失败就把号永久判死刑是错的 —— refresh_token 往往
 * 仍然有效（上游临时 400 / 网络抖动），隔一会儿再试就能自己活过来。
 * 既要留重试路径，也不能让真失效的号每次请求都去烧一次一次性的 refresh_token。
 * 冷却只存内存，DSH 重启后归零再试一次。
 */
const STALE_RETRY_MS = 3e5;
/**
 * 续期 POST 的硬超时。
 *
 * 这个请求**必须**有超时：`refreshToken()` 的 abort 由调用方传，而两处 `refresh()` 都没传 ——
 * 于是刷新请求完全没有超时。一旦 STS 接了连接却不回（华为侧偶发、或本机代理/防火墙半开），
 * `this._inflight` 里那个 promise 永远不 settle，`.finally` 永远不跑，`_inflight` 就永久占位。
 * 之后每一轮 `ensureFresh()` 都返回同一个挂起的 promise → 这个号在进程存活期间**再也不会续期**，
 * 2 小时后 token 到期，表现就是「CodeArts 又掉了、又要重新登录」，而重启 DSH 就好了。
 */
const REFRESH_TIMEOUT_MS = 25e3;
/**
 * 两次续期尝试之间的最小间隔。
 *
 * `refresh_token` 是一次性的：上游收到并轮换后，本地这份就作废了。请求若在「已送达、响应没回来」
 * 的区间里失败，盲目立刻重试只会拿已作废的 token 再撞一次 (invalid_grant)。留 20 秒间隔既能让
 * keepAlive 的 5 分钟节拍照常重试，又不会在一次失败里连撞多下。
 */
const REFRESH_RETRY_GAP_MS = 2e4;
/** 取出失败原因文本（directFetch 抛的类型不固定）。 */
function refreshFailureText(error) {
	return error instanceof Error ? error.message : String(error === null || error === undefined ? "" : error);
}
/**
 * 这次续期失败是「上游明确拒绝」还是「链路问题」。
 *
 * 只有前者才该把账号标成 stale（= 面板提示重新登录）。旧实现 catch 里一律 `cred.stale = true`，
 * 一次网络抖动就把号判成「必须重新登录」并落盘 —— 用户看到的正是「CodeArts 老是掉」。
 * 网络类失败保留凭据、留 `lastRefreshError`，下一轮 keepAlive 自己会活过来。
 */
function isDefinitiveRefreshRejection(text) {
	return /refresh token failed:\s*(400|401|403)/i.test(text)
		|| /invalid_grant|invalid_token|invalid_request|InvalidDPoPHeader|use_dpop_nonce/i.test(text);
}
var CodeArtsCredentialStore = class {
	_current;
	_path;
	/** 正在进行的刷新。并发请求必须共用它，不能各刷一次。 */
	_inflight;
	/**
	* 凭证代际。重登/清除会推进它，让还在飞的刷新发现自己过期，
	* 从而不把刷新结果写回去覆盖掉刚拿到的新凭证。
	*/
	_gen = 0;
	/** 作废在飞的刷新；任何直接写凭证的路径都要先调它。 */
	invalidateInflight() {
		this._gen += 1;
		this._inflight = void 0;
	}
	constructor(path) {
		this._path = path;
	}
	setPath(path) {
		this.invalidateInflight();
		this._current = void 0;
		this._path = path;
	}
	/** 给 shim 用：返回签名所需全套。 */
	async resolve() {
		const cred = await this.ensureFresh();
		if (cred === void 0) return void 0;
		return {
			token: cred.token,
			accessKeyId: cred.accessKeyId,
			secretAccessKey: cred.secretAccessKey,
			securityToken: cred.token
		};
	}
	async current() {
		return this._current ??= await loadCredential(this._path);
	}
	/** 从 OAuth 登录结果落库。 */
	async setFromOAuth(t, label) {
		this.invalidateInflight();
		const cred = credentialFromOAuth(t, label);
		await saveCredential(this._path, cred);
		this._current = cred;
		await this.claimIfPossible(cred);
	}
	/** 领取限时福利（幂等）；无 AK/SK 时静默跳过。 */
	async claimIfPossible(cred) {
		await claimIfPossible(cred);
	}
	/** 手动粘贴 security_token（降级态，无 AK/SK）。 */
	async set(token, label) {
		this.invalidateInflight();
		const cred = {
			token: token.trim(),
			label,
			storedAt: Date.now()
		};
		await saveCredential(this._path, cred);
		this._current = cred;
	}
	async clear() {
		this.invalidateInflight();
		this._current = void 0;
		await clearCredential(this._path);
	}
	async hasCredential() {
		return await this.current() !== void 0;
	}
	/**
	* 自动续期：若距过期不足 `REFRESH_SKEW_MS` 且具备 refresh 条件，则刷新并落库。
	* 返回当前（可能已刷新）凭证。
	*/
	async ensureFresh() {
		const gen = this._gen;
		const cred = this._current ?? await loadCredential(this._path);
		if (this._gen !== gen) return this._current;
		this._current = cred;
		if (!cred) return void 0;
		if (!cred.refreshToken || !cred.dpopPrivateKey || !cred.clientId) return cred;
		const exp = cred.expiration ? Date.parse(cred.expiration) : NaN;
		if (!(Number.isNaN(exp) ? false : exp - Date.now() < REFRESH_SKEW_MS)) return cred;
		return this._inflight ??= this.refresh(cred, {
			refreshToken: cred.refreshToken,
			dpopPrivateKey: cred.dpopPrivateKey,
			clientId: cred.clientId
		}).finally(() => {
			this._inflight = void 0;
		});
	}
	/**
	* 真正去刷一次。
	*
	* 两条铁律（ux-v40）：
	* 1) 请求必须带硬超时，否则一次挂住的 STS 会把这个号的 `_inflight` 永久占死；
	* 2) 只有上游**明确拒绝**（400/401/403、invalid_grant 系）才把凭证标成 stale 落库。
	*    链路问题（超时、连接被重置、代理半开）保留凭据，下一轮 ensureFresh 自己会重试 ——
	*    旧实现一律标 stale 落库，一次网络抖动就变成「又要重新登录」。
	*/
	async refresh(cred, mat) {
		const gen = this._gen;
		/**
		* 这次刷新的结果还能不能往回写。光看代际号不够：重登是异步落库的，可能在
		* 本次刷新启动**之后**才把 _current 换掉，那时代际号已经来不及拦。所以还要
		* 确认「当前凭证仍然是这次刷新的那一份」。
		*/
		const stillCurrent = () => this._gen === gen && this._current === cred;
		try {
			const next = credentialFromOAuth(await refreshToken(defaultLoginConfig(), {
				userId: cred.userId ?? "",
				userName: cred.userName ?? "",
				domainId: "",
				securityToken: cred.token,
				accessKeyId: cred.accessKeyId ?? "",
				secretAccessKey: cred.secretAccessKey ?? "",
				expiration: cred.expiration ?? "",
				refreshToken: mat.refreshToken,
				clientId: mat.clientId,
				dpopPrivateKey: mat.dpopPrivateKey
			}, AbortSignal.timeout(REFRESH_TIMEOUT_MS)), cred.label);
			if (!stillCurrent()) return next;
			/**
			* 先把新 token 放进内存，再落盘：反过来写的话，写盘一抛就把上游已轮换出的
			* refresh_token 丢掉，磁盘上留着的旧那份已经作废 —— 之后每次续期都是 invalid_grant。
			*/
			this._current = next;
			try {
				await saveCredential(this._path, next);
			} catch (error) {
				this.lastRefreshError = "续期成功但写盘失败（新 refresh_token 已在内存里）：" + refreshFailureText(error);
				return next;
			}
			this.lastRefreshError = void 0;
			await this.claimIfPossible(next);
			return next;
		} catch (error) {
			const text = refreshFailureText(error);
			this.lastRefreshError = text;
			if (!isDefinitiveRefreshRejection(text)) {
				if (!stillCurrent()) return cred;
				this._current = cred;
				return cred;
			}
			cred.stale = true;
			if (!stillCurrent()) return cred;
			this._current = cred;
			try {
				await saveCredential(this._path, cred);
			} catch {}
			return cred;
		}
	}
};
/**
* 手工粘贴 token 的降级账号固定用这个 id：再粘一次是**覆盖**，而不是又加一个。
*/
const MANUAL_ACCOUNT_ID = "manual";
function codeartsAccountsPath(home) {
	const base = home ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(base, ".codearts-accounts.json");
}
/**
* 账号的自然键，按稳定性依次退让：
*
* 1. `userId` —— 最理想，同一个人永远同一个键。
* 2. `userName`。
* 3. **DPoP 公钥**。实测上游的 token 响应里 `user_id` / `user_name` **都是空串**
*    （2026-09-30 用真实账号核对），所以前两级拿不到。DPoP 密钥由每次登录生成、
*    续期时原样复用，因此「同一次登录」内稳定、不同账号必然不同 —— 比拿 token
*    做键好，因为 token 每次续期都会轮换。
* 4. 最后才退回 token 哈希（手工粘贴的降级凭证没有 DPoP 密钥）。
*
* 已知代价：上游不给稳定身份，所以**对同一个账号重新登录**会被当成新账号，
* 旧条目会自己失效（凭据被拒 → 停用）并可在卡片上删掉。
*/
function accountIdOf(cred) {
	if (typeof cred.userId === "string" && cred.userId !== "") return cred.userId;
	if (typeof cred.userName === "string" && cred.userName !== "") return cred.userName;
	const jwk = cred.dpopPrivateKey;
	if (jwk !== void 0 && typeof jwk.x === "string" && typeof jwk.y === "string") return `k${createHash("sha256").update(`${jwk.x}.${jwk.y}`).digest("hex").slice(0, 15)}`;
	return `t${createHash("sha256").update(cred.token).digest("hex").slice(0, 15)}`;
}
function summarizeAccount(id, cred) {
	return {
		id,
		...cred.label === void 0 ? {} : { label: cred.label },
		...cred.userName === void 0 ? {} : { userName: cred.userName },
		...cred.expiration === void 0 ? {} : { expiration: cred.expiration },
		...cred.storedAt === void 0 ? {} : { storedAt: cred.storedAt },
		stale: cred.stale === true,
		signable: typeof cred.accessKeyId === "string" && cred.accessKeyId !== "" && typeof cred.secretAccessKey === "string" && cred.secretAccessKey !== "",
		paused: cred.paused === true,
		pinned: cred.pinned === true
	};
}
/**
* 单个账号的内存状态与续期。
*
* 每个账号一份、互不干扰。`refresh_token` 是一次性的，上游在刷新时会轮换它：
* 同一账号内并发刷新会烧掉它、并让失败的那次把 `stale` 盖在成功那次刚拿到的
* 凭证上，登录态就此写死（本机真实踩过一次）。所以这里保留单凭证时代验证过的
* 「单飞 + 代际」两条保护，只是作用域缩到单个账号。
*/
var AccountSlot = class {
	_cred;
	_inflight;
	_gen = 0;
	_staleRetryAt = 0;
	/** 上一次续期失败的时间戳，用来给非 stale 的网络类失败留最短重试间隔。 */
	_refreshFailedAt;
	/** 上一次续期失败的原文，给面板/日志看。 */
	lastRefreshError;
	persist;
	constructor(cred, persist) {
		this._cred = cred;
		this.persist = persist;
	}
	get credential() {
		return this._cred;
	}
	/** 账号被替换或删除：作废在飞的刷新，别让它回头写回旧值。 */
	invalidate() {
		this._gen += 1;
		this._inflight = void 0;
	}
	async ensureFresh() {
		const cred = this._cred;
		if (cred.stale === true) return this._retryStale(cred);
		if (!cred.refreshToken || !cred.dpopPrivateKey || !cred.clientId) return cred;
		const exp = cred.expiration ? Date.parse(cred.expiration) : NaN;
		if (!(Number.isNaN(exp) ? false : exp - Date.now() < REFRESH_SKEW_MS)) return cred;
		return this.forceRefresh();
	}
	/** stale 号带冷却地再试一次 refresh_token；刷新成功会自然清掉 stale。 */
	async _retryStale(cred) {
		if (!cred.refreshToken || !cred.dpopPrivateKey || !cred.clientId) return cred;
		const now = Date.now();
		if (now - this._staleRetryAt < STALE_RETRY_MS) return cred;
		this._staleRetryAt = now;
		return this.forceRefresh();
	}
	/**
	* 不管还剩多久，立刻续期一次。
	*
	* 给上游回 `invalid_iam_token` 时用：token 可能被提前作废（另一个客户端续期、
	* 上游轮换），而 `expiration` 还写着几小时之后，`ensureFresh` 根本不会动。
	* 仍然走单飞，避免并发请求把一次性的 refresh_token 烧掉。
	*/
	async forceRefresh() {
		const cred = this._cred;
		if (!cred.refreshToken || !cred.dpopPrivateKey || !cred.clientId) return cred;
		/**
		* 刚失败过就先别撞：refresh_token 一次性，请求若停在「已送达、响应没回来」的区间，
		* 立刻重试就是拿已作废的 token 再撞一次 invalid_grant，会把整个 token family 判死。
		* stale 号走 _retryStale 的 5 分钟冷却，这里只拦非 stale 的网络类失败。
		*/
		if (cred.stale !== true && this._refreshFailedAt !== void 0 && Date.now() - this._refreshFailedAt < REFRESH_RETRY_GAP_MS) return cred;
		this._staleRetryAt = Date.now();
		return this._inflight ??= this.refresh(cred, {
			refreshToken: cred.refreshToken,
			dpopPrivateKey: cred.dpopPrivateKey,
			clientId: cred.clientId
		}).finally(() => {
			this._inflight = void 0;
		});
	}
	async refresh(cred, mat) {
		const gen = this._gen;
		const stillCurrent = () => this._gen === gen && this._cred === cred;
			try {
				const next = credentialFromOAuth(await refreshToken(defaultLoginConfig(), {
					userId: cred.userId ?? "",
					userName: cred.userName ?? "",
					domainId: "",
					securityToken: cred.token,
					accessKeyId: cred.accessKeyId ?? "",
					secretAccessKey: cred.secretAccessKey ?? "",
					expiration: cred.expiration ?? "",
					refreshToken: mat.refreshToken,
					clientId: mat.clientId,
					dpopPrivateKey: mat.dpopPrivateKey
				}, AbortSignal.timeout(REFRESH_TIMEOUT_MS)), cred.label);
				if (!stillCurrent()) {
					/**
					* 槽位在续期途中被换掉了（重读磁盘 / 暂停置顶 / 重新登录），但**这次 POST 已经
					* 让上游轮换了那枚一次性 refresh_token**：不落盘等于把新链丢进黑洞，
					* 磁盘上留着的旧 token 已作废 → 之后每次续期都是 invalid_grant，账号永久掉线。
					* 因此这里仍要尝试落库，但带上「文档里还是本次消费的那一枚」这个守卫：
					* 若用户刚刚重新登录换了新链，守卫不成立，绝不覆盖。
					*/
					try {
						await this.persist(next, mat.refreshToken);
					} catch {}
					return next;
				}
				/** 先落内存再落盘：写盘抛错时不能把上游已轮换出的 refresh_token 丢掉。 */
				this._cred = next;
				this._refreshFailedAt = void 0;
				try {
					await this.persist(next);
				} catch (error) {
					this.lastRefreshError = "续期成功但写盘失败（新 refresh_token 已在内存里）：" + refreshFailureText(error);
					return next;
				}
				this.lastRefreshError = void 0;
				await claimIfPossible(next);
				return next;
			} catch (error) {
				const text = refreshFailureText(error);
				this.lastRefreshError = text;
				this._refreshFailedAt = Date.now();
				if (!isDefinitiveRefreshRejection(text)) {
					if (!stillCurrent()) return cred;
					this._cred = cred;
					return cred;
				}
				cred.stale = true;
				if (!stillCurrent()) return cred;
				this._cred = cred;
				try {
					await this.persist(cred);
				} catch {}
				return cred;
			}
		}
};
/**
* 读账号文档。
*
* 导出给守护进程（`keeper-main.ts`）用：它跑在 DSH 之外的独立进程里，只做「读文档 →
* 续期 → 写回」这一件事，不需要 `CodeArtsAccountStore` 那套槽位/冷却/单飞状态。
*/
async function readAccountDocument(path) {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return void 0;
		const accounts = parsed.accounts ?? {};
		const order = Array.isArray(parsed.order) ? parsed.order.filter((id) => typeof id === "string") : [];
		for (const id of Object.keys(accounts)) if (!order.includes(id)) order.push(id);
		return {
			version: 1,
			order,
			accounts
		};
	} catch {
		return;
	}
}
/** 多账号凭证存储：一个账号一份槽位，共用一个文档文件。 */
var CodeArtsAccountStore = class {
	_doc;
	_slots = /* @__PURE__ */ new Map();
	_loading;
	/** 落库串行化：多个账号的续期可能同时想写同一个文档。 */
	_writeChain = Promise.resolve();
	path;
	/** 旧版单凭证文件；新文档不存在时把它收编成第一个账号。 */
	legacyPath;
	constructor(path, legacyPath) {
		this.path = path;
		this.legacyPath = legacyPath ?? join(dirname(path), ".codearts-auth.json");
	}
	async loaded() {
		this._loading ??= this.load();
		return this._loading;
	}
	async load() {
		const doc = await readAccountDocument(this.path);
		if (doc !== void 0) {
			this.adopt(doc);
			return;
		}
		const legacy = await loadCredential(this.legacyPath);
		const fresh = {
			version: 1,
			order: [],
			accounts: {}
		};
		if (legacy !== void 0) {
			const id = accountIdOf(legacy);
			fresh.order.push(id);
			fresh.accounts[id] = legacy;
		}
		this.adopt(fresh);
		if (legacy !== void 0) await this.persistDoc();
	}
	adopt(doc) {
		this._doc = doc;
		this._slots.clear();
		for (const [id, cred] of Object.entries(doc.accounts)) this._slots.set(id, new AccountSlot(cred, this.persisterFor(id)));
	}
	/**
	* 给某个账号生成「把凭证写回文档」的落库函数。
	*
	* `expectRefreshToken` 是可选的守卫：只有文档里该账号的 refresh_token 仍然是
	* 指定的那一枚时才写。续期途中若被 `invalidate()` 打断（`reloadFromDisk`、暂停/置顶、
	* 重新登录），内存里的槽位已经不是本次刷新的那一份，但**上游已经把这一次性的
	* refresh_token 轮换掉了** —— 结果不落盘就是永久丢失，下一轮必然 invalid_grant，
	* 整个 token family 判死、只能重新登录。带上守卫就能区分两种情形：
	* 文档里还是那枚旧 token（没人换过链）→ 必须写；已经是新链（用户刚重登）→ 绝不覆盖。
	*/
	persisterFor(id) {
		return async (cred, expectRefreshToken) => {
			if (this._doc === void 0) return;
			if (typeof expectRefreshToken === "string" && expectRefreshToken !== "") {
				const current = this._doc.accounts[id];
				if (current === void 0) return;
				if (current.refreshToken !== expectRefreshToken) return;
			}
			this._doc.accounts[id] = cred;
			await this.persistDoc();
		};
	}
	persistDoc() {
		const snapshot = this._doc;
		const write = async () => {
			if (snapshot !== void 0) await writeJsonAtomic(this.path, snapshot);
		};
		this._writeChain = this._writeChain.then(write, write);
		return this._writeChain;
	}
	/** 按展示顺序返回账号摘要；把最近一次续期失败原因一并透出，面板才能说清为什么掉了。 */
	async list() {
		await this.loaded();
		const doc = this._doc;
		return doc.order.filter((id) => doc.accounts[id] !== void 0).map((id) => {
			const summary = summarizeAccount(id, doc.accounts[id]);
			const error = this._slots.get(id)?.lastRefreshError;
			return error === void 0 || error === "" ? summary : {
				...summary,
				refreshError: error
			};
		});
	}
	async ids() {
		await this.loaded();
		const doc = this._doc;
		return doc.order.filter((id) => doc.accounts[id] !== void 0);
	}
	async credential(id) {
		await this.loaded();
		return this._doc.accounts[id];
	}
	/** 首个账号——卡片顶部与 CLI 的「当前」。 */
	async current() {
		const ids = await this.ids();
		return ids.length === 0 ? void 0 : this._doc.accounts[ids[0]];
	}
	async hasCredential() {
		return (await this.ids()).length > 0;
	}
	/** 新增或更新一个账号，返回它的 id。 */
	async upsert(cred, id = accountIdOf(cred)) {
		await this.loaded();
		const doc = this._doc;
		this._slots.get(id)?.invalidate();
		doc.accounts[id] = cred;
		if (!doc.order.includes(id)) doc.order.push(id);
		this._slots.set(id, new AccountSlot(cred, this.persisterFor(id)));
		await this.persistDoc();
		await claimIfPossible(cred);
		return id;
	}
	/**
	* 从一次 OAuth 登录结果新增/更新账号。
	*
	* 「再登录一次」天然就是「添加账号」：同一账号是更新，别的账号就是新增。
	*
	* 传了 `identity`（来自 `fetchCallerIdentity` 的稳定 user_id）就用它当账号键 ——
	* 这正是「对同一个账号重新登录会被当成新账号」的解药；拿不到身份时退回旧行为
	* （DPoP 公钥当键），也就是每次登录各自成一条。
	*/
	async upsertFromOAuth(t, label, identity) {
		const cred = credentialFromOAuth(t, label);
		if (identity !== void 0) {
			cred.userId = identity.userId;
			if (identity.userName !== "") cred.userName = identity.userName;
			if (identity.domainId !== "") cred.domainId = identity.domainId;
		}
		return this.upsert(cred);
	}
	/**
	* 把一条已有账号迁移到它的稳定身份键上（同键则合并）。
	*
	* 用在两处：登录后回填身份（老条目已经存在时合并掉），以及 `dsh-codearts identity --fix`
	* 清理历史遗留的重复条目。合并时保留 `storedAt` 较新的一份凭证，位置沿用目标键原有的顺序。
	*
	* @returns 迁移结果：`merged` 表示并入了已存在的那条，`moved` 表示只换了键，`noop` 表示键没变
	*/
	async adoptIdentity(id, identity) {
		await this.loaded();
		const doc = this._doc;
		const existing = doc.accounts[id];
		if (existing === void 0) return "noop";
		const targetKey = identity.userId;
		if (targetKey === "" || targetKey === id) {
			doc.accounts[id] = {
				...existing,
				userId: identity.userId === "" ? existing.userId : identity.userId,
				...identity.userName === "" ? {} : { userName: identity.userName },
				...identity.domainId === "" ? {} : { domainId: identity.domainId }
			};
			this._slots.get(id)?.invalidate();
			this._slots.set(id, new AccountSlot(doc.accounts[id], this.persisterFor(id)));
			await this.persistDoc();
			return "noop";
		}
		const target = doc.accounts[targetKey];
		const keep = target === void 0 ? existing : newerCredential(target, existing);
		doc.accounts[targetKey] = {
			...keep,
			userId: identity.userId,
			...identity.userName === "" ? {} : { userName: identity.userName },
			...identity.domainId === "" ? {} : { domainId: identity.domainId }
		};
		delete doc.accounts[id];
		doc.order = doc.order.filter((existingId) => existingId !== id);
		if (!doc.order.includes(targetKey)) doc.order.push(targetKey);
		this._slots.get(id)?.invalidate();
		this._slots.delete(id);
		this._slots.get(targetKey)?.invalidate();
		this._slots.set(targetKey, new AccountSlot(doc.accounts[targetKey], this.persisterFor(targetKey)));
		await this.persistDoc();
		return target === void 0 ? "moved" : "merged";
	}
	/** 手工粘贴 security_token（降级态，无 AK/SK）——固定覆盖同一个「手工」账号。 */
	async set(token, label) {
		await this.upsert({
			token: token.trim(),
			label,
			storedAt: Date.now()
		}, MANUAL_ACCOUNT_ID);
	}
	async remove(id) {
		await this.loaded();
		const doc = this._doc;
		this._slots.get(id)?.invalidate();
		this._slots.delete(id);
		delete doc.accounts[id];
		doc.order = doc.order.filter((existing) => existing !== id);
		await this.persistDoc();
	}
	/**
	* 暂停 / 恢复一个账号。
	*
	* 只改标记，不碰凭证：恢复时不需要重新登录。重新装配槽位是因为 AccountSlot
	* 缓存的 `_cred` 是旧对象，续期回写会把它盖回来 —— 换了对象，续期写到新文档里。
	*/
	async setPaused(id, paused) {
		await this.loaded();
		const doc = this._doc;
		const cred = doc.accounts[id];
		if (cred === void 0) return false;
		doc.accounts[id] = {
			...cred,
			paused
		};
		this._slots.get(id)?.invalidate();
		this._slots.set(id, new AccountSlot(doc.accounts[id], this.persisterFor(id)));
		await this.persistDoc();
		return true;
	}
	/** 置顶 / 取消置顶：只改变轮转先后，不绕过冷却与并发上限。 */
	async setPinned(id, pinned) {
		await this.loaded();
		const doc = this._doc;
		const cred = doc.accounts[id];
		if (cred === void 0) return false;
		doc.accounts[id] = {
			...cred,
			pinned
		};
		this._slots.get(id)?.invalidate();
		this._slots.set(id, new AccountSlot(doc.accounts[id], this.persisterFor(id)));
		await this.persistDoc();
		return true;
	}
	/** shim 用：参与轮转的账号 id（排除用户暂停的）。 */
	async dispatchIds() {
		const paused = new Set(await this.pausedIds());
		return (await this.ids()).filter((id) => !paused.has(id));
	}
	/** 被用户暂停的账号 id（账号池据此保留状态但不派活）。 */
	async pausedIds() {
		await this.loaded();
		const doc = this._doc;
		return (await this.ids()).filter((id) => doc.accounts[id]?.paused === true);
	}
	/** 置顶账号的 id 列表（给账号池排序用）。 */
	async pinnedIds() {
		await this.loaded();
		const doc = this._doc;
		return (await this.ids()).filter((id) => doc.accounts[id]?.pinned === true);
	}
	/** 清空全部账号（整体登出）。 */
	async clear() {
		await this.loaded();
		for (const slot of this._slots.values()) slot.invalidate();
		this._slots.clear();
		this._doc = {
			version: 1,
			order: [],
			accounts: {}
		};
		await this.persistDoc();
		await clearCredential(this.legacyPath);
	}
	/** 给 shim 用：解析某账号的签名材料（内部含续期）。 */
	async resolve(id) {
		await this.loaded();
		const slot = this._slots.get(id);
		if (slot === void 0) return void 0;
		const cred = await slot.ensureFresh();
		return {
			token: cred.token,
			accessKeyId: cred.accessKeyId,
			secretAccessKey: cred.secretAccessKey,
			securityToken: cred.token
		};
	}
	/**
	* 上游报 IAM token 无效时强制续期。
	*
	* `seenToken` 是这次请求实际用的 token：若别的请求已经换过凭证，就别再刷一次
	* （refresh_token 会轮换，白刷一次就多一次失败风险）。
	*/
	async forceRefresh(id, seenToken) {
		await this.loaded();
		const slot = this._slots.get(id);
		if (slot === void 0) return void 0;
		if (seenToken !== void 0 && slot.credential.token !== seenToken) return slot.credential;
		return slot.forceRefresh();
	}
	/**
	* 从磁盘重读账号文档，丢掉内存里的槽位缓存。
	*
	* 给「常驻守护进程」（`keeper-main.ts`）用：它在 DSH 之外续期并写回同一个文档，
	* 所以插件这边必须定期重读，否则会一直用启动时那份快照 —— 表现为「守护进程明明
	* 续上了，卡片还显示快过期」，更糟的是插件下一次落库会把守护进程刚写的新
	* refresh_token 覆盖回旧的，那个号就再也续不上了。
	*
	* 只在**没有**在飞的续期时调用（`keepAliveLoop` 里与 `keepAlive` 互斥）；
	* 重读会把所有槽位重建，正在跑的刷新结果会被代际号拦下，不会写回。
	*/
	async reloadFromDisk() {
		const doc = await readAccountDocument(this.path);
		if (doc === void 0) return false;
		for (const slot of this._slots.values()) slot.invalidate();
		this.adopt(doc);
		return true;
	}
	/**
	* 后台保活：把所有**还能续**的账号过一遍 `ensureFresh`。
	*
	* 为什么需要它：`ensureFresh` 只会被「有请求进来」这条路径触发，而凭证有效期是
	* 固定的 2 小时。用户开着 DSH 但不聊天时，没有任何请求 → 凭证裸奔到过期 → 下一次
	* 发消息前必须先重新登录。定时调这里，只要 DSH 活着凭证就一直被续上。
	*
	* 只刷「距过期不足 `REFRESH_SKEW_MS`」的那些，刚从上游拿到的号不会被白刷一次：
	* `refresh_token` 是一次性的，多余的刷新只会多一份失败风险。
	* `stale` 的号（已确认必须重新登录）直接跳过——空转只会白烧请求。
	*/
	async keepAlive() {
		await this.loaded();
		const needsLogin = [];
		let refreshed = 0;
		let checked = 0;
		for (const [id, slot] of this._slots) {
			const before = slot.credential;
			if (!before.refreshToken || !before.dpopPrivateKey || !before.clientId) {
				if (before.stale === true) needsLogin.push(id);
				continue;
			}
			const exp = before.expiration ? Date.parse(before.expiration) : NaN;
			const expiring = Number.isNaN(exp) ? false : exp - Date.now() < REFRESH_SKEW_MS;
			// stale 号也过一遍 ensureFresh：它会带冷却地重试 refresh_token，
			// 一次临时失败不该让账号永久停在「必须重新登录」。
			if (before.stale !== true && !expiring) continue;
			checked += 1;
			const after = await slot.ensureFresh().catch(() => before);
			if (after.token !== before.token) refreshed += 1;
			if (after.stale === true) needsLogin.push(id);
		}
		return {
			checked,
			refreshed,
			needsLogin
		};
	}
};
//#endregion
export { codeartsAuthPath as a, writeJsonAtomic as c, startLogin as d, codeartsAccountsPath as i, defaultLoginConfig as l, CodeArtsCredentialStore as n, credentialFromOAuth as o, MANUAL_ACCOUNT_ID as r, readAccountDocument as s, CodeArtsAccountStore as t, refreshToken as u };
