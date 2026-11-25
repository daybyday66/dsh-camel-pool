# 驼峰插件（dsh-camel-pool）自检报告

> 状态：**历史存档 + 逐条结案**。下文第四节每条缺陷都标了 `fixed` / `open`，
> 行号是写报告时的快照，改完后可能已经位移 —— 判断修没修看结论，不要看行号。
> 对象：2026-11-13 落盘版本，含本次接入的 CodeArts 第 7 条 registerPoolRoute。
> 方式：8 轮只读探针，全程未改动任何文件。

## 缺陷结案表

| 编号 | 标题 | 状态 | 落地位置 |
| --- | --- | --- | --- |
| P1-1 | signed-out 文档被池内核误判成已登录 | fixed | `providers/codearts/index.js` signedOutDoc 不再带 credits 对象 |
| P1-2 | 关自动签到后 CodeArts 签到列恒 unknown | fixed | `panel.js` checkinOf 补 codearts 分支；STATUS_PATH 透传 welfare |
| P2-3 | 模型白名单被 libraryBypass 绕过 | fixed | 删 `hasLibraryBypassRoute` 与兜底分支；gemini 补 setExternalHidden。见 ux-v14 |
| P2-4 | hidden() 未接 disabledModels / hiddenChannels | fixed | codearts / gemini 均改为读面板注入的隐藏钩子 |
| P2-5 | 中文文案与英文分类器错配 | fixed | 错误体挂 `kind`（池词汇）；池侧 `structuredFailureKind` 优先读。见 ux-v14 |
| P3-6 | `if (prepared.error)` 死代码 | fixed | 改为传真窗口 `contextWindowFor(body)`，分支在上下文装不下时真实可达 |
| P3-7 | 双积分数据源 | recorded | 实为同一 60s 缓存，仅 detail 字段拍平后命名不一致；不做合并，改为按此结论解释 |
| P3-8 | normalizeEntry 放行写法脆 | fixed | `CHANNEL_KINDS` 带 `idPattern`，校验收敛到 `channelIdMatches`。见 ux-v14 |
| P3-9 | 在线端点 404（部署态） | fixed | 重启宿主后 5 个端点全部 200 |
| P3-10 | codearts 调用 `isIamTokenError()` 但没 import | fixed | 补导入；新增 `scripts/check-imports.mjs` 把同类漏导入变成提交即红 |
| P3-11 | 池内核 `structuredFailureKind` 用 `str()` 但本文件没定义 | fixed | 补本地 `str`；`check-imports` 增跨模块裸调用闸（`findLeakedHelpers`）。见 ux-v16 |
| P3-12 | 历史 verify 脚本 `ROOT = argv[2] \|\| cwd`，换个目录执行即崩 | fixed | `scripts/_paths.mjs` 从 `import.meta.url` 推导；宿主依赖兜底 + 活体门控。见 ux-v16 |

`fixed` 项的复跑命令是 `npm run check`，它现在是三级，对应三类「静态看不出、只有某一层能看见」的错误：

- `scripts/check-all.mjs` —— 25 个文件 `node --check` + 36 条契约断言，
  含针对上表的负向断言（例如「codearts 不再把窗口写成 0」「面板不再内联单例判断」）；
- `scripts/check-imports.mjs` —— 两道闸，抓的都是「语法对、跑正常路径也对，只有走到某个
  分支才 ReferenceError」这一类：
  ① 把 `engine.js` 重导出的 53 个可读名当白名单，扫 `lib/` 每个文件的代码区（注释、字符串、
  正则先剥掉）有没有裸引用却既没 import 也没本地声明（P3-10）；
  ② 跨模块裸调用：某名字在别的 `lib/` 文件里有声明，本文件没 import 也没声明却直接调
  ——「抄了逻辑没抄助手」（P3-11）。`--selftest` 把这两起真实事故在内存里复原，必须抓回来
  且干净树零误报；
- `scripts/check-pool-core.mjs` —— 真 import 真跑的 39 项池内核断言
  （当日桶排队、latch 让位给当日桶、latch 不得越过更早到期的路由、同档粘性仍生效、
  真实形状回归（11-30 的 trae 必须排在 12-05 的 wb2 之前）、`expiring=0` 不误判、
  状态字段透出、`only` 只刷指定路由）。
  静态断言抓不住 `??` 写成 `||` 这类改动，所以运行时那一层不能省。
