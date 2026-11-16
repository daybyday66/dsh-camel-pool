# 驼峰插件全方位优化与自检报告

日期：2026-11-15　对象：`dsh-camel-pool` v1.0.2（`C:\Users\00\Documents\the coding assistant\驼峰插件\dsh-camel-pool`）

## 一、结论

修完 16 处真实缺陷（含 1 个 P0、8 个 P1、4 个 P2 与 3 个 P3），并新增一套 `scripts/check-hardening.mjs` 回归闸门接进 `npm run check`。全量自检通过：

| 自检 | 结果 |
| --- | --- |
| `npm run check`（语法 28/28 + 全部契约 + 新增 hardening） | 通过 |
| `scripts/usage-credit-selftest.mjs`、`scripts/usage-selftest.mjs` | 通过 |
| `npm run verify` | ALL_ASSERTIONS_PASSED |
| `npm run verify:e2e` | ALL_E2E_ASSERTIONS_PASSED（S1–S4 全绿） |
| `npm run verify:net` | 按设计跳过（需 `DSH_LIVE_NET=1` 与真实网络） |

## 二、修复清单

### P0 账本可能整份丢失

- `lib/shared/usage.js`（`flushUsage` / 新增 `scheduleFlushRetry`）：临时文件原本固定为 `*.json.tmp`，两个进程或两次 flush 并发会互相覆盖、rename 到 `ENOENT`；写失败后 timer 已被清空却不再调度，磁盘瞬时故障后直到下一次记账才重试，进程退出即丢账本。现改为 `文件名.pid.时间戳.随机.tmp` 唯一临时名，成功后清零失败计数，失败则按 1.5s→60s 指数退避重试（最多 5 次）并清理残留临时文件。

### P1 会影响真实体验的问题

1. `lib/shared/net-rescue.js`（`installFetchRescue`）：幂等标记写入的是 `tag` 字符串，守卫却比较 `=== true`，于是每次安装都把已包装的 `globalThis.fetch` 再包一层，网络故障时触发嵌套直连重试、内存与请求量随安装次数放大。现改为识别「字符串或旧布尔 `true`」两种历史标记，`fetchRescueInfo()` 同时兼容旧值。
2. `lib/shared/pool.js`（`refreshPoolCredits`）：面板轮询、状态强刷、成功流后的积分采样会并发进入，同一路由重复打上游，慢的旧响应还会覆盖新余额。现按 routeKey 做 in-flight 合并（新增 `creditRefreshInFlight`，单路由拉取抽出为 `refreshOneRoute`）。
3. `lib/shared/usage.js`（`dayKey` / 新增 `stampMs`）：`Date.parse` 对不带时区的 ISO 串按宿主本地时区解释，再固定 +8h，宿主 TZ 一变日/周/月窗口与积分归属就漂移。现无时区串统一按 Asia/Shanghai 解释。
4. `lib/shared/usage.js`（`noteCreditObservation`）：原实现先把新余额写进 `snapshots` 再校验 delta，异常跳变（>10000 或脏数据）会抹掉比较基线，下一次正常下降被重复记账、`direct` 水位归零让双计防线失效。现改为：首次只建基线；上涨/重置直接换基线；异常跳变保留旧基线并标 `suspect`；只有合法下降才记账并推进快照。
5. `lib/providers/pool/index.js`（`structuredFailureKind` / 新增 `firstJsonObject`）：原实现只认整段纯 JSON，`data: {...}`、BOM、带尾部日志或超 4000 字节的错误体会解析失败，`auth` 被降级成 60 秒 transport 冷却。现从任意正文里按括号配对挖出第一个完整 JSON 对象，并支持 `error.kind/type/code`。
6. `lib/providers/pool/index.js`（`looksLikeUpstreamRejection`）：所有 503 都被归成 15 秒 upstream，过载/限流被当成「窗口拒绝」反复重撞。现 503 需正文命中容量类文案，空正文保留 upstream，其余落回 quota/transport 分支。
7. `lib/providers/pool/index.js`（`streamQuotaError`）：先判 `"choices"` 导致「HTTP 200 + choices + error」的额度错误被当正常 completion 开流。现错误字段优先，`"error":` 或 `event: error` 命中即判额度错误。
8. `lib/panel.js`（`/checkin` 路由）：exact 与 prefix 注册了同一个 path，prefix 若先命中，裸 `/checkin` 会被 slice 成空 id 直接 404，一键签到整批失效。现 prefix 改为 `HUB_CHECKIN_ROUTE + "/"`，并在 handler 里对空 id 回退到 `claimAll` 一键签到。

