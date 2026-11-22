# 驼峰积分池 · dsh-camel-pool

**驼峰积分池**是 DSH 的积分池插件：把 WorkBuddy、Qoder、Trae、CodeArts 等多平台的免费额度与积分汇聚成一个统一的「能量池」——一个面板看余额、一次签到领当天积分、一个下拉选全部模型；调用时自动挑最划算、最快过期的路由。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **English** — Camel Pool is a DSH plugin that gathers free credits from WorkBuddy, Qoder, Trae and CodeArts into one pool: a unified balance panel, one-click daily check-in with automatic make-up, and a single model picker across all channels. Requests are routed to the cheapest, soonest-expiring channel automatically.

---

## 名字的来历

「驼峰」取意于骆驼的驼峰——骆驼把能量储存在驼峰里，穿越沙漠时再一点点取用。这个插件做的是同一件事：

- 把散落在多个平台、会过期、会重置的免费积分与额度「存」进一个池子；
- 模型调用时像骆驼消耗驼峰一样按需取用，优先烧当天就过期的部分（见「当日额度优先」）；
- 一个池子统一对外，调用方不必关心背后是哪几家渠道、哪条路由。

`dsh-camel-pool` 即「DSH 的驼峰（camel）积分池」；`camel` 也呼应 camelCase 的写法，插件 id、npm 名、settings 命名空间统一用它。

---

## 主要功能与重点

- **统一额度面板**：侧栏常驻「驼峰积分池」入口，大字显示总积分，逐条路由列出剩余额度、即将过期量、优先级、代金券与额度占比条，套餐明细默认折叠、可搜索展开（详见下一节「你会得到什么」）。
- **自动签到 + 补领到账**：打开面板时幂等领取当天可领积分；Qoder 活动窗口未到（约每日 10:00 开放）或 Trae 上游失败时，持久化队列会在到点后自动补领，确保「点了签到，积分到账」（ux-v35）。
- **多渠道模型下拉**：WorkBuddy（多槽位）、Qoder CN、Trae CN 与积分池自身的白名单模型合进一个列表，按渠道分组、标积分倍率，中途换渠道历史不断。
- **智能池调度**：按剩余额度挑路由，402/429 自动熔断换线；当日即将过期的额度优先烧，粘性让位给当日桶；真实请求只记 token 长度、不含凭据。
- **用量账本**：记录每日请求与消耗；CodeArts 这类余额含赠包/当日到期包的渠道只认上游直接上报的消耗，避免套餐重置被误记成巨额虚高（ux-v34）。
- **即时可配**：`autoCheckin`、额度/券优先、隐藏或禁用渠道与模型、低额度自动提推理档位等均可在设置里切换、即时生效（见「配置」一节）。

---

**对外路由**（均为 loopback 回环端点，仅本机可访问）：

| 端点 | 用途 |
|---|---|
| `GET /plugins/dsh-pool/status` | 积分池状态：`credits.total`、`pool.routes`、`models`、`pool.order`、`pool.broken`；每条路由另带 `modelCount` / `rawModelCount` / `hiddenModelCount` / `droppedModels`（ux-v29 诊断字段，ux-v31 补齐 `hiddenModelCount`） |
| `GET /plugins/dsh-connect/status` | 渠道聚合状态（4 渠道 signed-in / credits / checkin.state） |
| `POST /plugins/dsh-connect/checkin` | 一键签到（全部渠道） |
| `POST /plugins/dsh-connect/checkin/<id>` | 单渠道签到 |
| `GET/POST /plugins/dsh-connect/settings` | 偏好读写（命名空间 `dsh-camel-pool`） |
| `GET /plugins/dsh-connect/models` / `/auth` | 模型目录 / 授权 |

`POOL_STATUS_PATH` 保持 `/plugins/dsh-pool/status` 不变——这是池内核对外契约，改了会断掉所有消费者。

---

## 你会得到什么

**积分池剩余额度面板（UX v2）。** 侧栏常驻一个「驼峰积分池」入口（`sidebar.footer.action`，`order: 21`），按钮上带状态点与额度摘要，点开是自己的浮层面板：

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

