# 更新记录

本文件记录池内核与面板的行为变更。`patch` 字段（`GET /plugins/dsh-pool/status` 的
`patch`）就是这里的版本号——面板页脚会把它显示成「内核标记」，两者逐字对应。

## 内核 ux-v35：签到补领到账修正（2026-11-21）

修「点了签到却不到账」：Qoder 活动窗口未到（每日约 10:00 才放签到福利）时，旧逻辑把 `showCampaign=true` 误判成 `done`，面板显示已签却不加分；Trae 上游偶发「参与用户太多」失败后没有重试。本版只动面板调度与 Qoder provider 判定，池内核状态机 `lib/shared/pool.js` 仍未改动。

### 变更

- **判定**：Qoder `claimCampaign()` 仅在 `claimedToday` 时返回 `already-claimed`；无可领奖励且窗口未到时返回 `pending` + `retryAt`（当天 10:05 或未来 CLAIM_BENEFIT 活动开始 +1 分钟），不再假报成功。面板 `checkinOf()` 同样只认 `claimedToday` 为 `done`，`showCampaign` 但不可领改为「待补领」提示。
- **补领队列**：`lib/panel.js` 新增持久化队列 `.dsh-checkin-retry.json`（仅 qoder / trae，原子写、0600、保留 7 天），记录当天成功 / 待重试状态。
- **后台扫描**：`registerPanel()` 内启动 15s 首次 + 20min 周期扫描，尊重 `autoCheckin` 与 `disabledChannels`，对到期队列 POST 各自 `checkinPath` 重试；Trae 失败 20min 后重试，Qoder 到点后重试；面板卸载时清理定时器。
- **端口兜底**：后台 sweep 无 req 上下文，原 `loopbackBaseFallback()` 只读 env、缺 `DSH_PORT` 时写死 3079 会打空；改为记录最近一次真实请求解析出的回环基址 `lastKnownBase`（由 `fanoutBaseOf(req)` 喂入），后台任务复用与 GUI 一致的正确端口。进一步抽出 `loopbackBaseStrict()`：没有任何可靠端口来源（面板尚未轮询、env 也缺失）时返回 null，sweep 直接跳过本轮，不再把 `fetch failed` 写进补领队列、浪费真正的重试机会。
- **归一化**：`normalizeClaim()` 把 `pending/retryable` 映射成 `unsupported` + 说明文案，一键签到不再把「窗口未开」算成失败。

### 自检

- `node --check lib/panel.js lib/providers/qoder/index.js` 通过；`npm run check` 全绿。
- 热重载后 `GET /plugins/dsh-qoder-connect/1/status` 的 checkin 带 `retryable/retryAt`；到点后台 sweep 自动补领，积分到账。

## 内核 ux-v34：用量记账口径修正（2026-11-21）

修用量页「累计积分消耗」虚高（实测显示 11 万+，真实消费约几百）。纯记账口径修正，池内核状态机 `lib/shared/pool.js` 仍未改动。

### 变更

- **根因**：`lib/shared/usage.js` 的 `noteCreditObservation()` 把每次余额下降都记成消耗。CodeArts 余额口径 `usageTotalPackageCredit.package_credit_remain` 含赠送包与当日到期包，套餐周期重置 / 赠包过期会被 20s 高频采样拆成无数小于 `MAX_CREDIT_DELTA`（10000）的小下降，绕过单次护栏后被不断累加（零请求日也记 1.5 万～3.5 万）。
- **治本**：CodeArts（routeKey `codearts` / meta.kind `codearts`）不再按余额差记账，只认上游 usage 事件直接上报的 `directCredits`；其余渠道余额差推算保持不变。
- **一次性账本迁移**：`ensureLoaded()` 里把 codearts 每天 platform.credits 收敛到 directCredits，`meta.__usageV2Migrated` 幂等标记，抹掉历史虚高而不动 token / 请求数 / 其它平台。
- **面板**：zh/en `usageNote` 改成自解释文案；累计消耗远超当前额度时，用量页顶部挂醒目提示，说明含非消费性余额变动、仅供参考。

### 自检

- `npm run check`、`node --check` 均通过；热重载后 `GET /plugins/dsh-connect/usage` 累计 credits 回落，`/plugins/dsh-pool/status` patch 保持兼容。

## 内核 ux-v33：面板显示优化（2026-11-20）

只改 `lib/client.js`（纯展示层），池内核、路由、调度一行未动。

### 变更

- **`unlimitedQuota` 文案泄漏**：`unlimitedQuota: '不限额'` 只存在于 WorkBuddy
  卡片的文案表里，积分池面板自己的 zh/en 表没有这个 key，`safeT` 查不到就原样
  返回，七牛行绿标上印着 `unlimitedQuota`。在面板自己的两张表里各补一行。
- **概览路由行**：数字拼总额（「余 1,838 / 2,000」，有总额时）；进度条改按本路由
  余/总额算，总额未知时退回按最大路由相对算；七牛行「余 —」改成「不限额」。
- **用量页百分比**：旧文案把「占总请求比」跟在 fail 后写成 `(94%)`，Trae
  12 请求全失败也显示 `(1%)`。改成成功率 + 明确标注的占比，fail>0 标红。
