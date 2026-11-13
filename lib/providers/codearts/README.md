# CodeArts 渠道（驼峰积分池适配层）

华为云 CodeArts 作为 `dsh-camel-pool` 的**第 7 条 `registerPoolRoute`** 接入，按驼峰自己的规则来；
没有 fork 市场插件 `dsh-codearts`，没有独立 shim、独立 provider、独立积分面板。

## 为什么这样接

旧接入（`.codearts-shim.log`）把请求经本地 HTTP 代理多跳转发，`billion-context` 对请求体做
上下文压缩时签名覆盖的 body 被改写，上游直接回：

```
403 signed_request_requires_resign / bili_resign_unavailable
bili refused to forward this sdk-hmac-sha256 (CodeArts APIG SDK-HMAC-SHA256, #1884)-signed request:
the signature covers the request body, and any rewrite (context compression) would invalidate it upstream
```

CodeArts 用 APIG `SDK-HMAC-SHA256` 对**请求体原文**签名。本实现让签名与请求体在同一进程、
最后一公里生成：池把清洗后的最终 `init.body` 交给 `route.fetch`，`route.fetch` 忽略池塞进来的
`authorization: Bearer ...` 头，用 `prepareChatBody` 白名单重建 body，再交给
`transport.js` 的 `chatStreamDirect()` 现场签名、用 `node:https` 直连发出 —— 中间没有任何
可改写 body 的代理。顺带修掉旧 shim 的 `ReferenceError: extra is not defined` / `timer is not defined`。

**为什么不用全局 `fetch`**：`billion-context` 会接管 `globalThis.fetch`，对它识别出的
`SDK-HMAC-SHA256` 签名请求「先压缩改写、再自己重签」；它没有 CodeArts 凭据（只在
`$DSH_HOME/jet-hub/state.json` 里找 `provider: codearts` 的账号），重签不了就本地 403，
于是同一句话又回来了。所以 `transport.js` 绕开 `fetch`，直接走 `node:https`：签名的字节
就是出网的字节。实测（真实账号）`glm-5.3` / `kimi-k3` / `deepseek-v4.1-flash-1017` /
`openpangu-2.0-pro` 均 200 流式返回。

## 目录

| 文件 | 职责 |
| --- | --- |
| `vendor/` | 四个经实测的市场包构建产物（OAuth2 PKCE+DPoP、SDK-HMAC-SHA256 签名/SSE、模型发现、本机用量账本），逐字节复制、只读 |
| `engine.js` | 把 vendor 的 rolldown 短名导出重导出成可读名；全包唯一 import 入口 |
| `credits.js` | 积分统计解析、签到、排队探测、本机请求数/token 用量账本 |
| `transport.js` | 自建出口：SDK-HMAC-SHA256 签名 + `node:https` POST + 「累计快照 SSE → OpenAI 增量」转换，绕开被接管的全局 `fetch` |
| `index.js` | `registerPoolRoute` 契约、账号/登录会话、模型目录、4 条 loopback 路由、零密文状态 |

## 挂载点（宿主改动）

- `lib/providers/pool/index.js`：`apply()` 里 `registerPoolRoute(codeartsRoute(...))` +
  `startCodeartsRefresh()`；`POOL_STATUS_PATH` GET 把 `doc.codearts` / `doc.codeartsAuth`
  挂到统一状态文档；新增 4 条 `webServer.register` 路由（经 `ctx.effect` 回收）。
- `lib/channel-registry.js`：`CHANNEL_KINDS` 增 `codearts`（`multi:false`），默认注册表补一条；
  `channelOf()` 派生 `statusPath=/plugins/dsh-connect/codearts/status`、
  `checkinPath=/plugins/dsh-connect/codearts/checkin`、`credentialHint='.codearts-accounts.json'`。
  profile `C:/Users/00/.dsh/connect-channels.json:27-30` 里早已存在的 `{"id":"codearts",...}`
  因此被正确接纳，`allChannels()` 实测 7 行。
- `lib/panel.js`：`creditsOf()` 加 codearts 分支、`KIND_ADAPTERS` 加 codearts 适配器
  （`HUB_SETTINGS_NS` 仍是 `dsh-camel-pool`）。底部信息行的两个显示开关已随该行一起移除。