**自动签到。** 客户端所有 `useHubStatus()` 调用统一带 `?auto=1`（`lib/client.js` 的 `fetch(\`${STATUS_PATH}?auto=1\`)`），宿主 `lib/panel.js` 的 status handler 判 `prefsNow.autoCheckin === true && url.includes("auto=1")`，在扇出 `probeAll(..., { autoCheckin: auto })` 时顺带幂等领取当天可领积分。**没有额外定时器**，重复打开只领一次、不重复扣分。偏好项 `autoCheckin` 默认 `true`，可在设置里关掉（新额度面板的开关也写这个键）。新额度面板**刻意不触发第二次 `?auto=1`**，只读 `/plugins/dsh-pool/status`（首屏不带 refresh，打开弹窗时补一次 `?refresh=1`），避免并发重复 claim。

**一个下拉装下三家 + 池。** WorkBuddy（国区/国际版多槽位）、Qoder CN、Trae CN 的免费额度合进一个模型列表，按渠道分组旁标积分倍率；`dsh-pool` 作为独立一组出现，含 `hy4flash-free` 等 26 个白名单模型（CodeArts 5 个与老渠道同 id 的自动合并成一条；Gemini 6 个已于 ux-v22 整组移出，不再进池）。模型数以 `GET /plugins/dsh-pool/status` 的 `models` 实测为准，README 不再硬写条数。中途换渠道历史不断。三家协议（OpenAI 方言 / 私有 agent 协议 / 自定义编码流）由本包在中间翻译。**外加 ux-v36 起的自定义路由**：面板里自己填 `baseUrl` + 模型清单，任何 OpenAI 兼容上游都能挂进同一个下拉（见下方「自定义路由」一节）。

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

`poolEnabled`、`poolVoucherFirst`、`poolMergeModels`、`poolCostFirst`、`poolShowRoutes`、`poolAutoBoostEffort`、`poolBurnExpiringFirst` 都是 `.volatile()` 字段，切换即时生效、不落盘。改模型/渠道相关键会触发 `deps.onModelsChanged?.()` → `ctx.emit("llm/adapters-updated")`。写入走白名单（`lib/panel.js` 的 settings handler），不在表里的键一律丢弃。设置写入走 `settingsApi.update(HUB_SETTINGS_NS, patch)`，`HUB_SETTINGS_NS` 为 `dsh-camel-pool`，与 profile 条目 id 同源，否则会报 `No configurable plugin entry "dsh-connect"`。

---

## CodeArts 渠道（华为云，按驼峰规则接入）

第 7 条 `registerPoolRoute`，详见 [lib/providers/codearts/README.md](lib/providers/codearts/README.md)。要点：

- **内置**协议引擎，不依赖市场插件 `dsh-codearts`、不另起 shim / provider / 面板；
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

## 自定义路由：面板里直接加任意 OpenAI 兼容 API（ux-v36）

**别人下载这个插件后，不必改一行代码就能加自己的中转站 / 自建网关 / 任意 OpenAI 兼容上游。**
渠道中心面板的「+ 添加渠道」里，类型选 **「自定义路由（任意 OpenAI 兼容 API）」**，填四项即可：

| 字段 | 说明 |
|---|---|
| 渠道 ID | 小写字母开头，`[a-z0-9-]`，≤32 位；它同时是池路由 key、`channelId`、`providerId`、凭据文件名 |
| 上游地址 | `baseUrl`，`http(s)://` 开头，例如 `https://api.example.com/v1`；末尾斜杠会被去掉 |
| 请求路径 | 默认 `/chat/completions`。池转发 `POST <baseUrl><apiPath>`，请求体是标准 OpenAI 方言 |
| 模型清单 | 上游要暴露的模型 id，逗号/分号/换行/顿号都能分隔，最多 64 个，顺序保留 |

创建成功后按提示：

1. **面板立刻可用**：新行出现在渠道列表里，点「粘贴」把 API Key 存进 `~/.dsh/connect-auth/<id>.key`（0600，纯文本，原样当 `Authorization: Bearer <key>` 发出去，不做任何形状校验）；
2. **模型要重启 DSH 才出现**：provider 侧是冷装载的（与 workbuddy/trae/qoder 同一条规矩），重启后 `dsh-pool` 分组里才会多出这些模型；
3. 模型名填错了不用重建渠道：改完上游后点该行的「更新模型」，插件会 `GET <baseUrl>/models`（把 `apiPath` 的 `/chat/completions` 换成 `/models`）拉清单并写回注册表；上游没有 `/models` 时会明确告诉你「该线路可能没有 /models，模型清单可以手填」，此时手改注册表里的 `models` 即可。