- `scripts/check-hardening.mjs` 的 ux-v43 两条闸锁的是「直连通道必须自带非 undici 的 UA」：
  `const DEFAULT_USER_AGENT =` 必须在位、`withDefaultUserAgent(input, raw)` 必须在 `directFetch`
  的 undici/raw 分叉**之前**。缺任一条，undici.fetch 会自己塞 `UA: undici`，Trae 网关按裸客户端
  回 4011（伪装成限流），trae/trae2 重新 100% 502 —— 这类回归在普通单测里完全看不出来。

- `scripts/check-checkin-device.mjs` —— 真实 import + 临时台账跑的 12 项 Trae 签到设备号断言
  （首次 get 登记 fallback 落盘、已有值不覆盖、两账号隔离、rotate 换号/落盘/不动他人、
  不与已有号重复、连续 rotate 不重号、空 key 直通不写表、坏台账当空表重建、无 tmp 残留、
  0600 权限）。`@deepseek-ai/dsh-home-paths` 在独立 node 下解析不到时自动注册 resolve 钩子
  替身，被测 get/rotate 只碰 node:fs 与 node:crypto，不调用宿主 API。

只想跑一部分时用 `npm run check:syntax` / `npm run check:imports` / `npm run check:core`。

实机那一层是 `npm run verify:live`：不传端口时自动在最近出现过的宿主端口里找活的那个，
验 `patch` 标记是否已是当前内核版本、每条有当日桶的路由是否把 `expiring`/`expiringAt` 报全。
> 后续变更：CodeArts 输入框下方状态行与两个显示开关（`codeartsShowCredits` / `codeartsShowQueue`）
> 已按用户要求整体移除，本报告里涉及它们的段落仅作历史记录。
> 路径约定：下文路径均相对 `dsh-camel-pool/`，行号为当前落盘版本。

## 一、自检怎么做的（可复现）

| 项 | 方法 | 结果 |
| --- | --- | --- |
| 语法 | `lib/client.js`（6092 行 / 259113 字符）走 `new vm.Script`（classic script 语义）；其余 12 个文件走 `SourceTextModule` | 全绿 |
| 依赖解析 | 独立 Node 进程真实 import vendor 4 chunk + engine/credits/index/channel-registry/shared/pool | 全通；`lib/panel.js` 报 `Cannot find package '@deepseek-ai/dsh-home-paths'`、`lib/index.js` 报 `Cannot find package '@deepseek-ai/dsh-atomic-write'`，是宿主运行时专有包，非语法问题 |
| 运行时行为 | 真实调用 `codeartsDetail()` / `codeartsRoute().models()` / `codeartsCredits(true)` / `allChannels()` / `mergedModelGroups()` / `orderedRoutesFor()` / `poolStatusDocument()` | 见下 |
| 凭据纪律 | grep `writeJson|console|logger|token|secretAccessKey|securityToken|accessKeyId|dpopPrivateKey` 全库 | 命中 0；`shared/http.js:144-148` 的 `safeMessage` 还会洗掉 JWT 整串和 `code=/token=/refresh_token=/access_token=` 查询值 |
| 契约一致性 | 4 条路由 URL 全库 grep 比对 | `channel-registry.js:308-309`、`client.js:5711-5713`、`codearts/index.js:51-54`、`lib/index.js:275`、`panel.js:496` 完全一致 |
| 在线端点 | GET `http://127.0.0.1:<宿主端口>/plugins/dsh-pool/status` 等 | 报告当时 status 200 但无 codearts 字段、新端点 404 → 宿主仍跑旧版 lib（P3-9，重启后已全部 200） |

## 二、总体评价