- **用量页零活动平台**：默认折叠（Gemini Pro 历史残留行、Qoder、七牛等），
  底部「显示空闲平台 (N)」按钮可展开。
- **趋势图**：图下补起止日期一行。
- **套餐明细聚合**：同渠道同名套餐按 (route, packageName) 合并，余额/总额求和、
  行上挂 ×N、到期取最早；标题与「展开全部」计数改成组数。

### 自检

- `npm run check` 全绿，含新增静态断言；`node --check` 过 `lib/client.js`。
- 仍无真机联调：面板实际渲染需在本机 DSH 里看截图确认。


## 内核 ux-v32：DeepSeek 第三轮审计——七牛两处 P1 + 归一化 P0 残留（2026-11-20）

### 变更

- **P0 残留：归一化展开进 try**（`lib/shared/pool.js`）：`[...models]` 与
  `route.models()` 调用包进同一个 try。ux-v31 只兜住了调用，迭代器中途抛错 /
  立即抛错 / `Symbol.iterator` 的 getter 抛错三种都照样打穿 status。
- **P1-1：顶部总额不再和七牛行自相矛盾**（`lib/client.js`）：`emptyCredits`
  加 `hasSynthetic` 旁路；只剩 synthetic 路由且总额为 0 时顶部显示「不限额」
  而不是「不可用 / 探测中」。旧逻辑是 ux-v29 就有的，ux-v31 把七牛行放进首屏
  后才第一次被用户看见。
- **P1-2：七牛有 key 才注册**（`lib/providers/pool/index.js` / `routes-builtin.js`）：
  注册从 `apply()` 同步段移到 `start()` 里，先读一次 key，空或抛错都跳过，
  配好后重启 DSH；release 进 `disposers` 随热重载回收。纵深防御：
  `qiniuRoute().credits()` 先 `await readKey()`，没 key 就抛错，
  `refreshOneRoute` 记 error + signedOut（旧数据可保留时记 stale + error）。
- **无路由文案**（`lib/client.js`）：`routesSecEmpty` 一条路由都没有时显示
  「暂无路由」而不是永远「加载中」（中英双语文案 `noRoutes`）。
- **文档补齐**：`docs/` 补写 ux-v30 报告（当时只写了 CHANGELOG），本轮新增
  ux-v32 报告；四份报告齐了。

### 自检

- `npm run check` 全绿，含新增断言：归一化展开在 try 里、synthetic 旁路在位、
  `noRoutes` 文案在位、七牛注册有 key 门、credits() 没 key 抛错；
  `check-pool-core` 新增「抛错的迭代器不打挂整池」三项运行时断言（中途抛 /
  getter 抛 / 立即抛，诊断均记 0 条）。
- 仍无真机联调：需挂真实 Trae 号跑一轮 402/429 切换确认；七牛有/无 key 两种
  机器也需各跑一轮启动，确认路由出现与不出现都符合预期。

### 已知未决

- `dfmodel` 仍是死 alias，目标 id 不在白名单里；`hiddenModelCount` 进了 status
  但面板仍不展示（诊断字段，可接受）。


## 内核 ux-v31：DeepSeek 第二轮审计——P0 回归 + 活路由看不见补齐（2026-11-20）

### 变更

- **P0：脏路由不再打挂整池**（`lib/shared/pool.js`）：`models()` 返回值先归一化
  成数组再算诊断与分组（数组原样、可迭代展开、字符串与普通对象当空）。ux-v30
  在 `try/catch` 之外裸调 `models.filter()`，一条路由回 `Set` / 字符串就
  `TypeError`，打穿 `mergedModelGroups()` 与 `poolStatusDocument()`（status 500、
  面板全空）。`rawModelCount` 改成归一化后的长度（`Set` 没有 `length`）。
- **七牛首屏可见**（`lib/client.js`）：折叠谓词补 `syntheticBalance === true`；
  行上挂「不限额」标签（`unlimitedQuota`，已有文案）。`priority: -1`、每天 00:00
  重置、最该优先烧的那条路由此前因 `remaining` 为 `undefined` 被折叠掉。
- **账号区死锁**（`lib/client.js`）：「全部套餐」按钮条件去掉 `positiveCount > 0`。
  所有套餐归零时旧条件让按钮消失，用户切不回全量，只能等余额回来。
- **Trae 只在凭据真变时清熔断**（`lib/providers/trae/index.js`）：凭据是
  `keepalive.tick()` 返回 `renewed` / `adopted`，或 token 指纹（内存内哈希，
  不存 token、不记日志）变了，才调 `clearBreakers`。同条 token 每 30 秒巡检
  不再清 auth 冷却。未采用审计的「只看 userId」方案：同一账号续期/重登时
  userId 不变，那样会把 ux-v29 修的问题带回来。
- **`hiddenModelCount` 透出**（`lib/shared/pool.js` / `README.md`）：status 路由
  条目补上该字段，不再是只写不读的死字段。

### 自检

- `npm run check` 全绿，含新增断言：归一化在位、hidden 透出、synthetic 放行、
  账号按钮条件、tick 结果判据；`check-pool-core` 新增「非数组 `models()` 不抛
  且诊断条数合理（Set 展开 1 条、字符串/对象当空）」「`droppedModels` 上限 8 条」
  「`hiddenModelCount` 计入被 `hidden()` 滤掉的模型」三项运行时断言。