### 与内置渠道的差异（都是刻意的）

- **不过白名单**：`shared/pool.js` 的 `CURATED_MODELS` 只点名了 26 个模型 id。自定义路由的模型名由用户自填，因此走一条合成 curated 条目的旁路（`tier: 5`），**不改写 `poolId`**——请求里的 `model` 就是用户填的原名。
- **没有签到、没有额度行**：它只是一条转发线路，「一键签到」对它报 `unsupported`，额度区不编造数字（上游没有余额接口时宁可不显示）。
- **`priority: 5`**：排在 `qiniu`(-1) / `workbuddy`(0) / `trae`(1) / `qoder`(2) / `codearts`(3) 之后、`bailian`(9) 之前，即内置额度先用，自定义线路兜底。
- **探活是本地合成的**：`channelOf()` 给它 `localOnly: true` 与空 `statusPath`，面板不发任何回环请求（否则会打到自己）；状态只看「Key 文件在不在」。
- **禁用照常生效**：`disabledChannels: ["<id>"]` 整条下架，`disabledModels: ["<id>/<model>"]` 只下架单个模型。

### 密钥去哪了

三级读取，与七牛/百炼同一套语义（`lib/providers/pool/custom-routes.js` 的 `createCustomKeyReader`，缓存 10s）：

1. 环境变量 `CUSTOM_<ID>_API_KEY`（id 里非 `[A-Za-z0-9]` 的字符换成 `_` 再大写，例如 `my-router` → `CUSTOM_MY_ROUTER_API_KEY`）；
2. `~/.dsh/connect-auth/<id>.key`（面板「粘贴」写的就是这里）；
3. 宿主凭据服务 `ctx.get("credentials").resolve(...)`。

三者都空时该路由**不注册**（启动日志一条 warn，不影响内置渠道），配好后重启 DSH 即可。**没有任何地方会输出 key 明文**：`.pool-route.log` 只记 `tokenLen`。

---

## 多账号与「同号」保护（ux-v38）

同一个渠道可以加多个槽位（`trae` / `trae2`、`qoder1` / `qoder2`、`workbuddy1` / `workbuddy2`…），它们各自独立持有凭据、各自报余额。但有两件事必须说清楚：

### 桌面端只能登一个 Trae 号 —— 这是上游限制

Trae 桌面 App 的登录态只存在 `%APPDATA%/Trae CN/User/globalStorage/storage.json` 的一个 `iCubeAuthInfo://icube.cloudide` 条目里。**换号登录就是把那一个条目覆盖掉**，所以「桌面上登了小号、另一个号就显示不可用」是必然的，插件无法改变。

插件自己的槽位不走桌面端：每个槽一套 `(deviceId, 私钥)`，凭据落在 `~/.dsh/connect-auth/trae.json` / `trae2.json`，彼此独立。**要让两个槽指向不同账号，必须分别用浏览器登录**（池浮层 → 「＋ 添加路由」→ Trae 卡片 → 「登录」）。

### 自动 adopt 不再替你做决定

`keepalive` 的自动 adopt 原本只有一个用途：**把本槽救活**。但当本槽 token 到期、而桌面端登着另一个号时，旧逻辑会整份搬过来 —— 于是所有 Trae 槽在 30 秒内被统一成桌面端那个号。症状就是「两个 Trae 显示一模一样的额度」。

现在 `lib/providers/trae/keepalive.js` 的 `adopt()` 分三档：

| 本槽状态 | 桌面端 | 行为 |
| --- | --- | --- |
| 还没有账号（新槽 / 快照坏） | 任意 | 放行 —— 这是唯一合理的首次导入 |
| 有自己的账号，且与桌面端**相同** | 同号 | 交给 `newerThan` 判定，谁新用谁（共链续期） |
| 有自己的账号，且与桌面端**不同** | 异号 | **拒绝**，记 `adoptBlocked`，等你在面板里显式换号 |