| 维度 | 分 | 一句话 |
| --- | --- | --- |
| 分层与隔离 | 9 | 池内核 `shared/pool.js` 与渠道 provider 边界清楚，vendor 4 chunk 逐字节复制 + `engine.js` 重导出可读名，不 fork 市场插件、不起独立 shim |
| 上游协议正确性 | 9 | 最后一公里 `prepareChatBody` 白名单重建 + `chatStream` 现场 SDK-HMAC-SHA256 重签，从根上绕开旧 shim 的 `signed_request_requires_resign` / `bili_resign_unavailable` 403 |
| 凭据纪律 | 10 | 0600 落盘、日志只记 `tokenLen`、`accountRow` 不含 AK/SK/token、端点零密文、`safeMessage` 二次清洗 |
| 调度 / 降级 / 熔断 | 9 | `BREAKER_TTL_MS` 分档（quota/transport 60s、auth 600s、upstream 15s）、探测窗口内 HTTP 200 假成功切成下一条路由、latch 提前释放 |
| 面板与设置契约一致性 | 7 | 开关默认值用 `!==false` 兼容旧配置、settings POST 白名单、`ctx.effect` 统一反注册都到位；但签到归一化与 signed-out 文档形状没对齐既有约定 |
| 模型目录治理 | 6 | `libraryBypass` 兜底把 13 个动态模型全量注入，绕过了自己在 `shared/pool.js:278` 立下的「显式列入白名单」约定 |
| 运行时可观测性 | 8 | `.pool-route.log` + 本机 `.codearts-usage.json` 账本、逐号明细、排队探测；缺一条把上游错误码映射成池可判类别的通路 |
| 端到端验证 | 5 | 静态与运行时探针充分，但宿主进程没重启、没有真实华为云账号登录后的全链路回放 |

**综合 8/10：架构与协议层可以直接上生产，先补下面 3 处一致性再重启。** 这次重接最值得保留的决策是「把 CodeArts 做成一条 `registerPoolRoute`，而不是再起一个 shim」——上游签名覆盖请求体，任何中间层改写都会让签名失效，最后一公里重签是唯一稳妥解，旧实现的 403 日志已经证明了这一点。

## 三、做对了的（别重构）

1. **协议引擎 vendor 化**：`providers/codearts/vendor/` 只放 4 个 rolldown chunk（rolldown-runtime / auth / upstream / version），`engine.js` 把 `C/r/T/t/c/k/n/u/S/i/l/a/s/E` 之类短名重导出成可读名，适配层只依赖 engine，不碰 `index.mjs`。升级市场包只需替换 4 个文件。
2. **零密文贯穿全链路**：`forwardChat` 的 `logPoolEvent attempt` 只记 `tokenLen`；`accountRow`（`credits.js:147-175`）只输出 `id/label/size/remain/expiring/expireAt/endTimeMs/planStatus/basic/bonus/onDemand/tokens/checkin`，没有 `securityToken/accessKeyId/secretAccessKey/dpopPrivateKey`；4 条 web 路由全部 `loopbackRequest` 前置 403。
3. **失败不连累主链路**：`codeartsDetail()` 挂进 `POOL_STATUS_PATH` GET 用 try/catch 包住（`providers/pool/index.js:1676-1686`）；账本 `noteRequest/noteUsage/noteFailure` 全部 try/catch；client 的 5 份 CONTRIBUTIONS 逐份 try/catch 隔离。
4. **设置向后兼容**：`codeartsShowCredits/codeartsShowQueue` 默认 true 且读法统一是 `prefs.x !== false`，老配置缺字段时不会把面板关掉；`HUB_SETTINGS_NS` 保持 `dsh-camel-pool`，`settingsApi.update` 不会 503。
5. **签到幂等 + 排队探测**：`claimCheckin` 把 vendor 的 `claimed/already/unavailable/failed` 映射成面板八态；`probeQueue` 查完立刻 `clearQueueStatus` 清票。
6. **模型自动发现**：`refreshCodeartsModels()` + 30 分钟 `setInterval(...).unref()`，空目录抛错保留静态 13 模型兜底，不会让模型列表清空。

## 四、缺陷清单（现象 → 证据 → 影响 → 补丁）

### P1-1　signed-out 文档被池内核误判成「已登录」（运行时已坐实）

- 现象：`codearts/index.js:215-217` 的 `signedOutDoc()` 在未登录时也带 `credits: { remain:0, total:0, accounts:[] }`。
- 证据：`shared/pool.js:858-892` 的 `extractCredits(doc)` **优先**判 `typeof doc.credits === 'object'` 就走 creditsDoc 分支并直接 `return { ..., signedOut:false }`；只有**没有 credits 对象**时 `:888` 才检查 `doc.status !== 'signed-in'` 返回 `signedOut:true`。真实探针结果：

