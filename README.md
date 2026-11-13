# 驼峰积分池 · dsh-camel-pool

**从「渠道中心」(`dsh-connect`) 整包独立出来的单独插件。** 自带积分池剩余额度显示面板、自动签到、多渠道聚合模型下拉。后续可以继续往池子里添加更多渠道来扩充模型选择，不再依赖 `dsh-workbuddy-trae-qoder-connect`。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **English** — A standalone DSH plugin forked out of the Connect Hub. It keeps the pooled-credit panel, automatic daily check-in and the multi-channel model picker, and can grow with more pool routes. It no longer depends on `dsh-workbuddy-trae-qoder-connect`.

---

## 为什么独立

原先积分池内核（`lib/providers/pool/**` + `lib/shared/pool.js`）寄居在 `dsh-connect` 包里。上游渠道中心一更新，就会把池内核整片覆盖掉（2026-11-07 的事故根因）。本包做法是**路线 B：整包 fork**——

- 池内核状态机 `lib/shared/pool.js`（注册表 / credits / latches / breakers / 排序）**一字未动**，与旧包完全同源；`lib/providers/**` 只有 `pool/index.js` 的状态快照 handler 加了一处「现读偏好注入 `active` / `pool.order`」的文档投影（修 8.4 第 6/7 项，见下），不触碰任何状态机逻辑；
- 旧的 `dsh-connect` 在 profile 层 `disabled: true`，由本包独占所有路由与面板；
- 包标识全面改成 `dsh-camel-pool`（npm 名、运行时插件 id、`HUB_SETTINGS_NS`、客户端 module-loader id、settings 命名空间）；
- 上游渠道中心以后再更新，也碰不到本包里的池内核。

因此「脱离渠道中心成为单独插件」是天然的：本包自己就是一个完整插件，同时承载三家渠道 + 积分池 + 面板 + 自动签到。

**保留的路由前缀**（最小改动，旧插件已禁用，无冲突）：

| 端点 | 用途 |
|---|---|
| `GET /plugins/dsh-pool/status` | 积分池状态：`credits.total`、`pool.routes[10]`、`models[28]`、`pool.order`、`pool.broken` |
| `GET /plugins/dsh-connect/status` | 渠道聚合状态（4 渠道 signed-in / credits / checkin.state） |
| `POST /plugins/dsh-connect/checkin` | 一键签到（全部渠道） |
| `POST /plugins/dsh-connect/checkin/<id>` | 单渠道签到 |
| `GET/POST /plugins/dsh-connect/settings` | 偏好读写（命名空间 `dsh-camel-pool`） |
| `GET /plugins/dsh-connect/models` / `/auth` | 模型目录 / 授权 |

`POOL_STATUS_PATH` 保持 `/plugins/dsh-pool/status` 不变——这是池内核对外契约，改了会断掉所有消费者。

---

## 你会得到什么

**独立的积分池剩余额度面板（本包新增，UX v2）。** 侧栏常驻一个「驼峰积分池」入口（`sidebar.footer.action`，`order: 21`），按钮上带状态点与额度摘要，点开是自己的浮层面板，独立于渠道中心面板：

- 大字显示 `credits.total`（例如 `9,318.21`）；`role="status" aria-live="polite"` 状态条区分「刷新中 / 已更新 / 数据过期 / 请求失败（带重试）」，绝对时间 + 相对时间（`justNow` / `secondsAgo`）；
- 每条池路由各自的 `remaining`、`expiring`、`priority`、`voucher`、额度占比条，低额度（`<500`）、探测失败、代金券、熔断分别打标记；
- 各账号套餐明细**默认折叠 8 项** + 搜索框 + 「展开全部」，避免刷屏（条数随后续账号增减，不在文档里写死）；当前 `models` 数、`pool.broken`、内核 `patch` 指纹与抓取时间；
- 「刷新」按钮走 `?refresh=1` 强制重取额度；面板打开时每 120s 自动轮询，**页面切到后台暂停、切回来立即补刷**；
- 「一键签到」按钮 `POST /plugins/dsh-connect/checkin`，带 busy/done/failed 反馈态；「自动签到」开关直接 `POST /plugins/dsh-connect/settings` 改 `autoCheckin`，`aria-pressed` 显示开关状态；
- 「复制摘要」把额度/路由/内核指纹写进剪贴板（真实换行）；`prefers-reduced-motion` 下关闭动效。