- `lib/index.js`：`PROVIDERS` 不动（CodeArts 走池路由，不走渠道适配器循环），
  `refreshChannel()` 加 codearts 分支调 `refreshCodeartsModels()`。
- `lib/client.js`：末尾追加独立 IIFE `codeartsClient` + `CONTRIBUTIONS` 增 `["codearts", codeartsClient]`
  （classic script，无顶层 import/export，`BOOT_PLACEHOLDER` 保留）。
- `lib/index.js` 另加一行：`HOOKED_PROVIDERS = PROVIDERS.concat([["codearts", codearts]])`，只用于注入
  `setExternalHidden` / `setPickerHidden` —— 让 CodeArts 和 workbuddy / trae / qoder 吃同一套
  「禁用模型 / 禁用渠道 / 池启用」规则（见下节）。
- profile `cordis.patch.yml`：`- id: dsh-camel-pool` 保持既有 config（底部信息行已移除，两开关不再使用）。

## 与三个老渠道完全同规则

- **只保留用户点名的 5 个模型**：`deepseek-v4.1-flash` / `glm-5.3-flash` / `glm-5.3` /
  `kimi-k3` / `kimi-k3.1-pro`。`ALLOWED_CODEARTS_MODELS` 是硬清单，`refreshCodeartsModels()`
  从上游目录里只挑这 5 个并按固定顺序输出；`libraryBypass` 已移除，上游新增模型不会灌进模型库。
- **与老渠道同规则**：`models()` 不看登录状态（未登录点选得到 401 + 中文提示，而不是条目消失）；
  这 5 个 id 全部已在 `lib/shared/pool.js` 的 `CURATED_MODELS` 里，与老渠道同 id 合并成一条，
  不重复出现、顺位稳定。
- **吃面板隐藏规则**：`hidden()` 返回 `externalHidden(codearts) + pickerHidden(codearts)`，由
  `lib/index.js` 注入 `disabledModelsFor` / `pickerHiddenFor`；禁用模型或关掉池启用时，CodeArts
  的条目同样从模型库消失（实测：禁掉 `GLM-5.2` 后合并分组 13 → 12）。
- **签到同形**：状态里的 `checkin` 来自积分统计的当日福利活动（`credits.accounts[*].checkin`
  的 `claimable` / `claimedToday` / `amount`），面板签到列与 trae / qoder 用同一套状态机。
- **额度同形**：`credits()` 返回 `{status, credits:{remain,total,accounts,endTime}}`，与三渠道同
  字段，直接进 `/plugins/dsh-pool/status` 的 `credits.total` 与逐号明细。

## 路由（全部 loopback 放行、零密文）

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `/plugins/dsh-pool/codearts-oauth` | GET/POST | 华为云 OAuth2 登录（PKCE+DPoP）、粘贴 `security_token`、登出、暂停/置顶账号、刷新模型、取消登录 |
| `/plugins/dsh-connect/codearts/status` | GET | 渠道状态：积分/逐号明细/模型数 |
| `/plugins/dsh-connect/codearts/checkin` | POST | 每日签到（幂等） |
| `/plugins/dsh-pool/codearts-queue` | GET/POST | 上游排队位置探测 |
| `/plugins/dsh-pool/status` | GET | 统一状态文档里 `codearts` / `codeartsAuth` 两个字段 |

`POOL_STATUS_PATH` 保持 `/plugins/dsh-pool/status` 不变，旧面板、旧渠道、旧额度数据全部不受影响。

## 客户端（只保留设置卡片）

- **输入框下方不再有 CodeArts 状态行**：按用户要求整条删除（`client.js` 里的 `InfoLine`、
  `DetailPanel`、`conversation.input.right` 槽位注册、`.dca-line*` 样式与两个显示开关文案
  一并清理）。积分 / 即将过期 / 签到 / 用量 / 排队仍在统一面板和
  `/plugins/dsh-pool/status` 里可读，不再单独占输入框下方一行。
- 设置卡片（`settings.plugin.item` + `settings.plugins.tab` 双 seam）保留：华为云 OAuth 登录、
  粘贴 token、逐账号暂停/置顶/登出、排队探测。