- 仍无真机联调：需挂真实 Trae 号跑一轮 402/429 切换确认。

### 已知未决

- v27/v28 仍无 CHANGELOG 条目（不补编）；`dfmodel` 仍是死 alias，目标 id 不在
  白名单里，Qoder 的 `dfmodel` 仍被静默滤掉——没有证据证明它就是 v4.1 那档，
  猜映射比留着更糟。


## 内核 ux-v30：DeepSeek 审计四补丁（2026-11-20）

本条是 DeepSeek V4.1 Flash 对 ux-v29 的逐行审计后打的补丁，四条问题经本机
逐项核对全部属实，另加它指出的一处误导性别名。

### 变更

- **折叠按钮进去出不来**（`lib/client.js`）：`hiddenRouteCount` 改成与
  `showAllRoutes` 无关的常量（`routes.length - filteredRoutes.length`）。此前
  展开后它变 0，按钮直接消失，只能刷新面板。
- **`route.models()` 调 3 次变 1 次**（`lib/shared/pool.js`）：主循环那次的结果
  存进 `diagRawIds`，诊断段复用，不再另调两次；`hiddenMatcher` 也只算一遍。
  注释曾写着“不重复调”，代码正好相反，一并改掉。
- **注销清诊断**（`lib/shared/pool.js`）：`unregisterPoolRoute()` 补
  `routeDiagnostics.delete(key)`，长跑不再留幽灵条目。
- **死代码收尾**（`lib/client.js` / `lib/providers/gemini/oauth.js`）：删掉
  `.dcp-gq-grid` / `.dcp-gq-box` 两条 CSS；两处 Gemini 登录报错不再指向已删的
  `scripts/gemini-oauth-login.mjs`，改成说明 Gemini 已于 ux-v22 移出、如需恢复
  先重新注册路由。
- **误导性别名**（`lib/shared/pool.js`）：删掉 `ID_ALIASES` 里
  `deepseek-v4-flash-official → deepseek-v4-flash` 这一行。`deepseek-v4-flash`
  本身不在白名单里，任何直接请求它都会 402；official id 本身已在白名单，
  靠 `curatedKeyOf` 从 candidate.id 就能进库，alias 纯属多余。行为无变化，
  只是不再把两个 id 混成一组。
  - 另注：`dfmodel → deepseek-v4-flash` 这条 alias 仍指向同一个不在白名单的
    目标，Qoder 的 `dfmodel` 目前在池里仍是被滤掉的状态；没敢直接把它改指
    `deepseek-v4.1-flash`，因为没有证据证明 Qoder 的 DeepSeek-Flash 就是
    v4.1 那档，猜映射比留着更糟，留待有实测再定。

### 自检

- `npm run check` 全绿，含新增断言：折叠计数恒定、注销清诊断、Gemini CSS 与
  旧提示已删、误导性别名已删；`check-pool-core` 新增「每路由只调一次
  `models()`」「注销后诊断无幽灵条目」两项运行时断言。
- 仍无真机联调：12s 探测、清熔断、trae2 目录与本次四补丁都只过了静态断言与
  `npm run check`，需挂真实 Trae 号跑一轮 402/429 切换确认。


## 内核 ux-v29：Trae 路由掉线根因修复 + 面板降噪 + Gemini 死代码清理（2026-11-20）

> 注：代码里的 `patch` 在 ux-v26 之后已升到 ux-v28，但 CHANGELOG 没有 v27/v28 的
> 条目（文档漂移）。本条只写 v29 实际改动，不补编 v27/v28 的内容。

### 变更

- **Trae 兜底 id 进白名单**（`lib/shared/pool.js`）：`CURATED_MODELS` 23 → 26 条，
  新增 `deepseek-v4-flash-official` / `deepseek-v4-pro-official` / `minimax-m3`。
  根因：Trae SOLO 兜底名单 / 快照里的这三个真实 id 不在白名单里，产品误判成 solo
  或快照缺失时它们会被 `mergedModelGroups()` 静默过滤，表现为「Trae 路由莫名其妙掉了」。
- **路由掉线可诊断**（`lib/shared/pool.js`）：新增 `routeModelDiagnostics()`，
  `pool.status` 每条路由透出 `modelCount` / `rawModelCount` / `droppedModels`（最多 8 个）。
  排查口径见 README「路由掉了怎么查（ux-v29）」。
- **Trae 首字节探测放宽**（`lib/providers/pool/index.js`）：多路由时 Trae 由 6s 放到 12s，
  其余路由仍 6s，单路由仍 45s。一次 agent 槽位冷启动慢不再记 60s transport 熔断。
- **登录/续期成功清熔断**（`lib/providers/trae/index.js`）：浏览器登录落盘后与每轮巡检
  `store.resolve()` 成功后各调一次 `clearBreakers(instanceId)`——此前一次 auth 失败记的
  10 分钟冷却会让刚登好的号继续「掉线」10 分钟。
- **trae2 目录修复**（`lib/index.js`）：trae2 不再读 `trae-cn/models-<id>.json`（导出脚本
  只写 `trae-cn/models.json`，旧路径永远不存在，trae2 只能读 5 条兜底模型）。同产品目录
  共用，账号靠各槽自己的 `credentialFile` 区分。