对应源码是 `lib/client.js` 里的第 5 个独立 IIFE `poolCreditsClient`（纯文本片段 `_tools/pool-credits-client.fragment.js`，同步脚本 `_tools/sync-ux-fragment.mjs`），自带 `react`/`react-dom`、zh/en 文案与 `ctx.locale` / `ctx.slots` 注册，全部 `try/catch` 兜底，挂不上也不影响宿主路由。

### UX v2 交互优化（相对首版）

| 短板（首版） | UX v2 |
|---|---|
| 侧栏与弹窗各发一份请求、数字会打架 | 模块级 `shared` + `listeners` + 单例 `inFlight`，两份视图共用一份状态；首屏只发 1 次 status，打开弹窗才补 1 次 `?refresh=1` |
| 全部套餐行全量铺开 | 搜索 + 默认折叠 8 项 + 展开全部 |
| 错误 / 关闭 / 过期态没区分 | `aria-live` 状态条、stale 阈值 300s、错误重试按钮、12s `AbortController` 超时 |
| 签到反馈弱、自动签到状态不可见 | 一键签到 busy/done/failed 三段反馈 + 自动签到开关读 `/settings` 并可写回 |
| 无焦点管理与键盘可达 | `role="dialog" aria-modal`、首按钮自动 `data-dcp-autofocus`、Tab 焦点环、Escape 关闭、关闭后焦点还回侧栏按钮、`:focus-visible` 描边 |
| 轮询不看页面可见性 | `visibilitychange` 隐藏暂停 / 可见补刷 |
| 无一键复制 / 无障碍语义 | 复制摘要、智能定位（视口越界回退）、`aria-controls/expanded/busy` |

自检（离线实证，不依赖浏览器插件）：`node _tools/verify-ux.mjs` → 62/62 PASS（静态契约 25 项 + 真实渲染组件 37 项，含共享单请求、dialog/portal、折叠、复制换行、一键签到 POST、开关 POST）；`node _tools/final-delivery-check.mjs` → 50/50；`node _tools/verify-client-registration.mjs` → 19/19。三者结果分别写入 `_tools/verify-ux.out.txt`、`_tools/final-delivery-check.out.txt`、`_tools/verify-client-registration.out.txt`。

**自动签到。** 沿用原机制：客户端所有 `useHubStatus()` 调用统一带 `?auto=1`（`lib/client.js` 的 `fetch(\`${STATUS_PATH}?auto=1\`)`），宿主 `lib/panel.js` 的 status handler 判 `prefsNow.autoCheckin === true && url.includes("auto=1")`，在扇出 `probeAll(..., { autoCheckin: auto })` 时顺带幂等领取当天可领积分。**没有额外定时器**，重复打开只领一次、不重复扣分。偏好项 `autoCheckin` 默认 `true`，可在设置里关掉（新额度面板的开关也写这个键）。新额度面板**刻意不触发第二次 `?auto=1`**，只读 `/plugins/dsh-pool/status`（首屏不带 refresh，打开弹窗时补一次 `?refresh=1`），避免并发重复 claim。

**一个下拉装下三家 + 池。** WorkBuddy（国区/国际版多槽位）、Qoder CN、Trae CN 的免费额度合进一个模型列表，按渠道分组旁标积分倍率；`dsh-pool` 作为独立一组出现，含 `hy4free` 等 28 个模型（叠加 CodeArts 5 个 + Gemini 6 个，与老渠道同 id 的自动合并成一条）。中途换渠道历史不断。三家协议（OpenAI 方言 / 私有 agent 协议 / 自定义编码流）由本包在中间翻译。

**池调度。** `order: "credits-first"` 按剩余额度挑路由（可切 `voucherFirst` 让百炼券殿后）；402/429 自动 latch 熔断 60s 换下一条；`xhigh` → `max` 档位降级；真实请求写 `.pool-route.log`，只记 `tokenLen` 不含任何凭据。
### 当日额度优先（`poolBurnExpiringFirst`，默认开）

CodeArts 的每日签到 100 积分**当天 24:00 过期**，过期即归零。只按「套餐期末」排序时，池会把它和几天之后才到期的余额一视同仁，签到分常常烧不掉。

现在排序吃第二个信号：

