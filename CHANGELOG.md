# 更新记录

本文件记录池内核与面板的行为变更。`patch` 字段（`GET /plugins/dsh-pool/status` 的
`patch`）就是这里的版本号——面板页脚会把它显示成「内核标记」，两者逐字对应。

## ux-v18（2026-11-15）

### 修复：网络一抖，十个渠道余额全变 0 / 到期时间全空

- 现象：宿主重启后 `GET /plugins/dsh-pool/status` 十条路由里九条 `fetch failed`、`credits.total=0`，CodeArts 卡片同样 `积分统计接口失败 (0): ... fetch failed`，面板上余额与到期时间同时消失。
- 根因一：宿主进程按 `HTTP(S)_PROXY` 装过全局 dispatcher；本机代理（127.0.0.1:7897）当时返回 502 / TLS 握手失败，而同一时刻子进程直连 `https://api.trae.cn`、`https://snap-access.cn-north-4.myhuaweicloud.com` 全部可达 —— 坏的是代理链路，不是上游或 DNS。
- 根因二：`refreshPoolCredits()` 的 catch 直接把缓存覆盖成 `{accounts: [], signedOut: true}`，一次瞬时失败就把已显示的余额清零，且没有 `stale` 语义区分「真的没额度」与「这次没读到」。
- 修复：新增 `lib/shared/net-rescue.js` —— 主 `fetch` 只在网络型错误（`fetch failed` / `UND_ERR_*` / `ECONNRESET` / 超时 / 代理隧道失败）时，用 undici 显式 `Agent`（不读 env proxy）重试一次；成功路径与流式 body 形状完全不变。`lib/index.js` 在渠道首次打上游之前安装。
- 修复：`refreshPoolCredits()` 失败时保留上一份好数据，只加 `stale` / `error` / `lastGoodAt`；`pool.routes[]` 新增 `stale` 与 `lastGoodAt`；面板路由行显示「离线 · 上次 {time}」，余额继续显示而不是「—」。

## ux-v17（2026-11-15）

### 新增：免费用户积分到期政策估算

- 现象：Trae / Qoder / Gemini 等渠道上游不返回逐包积分到期；池内核把缺失 `expiryMs` 视作 `Number.MAX_SAFE_INTEGER`，按「最早积分过期优先」排序时这些渠道永远垫后。
- 官方依据：Trae CN《套餐与计费》（https://docs.trae.cn/ide_plans-and-billing）每月登录赠送 500 积分「当前自然月」、签到/邀请/新用户等 31 个自然日；Qoder《每日领取 100 Credits》（http://docs.qoder.com/zh/events/100credits）每笔奖励自领取日起 30 天、Qoder《Pricing》（http://docs.qoder.com/account/pricing）Plan Credits 当前计费周期末不结转；Google AI Studio《Rate limits》（https://aistudio.google.com/docs/rate-limits）RPD 于太平洋时间午夜重置；华为云《每日签到得积分》（https://support.huaweicloud.com/offers-codeartsagent/codeartsagent_offers_0004.md）签到积分当日有效、华为云《新版上线》（https://support.huaweicloud.com/price-codeartsagent/codeartsagent_billing_0028.md）优先消耗剩余有效期最短的积分且未使用额度不结转。
- 修复：新增 `lib/shared/credit-expiry-policy.js`，对无上游逐包到期的 Trae / Qoder 按当前自然月末作保守估算，对 Gemini 按下一个太平洋午夜估算；`extractCredits()` / `refreshPoolCredits()` 让无 `credits()` 的订阅制路由也得到有限 `expiryMs`；状态文档新增 `expiryEstimated` / `expirySource` / `expiryPolicy` / `expiryUrls`，渠道卡与常显条用「估算」虚线标签区分，真实上游到期始终优先。
- 排序：估算值只参与路由排序与展示，不改余额、不冒充上游精确值；`hindsightAutoOrder` 与 `orderedRoutesFor` 因此不再把免费/签到渠道当成无限期。

## ux-v16（2026-11-14）

### 修复：池内核 `str` 未定义 —— 结构化错误分类整条路 500

- 现象：`verify-gemini-429-e2e` / `verify-uxv11-e2e` 的红字不是脚本挑剔，池真的回了
  `500 {"error":{"message":"str is not defined","type":"pool_internal_error"}}`；