### P2 稳定性与可观测性

9. `lib/shared/node.js`（`writeState`）：直接覆盖目标文件，面板/shim 并发读会解析到半截 JSON；现改为同目录 `pid.tmp` + `renameSync` 原子替换。
10. `lib/channel-registry.js`（`writeRegistry`）：临时文件名固定，两个并发 `/auth` 会 `ENOENT` 或互相覆盖，可能静默丢渠道；现临时名带 pid + 时间戳 + 随机串。
11. `lib/shared/pool.js`（`unregisterPoolRoute`）：注销只清 credits/breakers，残留 latch 与 `creditSampleAt` 会让 `pool.latches` 永久暴露已下线路由；现已一并清理。
12. `lib/providers/pool/index.js`（probe 超时）：`reader.cancel()` 返回 Promise，同步 `try/catch` 捕不到 rejection；现显式 `.catch(() => {})`。
13. `lib/providers/pool/index.js`（非 2xx 兜底）：`failures.push` 漏写 `kind`，`routes` 与 `pool-exhausted` 日志里 quota/transport 混在一起；现已补齐。

### P3 精度与客户端

14. `lib/shared/usage.js`（`round`）：`Math.round(value * scale)` 在 1.005 这类半分边界受二进制误差影响，改用十进制位移法。
15. `lib/client.js`（`useUsage`）：补 in-flight 去重（慢接口不再叠请求）、`finally` 复位、`visibilitychange` 恢复即刷新与监听清理。
16. `lib/client.js`（`load` / `post`）：强制刷新不再被在飞请求静默吞掉（`forcePending` 排队补一次）；`post()` 加 `AbortController` + 12 秒超时；状态文档校验拒绝数组载荷（`Array.isArray` 曾让 `[]` 被当成功文档）。

## 三、新增回归闸门

`scripts/check-hardening.mjs`（已接入 `npm run check`）覆盖此前完全没人拦的三类问题：

- fetch 兜底的重复安装是空操作、诊断 tag 正确、成功路径不被改写（真实 import 运行，不是字符串匹配）；
- `lib/client.js` 的 classic-script 契约：任何顶层 `import`/`export` 直接失败，并校验 `window.__ModuleLoader__.load({`、`factory: (require) => {` 等注册锚点；
- 本轮修复的落盘 / 并发 / 路由锚点（账本重试、时区解析、异常跳变、in-flight 合并、原子写、签到路由等）防止回退。

## 四、生效方式

主源码 `lib/client.js` 与 `lib/panel.js` 由宿主在启动时加载，改动需**重启 DSH**（或重载插件）后才在界面生效；Node 侧（`lib/shared/*`、`lib/providers/*`）同样在进程启动时装配。仅刷新页面不足以加载新 bundle。

## 五、后续可选（未做，避免超出本次范围）

- `usageDocument()` 每次刷新都全量导入并遍历全部历史日，长跑后 CPU/内存线性增长；建议改为增量导入 + 归档保留期。
- `createUsageTap()` 每块重扫 16KB 重叠 tail，且按 `"usage"` 字面匹配（模型正文里的伪 usage 会被记账）；建议按 SSE `data:` 帧解析。
- `lib/client.js` 里仍有若干裸 `setTimeout`（OAuth 轮询三连发、签到后延迟重载）没有卸载清理，建议统一抽 `later()` 收集 timer。