```
codeartsCredits(true) 实回 = { status:'signed-out', credits:{ remain:0, total:0, accounts:[] } }
pool 收到带 credits 的 signed-out → { signedOut:false, remaining:0, total:0 }
pool 收到不带 credits 的 signed-out → { signedOut:true }
```

- 对照：qoder `providers/qoder/index.js:2511-2516`、trae `:2310`、workbuddy `:1363` 的 signed-out 都是扁平 `{...base, status:'signed-out'}`，不带 credits 对象，正好避开这个分支。**CodeArts 是唯一带 credits 的 signed-out**，属于本次新增引入的形状不一致。
- 影响：目前**不产生可见故障**——`poolStatusDocument:944` 的 `status` 因为 `routes.length>0` 本来就恒为 `signed-in`，`credits.total` 也因 `remaining=0` 不受影响；但 `:937` 的 `signedIn` 被误置 true，一旦以后把 status 判定改成依赖 `signedIn`，就会出现「没登录却显示可用」。属于语义污染，趁早修。
- 补丁（`codearts/index.js`，去掉 credits 对象即可；`codeartsDetail()` 与 `panel.js:359-372` 的 creditsOf 都已有缺失兜底，不会连带报错）：

```js
function signedOutDoc(error) {
  return { status: 'signed-out', ...error !== undefined ? { error } : {} };
}
```

### P1-2　关掉自动签到后，CodeArts 的签到列恒为 `unknown`

- 证据：`panel.js:385-403` 的 `checkinOf` 前置分支只处理 `checkinDoc.claim.state`；`:404-482` 只有 workbuddy / trae / qoder 三个 kind 分支，`:483` 兜底 `return { state:'unknown' }`。`KIND_ADAPTERS` 里 codearts 是 `probeCheckin:false`（`:497`），所以 `probeChannel:714-729` 在关掉自动签到时**不会** GET 也不会 POST，`checkinDoc` 恒 undefined → 必落兜底 unknown。
- 另一半问题：`CODEARTS_STATUS_PATH` 返回体里写死 `checkin: { supported:true, claimable:false }`（`codearts/index.js:504-519`），把 `codeartsDetail()` 里由 `credits.js` welfare 算出的 `claimable/claimedToday/amount` 覆盖了；而这两个字段名借的是 qoder 形状，checkinOf 根本没有 codearts 分支去读。
- 影响：默认 `autoCheckin:true` 时走 POST claim 前置分支，显示正常；用户一旦关掉全局自动签到，主面板签到列变「未知」，且没有可点的签到入口。
- 补丁（两步）：① `panel.js:482` 前插入 codearts 分支：

```js
if (kind === 'codearts') {
  const checkin = doc.checkin;
  if (checkin === undefined || checkin === null) return { state: 'unknown' };
  if (checkin.supported === false) return { state: 'unsupported', note: checkin.reason };
  if (checkin.claimable === true) {
    return { state: 'claimable', ...checkin.amount !== undefined ? { reward: num(checkin.amount) } : {} };
  }
  if (checkin.claimedToday === true) return { state: 'done' };
  return { state: 'unsupported', note: checkin.reason ?? '当前账号没有进行中的签到活动' };
}
```

② `codearts/index.js` 的 STATUS_PATH 返回体把写死的 checkin 换成透传 welfare，例如 `checkin: { supported:true, claimable: doc.checkin?.claimable === true, claimedToday: doc.checkin?.claimedToday === true, amount: doc.checkin?.amount }`（字段名沿用 `credits.js:126-131` 的 welfare 形状）。

### P2-3　模型白名单约定被 `libraryBypass` 绕过