- **面板降噪**（`lib/client.js`）：删掉 Gemini 死代码（`geminiQuotaSec` / `gqBucket` /
  18 条 `geminiQuota*` 文案——`doc.geminiQuota` 自 ux-v22 起已不再下发，整块恒为 null）；
  路由默认只显示有余额 / 报错 / 过期 / 熔断的，其余折叠到「显示全部路由」；套餐明细
  `hideZero` 默认开（0 余额套餐默认折叠）。第一屏路由行从 9-10 行压到 3-5 行。
- **瘦身发布包**（`package.json` / `scripts/`）：删掉 25 个一次性 `probe-*.mjs`、
  `verify-gemini-429*.mjs`、`gemini-oauth-login.mjs`（其中多份 probe 脚本还硬编码了
  `C:\Users\00\.dsh\gemini-oauth.json` 绝对路径）；`package.json` 的 `files` 显式排除
  `probe-*` / `verify-gemini-*` / `gemini-oauth-login.mjs`，以后再加 probe 脚本也不会
  跟着发版。`lib/providers/gemini/**` 本体保留（`verify-uxv10.mjs` 仍在用它做回归）。
- **版本与文档统一**：`package.json` 1.0.2 → 1.0.3，`patch` ux-v28 → ux-v29；
  README 里 `routes=10` / `models=29` / 含 Gemini 6 个等已过期数字全部改成以
  `GET /plugins/dsh-pool/status` 实测为准，备份路径里的用户名绝对路径已删。

### 影响面

- 池模型库 23 → 26 条（只加了 Trae 已有的三个真实 id，不改任何已有模型的路由与排序）。
- 面板第一屏变短；想看全量路由点「显示全部路由」，想看 0 余额套餐点「全部套餐」。
- Trae 冷启动慢、重新登录后 10 分钟内仍掉线、trae2 只有 5 个模型这三类症状应消失；
  若仍出现，先看状态文档的 `droppedModels` / `pool.broken` 再报问题。
- `npm pack` 不再含 probe 脚本；本地调试 probe 脚本需自行从 git 历史取回。

### 自检

- `npm run check` 全绿（check-all / check-imports / check-pool-core / check-hardening /
  check-qoder-vault），含新增断言：Trae 兜底 id 进库、诊断字段在位、Trae 探测 12s、
  登录清熔断、trae2 无旧目录路径、客户端无 `geminiQuotaSec`、路由折叠开关在位。
- 云端无真实凭据，无法做 DSH 真机联调：见 `docs/OPTIMIZATION-REPORT-ux-v29.md`。


## 内核 ux-v22：Gemini 整组移出驼峰池（2026-11-20）

### 变更

- **Gemini 路由摘接线**（`lib/providers/pool/index.js`）：删掉 gemini 模块的 9 个符号与
  `quota.js` 两个函数的 import、`POOL_GEMINI_OAUTH_PATH` 常量、`registerPoolRoute(geminiRoute(...))`
  与 `startGeminiModelRefresh(...)`、`ctx.effect` 里的两条清理、转发体里 `kind === "gemini"`
  的字段删除分支、`POST /plugins/dsh-pool/status` 的本机额度同步桥（`writeGeminiQuota`）、
  `doc.geminiQuota` / `doc.geminiAuth` 两个状态字段，以及整段 `/plugins/dsh-pool/gemini-oauth`
  路由（原 start/submit/cancel/status 四动作）。`patch` 由 `ux-v21` 升到 `ux-v22`。
- **模型白名单**（`lib/shared/pool.js`）：`CURATED_MODELS` 移除 6 条 gemini 条目
  （gemini-4-argon / gemini-3.1-pro-preview / gemini-3.8-flash / gemini-3.5-flash-lite /
  gemini-3.5-pro / gemini-3.1-pro-high），`GEMINI_STRENGTH` 强度表与其在 `strengthOf()`
  里的固定值分支一并删除。白名单 29 → 23 条。
- **隐藏钩子**（`lib/index.js`）：删除 `import * as gemini`，`HOOKED_PROVIDERS` 由
  `[[workbuddy], [trae], [qoder], ["codearts", codearts], ["gemini", gemini]]` 收敛为
  只多带 codearts；面板的 `disabledModels` / `pickerHidden` 规则不再派发给 gemini。
- `lib/providers/gemini/**` 与 `scripts/gemini-oauth-login.mjs` 文件本身保留（历史快照与
  离线脚本仍在用），只是不再被注册进池。

### 影响面

- 池里不再有 gemini 候选：`GET /plugins/dsh-pool/status` 的 `models` 由 29 → 23，
  响应里不再出现 `geminiQuota` / `geminiAuth`；`GET /plugins/dsh-connect/models` 不再列出
  任何 gemini model id。面板 UI 无需改动 —— `doc.geminiQuota` 缺失时 `lib/client.js` 的
  `gq` 为 null，整块不渲染。
- 若以后要把 Gemini 加回来：反向恢复上述四处接线即可，`providers/gemini` 模块的导出面未动。

### 自检

