# 更新记录

本文件记录池内核与面板的行为变更。`patch` 字段（`GET /plugins/dsh-pool/status` 的
`patch`）就是这里的版本号——面板页脚会把它显示成「内核标记」，两者逐字对应。

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