被拒绝时 `GET /plugins/dsh-trae-connect/status`（以及 `/2/status`）的 `keepalive` 段会带 `adoptBlocked: { at, localUserId, desktopUserId }`，池浮层里这一行也会挂红标「同号」。

### 面板上的三个动作

池浮层 → 「＋ 添加路由」→ Trae 卡片每一行有两个按钮：

- **登录 / 重新登录**：带 `expectUserId`（= 本槽当前绑定的 userId）发起 PKCE。登成别的号会被后端 `login.js` 的账号守卫**当场作废**，不会污染本槽。
- **换号**：故意不带 `expectUserId`，允许登成另一个账号并把本槽改绑过去。这是唯一会改变槽位归属的操作，必须人点。

槽位行还会显示 `账号名 · userId 后 6 位` —— 以前两位都只显示「特依安」，两个槽塌成一个号时界面上完全看不出来。

### 同号告警

池状态文档的每条路由新增 `identity: { userId, account }`（由各 provider 的 `credits()` 自报，目前 trae 提供）。浮层把**同 kind 且 userId 相同**的路由标成「同号」，`title` 里列出是哪几条、userId 是多少。判重在界面 —— 池内核不据此做任何路由决策，请求照样按优先级与余额分发。

### 设备身份隔离：两个号各用一套设备（ux-v39）

ux-v38 只挡住了「自动 adopt 换号」，但还有一条更隐蔽的掉线路径：**两个槽共用同一个 `deviceId`**。

服务端对同一个 `DeviceID` 只保留最近一次 AuthCode 登录注册的那把公钥。实测矩阵：

| 链 | 私钥 | 结果 |
| --- | --- | --- |
| 特依安链 | 特依安钥 | OK |
| 特依安链 | 桌面钥 | 20403 |
| 桌面链 | 特依安钥 | 20403 |
| 同一把钥 | 换 deviceId | 20403 |

也就是说 `(deviceId, 私钥)` 必须成对且唯一。旧实现里 `slotIdentity()` 会在「本槽与桌面端同号」时**故意复用桌面身份**（桌面 `deviceId` + 桌面密钥对），想让桌面端跟着一起活下去。可一旦这个槽换成了别的号，它就变成「拿桌面的设备号给另一个账号续期」—— 谁先重新登录，谁就把对方顶成 20403。旧 `trae2.json` 的 `device.deviceId` 至今仍是桌面端那把，就是这条路径留下的。

ux-v39 改成**一律用本槽自己的身份**：

| 位置 | 行为 |
| --- | --- |
| `slotIdentity(doc, desktop)` | 只取 `doc.device`；发现 `local.deviceId === desktop.deviceId` 就返回 `undefined` → 调用方 `newDeviceId()` 造一套新的。**不再按账号复用桌面身份。** |
| `conflictsWithDesktop()` | 撞车判定抽成单一函数，`renew` / `status` / 池文档三处共用。判不出账号归属时按撞车处理（宁可停下也不乱签）。 |
| `keyMaterial(doc)` | 撞车时**拒签**并记 `deviceCollision`，绝不拿桌面设备号去签别人的链。 |
| `renew()` | 撞车直接早退（`code: "device-collision"`，`dead: true`），不再发出必然 20403 的请求。 |
| `writeBackToDesktop(doc)` | 新增设备号守卫：**本槽设备号 ≠ 桌面端设备号时一律不写回**。独立设备的 refreshToken 写回桌面端会让桌面端拿到不属于它设备的凭据。 |
| `status()` | 透出 `deviceId` 与 `deviceCollision`；池路由 `identity` 里也带一份，浮层据此挂红标「撞设备号」。 |

**撞车槽的自愈方式**：在池浮层对这一行点「换号」，用浏览器登一次。PKCE 登录会生成一套全新的 `deviceId` + 密钥对（`credentialFromLogin`），本槽从此与桌面端再无交集。

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