- `scripts/check-all.mjs` 的 `["gemini", gemini]` 断言改为 5 条反向断言：
  HOOKED_PROVIDERS 不含 gemini、`lib/index.js` 不 import gemini 模块、
  `lib/providers/pool/index.js` 不含 `geminiRoute(` 与 `gemini-oauth`、
  `lib/shared/pool.js` 不含 `gemini-4-argon`；`patch` 断言同步升到 `ux-v22`。
- `npm run check` 全绿（check-all / check-imports / check-pool-core / check-hardening /
  check-qoder-vault）。

## 内核 ux-v23～v26：Trae 自续期 / 自登录 / 面板入口（2026-11-20）

### 变更

- **`lib/providers/trae/vault.js`（新建）**：把 `scripts/trae-vault.mjs` 的 dGMF 加密内核
  （AES-128-CBC + SHA-512 掩码表、`seal` / `unseal`、`HDR`、`MAGIC`）原样搬进插件进程，
  并加 `readDesktopSession(appDir)`（一次解出登录态 + 设备密钥对 + machineId）与
  `writeCredentialFile(path, doc)`（tmp + rename 原子替换、0600）。插件从此不再要求用户手工
  跑 `export-trae-plain.mjs` 才能读到桌面端登录态。
- **`lib/providers/trae/keepalive.js`（新建）**：Trae 的续期器。`exchangeRefreshToken()` 逐字
  复刻桌面端 `exchangeTokenByRefreshToken`（`POST /trae/api/v3/oauth/ExchangeToken`，body
  `{ClientID, ClientSecret:"", RefreshToken, DeviceInfo, DeviceProof, IDEVersion}`，头只有
  `x-cloudide-token`）；三个必踩坑写进文件头：DeviceProof 键首字母大写、签名串用 `\n` 分隔、
  `DevicePublicKey` 必须是**登录时那把**。`adopt()` 从桌面端 storage.json 搬整份快照
  （`adoptedFrom`/`adoptedAt` 落盘），`renew()` 做一次性令牌的「换到即落盘」，
  `writeBackToDesktop()` 把新链回写桌面端（先备份 `storage.json.bak-<ts>`、校验键集不变、
  保持 4 空格缩进、桌面端更新则拒写）。单飞 + 失效冷却 + `needsLogin` 置位。
- **`lib/providers/trae/login.js`（新建）**：浏览器授权码登录。`createPkce()` + `createDeviceKeyPair()`
  （P-256）+ `buildLoginUrl()`（字段与 `main.js` 的 `Vhe.buildLoginUrl` 对齐）+ 回环回调服务
  （`127.0.0.1:0/authorize`，GET/POST/OPTIONS 全收，TTL 10 分钟）+ `exchangeAuthCode()` +
  `fetchUserInfo()`；`submit()` 供反代/换 host 时手动投递。`account.username` 取
  **`info.ScreenName`** —— `GetUserInfo` 的 Result 里没有 `Username` 字段，取错会让快照里
  的账号名恒为 `undefined`、面板上「是谁登的」整格消失。
- **`lib/providers/trae/index.js`**：新增 `traeKeepaliveAction` / `traeLoginAction` 与三条派生
  路由（`/keepalive`、`/login` 由 `statusRoute` 把结尾换掉得到，多实例序号自动跟随）；
  `traeRouteHandler` 改为把解析后的 body 传给 handle（POST 上限 64 KiB，超限 413、非法 JSON 400）；
  `apply()` 里创建 keepalive / login 实例并塞进 deps，`refresh()` 开头先 `keepalive.tick()`
  （顺序不能反：`store.resolve()` 遇过期直接抛）。
- **登录 host 修正**：`/authorization` 只挂在 `https://www.trae.cn`（打 `api.trae.cn` 回 404，
  body 是 `<center>TLB</center>`），ExchangeToken 仍走 `https://api.trae.cn`。新增常量 `LOGIN_BASE`。
- **面板入口**（`lib/client.js`）：渠道中心每个 `kind === "trae"` 的行头新增「续期」「登录」两个
  按钮（`onTraeKeepalive` / `onTraeLogin`，路径按 `row.id.slice(4)` 派生槽位序号），结果就地显示在
  该行下方；两套文案各补 `traeRenew*` / `traeLogin*` / `traeNeedsLogin`。
- `patch`：`ux-v22` → `ux-v23` → `ux-v24` → `ux-v25` → **`ux-v26`**。

### 影响面

- Trae 槽位此前**完全没有自续期路径**（`providers/trae` 的 6 处 `refresh` 全是模型目录/倍率，
  凭据只按 JWT exp 判过期，过期就抛）。现在两个槽位各自独立：`trae` 与 `trae2` 分别绑定自己的
  `connect-auth/trae*.json`、自己的 deviceId 与密钥对，巡检不再互相覆盖（自动 adopt 只在
  「本槽自己已过期或没有快照」时触发，避免每 30 秒把所有槽位统一成桌面端当前号）。
- 实测：四条历史 refresh token 全被判 `20101 refresh token is invalid`，只能靠浏览器登录造新链；
  登录后 `POST /keepalive {action:"renew"}` 首次成功（`renewed:true`），并正确回写桌面端
  storage.json（10188 B / 29 键 / 4 空格缩进不变，另存 `.bak-<ts>`）。
- 其余渠道（workbuddy / qoder / codearts）与池路由、额度账本一行未动。

### 自检