- 证据：`codearts/index.js:409` 声明 `libraryBypass:true`；`shared/pool.js:467-472` 只要组内有一条该标记就返回 true；`:541-548` 把未命中白名单的模型用 `{ idLower: group.poolId, tier:4, index:1000+i }` 全量兜底注入。**而 `shared/pool.js:278` 的注释自己写着「Gemini Pro 订阅：用户点名的 4 个，显式列入白名单（不再依赖 libraryBypass 兜底）」**，`:279-285` 也确实列了 6 个 gemini id。
- 运行时实测（`mergedModelGroups` 只注册 codeartsRoute）：13 个 group 全部 `free:false`、`tier:4 / index:1000+`，poolId 为 `deepseek-v4.1-flash / glm-5.3-flash / deepseek-v4-pro / openpangu-2.0-pro / glm-5.2 / glm-4.7 / qwen3-vl-235b / qwen3.5-397b-a17b-vl / qwen3.6-27b-vl / glm-5.1 / deepseek-v4.1-flash-1017 / deepseek-v4-flash-0731 / openpangu-2.0-flash`。其中 3 个已命中白名单，另 10 个是兜底注入。
- 影响：模型选择器里多出 10 个排在最末、无 tier 语义的模型；动态目录一旦新增模型也会自动灌入。另外 `orderedRoutesFor` 是**精确小写匹配**（`orderedRoutesFor('GLM-5.2')` 实测返回 `[]`，必须传 `glm-5.2`），调用方传原始大写 id 会扑空。
- 补丁（按项目既有约定）：在 `CURATED_MODELS` 尾部追加未命中的小写 id —— `glm-5.2 / glm-5.1 / glm-4.7 / openpangu-2.0-pro / openpangu-2.0-flash / qwen3-vl-235b / qwen3.5-397b-a17b-vl / qwen3.6-27b-vl / deepseek-v4-flash-0731 / deepseek-v4-pro-0813 / deepseek-v4.1-flash-1017`，给合理 tier；然后去掉 `libraryBypass:true`，让动态目录与白名单一致。长期做法是把白名单改成可按 route.key 声明 tier 的表，而不是全局常量。

### P2-4　`hidden()` 未接 `disabledModels` / `hiddenChannels`

- `codearts/index.js:414` 是 `hidden: () => []`，恒空；对照 `workbuddy/index.js:1882/:2240`、`trae/index.js:2087/:2568`、`qoder/index.js:2255/:2872` 都通过 `setPickerHidden(fn)` 接了 `lib/index.js` 注入的 `pickerHiddenFor`。`gemini/index.js:322` 同样是恒空（既有先例），但既然本次是「按我的规则来」，新渠道应当对齐主渠道。
- 影响：设置里的「隐藏渠道 / 停用模型」对 CodeArts 无效。
- 补丁：仿 qoder 加 `setCodeartsHidden(fn)` 模块级变量 + `hidden: () => excluded`，在 `lib/index.js:132` 注入 `pickerHiddenFor` 的同一处调用它。

### P2-5　错误响应中文文案与 `forwardChat` 分类器错配（待实测确认）

- `codeartsFetch` 失败时回 `jsonResponse(status, { error:{ message: upstreamErrorMessage(...), kind } })`；`upstreamErrorMessage`（vendor `upstream-CVtspzAv.mjs:952-962`）把 resign / TPM / TM.00001041 / IAM / 模型不可达 / 非多模态都翻成中文。而 `providers/pool/index.js:873/:884/:893/:899` 的 `looksLikeAuthFailure` / `INVALID_ARGUMENT` 正则 / `looksLikeUpstreamRejection` / `looksLikeQuota` 都基于**原始响应文本**匹配英文或上游码。
- 风险：`session_dead` / `iam_stale` 这类本该走 600s auth 冷却并清 latch 的失败，可能因为 message 是中文而落进默认 `transport` 60s 熔断，换路由策略打折。
- 补丁（最小）：错误体里并列保留上游原始 code 与一个机器可判标记，例如 `{ error: { message, kind, code: rawCode } }`，并让 `looksLikeAuthFailure` 识别 `kind === 'session_dead' || kind === 'iam_stale'`；或在 message 里保留 `APIG.0301` / `signed_request_requires_resign` 原串不翻译。

### P3-6　`if (prepared.error)` 是死代码

`codearts/index.js:199` 判断 `prepared.error`，但 vendor `prepareChatBody` 的返回实测 keys 为 `['url','body','model','chatId']`，永远不带 error。删掉这段，或改成校验 `prepared.url` / `prepared.body` 非空，别留一条永远不会走的分支误导后来人。

### P3-7　双积分数据源

`route.credits()` 把积分汇进 `doc.credits.total`，`codeartsDetail()` 又把一份积分汇进 `doc.codearts`，两者都靠 `CREDITS_TTL_MS=60000` 缓存去重。当前一致，但属于两份事实源。建议让 `POOL_STATUS_PATH` 直接复用 `codeartsCredits()` 的同一份结果，或让 `codeartsDetail()` 只取 `poolStatusDocument` 里的 codearts account 行。