注册完 `onPoolRoutesChanged` 会自动 `ctx.emit("llm/adapters-updated")`，模型下拉立刻出现新分组；`pool.status` 的 `routes[]` 也会多一条。参照现有路由（按 `priority` 升序）：`qiniu`(-1，合成余额)、`workbuddy:workbuddy1`/`workbuddy2`(0)、`trae`/`trae2`(1)、`qoder1`/`qoder2`(2)、`codearts`(3)、`custom:<id>`(5，用户在面板里自建，**不需要改代码**，见上方「自定义路由」一节)、`bailian`(9，`providerId: "aliyun-bailian"`，`voucher: true` 强制殿后)。渠道侧的适配器同样在 `lib/index.js` 的渠道循环里按 `PROVIDERS` 追加即可。

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
2. `GET /plugins/dsh-pool/status` 200，`models=26`（白名单条数）、`pool.broken=[]`、`active=true`；路由条数以实测为准，不再断言固定值；
3. `?refresh=1` 后 `credits.total ≈ 9318.21`；
4. `GET /plugins/dsh-connect/status` 4 渠道 `signed-in`、`issues:0`；
5. 模型选择器出现 `dsh-pool` 分组，含 `hy4flash-free`；
6. `poolEnabled` 切换立即生效；
7. `poolVoucherFirst` 切换改变 `pool.order`；
8. 真实池请求写 `.pool-route.log`，`tokenLen` 有值、**无任何凭据**；
9. 402/429 触发熔断 + latch，`xhigh` → `max` 降级；
10. 回滚演练可还原。

### 状态快照现读修复（8.4 第 6/7 项）

8.4 验收时发现 `pool.order` / `active` **永久滞后**：`poolEnabled` / `poolVoucherFirst` 是 `.volatile()` 字段，`settings.update()` 走 `updateVolatile()` 原地改内存，不写 profile patch、不触发 `apply()` 重跑；而 `lib/shared/pool.js` 里 `providerActive` / `voucherFirstDefault` 两个模块级旗标**只在 `apply()` 启动时写一次**，`poolStatusDocument()` 的 `active`(`:543`) 与 `order`(`:555`) 读的正是这两个旗标。真实转发/模型现读偏好（`providers/pool/index.js:399`、`enabled():251-255`）不受影响，只有状态快照字段落后。

修复在**挂载层文档投影**，不动状态机：`lib/providers/pool/index.js:709-718` 的 status handler 现读 `readPreferences()`，把活值传给 `poolStatusDocument({ voucherFirst: prefs.poolVoucherFirst === true })`（`:538` 的 `??` 本就支持覆盖）并覆写 `doc.active = prefs.poolEnabled !== false`。实测（`_tools/verify-fix.mjs`）：切 `poolVoucherFirst` 后 `pool.order` 在 3s 内变 `voucher-first`、关 `poolEnabled` 后 `active=false` 在 1.5s 内跟上，恢复后回到 `credits-first` / `true`，`routes=6` / `models=41` / `broken=[]` 恒定。

---

## 路由掉了怎么查（ux-v31）

路由「莫名其妙掉了」以前只能靠猜，现在按顺序看三处：

1. `GET /plugins/dsh-pool/status` 里那条路由的 `modelCount` / `rawModelCount` / `droppedModels`：`rawModelCount>0` 但 `modelCount=0` 是白名单把上游 id 全滤了（看 `droppedModels` 里是谁，缺了就往 `CURATED_MODELS` 加一行）；`rawModelCount=0` 是目录/凭据层就没给出模型（Trae 看 `trae-cn/models.json` 在不在、产品是不是误判成 solo）；路由整条不在 `pool.routes` 里是 shim/注册层没起来（看 DSH 日志里 `dsh-trae-connect: 回环 shim 启动失败`）。
2. `pool.broken`：`auth` 冷却 10 分钟，`quota`/`transport` 60 秒内自愈；凭据真变了（续期/换号/重登）插件才会清熔断（ux-v31），同条 token 每 30 秒巡检不再清。也可以手动 `POST /plugins/dsh-pool/breakers?route=trae` 清一条。
3. Trae 专用：渠道行上的「续期」「登录」按钮；`needsLogin` 置位说明 refresh 链已废（20101），只能浏览器重新登录造新链，续期再试只会继续失败。

## 回滚

备份在本地 `_backup/<时间戳>/`（不要把含用户名的绝对路径写进发行版文档）：

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