- `scripts/check-all.mjs` 的 `patch` 断言同步升到 `ux-v26`；`npm run check` 五套全绿
  （check-all / check-imports / check-pool-core / check-hardening / check-qoder-vault 14 项）。
- `node --check` 过 `index.js` / `keepalive.js` / `login.js` / `vault.js` / `client.js`。
## 客户端 UI 升级（覆盖 dsh-camel-pool-v1.0.2-ui-upgraded.zip，2026-11-16）

### 变更

- `lib/client.js`：UI 文案与布局升级，纯客户端改动，`+446 / -328` 行，集中在第 5 个
  独立 IIFE `poolCreditsClient`（`CONTRIBUTIONS` 契约不变，classic script 无顶层
  `import`/`export`）。
- 面板标题 `驼峰积分池 · 剩余额度` → `驼峰积分池`；页脚 `内核标记 {patch}` → `内核 {patch}`；
  `刷新额度` → `刷新`；`{count} 个模型` → `{count} 模型`。
- 新增缩写文案：`caShort`（CodeArts）、`expiryMore`（`+{count} 项`）、
  `autoCheckinShort`、`costFirstShort`、`voucherFirstShort`、`poolEnabledShort`、
  `showRoutesShort`；新增 `EXPIRY_PREVIEW_COUNT = 2` 控制到期项预览条数。
- 新增 0 余额过滤开关：`hideZero` / `showZero`（`仅看可用 ({count})` / `全部套餐 ({count})`）。
- `polish-preview.png` 同步替换为发行版内新图（该文件被 `.gitignore:12` 忽略，不入库）。

### 影响面

- 仅 UI：`POOL_STATUS_PATH` 仍是 `/plugins/dsh-pool/status`，内核 `patch` 仍为 `ux-v21`，
  路由、额度、账本、渠道注册逻辑一行未动；其余 97 个文件与 `dsh-camel-pool-v1.0.2-improved.zip`
  逐字节一致。
- 自检：`npm run check` 全绿（`check-all: 全部通过` / `check-imports` 53 个导出名全先导入后使用）。

## 维护：记忆插件换成 hy4flash + 思考强度 medium（2026-11-16）

### 现象

- daemon 的 `HINDSIGHT_API_*_LLM_MODEL` 想改成 `hy4flash`，池却回 402
  `pool_exhausted`「积分池里没有可用于 hy4flash 的路由」——`/v1/models` 里只有
  `hy4flash-free` 与 `hy4std`；同时 `reasoning_effort: "medium"` 被静默改写成 `high`。

### 根因

- `hy4flash` 与 `hy4flash-free` 的上游 `name` 都是 `Hy4 flash`，`normName` 归一后同是
  `hy4flash`。`mergedModelGroups` 的第三把 key（`"name:" + normName(...)`）把后来的
  `hy4flash` 并进先建的 `hy4flash-free` 组；一个组只产出一个 `poolId`，于是 `hy4flash`
  作为一个独立模型彻底消失，`orderedRoutesFor("hy4flash")` 返回空 → 402。
- hy4 家族目录里只声明 `supportedEfforts: ["high"]`，`reasoningFields` 生成的
  `thinkingLevelMap` 只有 `high`；`translateEffort` 于是把 `medium` 按距离打分改写成
  `high`。实测上游对 `reasoning_effort` 完全不校验：hy4flash / hy4flash-free / hy4std ×
  low|medium|high|xhigh|max 共 18 次探测全部 200，从未出现 400
  `invalid_reasoning_effort` / code 11133。声明面比接受面窄。

### 修复

- `lib/shared/pool.js`：新增 `curatedEntryOfId(raw)`；`mergedModelGroups` 只有在
  「本组未被白名单点名」或「两组的白名单条目是同一条」时才允许按 `name` key 合并。
  同名但各自被点名的模型（`hy4flash` / `hy4flash-free`）于是保持两个独立 `poolId`。
- `lib/providers/workbuddy/index.js`：新增 `MEASURED_EFFORT_ACCEPTANCE` 实测表与
  `measuredEfforts(id)`，`reasoningFields` 里以「实测 > 目录声明 > 探测结果」取值。
  目前只登记 `/^hy4(?:std|flash|flash-free)?$/`，放宽为 low/medium/high/xhigh/max；
  `off` / `minimal` 仍恒为 `null`，不会因为放宽而多出关思考的档位。
- `~/.hindsight/start-daemon.ps1` / `run-daemon.ps1`：5 个 scope 的 `_LLM_MODEL` 改成
  `hy4flash`，5 个 `_REASONING_EFFORT` 改成 `medium`。

### 回归

- 池 `/v1/models` 从 29 → 30 条，`hy4flash-free` / `hy4std` / `hy4flash` 三条并存。
- 直打池 `model=hy4flash` + `reasoning_effort=medium`：200，SSE 正常（先
  `reasoning_content` 后 `content`，上游 `model` 字段 `hy4-flash`）。
- `translateEffort` 单元探针：新 map 下 `medium → medium`，旧 map（只有 high）下
  `medium → high` —— 证明改写确由白名单表达力造成。