- 根因：ux-v14 新增的 `structuredFailureKind` 用 `str()` 判结构化 `error.kind`，但
  `lib/providers/pool/index.js` 里没有这个助手（它只定义在
  `providers/codearts/index.js` 与 `providers/codearts/credits.js`）；
- 伤害面：只要上游回的是 JSON 错误体（`text` 以 `{` 开头），分类器自己先抛
  ReferenceError，被最外层兜成 500 —— 真实分类（auth / quota / upstream）全丢，熔断、
  latch 清理、切下一条路由全不发生。纯文本错误体反而能正常分类，所以线上只表现为
  「偶发 500」，最不该 500 的配额/掉登录路径恰恰最容易踩到；
- 修复：补回本地 `str`（非字符串一律空串）；并把这道缺口做成静态可查（见下）。

### 新增：跨模块「裸调用」静态闸

- `scripts/check-imports.mjs` 加第二道闸 `findLeakedHelpers`：先收集 `lib/` 全部文件里
  声明过的名字（任意缩进 —— 池内核整个主体缩在工厂函数里，按第 0 列收会把自己人也算成
  「别人的」），再逐文件找「裸调用了某名字，但本文件既没 import 也没声明」，报出它定义在
  哪几个文件。ux-v16 的 `str` 事故就是它抓的；
- 为了让这道闸可信，`stripNonCode` 补了两处：① 认正则字面量（此前
  `/"error"|"code"|"message"…/` 这种带引号的正则会把后面二十行当字符串吃掉，于是
  `toPoolModel` 这种本文件明明有的函数反被判成漏定义）；② 收集形参名
  （`resolve` / `res` / `quota` 这类以形参身份被调用的名字不算漏定义）；
- `--selftest` 现在复现两起真实事故：删掉 codearts 的 `isIamTokenError` 导入、删掉池内核的
  `str` 定义，都必须被抓回来，干净树必须零误报。

### 工程化：历史 verify 脚本不再「开箱崩」

- 三个脚本的 `ROOT` 原是 `process.argv[2] || process.cwd()`，在仓库根以外执行会拼出不存在
  的路径。改为从 `import.meta.url` 推导（`scripts/_paths.mjs` 的 `repoRoot`），
  `argv[2]` / `DSH_CAMEL_POOL_ROOT` 只作覆盖；
- 宿主依赖（`@earendil-works/pi-ai`、`@deepseek-ai/dsh-llm*`）在本机 node_modules 里是指向
  宿主安装目录的软链，宿主改 asar 打包后全断。新增 `scripts/_hostdeps-hooks.mjs`：只在本进程内
  给这些裸包加一条兜底解析（按 `exports` 条件表手写，含 `*` 通配），真找不到才 SKIP ——
  不动 profile、不动宿主；
- `verify-uxv12-escape.mjs` 这类需要真网络的活体测试加门控：`DSH_LIVE_NET=1` 才跑，否则打印
  SKIP 并退出 0，不再用一个连不上 Google 的超时栈冒充代码缺陷；
- 顺手修好三处真实断言：`verify-uxv11-e2e` 的「单路由 45s 探测窗口」、`verify-gemini-429-e2e`
  的「全池失败 502」、`verify-uxv10` 的硬编码路径 —— 现在四个脚本开箱全绿，`npm run verify:e2e`
  一键跑两个真起 HTTP 服务的端到端脚本；
- `verify-gemini-429.mjs` 的 A2 断言改契约（不是改松）：它还在验 ux-v11 之前的「持续 429 应换多个
  候选模型」，而 `codeassist.js:758` 起已经明确「项目级 429 换候选共享同一配额、换过去只白烧预算，
  原地退避走完就把 429 回池」。新断言 = 单候选 + 恰好 4 次调用（首发 + 3 格阶梯）+ 响应体保留
  `RESOURCE_EXHAUSTED`；同时给它加 `GEMINI_NO_APIKEY_ESCAPE=1` 与压短的
  `GEMINI_CA_QUOTA_LADDER`，跑时从 86s 降到 0.4s（之前它会真去连 apikey 端点等超时）；