### P3-8　`normalizeEntry` 的放行写法脆

`channel-registry.js:129` 是 `if (kind !== 'workbuddy' && kind !== 'trae' && kind !== 'qoder' && id !== kind) return undefined;` —— codearts 靠 `id === kind` 恰好放行，第二个 CodeArts 实例（`codearts2`）会被静默丢弃。当前 `CHANNEL_KINDS.codearts.multi:false` 与之自洽，但更稳的是把校验改成白名单查表 `CHANNEL_KINDS[kind]`，id 走各 kind 自己的正则。

### P3-9　在线端点 404（部署态，非代码缺陷）

GUI 上 `GET /plugins/dsh-pool/status` 仍返回旧结构（`credits.total=11678.04`、无 codearts 字段），`GET /plugins/dsh-pool/codearts-oauth` 与 `GET /plugins/dsh-connect/codearts/status` 都是 404。原因是 `webServer` 路由注册在 `ctx.inject(['webServer'])` 回调里，新增路由必须重启 DSH 桌面端进程；`README.md:130` 说的「lib/*.js 热加载」只对已注册路由的处理函数生效。

## 五、建议的落地顺序

**第一批（一次重启内做完，改动都在 3 个文件）**：P1-1 → P1-2 → P2-3。这三处都是「对齐项目自己已有的约定」，不涉及协议层，风险最低，收益是修掉语义污染、补齐签到列、让模型目录恢复白名单治理。

**第二批**：P2-4（偏好打通）、P2-5（错误分类打通）、P3-6（清死代码）、P3-8（注册表校验查表化）。

**长期**：
- 给 `registerPoolRoute` 写一份契约测试：`assertRoute` + `extractCredits(signed-out)` + `checkinOf` 八态 + `mergedModelGroups` 白名单命中，作为新增渠道的准入门禁，避免下一个渠道再踩 P1-1 / P2-3。
- 把 `POOL_STATUS_PATH` 里的 `doc.codearts / doc.codeartsAuth / doc.codeartsSettings` 三段 try/catch 收敛成一个 `channelExtras` 扩展点，后续渠道不用再改 `providers/pool/index.js`。
- 真实账号回放一次：登录 → 拉目录 → 发一条 `/api/v2/chat/completions` → 看 `.pool-route.log` 的 `tokenLen` 与 usage 账本 → 领取签到 → 关掉两个开关看信息行，补齐第五节端到端验证的 5 分。

## 六、重启后验收清单

```bash
# 宿主端口会变（13347 / 6854 / 10233 / 13836 都出现过）——从 GUI 地址栏取当前端口，
# 或直接 grep 宿主日志里的 listening 行，别照抄历史端口。
PORT=13836
curl -s http://127.0.0.1:$PORT/plugins/dsh-pool/status | jq '{status, credits:.credits.total, codearts:.codearts, auth:.codeartsAuth, settings:.codeartsSettings}'
curl -s http://127.0.0.1:$PORT/plugins/dsh-pool/codearts-oauth   | jq .
curl -s http://127.0.0.1:$PORT/plugins/dsh-connect/codearts/status  | jq .
curl -s http://127.0.0.1:$PORT/plugins/dsh-connect/codearts/checkin -X POST -H 'content-type: application/json' -d '{}' | jq .
curl -s http://127.0.0.1:$PORT/plugins/dsh-pool/codearts-queue      | jq .
```

补一条 ux-v14 专属验收：`curl -s http://127.0.0.1:$PORT/plugins/dsh-pool/status | jq '.pool.routes[] | select(.key=="codearts")'` 应同时出现 `expiring` 与 `expiringAt`，且 `expiringAt` 为当日上海 24:00 对应的 UTC（16:00Z）。

验收点：4 个新端点全部 200（不再是 404）；`/plugins/dsh-pool/status` 出现 `codearts` / `codeartsAuth` / `codeartsSettings`；设置卡片里「积分」「上游排队位置」两个开关各自关掉后，输入框下方信息行对应 chip 消失；真实登录后 `credits.accounts` 出现带 `route:'codearts'` 的逐号行。