- daemon 重启后 5 个 scope 全部 `model=hy4flash`；`hindsight_ingest_document` 触发真实
  调用：bridge 记录 `aggregated hy4flash -> 5850 content.len=1822/4172 finish=stop`，
  daemon `STREAMING RETAIN COMPLETE: 3 units` / `CONSOLIDATION COMPLETE: 73.137s` /
  `completed: 3 processed`。

### 静态防线

- `scripts/check-all.mjs` 新增四条断言：`curatedEntryOfId` 存在、`nameKeyUsable` 参与
  keys 构造、`MEASURED_EFFORT_ACCEPTANCE` 存在、`reasoningFields` 用 `measured ??`。
## 工具链：插件改动自动同步 GitHub（2026-11-16）

- 新增 `scripts/gh-push.mjs`（`npm run sync`）：先试原生 `git push`，本机 `github.com:443`
  被阻断时自动改走 GitHub Git Data API（blob → tree → commit → `PATCH .../git/refs/heads/main`）。
  commit 对象按 `git cat-file commit` 的原始字节重建，远端 SHA 与本地逐字一致，后续走增量。
- token 存放在 `~/.dsh/camel-pool-gh.token`（ACL 只给当前 SID 读权限），不写进仓库与 `.git/config`。
- `.git/hooks/post-commit` 提交后后台执行同步，日志 `~/.dsh/gh-sync.log`；
  `git config --local dsh.autosync false` 或 `DSH_NO_AUTOSYNC=1` 可临时关闭。
- 约定写进 `AGENTS.md`，后续会话据此执行。
## 维护：记忆插件的 LLM 从 hy3 迁到 minimax-m3.1-flash（2026-11-16）

### 现象

- Hindsight 记忆 daemon（`~/.hindsight`，监听 9077）的 retain / reflect / consolidation
  全部失败，`daemon-stdout.log` 里每 5 分钟一行 `Scheduled mental model refresh:
  scheduled 0 model(s), 6 paused after a failed refresh`。
### 根因

- WorkBuddy 上游目录把 `hy3` / `hy3-x` / `hy4-preview` / `hy4free` 全部换成了 hy4 家族
  （`hy4std` / `hy4flash-free` / `hy4flash`），旧 id 在目录里已不存在；
  池的 `CURATED_MODELS` 白名单又没登记新 id → `/v1/models` 里查不到、请求直接 402
  `pool_exhausted`，daemon 拿不到任何可用模型。
- 另外 hy4 家族全部 `onlyReasoning: true`，正文写在 `reasoning_content` 里，
  `content` 是空串；`hindsight-sse-bridge` 聚合 SSE 时不回填，记忆抽取会拿到空正文。
### 修复

- `lib/shared/pool.js` 的 `CURATED_MODELS`：删掉死 id `hy4free` / `hy3`，
  新增 `hy4flash-free`（0 倍率免费档、960k ctx）、`hy4std`、`hy4flash`，共 29 条。
- `hindsight-sse-bridge/bridge.mjs`：聚合时若 `content` 为空而 `reasoning_content` 非空，
  回填 `reasoning_content`（与池内核同语义）。
- `~/.hindsight/start-daemon.ps1` / `run-daemon.ps1`：5 个 scope 的 `_LLM_MODEL`
  从 `hy3` 改为 `minimax-m3.1-flash`（0.08x、1M ctx、实测 ~3s、strict-JSON 3/3 稳定）。
### 回归

- 真桥实测：`minimax-m3.1-flash` / `glm-5.3-flash` / `step-5-preview` / `deepseek-v4.1-flash`
  / `space-bunny` / `kimi-k3.1-pro` 均 200 且 JSON 合法；`hindsight-auto` 落到 `gemini-4-argon`
  慢 5-10 倍；`nvidia/nemotron-3-ultra-550b-a55b0-free`、`doubao-seed-2.1-turbo`、
  `mimo-v2.6-flash`、`qwen3.8-flash` 都是 502。
- daemon 重启后 `LLM: provider=openai, model=minimax-m3.1-flash` 五行齐全；
  写一条文档触发 retain → `store=PostgresMemories docs=1`、`[CONSOLIDATION] processed=2/2`。
## ux-v21（2026-11-16）

- 同步内核版本标记 `ux-v21`，完成全方位自检加固、用量账本 SSE 帧解析与池分类器模块化拆分。

## ux-v20（2026-11-16）

### 修复：Qoder 会话一过期，面板那条路由就红「暂不可用」，只能手工重灌

- 现象：`/plugins/dsh-pool/status` 里 qoder1 一条带 `error`，面板渲染成红字「暂不可用」；
  其余九条正常。用户的观感是「总有一条路由莫名其妙挂掉」。
- 根因：`createSessionStore.current()` 只读 `$DSH_HOME/connect-auth/<id>-session.json`，
  `expiresAt` 一过就 `return undefined`，上层回落 PAT —— 而 qoder1 从来没配 PAT，
  于是整条路由掉成 signed-out。文件里的 `refreshToken` 没有任何代码消费；
  `POST /api/v1/jobToken/refresh` 无论带什么 body 都是 400，`/api/v1/auth/refresh` 一类
  是 401 `TOKEN_INVALID`，**上游没有可用的续期端点**。真正会续期的只有 Qoder CN 桌面
  App 自己（它登录一次就把新会话写进 `%APPDATA%/com.qodercn.app.stable/auth.v1.dat`）。