- `verify-uxv14-live.mjs` 的 patch 断言不再写死版本号，改成从 `lib/providers/pool/index.js`
  读 `patch: "ux-vN"` 自推导 —— 写死的代价是每次升 patch 都得回来改一行，忘改就是「脚本红了但
  一切正常」，和它要防的「磁盘改了进程还是旧的」同样有毒性；现在失败信息直接写明
  「源码 ux-v16 / 宿主 ux-v15，重启宿主后再验」。

## ux-v15（2026-11-14）

### 修复：设置写入白名单漏键

- POST `/plugins/dsh-connect/settings` 的白名单漏了 schema 里可切换的
  `poolAutoBoostEffort` / `disabledChannels` / `disabledModels`：面板
  「切换模型自动提档」开关一点就 400 `no-whitelisted-field`，客户端把 400 当失败
  静默回弹、无任何错误提示（实机 curl 复现，修后 200）；
- 补齐三键（数组键沿用归一规则：channels 只要 string，models 还要含 `/`），
  三者写入后会触发 `onModelsChanged` 广播，模型列表与开关状态不再自相矛盾；
- `scripts/check-all.mjs` 同步断言三键都在白名单里；内核 `patch` 升为 **ux-v15**。

### 修复：漏导入导致的 ReferenceError

- 实机路由日志 `~/.dsh/.pool-route.log` 出现
  `route-fail reason=transport error="isIamTokenError is not defined"`：
  `lib/providers/codearts/index.js` 的 `poolKindOf` 用了 `isIamTokenError`，但
  engine.js 重导出的 53 个可读名里这一个没进导入表 —— 只在有非 2xx / 流内错误帧时
  才炸，正常流量与 `node --check` 都发现不了；
- 后果：ReferenceError 被 forwardChat 兜成 `kind: "transport"`（60 秒冷却），本来该
  记 10 分钟的 `iam_stale` 被降级成 60 秒普通冷却，真实分类彻底丢失；
- 修复：导入表补回 `isIamTokenError`；新增 `scripts/check-imports.mjs` 防线：把
  `engine.js` 重导出的 53 个可读名当白名单，扫 `lib/` 下每个文件的**代码区**（注释
  与字符串先剥掉）里有没有裸引用却既没 `import` 也没本地声明；`--selftest` 在内存里
  把这次事故复现一遍，扫描器必须抓回来且干净树零误报。接进 `npm run check`，
  同类漏导入从「上线踩雷」变成「提交即红」。

## ux-v14（2026-11-14）

### 当日额度优先烧

- `credits()` 现在额外报 `expiring`（当日将过期余额合计）与 `expiringAt`（过期时刻）；
- `extractCredits` 收下这两个字段；有当日桶时 `expiryMs` 取 `min(套餐期末, 当日过期时刻)`，
  于是该路由在「最早过期优先」里自然排第一；
- `orderedRoutesFor` 新增 latch 让位：头部还有当日桶时，粘性 latch 退到当日桶之后
  （`poolBurnExpiringFirst: false` 可关，关掉完全回到旧行为）；
- 服务成功后 `invalidateCredits()` + 当日桶有剩则强制刷新积分（`refreshPoolCredits({ force: true, only: [routeKey] })`
  只刷这一条——force 全池等于每个成功请求都打一轮上游），下一次排序读到真实剩余；
- 面板新增「当日积分优先」开关（默认开），状态文档 `pool.routes[]` 多两个字段
  `expiring` / `expiringAt`。

### 错误分类改为结构化优先

- 各适配层错误体现在都带 `error.kind`，取值是池内核词汇：
  `session_dead` / `iam_stale` / `quota` / `upstream` / `transport`，另带 `error.code`
  保留上游原始分类；
- 池侧新增 `structuredFailureKind()`，非 2xx 时先读它，读不到才跑原来的英文正则。

  修的是：CodeArts 适配层把错误翻译成中文人话（`upstreamErrorMessage` 的产物），
  而 `looksLikeAuthFailure` 只认英文，于是「IAM token 已失效」被降级成 60 秒 transport
  冷却——掉登录的号每 60 秒白撞一次上游，而不是记 10 分钟 auth 冷却并切走。

### 模型目录

- 删掉 Gemini 路由的 `libraryBypass`：上游多出任何未登记 id 一律不进池，
  `CURATED_MODELS` 是唯一事实源（此前动态模型会以 tier 4 兜底注入，绕过白名单）；