- 数据源只有 `/plugins/dsh-pool/status`，不新开第二条轮询链。

## 凭据纪律

`security_token` / 临时 AK / SK / `refresh_token` / DPoP 私钥一律不出进程：日志、
`.pool-route.log`、端点响应里都没有明文（仅记 `tokenLen`）；凭据只由 `CodeArtsAccountStore`
以 `0600` 落在 `$DSH_HOME/.codearts-accounts.json`（老单账号文件 `.codearts-auth.json` 自动兼容）；
本机用量账本 `.codearts-usage.json` 按天留 60 天。

## 生效与验证

`lib/*.js` 热加载即可；但 4 条 web 路由注册在 `ctx.inject(["webServer"])` 回调里，
**新增路由需要重启 DSH 桌面端**（主 `README.md:130`）。重启后：

```bash
curl -s http://127.0.0.1:10233/plugins/dsh-pool/status | jq '.codearts, .codeartsAuth'
curl -s http://127.0.0.1:10233/plugins/dsh-pool/codearts-oauth | jq .
curl -s http://127.0.0.1:10233/plugins/dsh-connect/codearts/status | jq .
```

未登录时 `codeartsAuth.loggedIn=false`、这 5 个模型照常出现在 `dsh-pool` 分组；
登录后 `fetchModels()` 会自动刷新，但只保留这 5 个（实测上游 11 个 → 本地 5 个），
积分/签到/排队按 60s TTL 缓存并单飞。

> `lib/*.js` 的改动一般热加载即可；但**本次新增了 `transport.js` 这个新模块**，宿主只有在
> 重新加载插件（重启 DSH 桌面端，或在插件页把 `dsh-camel-pool` 关掉再开）后才会把新导入图
> 装进来。判断是否已加载：`GET /plugins/dsh-connect/codearts/status` 的 `checkin` 里应出现
> `checkedIn` / `amount` 字段。

## 推理档位（reasoning）必须真实存在，否则整个模型库清零

宿主 `@deepseek-ai/dsh-llm` 对 `reasoning` 是硬校验：`reasoning` 存在但 `efforts` 为空会抛
`adapter returned invalid reasoning metadata for provider "dsh-pool" model "..."`，并且**整个
dsh-pool provider 的模型列表会被清空** —— 一条坏元数据 = 用户的模型库全部消失（这就是那次
「模型库什么都用不了」的根因：CodeArts 的 fallback 模型写死 `reasoning: true` 却没给档位）。

所以 `index.js` 的 `toPoolModel()` 只在拿到真实档位时才写 `reasoning: true` + `thinkingLevelMap`：
刷新目录时先 `POST /v1/model/thinking-variants`（body `{ model_names }`，官方限 50 个名字）取
`variants[name].strengths` / `default_strength`，只保留 off/minimal/low/medium/high/xhigh/max
里的值；拿不到、抛错、或 strengths 为空 → 该模型就是非推理模型（照样进库、照样可选、照样能聊），
**绝不猜档位**。实测 11 个代理模型只有 GLM-5.2 与 glm-5.2-sft-harmony 报 `["high","max"]`，其余 9 个
（deepseek-v4.1-flash / deepseek-v4.1-flash-1017 / glm-5.3 / glm-5.3-flash / kimi-k3 /
kimi-k3.1-pro / openpangu-2.0-flash / openpangu-2.0-pro / speed）为 false。

以后往任何池渠道加模型都照此办理：`reasoning: true` 必须同时给出至少一个非 null 档位，
否则整库归零。改完 `lib/providers/codearts/index.js` 后若状态条没变化，让插件重载一次
（插件页关掉再开，或调一次 unlag 刷新按钮）。

## 回滚

删掉 `lib/providers/codearts/`、`lib/client.js` 里的 `codeartsClient` IIFE 与 `CONTRIBUTIONS`
那一行、`lib/providers/pool/index.js` 里 5 处、`lib/channel-registry.js` 里 3 处、
`lib/panel.js` 里 5 处、`lib/index.js` 里 2 处、profile 两个开关，重启即可；
其它 6 条池路由与面板完全不受影响。`_ref_codearts/` 是参考样本，可整目录删除。