- 适配层在 `credits()` 的 `doc.credits` 里多报两个字段 `expiring`（当日将过期余额合计）与 `expiringAt`（过期时刻，此处是本地当日 24:00 对应的 UTC 时间）；
- 池内核 `extractCredits` 把它收进 credit；有当日桶时 `expiryMs` 取 `min(套餐期末, 当日过期时刻)`，于是这条路由在「最早过期优先」里天然排到最前；
- `orderedRoutesFor` 额外做一次「latch 让位」：粘性 latch 原本压过一切排序，会把请求按在上一条路由上、继续烧掉长期额度。现在只要头部还有当日桶，latch 就退到当日桶之后（`burnExpiringFirst: false` 可关掉这个让位）；
- 每次走完一条路由都会 `invalidateCredits()`，当日桶还有剩就立刻强制刷新积分，下一次排序读到的是真实剩余，而不是 5 分钟前的缓存。

100 分烧完之后 `expiring` 归 0、`expiryMs` 回到套餐期末，这条路由自然落回原位——**静默切换不需要任何特判**，全部由排序表达。

---

## 配置（profile 层 `- id: dsh-camel-pool`）

| 键 | 默认 | 作用 |
|---|---|---|
| `autoCheckin` | `true` | 打开面板/侧栏时幂等领取当天签到 |
| `showDockButton` | `true` | 左侧栏显示渠道中心入口 |
| `hiddenChannels` | `[]` | 隐藏渠道（只影响展示，不影响参与） |
| `disabledChannels` | `[]` | 禁用渠道（真正下架其模型） |
| `disabledModels` | `[]` | 禁用模型 |
| `useMaximumContextWindow` | `true` | 上游声明多档窗口时取最大档 |
| `poolEnabled` | `true` | 积分池适配器开关（判默认用 `!== false`） |
| `poolVoucherFirst` | `false` | 切换 `pool.order`：券优先 / 额度优先 |
| `poolMergeModels` | `true` | 合并不同渠道的同名模型（关掉后各渠道单独可选，便于绕开失灵路由） |
| `poolCostFirst` | `false` | 模型列表按性价比排序（免费优先，其余按倍率升序） |
| `poolShowRoutes` | `false` | 在模型名后标注来源渠道 |
| `poolAutoBoostEffort` | `false` | 低额度时自动把推理档位提到 `xhigh` |
| `poolBurnExpiringFirst` | `true` | 当日即将过期的额度优先烧（见「当日额度优先」一节） |

`poolEnabled`、`poolVoucherFirst`、`poolMergeModels`、`poolCostFirst`、`poolShowRoutes`、`poolAutoBoostEffort`、`poolBurnExpiringFirst` 都是 `.volatile()` 字段，切换即时生效、不落盘。改模型/渠道相关键会触发 `deps.onModelsChanged?.()` → `ctx.emit("llm/adapters-updated")`。写入走白名单（`lib/panel.js` 的 settings handler），不在表里的键一律丢弃。设置写入走 `settingsApi.update(HUB_SETTINGS_NS, patch)`，`HUB_SETTINGS_NS` 已改成 `dsh-camel-pool`，与 profile 条目 id 同源，否则会报 `No configurable plugin entry "dsh-connect"`。

---

## CodeArts 渠道（华为云，按驼峰规则接入）

第 7 条 `registerPoolRoute`，详见 [lib/providers/codearts/README.md](lib/providers/codearts/README.md)。要点：

- **不是** fork 市场插件 `dsh-codearts`、不是独立 shim、不是独立 provider / 独立面板；
  协议引擎放 `lib/providers/codearts/vendor/`（4 个实测构建产物），`engine.js` 重导出可读名，
  `index.js` 只做池契约 + 状态挂载 + 4 条 loopback 路由。
- `route.fetch` 对池清洗后的最终 `init.body` 做 `prepareChatBody` 白名单重建，再交给
  `lib/providers/codearts/transport.js`：自签 `SDK-HMAC-SHA256`、用 `node:https` 直连、把
  「累计快照 SSE」转成 OpenAI 增量。**不走全局 `fetch`**——它被 billion-context 接管，会先压缩
  再自签，而对方没有 CodeArts 凭据，于是本地 403 `signed_request_requires_resign` /
  `bili_resign_unavailable`（签名覆盖 body，任何改写都会让上游拒）。
- 积分 / 即将过期额度 / 每日签到 / 上游排队位置 / 本机请求数与 token 用量统一挂到
  `/plugins/dsh-pool/status` 的 `doc.codearts`，由驼峰统一面板读取；输入框下方不显示单独状态行。
- OAuth2 登录（PKCE+DPoP）、粘贴 `security_token`、逐账号管理走
  `/plugins/dsh-pool/codearts-oauth`；渠道状态 / 签到 / 排队走
  `/plugins/dsh-connect/codearts/{status,checkin}` 与 `/plugins/dsh-pool/codearts-queue`。