- `hidden()` 改为读 `setExternalHidden` / `setPickerHidden`，与 CodeArts、
  老渠道同一套 `disabledModels` / `disabledChannels` / `poolEnabled` 规则。

### 渠道注册表与上下文预检

- `CHANNEL_KINDS` 从「只写 `multi`」升级成真正的单一事实源：每条渠道带自己的
  `idPattern`，新增 `channelIdMatches(kind, id)`；`normalizeEntry` 与面板的
  `create` 校验都调它，原来的五条硬编码 `if`（workbuddy 正则 / trae 正则 /
  qoder 正则 / `id !== kind` 单例判断）全部删除。加新渠道只改一处表。
- CodeArts 的 `prepareChatBody` 现在传真窗口（`contextWindowFor` 从
  `currentModels` 里查），此前恒传 0，`prepared.error` 是不可达死分支，超长上下文
  只能撞上游 400；现在本地就能拦，并归到 `kind: "invalid"`，
  不会被记成 60 秒熔断白冷却一条健康路由。

### 工程化

- `npm run check` = `check-all.mjs`（25 个文件语法检查 + 35 条契约断言）
  + `check-imports.mjs`（53 个引擎导出名的漏导入扫描）
  + `check-pool-core.mjs`（12 项池内核运行时断言）；
- `scripts/check-pool-core.mjs` 是真 import 真跑：当日桶排队、latch 让位、
  `expiring=0` 不误判、状态文档字段透出——这些改一个 `??` 成 `||` 照样过静态
  检查，只能靠运行时断言兜住。全程假路由注入，不碰网络与真实凭据；
- `scripts/verify-uxv11-e2e.mjs` / `verify-uxv12-escape.mjs` / `verify-gemini-429.mjs`
  三处 `ROOT` 补默认值，不再需要手传入参即可跑；
- `npm run verify:live`（`scripts/verify-uxv14-live.mjs`，端口自动发现）：对着跑着的
  宿主验 `patch` 是否已是 `ux-v15`、每条有当日桶的路由是否把 `expiring`/`expiringAt`
  报全——静态断言全绿只证明磁盘改了，证明不了进程加载了新模块；
- README 的路由数 / 模型数 / 套餐数 / 配置键表 / 端点表与代码对齐，图床缺失的头图移除。

## ux-v13（历史）

省略 `stream` 时按非流式处理（此前写 `!== false`，省略即被当成流式）。

## ux-v12

API-key 逃生通道：OAuth project 配额耗尽与 apikey 配额是两套账，
OAuth 候选全败时改道 apikey 再兜一次底。

## ux-v11

- 429 `RESOURCE_EXHAUSTED` 按 project 级时间窗处理（实测单窗 40s+）；
- 单次 fetch 的超时只覆盖「拿到响应头」这一段，不再把 pro 档的长首字节误判成超时；
- 无 signal 时必须照常等满 ms。

## ux-v10

- 拒绝窗口自愈：400 `FAILED_PRECONDITION` / 404 `NOT_FOUND` / 503 不再当成模型名非法
  立刻放弃，也不再记 60 秒 transport 熔断；改为内部短退避重试 + 候选轮换，
  池侧单独记 15 秒 upstream 冷却；
- 补 `gemini-3.5-pro` / `gemini-3.1-pro-high` 两个宿主下拉里真实存在的档位；
- 探测窗口首字节 6 秒超时；自动提档改成面板开关 `poolAutoBoostEffort`（默认关）。

## ux-v9

修复 Gemini 偶发 429 导致的 60 秒 quota 熔断锁死（route.fetch 内短退避重试 +
单路由组熔断兜底探测）。

## ux-v8

OAuth2 Code Assist 复用 Google AI Pro 订阅，免绑卡。

## ux-v7

Gemini 模型收敛到 4 个；官方用量限额区块与本机同步端点。

## ux-v6

- 免费语义收窄、思考强度默认最高档、下拉显示开关重整；
- 渠道中心残留入口清理（`showDockButton` 自此只作配置兼容保留）。

## ux-v5

面板开关归入模型库。

## 首版

26 模型白名单 / 确定性排序 / 性价比开关 / 路由显示开关 / 积分过期跨路由 /
下拉只留合并模型。
