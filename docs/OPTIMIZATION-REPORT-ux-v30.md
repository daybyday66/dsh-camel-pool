# 优化报告 ux-v30（2026-11-20）

> 本报告是事后补写的——ux-v30 当时只写进了 CHANGELOG，没有单独报告。
> 内容与 CHANGELOG「内核 ux-v30」一节一致，不新增事实。

DeepSeek V4.1 Flash 对 ux-v29 的逐行审计后打的补丁，四条问题经本机逐项核对全部属实，
另加一处误导性别名。

## 四补丁

- **折叠按钮进去出不来**（`lib/client.js`）：`hiddenRouteCount` 改成与
  `showAllRoutes` 无关的常量。展开后它变 0，按钮直接消失，只能刷新面板。
- **`route.models()` 调 3 次变 1 次**（`lib/shared/pool.js`）：主循环那次的结果
  存进 `diagRawIds`，诊断段复用，不再另调两次。
- **注销清诊断**（`lib/shared/pool.js`）：`unregisterPoolRoute()` 补
  `routeDiagnostics.delete(key)`，长跑不再留幽灵条目。
- **死代码收尾**：删掉 `.dcp-gq-grid` / `.dcp-gq-box` 两条 CSS；两处 Gemini
  登录报错不再指向已删的 `scripts/gemini-oauth-login.mjs`。
- **误导性别名**：删掉 `ID_ALIASES` 里 `deepseek-v4-flash-official → deepseek-v4-flash`
  这一行。`deepseek-v4-flash` 本身不在白名单里，official id 靠 `curatedKeyOf`
  从 candidate.id 就能进库，alias 纯属多余，行为无变化。
  - `dfmodel → deepseek-v4-flash` 仍指向同一个不在白名单的目标，没敢直接改指
    `deepseek-v4.1-flash`，没有证据证明 Qoder 的 DeepSeek-Flash 就是 v4.1 那档。

## 遗留（ux-v30 引入，后由 ux-v31 修）

ux-v30 把诊断计算搬进主循环时，在 `try/catch` 之外直接 `models.filter()`，
一条路由回 `Set` / 字符串就打穿整池——这个 P0 回归由 ux-v31 修掉，见
`docs/OPTIMIZATION-REPORT-ux-v31.md`。