- `lib/client.js` 追加独立 IIFE `codeartsClient`（只保留设置卡片），`CONTRIBUTIONS` 增一行；
  classic script / `BOOT_PLACEHOLDER` / 凭证零输出约束全部保持。输入框下方信息行已按用户要求移除。
- **只保留 5 个模型**：`deepseek-v4.1-flash` / `glm-5.3-flash` / `glm-5.3` / `kimi-k3` /
  `kimi-k3.1-pro`，按用户点名的顺序硬过滤，上游目录里的其余模型一律不进池。
- **与三个老渠道完全同规则**：`models()` 不看登录状态；这 5 个 id 全部已在 `shared/pool.js` 的
  `CURATED_MODELS`（与老渠道同 id 合并成一条）；`hidden()` 接 `setExternalHidden` /
  `setPickerHidden`，受 `disabledModels` / `disabledChannels` / `poolEnabled` 管辖；`credits()`
  与 `checkin` 字段形状和 trae / qoder 一致。
- `POOL_STATUS_PATH` 仍是 `/plugins/dsh-pool/status`；旧 6 条路由、旧面板、旧额度数据不受影响。

**新增 web 路由注册在 `ctx.inject(["webServer"])` 回调里，须重启 DSH 桌面端才生效**（`lib/*.js` 本身热加载）；
**新增模块文件**（如 `lib/providers/codearts/transport.js`）同样要重新加载插件才会进导入图。

---

## 后续：添加更多渠道以扩充模型选择

池内核对外只认一个契约 `registerPoolRoute(route)`（`lib/shared/pool.js:99-105` 硬校验）。新增一条渠道 = 在 `lib/providers/pool/index.js` 的 `apply()` 里多注册一个 route 对象：

```js
registerPoolRoute({
  key: "myprovider:slot1",          // 全局唯一
  kind: "openai",                   // 协议方言
  providerId: "myprovider",        // 宿主适配器 provider
  channelId: "slot1",              // 注意 Qoder 的 channelId ≠ providerId
  displayName: "我的渠道",
  priority: 1,                      // 越小越优先；券类给 9 殿后
  voucher: false,
  chatUrl()     { return "https://…/chat/completions"; },
  token()       { return readAuthFile(); },   // 凭据零输出，只返回字符串
  models()      { return cachedCatalog(); },  // [{id,name,contextWindow,maxTokens,reasoning,input}]
  hidden()      { return prefs.disabledModels; },
  credits()     { return probeRemaining(); }, // TTL 300000 缓存
  status()      { return "signed-in"; },
});
```

注册完 `onPoolRoutesChanged` 会自动 `ctx.emit("llm/adapters-updated")`，模型下拉立刻出现新分组；`pool.status` 的 `routes[]` 也会多一条。参照现有 6 条：`workbuddy:workbuddy1/2/4`、`trae`、`qoder`、`bailian`（`providerId: "aliyun-bailian"`, `priority: 9`, `voucher` 殿后）。渠道侧的适配器同样在 `lib/index.js` 的渠道循环里按 `PROVIDERS` 追加即可。

**路线 A（后续升级）**：若想把池内核真正拆成一个独立 npm 包、由多个插件共享同一份状态，用 `globalThis[Symbol.for("dsh-pool.state.v1")]` 做跨包单例（规格 8.3 首选方案），避免两份内核各自维护 latches/credits 缓存。当前路线 B 已满足独立化目标，暂不需要。

---

## 安装与上线

```bash
# 1) 工作区目录即本包；由宿主装载（不要手写 profile 的 package.json / 不要手动 pnpm）
#    plugin_manager action: install_bundle target="<本包绝对目录>"
# 2) profile 层挂配置并禁用旧插件（cordis.patch.yml）：
#    - id: dsh-camel-pool
#      name: dsh-camel-pool
#      config: { autoCheckin: true, ..., poolEnabled: true, poolVoucherFirst: false }
#    - id: dsh-connect
#      disabled: true
# 3) 改装载层（cordis.patch.yml）后必须重启 DSH 桌面端；lib/*.js 热加载即可
```

包内 `cordis.patch.yml` 已自带 `- insert: - id: dsh-camel-pool / name: dsh-camel-pool`。校验装载用 `cordis_inspect_query Config.listConfigs`，UI 挂在 Client 的 `Slots.listSubTree` 里查。现有会话保留的是启动时的插件 revision，看新面板要开新会话。

---

## 验收清单（规格 8.4）

