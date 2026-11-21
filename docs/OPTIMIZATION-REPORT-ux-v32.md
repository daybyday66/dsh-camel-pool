# 优化报告 ux-v32（2026-11-20）

DeepSeek V4.1 Flash 对 v1.0.5（ux-v31）的第三轮复审：五组修复全部真的落地了，
且它承认拒绝其 `ratesUserId` 判据是对的（tick 返回形状与三选一判据完全对得上）。
但还有 1 条 P1 只修了半边、1 条 P1 被 ux-v31 的改动放大、1 条 P0 残留。本版全部修掉。

## P1-1：七牛首屏可见只修了路由行，顶部总额还在说「不可用 / 正在探测」

`emptyCredits` 是 ux-v29 就有的旧逻辑（不是本次回归）：只剩 synthetic 路由时
`total` 恒为 0、`accounts` 恒为空，旧条件把它判成空，于是顶部大数字渲染
`t('unavailable')`、副标题渲染 `t('probing')`，和路由行上的「不限额」自相矛盾。
ux-v31 把七牛行放进首屏后，它第一次真的被用户看见了。修复：`emptyCredits`
加 `hasSynthetic` 旁路；只剩 synthetic 且总额为 0 时顶部直接显示「不限额」。

## P1-2：七牛无条件注册，没配 key 的机器会看到一条永远 401 的「不限额」路由

`apply()` 里无条件 `registerPoolRoute(qiniuRoute(...))`，而 `qiniuRoute().credits()`
不看 key，永远回 synthetic ok。没配 key 的机器上两个模型照样进库、照样可选、
路由行带绿标看着健康，实际每次请求都是空 Bearer。ux-v31 之前这条被路由折叠挡住，
看不见也就不会去点；ux-v31 修完首屏可见之后，坑被放到明面上了。修复分两层：

1. 注册移到 `start()` 里，先读一次 key（reader 自带 60 秒缓存），空或抛错都跳过，
   配好后重启 DSH 即可；release 进 `disposers`，随热重载回收。
2. 纵深防御：`qiniuRoute().credits()` 先 `await readKey()`，没 key 就抛错，
   `refreshOneRoute` 会记 error + signedOut（旧数据可保留时记 stale + error），
   面板上是报错不是绿标健康。key 在启动后被删掉也一样。

## P0 残留：归一化过程本身仍能打穿 status

ux-v31 的 `try` 只兜住了 `route.models()` 调用，`[...models]` 展开在 try 之外：
迭代器中途抛错、立即抛错、`Symbol.iterator` 的 getter 抛错，三种都打穿
`mergedModelGroups()` / `poolStatusDocument()`。v1.0.3 同位置也是这个行为，
不算回归，但注释写着「先把返回值归一化成数组」，读代码的人会以为这段已经安全了。
修复：展开和调用一起包进同一个 try，抛错就整条路由当空模型处理。

## 小尾巴

- `routesSecEmpty`：一条路由都没有时旧版永远显示「加载中」，现改成「暂无路由」
 （中英双语文案 `noRoutes`）。
- `hiddenModelCount` 进了 status 但面板仍不展示，只消费 `row.modelCount`——诊断字段，可接受。
- `docs/` 现在有 ux-v29 / ux-v30 / ux-v31 / ux-v32 四份报告，ux-v30 是本轮事后补写的。
- `dfmodel` 仍是死 alias，已知未决，未动。
- 仍无真机联调：12s 探测、熔断三选一、七牛首屏这三条目前只有静态断言和构造探针，
  没挂真 Trae 号跑过 402/429 切换。
