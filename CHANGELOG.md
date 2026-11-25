# 更新记录

本文件记录池内核与面板的行为变更。`patch` 字段（`GET /plugins/dsh-pool/status` 的
`patch`）就是这里的版本号——面板页脚会把它显示成「内核标记」，两者逐字对应。

## 内核 ux-v49：均衡报告只呈现可均衡的档 + 补 4 条精确回归（2026-11-25）

### 症状
ux-v48 交付后 Muse 复核（逻辑层）通过，但指出四点：① 缺 ux-v48 真 bug 的精确回归断言
（3 路由档 + latch 播种在非锚点，同一轮里锚点必须仍排在 latch 前）；② 缺反向分支
（balancedTo === latch 时粘性不被跳过）；③ 缺 report 过滤：单路由档没有均衡意义，
codearts 当日桶曾因 balanceCurrent 历史残留出现在 pool.balance，被误读成均衡在它上面
生效；④ 缺孤儿指针回归（档内路由被删后 balanceCurrent 指向不存在路由）。

### 根因
- creditBalanceReport() 只遍历 balanceCurrent，不校验该 tier 当前还剩几条路由，
  也不校验 routeKey 是否还在注册表 —— 单条档与已下线路由的残留条目都会透出。
- ux-v48 的修法只被 11 条断言间接覆盖，没有一条精确复现「3 路由 + latch 非锚点」形状。

### 变更
- lib/shared/pool.js 的 creditBalanceReport()：按注册表实时统计每个 tier 的路由数，
  只呈现 ≥2 条且 routeKey 仍在注册表的档。只过滤呈现，不删 balanceCurrent 记忆 ——
  路由增删回到 ≥2 条时原来的选择照样能用，unregister 清记忆的路径不变。
- 测试 scripts/check-pool-core.mjs 新增 4 条（56 → 60，实测条数）：
  - ux-v49 3 路由档 latch 播种非锚点，均衡锚点仍排前（bug 回归）—— ux-v48 真 bug 的精确复现；
  - ux-v49 两条同档时进 report —— 过滤前置条件（≥2 条且余额已知必须呈现）；
  - ux-v49 档内只剩 1 条后从 report 过滤掉 —— 单条档不再进报告；
  - ux-v49 balancedTo===latch 时粘性正常生效 —— 反向分支不崩、首位仍是锚点。
- scripts/check-all.mjs：版本闸升 ux-v49，加 4 条 ux-v49 静态闸（report 过滤单条档 /
  孤儿指针 / 两条测试断言在位）。
- 版本 1.0.12 → 1.0.13，patch ux-v48 → ux-v49。

### 未做的（Muse 建议但本轮不动）
- 云端独立 clone 复跑 npm run check：本次 Muse 侧因执行风险检查停下，只做逻辑复核；
  本机 npm run check 全绿 + 真机切流（trae 1936 vs 3372，差 1436 > 300 切到 trae2）仍是有效证据。

## 内核 ux-v48：均衡报告覆盖全档 + 粘性不越过同档均衡锚点（2026-11-25）

### 症状
ux-v47 落地后，Muse 独立 clone 复跑 npm run check 全绿、签字通过，但指出两点：
1. `GET /plugins/dsh-pool/status` 的 `pool.balance` 只列出**换过手的档**，从未换手的档
   （例如注册序靠前那条本来就是余额最多的）从报告里消失，面板上会误以为那档没在均衡。
2. 同档有 3 条以上路由（workbuddy1..3）时，latch 会在同档非锚点路由处提前 break floor，
   插到均衡锚点前面——把刚换过去的路由又顶回身后，差值被拉回 300 内，均衡等于不生效。
   2 路由档恰好卡在锚点处 break，所以这个 bug 只在 3+ 路由档暴露。

### 根因
- `balanceCurrent` 只在真正换手（`gap > 300`）时才写，没换手的档不写入 → report 没数据。
- `applyCreditBalance` 只返回 `anchors`（routeKey 集合），latch 的 floor 扫描只知道
  「这一条是不是锚点」，不知道「latch 自己所在的档已经被均衡判定该烧别的路由了」。3 路由
  档里 floor 先扫到同档的普通路由（非锚点）就 break，于是 latch 被插到锚点之前。

### 变更
- `lib/shared/pool.js`：
  - `applyCreditBalance` 里 `current` 确定后**总是幂等写回** `balanceCurrent`（不换手也写），
    让 `creditBalanceReport()` 列出所有 ≥2 条且余额已知的档的当前首选；
  - `applyCreditBalance` 额外返回 `tiers`（tierKey → 当前首选 routeKey）；
  - `orderedRoutesFor`：latch 抬升前先查 `balance.tiers`，若本档已被均衡判定该烧别的
    路由（`balancedTo !== latch`），粘性整段跳过——本档内的先后交给均衡决定。
- 测试：`scripts/check-pool-core.mjs` 新增 11 条 ux-v48 断言（report 覆盖全档、差值恰好
  =300 不切、3 路由档换手且其余保序、expiry/priority 不同分属不同档、余额非有限整块跳过、
  latch+均衡联动切走且下一轮不切回、unregister 清记忆），check-pool-core 从 45 → 56 项（实测条数）。

### 自检
- `npm run check` 全绿：check-all / check-imports / check-pool-core(58) / check-hardening
  ALL_PASSED / check-qoder-vault(14) / check-checkin-device(12) / check-checkin-claim(28)。
- 真机：`pool.balance` 现在同时列出 trae 档（首选 trae2）与 qoder 档（首选 qoder1，未换手）。

## 内核 ux-v47：同档同类路由的 300 分滞回均衡（2026-11-25）

### 症状
排序骨架只有「到期时间 → priority → 注册序」三级，同一天到期、同 priority 的同类路由
（trae / trae2、workbuddy1..3、qoder1/qoder2）只能按注册序烧：注册序靠前的那条被一直
烧穿，另一条几乎不动。用户要的是**积分均衡**：两条余额差超过 300 分才换手，换过去后
一直烧多的一方，直到它反过来比另一方少超过 300 再切回（滞回，避免在 300 边界抖动）。