1. `lib/**/*.js` 与 `scripts/**/*.mjs` 全部 `node --check` 通过；
2. `GET /plugins/dsh-pool/status` 200，`routes=10`、`models=28`、`pool.broken=[]`、`active=true`；
3. `?refresh=1` 后 `credits.total ≈ 9318.21`；
4. `GET /plugins/dsh-connect/status` 4 渠道 `signed-in`、`issues:0`；
5. 模型选择器出现 `dsh-pool` 分组，含 `hy4free`；
6. `poolEnabled` 切换立即生效；
7. `poolVoucherFirst` 切换改变 `pool.order`；
8. 真实池请求写 `.pool-route.log`，`tokenLen` 有值、**无任何凭据**；
9. 402/429 触发熔断 + latch，`xhigh` → `max` 降级；
10. 回滚演练可还原。

### 状态快照现读修复（8.4 第 6/7 项）

8.4 验收时发现 `pool.order` / `active` **永久滞后**：`poolEnabled` / `poolVoucherFirst` 是 `.volatile()` 字段，`settings.update()` 走 `updateVolatile()` 原地改内存，不写 profile patch、不触发 `apply()` 重跑；而 `lib/shared/pool.js` 里 `providerActive` / `voucherFirstDefault` 两个模块级旗标**只在 `apply()` 启动时写一次**，`poolStatusDocument()` 的 `active`(`:543`) 与 `order`(`:555`) 读的正是这两个旗标。真实转发/模型现读偏好（`providers/pool/index.js:399`、`enabled():251-255`）不受影响，只有状态快照字段落后。

修复在**挂载层文档投影**，不动状态机：`lib/providers/pool/index.js:709-718` 的 status handler 现读 `readPreferences()`，把活值传给 `poolStatusDocument({ voucherFirst: prefs.poolVoucherFirst === true })`（`:538` 的 `??` 本就支持覆盖）并覆写 `doc.active = prefs.poolEnabled !== false`。实测（`_tools/verify-fix.mjs`）：切 `poolVoucherFirst` 后 `pool.order` 在 3s 内变 `voucher-first`、关 `poolEnabled` 后 `active=false` 在 1.5s 内跟上，恢复后回到 `credits-first` / `true`，`routes=6` / `models=41` / `broken=[]` 恒定。

---

## 回滚

备份在 `C:\Users\00\Documents\the coding assistant\驼峰插件\_backup\20261107-193832\`：

- `cordis.patch.yml` / `cordis.yml` = profile 原始配置；
- `dsh-workbuddy-trae-qoder-connect/` = 源包整包副本。

UX v2 同步前的 `client.js` / `pool-credits-client.fragment.js` / `final-delivery-check.mjs` / `README.md` 另存于 `_backup\ux-v2-pre-sync-20261108-004549\`；只回滚交互改动直接还原这四件即可（改的是 `lib/client.js`，宿主热加载，无需改装载层、无需重启）。

回滚步骤：① profile 把 `- id: dsh-camel-pool` 段删掉、`- id: dsh-connect` 的 `disabled: true` 去掉；② 从 `_backup/<STAMP>/` 还原 `cordis.patch.yml`；③ 重启 DSH 桌面端；④ 若装过本地 bundle，用 `plugin_manager action: remove_bundle target="dsh-camel-pool"`；⑤ 确认 `GET /plugins/dsh-pool/status` 仍由旧包 200 响应。池内核状态机在本包里一字未改（仅挂载层状态快照有现读修复），回滚不会丢额度数据。

---

## 约束

- 运行时 Node `^22.19.0 || >=24.0.0`（实测 v22.20.0）；`type: module`。
- `lib/client.js` 是生成器合成的 **classic script**，禁止顶层 `import`/`export`；新增贡献必须是独立 IIFE 并加进末尾 `CONTRIBUTIONS` 数组。module-loader 的 `id` 必须等于 npm 包名。
- 所有 HTTP 端点只对 loopback 放行（`originIsLoopback` 缺失 Origin 即放行）；`abortOnClientDisconnect` 必须用 `res.on("close")` + `!res.writableEnded`。
- `BOOT_PLACEHOLDER` 不要删。
- **凭证零输出**：日志、端点响应、`.pool-route.log` 都不落任何账号/ token 明文，凭据只存 0600 本地文件。
- `lib/shared/pool.js` 的 scrub 是**非恒等替换**（正则/guard 认 `[R]`、replace 写 `[D]`），不要「顺手统一」成同一个字面量。
