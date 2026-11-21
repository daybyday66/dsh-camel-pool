# 优化报告 ux-v29（2026-11-20）

## 用户反馈的三个症状与根因

1. **路由莫名其妙掉了**
   - Trae SOLO 兜底名单 / 快照里的 `DeepSeek-V4-Flash-Official`、`DeepSeek-V4-Pro-Official`、`MiniMax-M3` 不在白名单里，`mergedModelGroups()` 静默过滤，池里直接消失，无任何报错。
   - `trae2` 读 `trae-cn/models-<id>.json`，导出脚本只写 `trae-cn/models.json`，旧路径永远不存在，trae2 只能读 5 条兜底模型。
   - Trae agent 槽位冷启动首字节经常超过 6s，旧逻辑记一次 transport 熔断 60s。
   - 一次 auth 失败记 10 分钟冷却，重新登录后也不清，刚登好的号继续「掉线」10 分钟。
2. **调用模型容易报错**
   - 上述熔断/冷却叠加后，`orderedRoutesFor()` 返回空，池回 402 `pool_exhausted`，面板上看起来像「所有渠道同时挂了」；实际上很多时候只是单条路由被冷却，且没有任何一条路由在状态文档里说明自己被白名单丢了哪些 id。
   - 修复：Trae 探测放宽到 12s、登录/续期成功清熔断、状态文档透出 `modelCount` / `rawModelCount` / `droppedModels`。
3. **DSH 里界面冗杂**
   - 面板第一屏有 9-10 条路由行 + 全部套餐明细；`doc.geminiQuota` 自 ux-v22 起已不再下发，但客户端还留着整块 Gemini 限额代码（恒为 null）。
   - 修复：路由默认只显示有余额 / 报错 / 过期 / 熔断的，其余折叠到「显示全部路由」；套餐 `hideZero` 默认开；删掉 Gemini 死代码。

## 改动清单

见 CHANGELOG.md「内核 ux-v29」一节。核心文件：`lib/shared/pool.js`（白名单 +26、诊断）、`lib/providers/pool/index.js`（探测 12s、patch ux-v29）、`lib/providers/trae/index.js`（登录/续期清熔断）、`lib/index.js`（trae2 目录）、`lib/client.js`（降噪、删 Gemini 死代码）、`package.json`（1.0.3、files 排除 probe 脚本）、`scripts/check-all.mjs` / `scripts/check-pool-core.mjs`（新增回归断言）、`README.md` / `CHANGELOG.md`（过期数字与绝对路径清理）。

## 云端验证（已做 / 未做）

- 已做：`npm run check` 全绿（check-all / check-imports / check-pool-core / check-hardening / check-qoder-vault），含 ux-v29 新增断言；池内核模拟宿主验证（假路由注册 Trae/WorkBuddy/CodeArts，`deepseek-v4-flash-official` 进库、诊断字段透出、排序正常）。
- 未做：DSH 真机联调。原因有二：
  1. 云端没有用户的真实凭据（Trae 桌面端登录态、WorkBuddy/Qoder/CodeArts 账号都在用户 Windows 本机），装上 DSH 也只能看到 signed-out / 0 额度，测不到真实路由。
  2. 本次尝试在云端装 DSH 时，子代理在加载插件这一步被系统安全检查拦停（提示该内容不可信、不得运行/安装/加载），已按拦停停止，未做启动与端点实测；另 `npx @deepseek-ai/dsh` 首次因 `/tmp` 512M tmpfs 写满（ENOSPC）失败，registry 查询到的 DSH 版本为 `0.2.2-rc.5`，Node v24.22.1 / npm 10.9.4 满足插件 engines 要求。
- 结论：云端完整复现目前做不到，也不应在没有用户明确授权的情况下绕过那次拦停去加载插件。真机验证请在用户 Windows 本机按下面步骤做。

## 本机上线步骤（Windows）

1. 备份现有插件目录与 `~/.dsh/connect-channels.json`、`connect-auth/`。
2. 用优化版 zip 覆盖插件目录，重启 DSH（或重装 bundle）。
3. `GET /plugins/dsh-pool/status` 应返回 `patch: "ux-v31"`（ux-v29 时为 ux-v29，见后续报告）、`models` 26 条（白名单数）。
4. 若某条路由仍不显示：看该路由的 `modelCount` / `rawModelCount` / `droppedModels`，再看 `pool.broken`；Trae 点渠道行上的「续期」「登录」。
5. 回滚：还原备份目录并重启 DSH；池内核状态与用量账本在 `~/.dsh` 下，不随插件覆盖丢失。

## 已知未修

- Trae shim 启动失败时（`shim.ready` reject），adapter 与池路由仍不会注册，只会记一条日志；这次没做 shim 重试重构，风险大于收益，留待后续。
- `lib/providers/gemini/**` 本体仍保留（`verify-uxv10.mjs` 仍在用），只是不再注册、不再进池、不再在面板渲染。
- `net-rescue` 的全局 fetch 劫持与证书类错误重试未动；`lib/client.js` 仍是单文件 6,554 行，未拆分。