### 根因
排序里的第三级是静态注册序，没有任何按余额调度的层；latch（任务粘性）只记「上次服务
成功的是谁」，不能承担均衡。二者混在一起还会互相打架：均衡把 A 换到前面，latch 又把
刚服务过的 B 拉回来，差值永远卡在 300 内，等于没生效。

### 变更
- `lib/shared/pool.js`：
  - `CREDIT_BALANCE_GAP = 300` 与 `balanceCurrent`（tierKey → 当前燃烧目标）；
  - `balanceTierKeyOf(route, credit)` = `kind|expiryMs|priority`：只有同渠道、同到期、
    同 priority 才互相均衡，跨渠道就算到期时间撞在一起也不混算；
  - `applyCreditBalance(items)`：按档分桶，块内任一路由余额未知就整块跳过（不猜）；
    `top.remaining - current.remaining > 300` 才换手，选中的那条挪到本桶第一个槽位，
    其余保持相对序；
  - `orderedRoutesFor`：均衡在 latch 之前算；latch 命中本池 live 路由时先播种进
    `balanceCurrent`（刚服务成功的那条本身就是当前该烧的），否则下一轮均衡会把刚服务
    的路由又换掉；latch 的 floor 扫描把均衡锚点与「当日桶 / 更早到期」同级保护；
  - `unregisterPoolRoute` 清掉指向已注销路由的均衡记忆；`poolStatusDocument` 增加
    `pool.balance`。
- `orderedRoutesFor` 新增选项 `balanceCredits: false`（关掉均衡，回纯注册序）。
- 测试 `scripts/check-pool-core.mjs` 增加 8 条 ux-v47 断言：同余额保持注册序、差 500
  换到多的一方、差 200 落在滞回带内不切回、反向差 400 切回、跨渠道不混算（bal-c 9000
  不抢 bal-trae 档首位）、差 3500 再切、开关可关、`pool.balance` 可查当前燃烧目标。
  原有「同档路由之间粘性仍生效」的 tie 路由改用独立 kind `fake-tie`，否则它会和
  trae(1800) 落进同一个均衡档（同 kind + 同 11-30 + 同 priority 1），断言位置被均衡正常
  改变后误报。

### 自检
- `check-pool-core` 39 → 47 项全过；`npm run check` 全绿（含 check-all 五条 ux-v47
  静态闸、check-imports、check-hardening、check-qoder-vault 14、check-checkin-device 12、
  check-checkin-claim 28）。
- 真机：重载后 `GET /plugins/dsh-pool/status` 的 `patch` 升至 ux-v47，`pool.balance`
  能读到当前燃烧目标。

## 内核 ux-v46：签到结果的 note 从服务端一路透到面板（2026-11-25）

### 症状
ux-v45 修了「claim 成功但余额接口读不到」会静默放过的问题，但补的 `note`
（「本次未校验到账」「余额未增加」）只存在于插件返回值里，**面板上永远看不到**：

- 一键签到：`lib/panel.js` 的 `normalizeClaim` 只从 `payload.message` 取文案，
  插件给的 `payload.note` 在归一化时就被丢掉，下游 `mergeClaim` 拿到的结果里根本没有 note。
- 单渠道手动点签到：`lib/client.js` 三处 `onCheckin` 成功分支（trae / workbuddy /
  qoder meta line）直接 `setClaim("done")`，不读 `body.note`。
- 顺带：`credited`（签到到账的额度增量）全仓库没有任何面板消费方，面板上连 "+100"
  都不显示——本轮先修 note 透出，credited 展示留作后续。

### 根因
服务端返回的签到结果是 `{ state, note, credited }`，面板归一化只认 `message`、
手动签到只认失败分支的 `message`，成功分支的 note 全链路没人接。

### 变更
- `lib/panel.js` `normalizeClaim`：`note` 改为 `payload.note ?? payload.message`，
  覆盖一键签到 sweep 和单渠道行内点击（都走 `mergeClaim`）两条路径。
- `lib/client.js` 三处 `onCheckin` 成功分支：读 `body.note` 进 note state，done
  态把它当 tooltip（hover 可见）。失败分支行为不变。
- 测试修复（`scripts/check-checkin-claim.mjs`）：场景 B 的 USAGE mock 之前按 deviceId
  给不同余额基数（旧号 2700 / 新号 2600），导致 `credited===100` 是「换号换基数」算出来的
  **假通过**，并不是 claim 真挣来的——而真实上游余额是账号级，x-device-id 不影响
  usage_summary。改成账号级有状态余额：只有 claim 成功才 `consumed 2700→2600`，
  `credited===100` 才真正证明「换号重试后到账了」。STATUS mock 也去掉了误导性的
  deviceId 分叉，统一返回 `checked_in:false`。
- 新增场景 F：9095 设备门和 9074 共用 `CHECKIN_DEVICE_GATE_CODES`，单独锁一条回归闸
  （撞 9095 → rotate 一次 → 成功）。`check-checkin-claim` 断言 23 → 28。

### 自检
- `npm run check` 全绿：check-all（含 ux-v46 三条静态闸）/ check-imports /
  check-pool-core（39）/ check-hardening / check-qoder-vault（14）/
  check-checkin-device（12）/ check-checkin-claim（28）。
- 真机：重载后 `GET /plugins/dsh-pool/status` 的 `patch` 升至 ux-v46。

## 内核 ux-v45：签到到账校验不再被余额接口故障静默绕过（2026-11-25）

### 症状

面板显示「签到成功」，但 Trae 余额接口（消费明细）偶发 500 / 超时，导致
claim 返回 code 0 之后 remainBefore / remainAfter 读不到。旧代码只在两个
余额都拿到时才比增量，读不到就直接放行 —— 「code 0 不等于真到账」的防线
被静默跳过，面板会把一次没核实到账的 claim 当成已到账。

### 修复

- `lib/providers/trae/index.js` 的 `claimDailyCheckin`：余额任一侧读不到时，
  不再静默，显式带 `note: "服务端返回成功，但余额接口读不到，本次未校验到账
  （code 0 不等于真到账）"`，`credited` 留空。
