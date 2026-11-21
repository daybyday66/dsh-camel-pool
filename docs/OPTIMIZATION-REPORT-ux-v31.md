# 优化报告 ux-v31（2026-11-20）

DeepSeek V4.1 Flash 对 v1.0.4（ux-v30）的第二轮复审，结论：四补丁全打对，
但 ux-v30 引入一个 P0 回归；ux-v29 的「活路由看不见」只修了半边。本版全部修掉。

## P0 回归：脏路由打挂整个 status

ux-v30 把诊断计算搬进主循环，却在 `try/catch` 之外直接 `models.filter()`。
`registerPoolRoute` 只校验 `typeof route.models === "function"`，不校验返回值，
一条路由回 `Set` / 字符串就 `TypeError`，打穿 `mergedModelGroups()` 与
`poolStatusDocument()`（status 500、面板全空）。旧版靠 `for...of` 天然宽容，
这是容错退化。修复：返回值先归一化成数组（数组原样、可迭代展开、字符串与
普通对象当空），再算诊断与分组；`rawModelCount` 改成归一化后的长度（`Set` 没有
`length`，旧写法会记成 0）。

## 活路由看不见（补齐另一半）

- 七牛：`syntheticBalance` 路由的 `remaining` 被主动置 `undefined`（1e12 是排序
  占位，不进进度条与总额），折叠谓词只认 `remaining > 0`，于是 `priority: -1`、
  每天 00:00 重置、最该优先烧的那条路由首屏看不见。谓词补 `syntheticBalance === true`，
  行上挂 `unlimitedQuota`（「不限额」）标签，不再只显示「余 —」。
- 账号区死锁：`hideZero` 默认开、所有套餐归零时 `positiveCount === 0`，
  旧条件 `accounts.length > positiveCount && positiveCount > 0` 让「全部套餐」
  按钮消失，用户在任何交互下都切不回全量，只能等余额回来。去掉后半条即可，
  外层已保证 `accounts.length > 0`。

## Trae 每 30 秒无条件清熔断

`refresh()` 由 30 秒巡检驱动，`store.resolve()` 只要本地 token 能解就成功，
于是 auth 的 10 分钟冷却对 Trae 形同虚设。修复：只在凭据真变时清——
`keepalive.tick()` 的返回值（`renewed` / `adopted`）或 token 指纹（内存内哈希，
不存 token、不记日志）变了才清。注意审计建议的「只看 `ratesUserId` 变了才清」
不够：同一账号续期 / 重登时 userId 不变，那样会把 ux-v29 修的「刚登好还掉线
10 分钟」又带回来，所以指纹与 tick 结果都要判。

## 其余

- `hiddenModelCount` 不再是死字段：`poolStatusDocument` 的路由条目补上它，
  README 字段表同步。
- `droppedModels` 上限 8 条、非数组 `models()`、hidden 计数三项都补了运行时断言。
- 文档：README 标题与字段表、ux-v29 报告里过期的 patch 号已同步到 ux-v31；
  v27/v28 仍无条目——不补编，只承认缺口。
- `dfmodel` 仍是死 alias（目标 id 不在白名单），已知未决，未动。