- 修复：新增 `lib/providers/qoder/desktop-vault.js`，把桌面 App 的会话解出来当作第三级来源。
  加密是 `v10` 前缀 + AES-256-GCM（12B nonce + 密文 + 16B tag），密钥在 `Local State` 的
  `os_crypt.encrypted_key`（去 5 字节 `DPAPI` 标记后由 Windows DPAPI 解封，`CurrentUser` 域）。
  DPAPI 那一步必须走 PowerShell（`Add-Type -AssemblyName System.Security`），AES-GCM 放 Node
  （PowerShell 5.1 没有 `AesGcm`）。
- 接法：`current()` 的三级来源变成 本地会话文件 → 桌面 App（自动导入并落盘）→ undefined。
  **已经有效的本地文件绝不覆盖**（否则手工配的 PAT 会话会被 App 的号顶掉）；导入带 5 分钟
  冷却与 in-flight 去重（解一次 DPAPI 要几百毫秒，状态路由每轮都会问）；状态路由最多等 3 秒，
  等不到就先回 undefined、导入继续在后台跑完。
- 防抢号：`desktopClaimedBy()` 扫同目录的 `qoder*<n>-session.json`，同一个 uid 只能占一个槽位
  （并发限制按账号算）—— 桌面 App 只登一个号，qoder2 不会被顶成同一个账号。
- 同时修掉一个自己挖的坑：`readLocal()` 的 `expired` 分支**也带 credential**（留给诊断看
  「过期的是哪一份」），而 `current()` 原本只判 `credential !== undefined`，于是过期会话被当成
  本地可用、导入永远不触发 —— 面板那行红字一直好不了。现在显式先排 `expired`。
- 顺手：`installFetchRescue()` 的重复安装改成真正的空操作（同版本 + `globalThis.fetch` 仍是我们
  的访问器时返回 `{installed:false, reason:"already"}`），tag 只在首次安装写；`setBase` 在底没变
  时不再重建 wrapper，保住引用相等性。
- 回归：`scripts/check-qoder-vault.mjs` 14 项（v10 密文往返、错密钥被 GCM 拦、魔数与长度校验、
  会话收敛、落盘字段、占用判定的五种情形、authDir 缺失不抛），已并入 `npm run check`。

## ux-v19（2026-11-16）

### 修复：一条多兆 prompt 让「积分池所有路由都失败」（每条路由同一个 422）

- 现象：DSH 面板连出三张「处理失败 / 已重试模型请求 (2/2)」，正文是
  `502 {"message":"积分池所有路由都失败: trae 422, trae2 422", "type":"pool_exhausted"}`，
  每条路由的 error 都是同一个
  `bili_gate_oversize_refusal_unattributed_bytes`："billion-context refused this request
  locally: it is not attributed to a bili-managed session and its body is larger than the
  silent-direct byte ceiling"。看起来像十个渠道同时挂，其实上游一次都没被打到。
- 根因：`lib/providers/pool/index.js` 的转发兜底写的是
  `typeof entry.route.fetch === "function" ? entry.route.fetch : fetch` —— 没声明
  `route.fetch` 的路由（trae / trae2 / qoder / workbuddy / bailian / qiniu）全部回落
  **全局** `fetch`。而 `billion-context` 用 `Object.defineProperty(globalThis,"fetch",…)`
  接管了它，一检测到第三方又包一层就把自己重链到最外层（`BILI_RECLAIM_FETCH_PATCH=0`
  才不回收），于是它的闸门永远在最前面：只要请求没被认成它自己管的会话、body 超过
  silent-direct 上限（`MAX_SILENT_DIRECT_BODY_BYTES = 8MB`，`BILI_SILENT_DIRECT_MAX_MB`
  可调），就在本地 422，请求一个字节都没出网。因为这是**进程级**包装，与路由无关，
  所以池里每一条未声明 fetch 的路由都以同样方式失败，最后汇总成 pool_exhausted。
- 修复：兜底改成 `shared/net-rescue.js` 的 `directFetch`（undici 显式 Agent → 裸
  `node:https/http`，完全不经过 `globalThis.fetch`）。这与 codearts / gemini 适配层
  早就采用的绕行方式一致 —— 装配顺序不再是变量。
- 修复：新增 `localGateRefusal(status, text)` 分类。422 且正文含 `bili_gate_*` 时记
  `kind:"gate"`，**不记熔断**（进程级闸门会把十条路由一起冷却 60s，下一个请求照样全灭），
  并把汇总从 `pool_exhausted` 改成 `pool_gate_blocked`，文案直接指出是请求体超了
  silent-direct 上限、以及该调哪个环境变量。
- 回归：`scripts/verify-uxv19-gate.mjs` 把全局 fetch 换成「凡是池转发就 422」的假闸门，
  断言池仍能 200 打通上游（全局 fetch 调用次数必须为 0），并断言声明了 route.fetch 且
  被闸门拒的路由得到 `pool_gate_blocked` 而不是 pool_exhausted、且不产生熔断。
- 静态防线：check-all 新增三条（兜底是 directFetch / 不再回落全局 fetch / 闸门单独分类），
  check-hardening 新增两条，防止这次修复被下一次「顺手改回去」抹掉。

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