- 新增 `scripts/check-checkin-claim.mjs`：起本地 HTTP 服务器伪装 Trae 账号
  网关，喂脚本化响应，覆盖 23 项断言 —— 全链路用签到设备号（不是会话 deviceId）、
  9074/9095 设备门恰好触发一次 rotate 并落盘、code 0 但余额没涨标「余额未增加」、
  **余额读不到标「未校验到账」**（ux-v45 修复点）、已签过不重复 claim。
- 宿主包（@deepseek-ai/* 与 @earendil-works/*）在独立 node 下解析不到，
  脚本用 `module.register` 注册 resolve 钩子换成最小替身；CI 里能解析真实包
  时自动跳过替身。

## 内核 ux-v44：Trae 签到设备号与会话身份分离（2026-11-25）

排查「trae 调用不了」时顺带撞见的第二个 bug，与 ux-v43 的 UA 无关。

### 症状

同一台机器上两个 Trae 账号（trae / trae2）只有先签的那个号能到账。第二个号点签到，要么回 `9074 当前参与用户太多，请稍后再试`，要么回 `code 0` 但余额一分不涨；面板两种都显示「已领取」。

### 根因（2026-11-25 实测）

签到接口有两层门，`x-device-id` 都参与判定：

1. `checked_in` —— **账号级**：该号今天领没领；
2. `did_checked_in` —— **设备级**：这台设备今天签没签；
3. 每人每天封顶 100 —— 同号当天第二次领，换什么设备号都回 `code 0` 空转。

`9074` 看着像排队，实测是**发券资格层按设备判**：同一个 token 换成当天没签过的设备号，立刻 `code 0` 且 `+100` 到账（请求头、machineId、UA、Origin 都试过，都不是变量）。而凭据里的 `deviceId` 是**会话身份**、与私钥配对，动它就会把同机另一条链顶成 `20403`。所以不能拿会话 deviceId 去顶设备门。

### 变更

1. 新增 `lib/providers/trae/checkin-device.js`：`$DSH_HOME/.trae-checkin-devices.json` 台账（`{"<userId>":"<deviceId>"}`），`get` / `rotate`，tmp+rename 原子写 0600，坏文件当空表。
2. `lib/providers/trae/index.js`：新增 `CHECKIN_DEVICE_GATE_CODES = Set([9074, 9095])`；`checkinCredential()` 读状态用签到设备号；`claimDailyCheckin()` 先用签到号读状态 → 未签才 claim → 撞 9074/9095 就 `rotate` 换号重试一次 → 成功后比 `remain` 增量，`credited === 0` 时写 `note`「服务端返回成功但余额未增加：该账号今天已经领过了」，不再假报成功。
3. `lib/panel.js`：`candidatePaths` 为 `codearts` 补 `.codearts-accounts.json` / `.codearts-auth.json`。不补则 `slotConfigured` 恒为 `false` —— 渠道页看不到 codearts、一键签到永远跳过它。
4. `package.json` 1.0.10；新增 `scripts/check-checkin-device.mjs` 运行时闸并接进 `npm run check`。

### 自检

`npm run check` 全绿。`check-checkin-device.mjs` 12 项（真实 import + 临时台账）：导出面、首次 get 登记 fallback 并落盘、已有值不被覆盖、两账号隔离、rotate 换号/落盘/不动他人、不与已有号重复、连续 rotate 不重号、空 key 直通且不写表、坏台账当空表重建、无 tmp 残留、0600 权限。静态层 `check-all.mjs` 加 8 条闸。

真机：两号签到设备号分离（`1729384655102837` / `4180492747601067`），trae 签到 `checkedIn: true`、`+100` 到账、`remain 2126.48/4700`。

## 内核 ux-v43：直连通道换成非 undici 的 User-Agent（2026-11-25）

用户原话：*「为什么 trae 调用不了，限流是什么原因，之前都好好的」*。

### 症状

`.pool-route.log` 里 trae / trae2 从 2026-11-24T08:36Z 起是 **121 次尝试 / 121 次失败**，零成功；轮转前的 `.pool-route.log.1` 里最后一次成功是 2026-11-20T08:29Z（历史 674 次 served）。失败原文逐字一致：

```
trae upstream (http 502): We're sorry, your requests have exceeded the rate limit. Please wait and try again later.
```

池因此一路降级：deepseek-v4.1-flash 的尝试落在 workbuddy:workbuddy2（359 次）、codearts（356 次，几乎全失败）、trae2（78）、trae（76）。

### 根因（不是限流，不是号，不是 IP）

同一 token、同一 endpoint、同一 payload、同一台机器（出口 IP 恒 101.71.37.28），**只改 User-Agent**：

| UA | 结果 |
| --- | --- |
| `undici`（undici.fetch 默认值） | HTTP 200，但 SSE 首事件就是 `{"code":4011,"message":"...exceeded the rate limit..."}`，响应体 189B |
| （不发 UA） | 同样 4011 |
| `curl/8.4.0` / `Go-http-client/2.0` / `python-requests/2.31` | 同样 4011 |
| `node`（Node 内建 fetch 默认值） | 正常 SSE，9K~25K |
| `TraeIDE/3.4.2` / `dsh-camel-pool/1.0.9` | 正常 SSE |

交替 4 轮 undici/node 稳定复现。结论：**Trae 网关按 UA 把裸 HTTP 客户端认出来，回 4011 伪装成限流**；4011 与真正的鉴权失败（HTTP 401 `code:1001`）是两回事。插件自 2026-11-16 起在 net-rescue 里改用 `undici.fetch` 做直连（为了绕开宿主 env 代理），从那一刻起就带上了 `UA: undici`。

### 变更

1. `lib/shared/net-rescue.js`：新增 `DEFAULT_USER_AGENT`（默认 `"node"`，可用 `DSH_POOL_USER_AGENT` 覆盖）与 `withDefaultUserAgent(input, options)`。
2. `directFetch` 在「undici 分支 / 裸 node:https 分支」**分叉之前**就补默认 UA —— undici 不补会自己塞 `undici`，裸分支压根不发；补在分叉前两条走法才一致。
3. `rawDirectFetch` 内部对最终的 headers 再兜一次（`input` 自带的 headers 也算调用方给的）；**调用方显式给了 `User-Agent` 就绝不覆盖**。
4. `fetchRescueInfo()` 增加 `userAgent` 字段，状态端点能直接看到当前值。
5. `lib/providers/pool/index.js` 内核标记 `ux-v42` → `ux-v43`。

### 自检

`npm run check` 全绿。`check-all.mjs` 与 `check-hardening.mjs` 各加三条静态闸（`const DEFAULT_USER_AGENT =` 在位、`withDefaultUserAgent(input, raw)` 在 `directFetch` 分叉前、裸分支的 `user-agent` 兜底在位），版本契约改到 `ux-v43`。真机复验：不带 UA 直接 `directFetch` 打 Trae 网关连 3 轮全部正常出流；显式传 `User-Agent: undici` 仍 4011（证明不覆盖调用方值是生效的）。

## 内核 ux-v42：最早过期优先，粘性不许插队（2026-11-25）

用户原话：*「第一，本质调用路由是按过期时间；第二因为 codearts 当天过期，所以每天优先调用它；第三，消耗完 codearts 当天过期的 100 分后，就继续按积分过期时间来调用，比如这回 trae 过期时间分明就是比 workbuddy 早，但你不调用 trae 的模型，就是你的问题了」*。

### 症状

`.pool-route.log` 里 `deepseek-v4.1-flash` 的尝试分布极不均衡：workbuddy:workbuddy2 命中 359 次、codearts 356 次（后者几乎全是 `400 CodeArts 免费档同时只允许 3 个会话` 与 `华为侧共享 TPM 超限` 失败），而 11-30 到期的 trae / trae2 分别只有 76 / 78 次。总积分还能用，但快到期的额度在闲置，晚到期的额度在狂烧。

### 根因

排序内核 `routeRank` 本来就是 `[expiryMs, priority, index]`，方向是对的。问题在**粘性 latch 的让位条件太窄**：ux-v14 只让它给 `expiring > 0`（当日桶）的头部块让位，而 workbuddy2 的 `expiring` 是 undefined —— 于是 `latch = {"deepseek-v4.1-flash": "workbuddy:workbuddy2"}` 把它顶到 expiring 块之后、trae 之前；它一成功就 `setLatch` 自我续期，形成闭环。结果「最早过期优先」在排序层成立、在最终顺序上被粘性推翻。

### 变更（三个文件）

1. `lib/shared/pool.js`：新增 `function ranksBefore(a, b)`，只比 `routeRank` 的前两级（到期时间、priority），第三级注册序不参与判定——只在注册序上不同的两条路由才算「同一档」。
2. `lib/shared/pool.js` 的 latch 让位循环改为两级条件：
   `while (floor < at) { const head = ordered[floor]; const burnsToday = (credits.get(head.routeKey)?.expiring ?? 0) > 0; if (!burnsToday && !ranksBefore(head, ordered[at])) break; floor += 1; }`
   即头部路由要么「有当日桶」，要么「到期更早」，latch 都必须让位；两者都不满足才停在它后面。
3. `lib/providers/pool/index.js` 内核标记 `ux-v41` → `ux-v42`。

`burnExpiringFirst: false` 的旧行为（粘性压过一切）保持不变。

### 效果（对应三条要求）

- ① 路由本质按过期时间：`credits-first` 的第一级就是 `expiryMs`，粘性只能在同档内换先后；
- ② CodeArts 当天过期：`expiring > 0` 让它的 `expiryMs` 被拉近到当日 24:00，加上让位条件的第一条，它每天必然排最前；
- ③ 烧完当日 100 分后：`expiring` 归 0，CodeArts 退回自己的套餐期末，顺序回到纯「到期时间 → priority」，11-30 到期的 trae/trae2 自然排在 12-05 的 workbuddy2 之前。

### 自检

`npm run check` 全绿。`check-pool-core.mjs` 扩到 39 项，新增三条：⑤ 拆成「让位给当日桶」+「不得越过更早到期」；⑤b 同档粘性仍生效（同为 11-30 到期、priority 1 的 tie-a/tie-b）；⑤c 真实形状回归（trae 必须排在 wb2 之前，wb2 排在 wb1 之前）。`check-all.mjs` 加两条静态闸（`ranksBefore` 在位、让位条件含 `!burnsToday && !ranksBefore`），并把版本契约改到 `ux-v42`。

## 内核 ux-v41：续期成功的两种掉线通道（2026-11-24）

ux-v40 修好了「失败一次就判死」，但 `refresh_token` 是**一次性轮换**的 —— 拿到了新 token 却没落盘，下场和续期失败一样：旧的那枚已作废，之后每次续期都是 `invalid_grant`，整个 family 判死。还剩两条这种通道：

1. **槽位在等 STS 响应期间被 `invalidate()`。** `reloadFromDisk()`、`setPaused()`、`setPinned()`、`upsert()` 都会调它。`AccountSlot.refresh()` 里 `if (!stillCurrent()) return next;` 把刚拿到的新凭证直接丢掉，磁盘上留着仍然是旧 token。
   - 现在改为补落盘，但带守卫：`persisterFor(id)` 增加可选参数 `expectRefreshToken`，只有文档里该账号的 `refresh_token` 仍等于本次消费的那一枚时才写。用户刚重新登录换了新链时守卫不成立，绝不覆盖。
2. **保活失败完全静默。** `startCodeartsRefresh()` 的 `aliveTick` 是 `void store.keepAlive().catch(function () {})`，`.pool-route.log` 里连一条 stale 都没有，用户说「又掉了」时只能靠猜。
   - 现在 `startCodeartsRefresh(intervalMs, keepAliveMs, logger)` 接宿主 logger，把 `{ checked, refreshed, needsLogin }` 和每个槽位最近一次的 `lastRefreshError` 写进日志；`reportAlive()` 做同文去重，避免 5 分钟一条刷屏。
   - `lib/providers/pool/index.js` 的调用改为 `startCodeartsRefresh(undefined, undefined, ctx.logger)`。

自检：`npm run check` 全绿，新增 5 条 ux-v41 回归闸（落库守卫、轮换后补落盘、`reportAlive` 在位、logger 已接、旧空 catch 必须消失）。
## 内核 ux-v40：CodeArts 续期不再「失败一次就判死」（2026-11-24）

用户反馈原话：*「我的华为的codearts号为什么总是掉，总是要重复登录」*。

华为签发的 token 固定 2 小时有效，插件已经有一套完整的保活链路：`startCodeartsRefresh()` 每 5 分钟调 `store.keepAlive()`，`REFRESH_SKEW_MS = 18e5` 提前 30 分钟续，`STALE_RETRY_MS = 3e5` 给 stale 号留 5 分钟冷却。链路本身是对的，但三个缺陷会让它在关键时刻静默失效。

### 根因

1. **续期 POST 没有超时**。`refreshToken(cfg, prev, abort)` 的 `abort` 由调用方传，而 `CodeArtsCredentialStore.refresh()` 与 `AccountSlot.refresh()` 两处都没传。`directFetch` 的 agent 只设了 `connect.timeout`，没有整体响应超时 —— STS 接了连接却不回时，那个 promise 永远不 settle，`this._inflight` 上挂的 `.finally` 永远不跑，`_inflight` 就永久占位。之后每一轮 `ensureFresh()` 都拿到同一个挂起 promise，这个号在进程存活期间**再也不会续期**，2 小时后 token 到期。表现就是「CodeArts 又掉了」，而重启 DSH 立刻好。
2. **任何失败都把 `stale = true` 落盘**。`catch { cred.stale = true; ... persist(cred) }` 不区分「上游明确拒绝」与「链路抖动」。一次 ECONNRESET、一次超时、一次本地代理半开，就把账号判成「必须重新登录」写进磁盘，之后每轮 `keepAlive` 都跳过它 —— 用户只能手动重登。
3. **先落盘再更新内存**。`await persist(next)` 抛错会直接进 catch，而 `next`（上游已经轮换出来的新 `refresh_token`）就此丢失，磁盘上留着的是刚被作废的旧那份。`refresh_token` 一次性且有 reuse 检测，之后每次续期都是 `invalid_grant`，只能重登。

现场证据：`~/.dsh/.codearts-accounts.json.bak-1794726787427`（2026-11-14 20:00）里 `stale: true`，而它的 `refreshToken` JWT 里 `counter` 已经是 **15** —— 说明自动续期正常工作了 15 次，是第 16 次失败把号写死。

### 变更（`lib/providers/codearts/vendor/auth-CF9XHMX-.mjs`）

1. 新增 `const REFRESH_TIMEOUT_MS = 25e3;`，两处 `refresh()` 都给 `refreshToken()` 传 `AbortSignal.timeout(REFRESH_TIMEOUT_MS)` —— `_inflight` 一定会在 25 秒内被清掉。
2. 新增 `refreshFailureText(error)` 与 `isDefinitiveRefreshRejection(text)`：只有 `refresh token failed: 400/401/403` 或 `invalid_grant` / `invalid_token` / `invalid_request` / `InvalidDPoPHeader` / `use_dpop_nonce` 才判「上游明确拒绝」。
3. 两处 `catch` 改为分流：明确拒绝 → 标 `stale` 并落盘（照旧）；链路问题 → 保留凭据、不标 `stale`、只记 `lastRefreshError` 与 `_refreshFailedAt`。
4. 新增 `const REFRESH_RETRY_GAP_MS = 2e4;`，`AccountSlot.forceRefresh()` 对**非 stale** 的失败留 20 秒最短重试间隔：`refresh_token` 一次性，请求停在「已送达、响应没回来」时立刻重试就是拿废 token 撞 `invalid_grant`，会把整个 token family 判死。stale 号仍走 `_retryStale()` 的 5 分钟冷却。
5. 成功分支改为**先 `this._cred = next` 再 `persist(next)`**；写盘失败只记 `lastRefreshError` 并返回 `next`，既不丢新 token 也不回头标 `stale`。
6. `AccountSlot` 新增字段 `_refreshFailedAt` 与 `lastRefreshError`。
7. `CodeArtsAccountStore.list()` 把 `slot.lastRefreshError` 合并进账号摘要（`refreshError` 字段，仅在有值时出现）。
8. `lib/providers/codearts/index.js` 的 `codeartsAuthStatus()` 把 `refreshError` 透到 `accounts[]`（截 200 字），面板能说清「这次为什么没续上」。
9. `lib/providers/pool/index.js` 内核标记升 `ux-v40`。

### 自检

- `npm run check` 全绿（check-all / check-imports / check-pool-core / check-hardening / check-qoder-vault）。
- `scripts/check-all.mjs` 追加 9 条 ux-v40 回归闸：超时常量、分类器、两处超时传入、catch 不再无条件标 stale、`_refreshFailedAt` 清空、重试间隔、`refreshError` 透出两处。
## 内核 ux-v39：Trae 多槽设备身份隔离，谁续期都不再顶掉别人（2026-11-22）

用户反馈原话：*「不管桌面端如何，反正就是能不能保证我这些路由在登录不同的两个号到插件里时间不会莫名其妙掉」*。

ux-v38 挡住了「自动 adopt 换号」，但漏了一条更隐蔽的掉线路径：**两个槽共用同一个 `deviceId`**。服务端对同一个 `DeviceID` 只保留最近一次 AuthCode 登录注册的那把公钥，实测矩阵是「特依安链 + 特依安钥 → OK；特依安链 + 桌面钥 → 20403；桌面链 + 特依安钥 → 20403；同一把钥换 deviceId → 20403」。所以 `(deviceId, 私钥)` 必须成对且唯一。

### 根因

`slotIdentity()` 旧实现里有一个「同号就复用桌面身份」的分支：本槽账号与桌面端相同时，直接返回桌面的 `deviceId` + 桌面密钥对，本意是让桌面端跟槽位共链、一起活下去。可这个槽一旦换成别的号，就变成**拿桌面的设备号给另一个账号续期** —— 两边谁先重新登录，谁就把对方判成 20403。`~/.dsh/connect-auth/trae2.json` 里 `device.deviceId` 至今仍是桌面端那把（`3119781355468217`），账号却已经是 `dd`，就是这条路径留下的现场。

更糟的是 `writeBackToDesktop()` 无条件把续期结果写回桌面 `storage.json`：独立设备的 refreshToken 被写进桌面端后，桌面端下次启动会拿它续期，而它绑的是另一个 `deviceId` —— 桌面端被投毒，槽位也保不住。

### 变更

- **`slotIdentity()` 只认本槽身份**（`lib/providers/trae/keepalive.js`）：删掉「同号复用桌面身份」分支。现在只取 `doc.device`；发现 `local.deviceId === desktop.deviceId` 就返回 `undefined`，调用方 `newDeviceId()` 造一套新的。撞车槽点一次「换号」即自愈（PKCE 登录必然生成新 `deviceId` + 新密钥对）。
- **`conflictsWithDesktop()` 抽出单一判定**（同上）：`renew` / `keyMaterial` / `status` / 池文档四处共用同一份逻辑。判不出账号归属时按撞车处理 —— 宁可停下也不乱签。
- **`keyMaterial()` 撞车拒签**（同上）：用 `doc.device` 密钥与回落桌面密钥两条分支都加撞车判定，命中则记 `deviceCollision = { deviceId, localUserId, desktopDeviceId, at }` 并返回 `undefined`。
- **`renew()` 遇撞车早退**（同上）：`code: "device-collision"`、`dead: true`、`lastAction: "device-collision"`，并置 `needsLogin`，不再发出必然 20403 的请求；`lastCollisionDeviceId` 去重，同一设备号只 warn 一次。
- **`writeBackToDesktop()` 加设备号守卫**（同上）：本槽设备号 ≠ 桌面端设备号时一律不写回，理由写明「写回会让桌面端拿到不属于它设备的 refreshToken」。这条把「续期」与「污染桌面端」彻底解耦。
- **`status()` 透出 `deviceId` / `deviceCollision`**（同上）；**池路由 `identity` 一并带出**（`lib/providers/trae/index.js`），浮层才能解释「为什么这条 Trae 需要点一次换号」。
- **池浮层「撞设备号」告警**（`lib/client.js`）：路由行在「同号」标签旁新增红标，`title` 里给设备号与可执行动作（点「换号」重登一次）。中英各补 `deviceCollision` / `deviceCollisionHint` 两键。
- **登录侧同步简化**（`lib/providers/trae/index.js`）：`slotIdentity(doc, { deviceId: desktop.deviceId })` —— 只按设备号判撞车，不再把 `userId` / `keyPair` 传进去诱导复用。
- **内核标记**：`patch` 从 `ux-v38` 升到 `ux-v39`。

### 自检

- `npm run check` 全绿（check-all / check-imports / check-pool-core / check-hardening / check-qoder-vault 14 项）。新增 10 条 ux-v39 回归闸，逐环覆盖：`slotIdentity` 撞车返回 `undefined`、`conflictsWithDesktop` 存在、`keyMaterial` 记 `deviceCollision`、`renew` 的 `code: "device-collision"`、`writeBackToDesktop` 的投毒守卫、`status()` 的 `deviceCollision`、登录侧的 `slotIdentity(doc, { deviceId: desktop.deviceId })`、池路由 `identity.deviceCollision`、前端 `r.identity.deviceCollision === true` 与 `deviceCollisionHint`。
- 隔离单测（临时脚本，已删）：造假快照（userId 999、过期假 JWT、假 refreshToken）+ 真桌面快照（userId 2539239213373945），跑 `tick()` → 返回 `code: "device-collision"`、`userId` 保持 `999` 未被覆盖、`adoptBlocked` 记录正确、连跑两轮只 warn 一次。
- 现状：`trae2.json` 的 `device.deviceId` 仍是桌面端那把，所以 ux-v39 上线后 `/plugins/dsh-trae-connect/2/keepalive` 会报 `deviceCollision: true`，浮层那一行挂红标 —— **这是预期的**：对这一行点一次「换号」即彻底分离。
## 内核 ux-v38：Trae 多槽不再被自动 adopt 成同一个号（2026-11-22）

用户反馈原话：*「我 trae 桌面平常只有一个号能登，好像登了一个号，另一个号就显示不可用了，刚刚两个号又都变成同一个号了」*。

两件事分开看：**「桌面端只能登一个号」是上游限制**（`storage.json` 里只有一个 `iCubeAuthInfo://icube.cloudide` 条目，换号就是覆盖它）；**「两个号变成同一个号」是插件的 bug** —— 桌面端一换号，所有 Trae 槽位在 30 秒内被自动 adopt 统一成桌面端那个号。

### 根因

`lib/providers/trae/keepalive.js` 的 `tick()` 判出本槽 `localStale`（token 到期，或某轮读快照失败）时，无条件调 `adopt(false)`，而 `adopt()` 唯一的守卫是 `localUserId === userId && !newerThan(...)` —— **只拦同号**。本槽是小号、桌面端是主号时 `localUserId !== userId`，守卫直接放行，整份凭据（含 userId / account）被覆盖。

比这更早的一层：`login.js` 本来就有账号守卫（`handleCallback` 里 `wantedUser !== arrivedUser` 直接作废这次登录），但前端 `loginSpec` 的 trae 分支 `postJson(path, { action: "start" })` **从来没传 `expectUserId`**，`session.userIdWanted` 永远是空 —— 守卫形同不存在。浏览器记着上一个号，用户点回原号也能登完，结果是静默覆盖另一个槽。

实证：`~/.dsh/connect-auth/trae2.json` 的 `adoptedAt: 2026-11-22T08:02:09.209Z`、`adoptedFrom: ...\Trae CN\User\globalStorage\storage.json`；而 `trae2.json.adopted-main-2026-11-22T08-01-43-694Z` 备份里 `loggedInFrom: "browser-pkce"`，说明 trae2 本来是一次独立登录（虽然服务端回的 userId 与 trae 相同）。两条路由的余额逐个相同（1965.31 / 4900）。

### 变更

- **adopt 三档语义**（`lib/providers/trae/keepalive.js`）：本槽没有账号 → 放行（唯一合理的首次导入）；同号 → 交给 `newerThan` 续期；**异号 → 拒绝**，记 `adoptBlocked: { at, localUserId, desktopUserId }` 并 warn。要换号只能由人在面板里显式发起。`noteLogin()` 与成功 adopt 各自清空 `adoptBlocked`。
- **`status()` 透出账号归属**（同上）：新增 `localUserId` / `localAccount` / `desktopUserId` / `adoptBlocked` 四个字段 —— 以前 `trae` 与 `trae2` 的 `account` 都显示「特依安」，界面上没有任何字段能证明它们是同一个号。
- **池路由上报 identity**（`lib/providers/trae/index.js`）：`credits()` 的返回值加 `identity: { userId, account }`。
- **池状态文档带出 identity**（`lib/shared/pool.js`）：`extractCredits()` 认出 `doc.identity` 对象，`creditsDoc` / `quotaDoc` 两支都带出去，`poolStatusDocument()` 写到每条路由的 `identity` 字段。**判重在界面，池内核不据此做路由决策。**
- **面板透出 userId**（`lib/panel.js`）：`normalizeChannel()` 放行 `raw.userId`；`HUB_AUTH_ROUTE` GET 的每一行加 `userId` —— 前端登录要用它当 `expectUserId`，池浮层要用它判同号。
- **前端登录带 expectUserId / 新增「换号」**（`lib/client.js`）：`loginSpec(channel, options)` 接受 `options.rebind`；trae 分支默认把 `channel.userId` 作为 `expectUserId` 传过去，`rebind === true` 时才不传。Trae 槽位行多一个「换号」按钮，`addBusy` 用 `login:` / `rebind:` 两个 key 区分。
- **账号名不再是 deviceId**（同上）：trae 的 poll 以前用 `login.deviceId` 当账号名显示，现在读 `login.result.credential.account.username`（兜底 userId）—— 以前那串数字是设备 id，两行显示同一串字看起来就像「登上了同一个号」。
- **同号告警**（同上）：池浮层算出 `sameAccountKeys`（同 kind + 同 `identity.userId` 且多余一条），命中的路由行挂红标「同号」，`title` 里写明是哪几条、userId 多少；槽位行显示 `账号名 · userId 后 6 位`。中英各补 5 个 i18n 键（`sameAccount` / `sameAccountHint` / `addRebind` / `addRebindHint` / `addKeepAccount`）。
- **样式**：`.dcp-add__slot` 加 `flex-wrap: wrap`（Trae 行三个按钮，440px 浮层里挤不开）。
- **内核标记**：`patch` 从 `ux-v36` 升到 `ux-v38`（ux-v37 是上一版池浮层「添加路由」）。

### 自检

- `npm run check` 全绿（check-all / check-imports / check-pool-core / check-hardening / check-qoder-vault）。新增 13 条 ux-v38 回归闸，逐环覆盖：`code: "other-account"` 换号保护、`adoptBlocked` 记录、`status()` 的 `localUserId` / `desktopUserId`、trae 路由的 `identity`、池文档的 `identity: credit?.identity`、面板的 `userId` 透出（两处）、前端 `expectUserId: wanted` 与 `rebind`、`sameAccountKeys` 与 `sameAccountHint`，外加一条 mustNotContain 防止「重新登录又不传 expectUserId」回潮。
- 实测两槽现状：`GET /plugins/dsh-trae-connect/status` 与 `/2/status` 的 `userId` 都是 `2539239213373945`、`account` 都是「特依安」，只有 `expiresAt` 与 `deviceId` 不同 —— 这就是事故现场。修完后 `adopt` 不会再让第三个槽变成这个号；已有的两个同号槽需要人在面板里对其中一个点「换号」重新登一次（旧数据无法自动分离，插件不猜用户想留哪个）。
## 内核 ux-v37：池浮层里直接添加路由，一键拉起浏览器登录（2026-11-22）

用户原话：*「我想要就是那种在这个界面可以有直接的按钮，不是那么复杂的还要到设置界面才能加，有 workbuddy 的，trae 的还有 qoder 和 codearts 的，还有第三方 api 导入的，点一下对应路由下的『添加路由』的按钮，就会自动跳转到浏览器的登录界面……登录之后一次性就自动导入到积分池的路由里了」*。

结论：**纯前端改动**。四家的登录端点本来就注册在每种 kind 的 `statusPath` 隔壁（workbuddy 的 `/login/start` + `/poll`、trae 的 `/login`、codearts 的 `/codearts-oauth`），前端直接打即可 —— 不新增宿主路由，所以不需要重启 DSH 就上线。

### 变更

- 池浮层「渠道路由」区标题栏右侧加「＋ 添加路由」按钮，展开后按平台分五张卡：WorkBuddy / Trae / CodeArts / Qoder / 第三方 API。
- 数据源是 `/plugins/dsh-connect/auth`（注册表 + 凭据状态的唯一真相），**不自己猜有哪些槽位**。哪些槽位现在能登录，就看它有没有出现在池路由里 —— 池路由 = 活 runtime = 登录路由存在。
- 已登录的槽位点「重新登录」，未登录的点「登录」；Qoder 没有浏览器登录，只能粘 `pt-` PAT 或从桌面 App 导入会话，卡片如实这么写；新建槽位回 `restartRequired: true` 并在界面提示重启。
- 第三方 API 复用 ux-v36 的 `kind: "custom"`（渠道 ID / 上游地址 / 请求路径 / 模型清单 / API Key 五个输入）。
- 中英各补 38 个 `add*` 文案键；新增 15 条 `.dcp-add*` 样式。

### 自检

- `npm run check` 全绿。实测四条登录路由：`POST /plugins/dsh-workbuddy-connect/1/login/start` 与 `/2/...` 都回 200 带 authUrl；`GET /plugins/dsh-trae-connect/login` 与 `/2/login` 都 200；`GET /plugins/dsh-pool/codearts-oauth` 200；qoder 走 PAT。
- `workbuddy3` 在注册表里但进程无 runtime（`/3/login/start` 回 405、`/3/status` 回 404），因此它不会出现在「添加路由」的可登录列表里 —— 与「新槽位必须重启」的结论一致。
## 内核 ux-v36：面板直接添加任意 OpenAI 兼容路由（2026-11-21）

用户提问原话：*「假如别人下载我这个插件之后，能在插件界面直接添加不同路由渠道吗，不能的话请你添加入口，我这暂时只支持 trae，workbuddy，qoder，codearts，阿里云百炼代金券，或者别的 api 路由」*。

结论：能加**同厂商多实例**（`workbuddy2` / `trae2` / `qoder3`），但**加不了任意 API 路由**——`CHANNEL_KINDS` 是闭集、`channelOf()` 对未知 kind 返回 `undefined`（于是 `allChannels()` 把它滤掉、面板连行都不显示）。本轮补的正是这条缺口，新增第 5 种 kind：`custom`。

### 变更

- **注册表**（`lib/channel-registry.js`）：`CHANNEL_KINDS` 增 `custom: { multi: true }`（故意不给 `idPattern`，id 只受 `ID_PATTERN` 约束）；新增 `normalizeCustomBaseUrl` / `normalizeCustomApiPath` / `normalizeCustomModels` / `normalizeCustomKeyHint` 四个归一化助手，`normalizeEntry` 对 custom 强制要求合法 `baseUrl`（缺则整条丢弃）并把四个字段放行——否则读回即丢；`channelOf()` 增 custom 支，输出 `localOnly: true`、空 `statusPath`/`checkinPath`、`credentialHint: connect-auth/<id>.key`；本地 `resolveDshHome()` 改成 export，让 provider 侧与面板侧用同一处路径推导。
- **面板**（`lib/panel.js`）：`authTargets()` 增 custom 支（密钥落 `connect-auth/<id>.key`）；`KIND_ADAPTERS` 显式登记 custom（不登记会借到 workbuddy 适配器去 POST 不存在的签到路由）；新增 `probeCustomChannel()` 本地合成状态（`signed-in` / `signed-out`，account 显示 `自定义 · <host>`），`probeChannel()` 首行短路——必须在 `fetchRoute` 之前，否则会请求空 `statusPath` 打到自己；`create` 分支校 `baseUrl`（400 `bad-base-url`）与 `models`（400 `empty-models`）并落四个自定义字段；凭据写入增 custom 分支，**放在 `pt-` 校验之前**，不做形状校验；`claimOne()` 对 custom 直接返回 `unsupported`（自定义路由没有签到）。
- **池路由**（新增 `lib/providers/pool/custom-routes.js`）：`createCustomRoute()` 把一条注册表条目变成池路由（`key`/`providerId`/`channelId` 都是条目 id、`chatUrl() = baseUrl + apiPath`、`token()` 走三级读取、`models()` 按条目里的 id 列表原样输出、`hidden()` 接 `disabledChannels`/`disabledModels`）；`registerCustomRoutes()` 在 `start()` 里逐条试读 key，读不到就跳过并 warn；`refreshCustomModels()` 实现面板的「更新模型」（GET `<baseUrl>/models` → `normalizeCustomModels` → 写回注册表，幂等不重复写盘）。**刻意不声明 `credits()`**：上游没有余额接口时不编假 0。
- **白名单旁路**（`lib/shared/pool.js`）：`mergedModelGroups()` 的丢弃点原本是 `if (!c) continue;`，会让自定义模型**全部静默消失**（自定义 id 当然不在 `CURATED_MODELS` 里）。改成：本组含 `kind: "custom"` 的候选时补一条合成 curated 条目（`tier: 5`、`index: group.order`、`synthetic: true`）并继续——比较器会读 `pa.c.tier`，没有合成条目会抛；**不改写 `group.poolId`**（改写会让请求打到不存在的模型名）。
- **挂载**（`lib/providers/pool/index.js`）：`start()` 里七牛之后、`createPoolAdapter` 之前调用 `registerCustomRoutes()`，release 推进 `disposers` 随热重载回收；整段包 try/catch —— 自定义路由出错不连累内置渠道。
- **刷新模型**（`lib/index.js`）：`refreshChannel()` 在「暂不支持更新」兜底之前加 custom 支，转调 `refreshCustomModels()`。
- **前端**（`lib/client.js`）：添加表单的类型下拉加第 4 项；custom 时展开「上游地址 / 请求路径 / 模型清单」三输入 + 一行说明；提交按钮的禁用条件抽成 `customFormBlocked`（custom 必须填 `baseUrl` 与 `models`）；中英各补 9 个 i18n 键。
- **内核标记**：`patch` 从 `ux-v33` 升到 `ux-v36`。

### 自检

- `npm run check` 全绿（check-all / check-imports / check-pool-core / check-hardening / check-qoder-vault），含本轮新增的 12 条 ux-v36 回归闸：注册表认 custom、baseUrl 归一化在位、缺 baseUrl 丢弃、`channelOf` 有 custom 支、探活走本地合成、`createCustomRoute` 在位、`refreshCustomModels` 在位、`start()` 真调用装载、release 回收、白名单旁路与合成 curated 条目——少任何一环都表现为「表单能填、模型不出现」。
- 端到端冒烟（临时 `DSH_HOME` + 手写注册表，跑完即删）：`chatUrl` / `token` / `models` 全部符合预期；**白名单旁路实证**——`gpt-4o-mini`、`deepseek-chat` 这两个不在 `CURATED_MODELS` 的 id 都出现在了 `mergedModelGroups()` 里，`orderedRoutesFor('gpt-4o-mini')` 能选到这条路由，`release()` 后分组干净消失。
- 「更新模型」用本地假上游验证：无 key → 提示先粘贴；有 key → `added: ["local-b", "local-c"], count: 3` 并真写回注册表；再点一次 `added: []`（幂等不重复写盘）；错 key → `上游 ... 回 HTTP 401（该线路可能没有 /models，模型清单可以手填）`。
- 隐藏链路验证：`disabledChannels: ["local"]` → 分组为 `[]`；`disabledModels: ["local/local-b"]` → `hidden()` 返回 `["local-b"]`、分组只剩 `local-a` / `local-c`。
- 仍无真机渲染截图：面板表单的实际观感需在本机 DSH 里看一眼。

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
