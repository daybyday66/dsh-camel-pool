/**
 * dsh-connect —— 浏览器侧（**由生成器合成，不要手改**）。
 *
 * 生成器：plugins/history/compose-dsh-connect-client-20260924.py
 *
 * 为什么是生成而不是手写：DSH 的客户端模块系统「一个包 = 一个客户端入口」
 * （`exports["./client"]`，行 id = 包名，见 dsh-client-modules 的 clientExportOf），
 * 所以四个渠道的面板/信息行必须落在**同一个** `window.__ModuleLoader__.load` 里。
 * 四份代码里的 `zh`/`en`/`name`/`inject`/`S` 等同名标识符靠**独立 IIFE 作用域**隔离，
 * 而不是靠手工改名 —— 手工改名是最容易出错的一步。
 *
 * 本文件**不能出现顶层 import/export**：宿主把它原样拼进 combo bundle 用 classic
 * <script> 执行；一旦出现，整批客户端代码都会抛 SyntaxError，浏览器只会报
 * `bundle ... loaded without registering "<某个无辜插件>"`，极难定位。
 */

window.__ModuleLoader__.load({
	// 行 id 必须等于 npm 包名（dsh-client-modules 的 clientExportOf 契约，
	// 见文件头）；独立包后服务端插件 id 同为 dsh-camel-pool。
	id: "dsh-camel-pool",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");

		// ══ dsh-workbuddy-connect 的客户端半侧（原样搬入，独立作用域）══
		const workbuddyClient = (() => {
			var module = { exports: {} };
			var exports = module.exports;
			Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		
		
		
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/status-paths.ts
		/** Node-free constants and types shared by the Host and browser halves. */
		/** Plugin-owned status endpoint consumed by its browser half. */
		const WORKBUDDY_STATUS_PATH = "/plugins/dsh-workbuddy-connect/1/status";
		/**
		* Plugin-owned probe control endpoint.
		*
		* Separate from the status route because it accepts writes: the status route's
		* loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
		* not the same as authorizing a state-changing action. This route therefore
		* also requires the in-process key the browser half receives with the status
		* document.
		*/
		const WORKBUDDY_PROBE_PATH = "/plugins/dsh-workbuddy-connect/1/probe";
		/**
		* The international (WorkBuddy AI) variant's own pair of routes.
		*
		* Kept as separate constants rather than a computed suffix so both halves
		* reference literal strings: the browser bundle and the host bundle are built
		* independently, and a shared expression is one build-config drift away from
		* the desk asking a route the host never mounted.
		*/
		const WORKBUDDY_AI_STATUS_PATH = "/plugins/dsh-workbuddy-connect/2/status";
		const WORKBUDDY_AI_PROBE_PATH = "/plugins/dsh-workbuddy-connect/2/probe";
		/** [本地分支 2026-09-24] 企业版渠道（workbuddy3）的一对路由。 */
		const WORKBUDDY_3_STATUS_PATH = "/plugins/dsh-workbuddy-connect/3/status";
		const WORKBUDDY_3_PROBE_PATH = "/plugins/dsh-workbuddy-connect/3/probe";
		//#endregion
		//#region src/client/status-document.ts
		/**
		* Whether a parsed status response really is a status document.
		*
		* A 200 is not a promise about the body: it may be empty, literal `null`, a
		* non-JSON page from a proxy, or an array. Both halves of the browser plugin
		* read the same route, so both must agree on what is valid — storing an
		* unreadable value puts something in state that the next render dereferences.
		*
		* The check is deliberately limited to the discriminator (plus `error`'s
		* `message`, which the error paragraph renders): validating optional fields
		* here would reject documents the host legitimately omits fields from.
		*/
		function isWorkBuddyWebStatus(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
			const wrapped = value;
			const status = wrapped["status"];
			if (status === "signed-out" || status === "signed-in") return true;
			return status === "error" && typeof wrapped["message"] === "string";
		}
		//#endregion
		//#region src/client/WorkBuddyPluginCard.tsx
		/**
		* WorkBuddy status card, rendered on whichever settings surface the host
		* provides: dispatched directly by DSH 0.1.5's settings Plugins tab (one card
		* per variant), or mounted by the bundle configuration page DSH 0.1.6+'s
		* Plugins page renders. The component itself is surface-agnostic — its props
		* are only the injected copy and variant.
		*/
		/** [本地分支] 国区账号 1。 */
		const CN_CARD_VARIANT = {
			id: "workbuddy1",
			titleKey: "title1",
			introKey: "intro1",
			signedOutKey: "signedOutHint1",
			statusPath: WORKBUDDY_STATUS_PATH,
			probePath: WORKBUDDY_PROBE_PATH
		};
		/** [本地分支] 国区账号 2。 */
		const AI_CARD_VARIANT = {
			id: "workbuddy2",
			titleKey: "title2",
			introKey: "intro2",
			signedOutKey: "signedOutHint2",
			statusPath: WORKBUDDY_AI_STATUS_PATH,
			probePath: WORKBUDDY_AI_PROBE_PATH
		};
		/** [本地分支 2026-09-24] 国区企业版账号。 */
		const ENTERPRISE_CARD_VARIANT = {
			id: "workbuddy3",
			titleKey: "title3",
			introKey: "intro3",
			signedOutKey: "signedOutHint3",
			statusPath: WORKBUDDY_3_STATUS_PATH,
			probePath: WORKBUDDY_3_PROBE_PATH
		};
		/** Every card, in display order. */
		// [2026-11-01] 企业版（workbuddy3）用户明确「没有就不要弄到渠道中心」，
		// 不进卡片列表（session-607db76f.md:138）；常量留着只为兼容旧 slot，不渲染。
		const CARD_VARIANTS = [CN_CARD_VARIANT, AI_CARD_VARIANT];
		const POLL_INTERVAL_MS = 6e4;
		const cardStyle = {
			overflow: "hidden",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 10,
			background: "var(--dsw-alias-bg-module-platform)",
			listStyle: "none"
		};
		const headerStyle = {
			boxSizing: "border-box",
			width: "100%",
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 16,
			border: 0,
			padding: "13px 14px",
			background: "transparent",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			textAlign: "left",
			cursor: "pointer"
		};
		const headTextStyle = {
			display: "flex",
			minWidth: 0,
			flexDirection: "column",
			gap: 3
		};
		const nameStyle = {
			fontSize: 14,
			lineHeight: "20px",
			fontWeight: 600
		};
		const descriptionStyle = {
			fontSize: 13,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const chevronStyle = {
			flex: "0 0 auto",
			fontSize: 18,
			lineHeight: 1,
			transition: "transform 120ms ease"
		};
		const cardBodyStyle = {
			borderTop: "1px solid var(--dsw-alias-border-l2)",
			padding: "16px 14px 18px"
		};
		const bodyStyle = {
			margin: 0,
			fontSize: 14,
			lineHeight: "22px",
			color: "var(--dsw-alias-label-secondary)"
		};
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			flexWrap: "wrap",
			gap: 12
		};
		const statusStyle = {
			display: "flex",
			alignItems: "center",
			gap: 9,
			fontSize: 15,
			fontWeight: 500,
			color: "var(--dsw-alias-label-primary)"
		};
		const buttonStyle$1 = {
			boxSizing: "border-box",
			minHeight: 34,
			padding: "6px 14px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 18,
			background: "var(--dsw-alias-bg-layer-1)",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			fontSize: 14,
			cursor: "pointer"
		};
		const errorStyle = {
			...bodyStyle,
			color: "var(--dsw-alias-state-error-primary)"
		};
		const quotaListStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 18,
			paddingTop: 2
		};
		const quotaGroupStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 10
		};
		const quotaTitleStyle = {
			margin: 0,
			fontSize: 14,
			lineHeight: "20px",
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)"
		};
		const quotaLabelStyle = {
			display: "flex",
			justifyContent: "space-between",
			gap: 12,
			fontSize: 13,
			lineHeight: "20px",
			color: "var(--dsw-alias-label-secondary)"
		};
		const modelBadgeStyle = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			flexWrap: "wrap"
		};
		const modelOfferStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 2
		};
		const modelRateStyle = {
			fontSize: 12,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const contextPreferenceStyle = {
			display: "flex",
			alignItems: "flex-start",
			gap: 9,
			padding: "10px 12px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			color: "var(--dsw-alias-label-primary)",
			fontSize: 13,
			lineHeight: "20px"
		};
		const contextPreferenceCopyStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 2
		};
		/**
		* Left half of one merged context/visibility row: the visibility checkbox (when
		* the account has one) beside the model's name and rate. Kept as a flex span so
		* the capacity column stays flush right no matter how long the name runs.
		*/
		const contextRowMainStyle = {
			display: "flex",
			alignItems: "center",
			gap: 9,
			minWidth: 0
		};
		const modelBadgeChipStyle = {
			padding: "1px 8px",
			borderRadius: 999,
			fontSize: 11,
			lineHeight: "18px",
			background: "var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))",
			color: "var(--dsw-alias-state-success-primary, #22a06b)"
		};
		/**
		* Localize an upstream promotional badge label, with an unknown-badge fallback.
		*
		* The CN catalog spells badges in Chinese (`限时免费`, `夜间折扣`); the
		* international document's `modelPromotions` carries English (`Free now`). Both
		* are mapped so the same promotion reads consistently in either UI language,
		* and anything else passes through verbatim — an unrecognized badge is still
		* information the upstream chose to show.
		*/
		function modelBadgeLabel(badge, t) {
			if (badge === "限时免费") return t("badgeLimitedFree");
			if (badge === "夜间折扣") return t("badgeNightDiscount");
			if (badge === "Free now") return t("badgeFreeNow");
			return badge;
		}
		const progressTrackStyle = {
			height: 8,
			overflow: "hidden",
			borderRadius: 999,
			background: "var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))"
		};
		/**
		* Inline confirmation box for a paid detection. Replaces the previous
		* `window.confirm`: the decision is one line plus two buttons, and a modal
		* alert for that is heavier than the action it guards.
		*/
		const confirmBoxStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 10,
			padding: "10px 12px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-1)"
		};
		const confirmRowStyle$1 = {
			display: "flex",
			justifyContent: "flex-end",
			gap: 8
		};
		/** One probeable model's row: name on the left, state and action on the right. */
		const probeRowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 12
		};
		const probeRowEndStyle = {
			display: "inline-flex",
			alignItems: "center",
			gap: 8,
			flex: "0 0 auto"
		};
		/**
		* Tab strip for the card body. Kept visually light — a full pill would compete
		* with the section headings, and the card is already the densest surface the
		* plugin owns.
		*/
		const tabBarStyle = {
			display: "flex",
			gap: 4,
			marginTop: 4,
			borderBottom: "1px solid var(--dsw-alias-border-l2)"
		};
		const tabStyle = {
			padding: "6px 12px",
			border: 0,
			borderBottom: "2px solid transparent",
			background: "transparent",
			color: "var(--dsw-alias-label-tertiary)",
			font: "inherit",
			fontSize: 13,
			lineHeight: "20px",
			cursor: "pointer"
		};
		const tabActiveStyle = {
			borderBottom: "2px solid var(--dsw-alias-brand-primary)",
			color: "var(--dsw-alias-label-primary)",
			fontWeight: 600
		};
		const tabPanelStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 18,
			paddingTop: 16
		};
		/**
		* Primary action of the inline confirmation. Fill and text colour come from the
		* theme as a pair: `brand-primary` is a light accent here, so pairing it with a
		* hardcoded white would render white-on-white.
		*/
		const primaryButtonStyle$1 = {
			...buttonStyle$1,
			border: "1px solid var(--dsw-alias-button-primary-fill)",
			background: "var(--dsw-alias-button-primary-fill)",
			color: "var(--dsw-alias-label-primary-foreground)"
		};
		function progressFillStyle(percent) {
			return {
				width: `${Math.max(0, Math.min(100, percent))}%`,
				height: "100%",
				borderRadius: "inherit",
				background: "var(--dsw-alias-brand-primary, #1677ff)"
			};
		}
		/**
		* Status dot colour. Takes `'loading'` as well as the document's own states:
		* before the first response the card knows nothing about the account, so it must
		* not borrow the signed-out grey — that would read as "nothing is wrong, nobody
		* is signed in" when the truth is "not read yet".
		*/
		function dotStyle(status) {
			return {
				width: 9,
				height: 9,
				borderRadius: "50%",
				flex: "0 0 auto",
				background: status === "signed-in" ? "var(--dsw-alias-state-success-primary, #22a06b)" : status === "error" ? "var(--dsw-alias-state-error-primary, #d92d20)" : "var(--dsw-alias-label-dimmed, #9aa0a6)"
			};
		}
		function formatNumber(value) {
			return new Intl.NumberFormat(void 0).format(value);
		}
		function formatTime(ms) {
			return new Intl.DateTimeFormat(void 0, {
				dateStyle: "medium",
				timeStyle: "short"
			}).format(new Date(ms));
		}
		function formatCycleReset(time) {
			const parsed = Date.parse(time);
			if (!Number.isNaN(parsed)) return formatTime(parsed);
			return time;
		}
		/**
		* One billing package as a labeled progress bar.
		*
		* A package whose allowance the upstream never reported (`size` not positive)
		* has no percentage to state. It must not fall back to 100%: the plugin would be
		* claiming a full quota it knows nothing about, which is the opposite of the
		* honest "remaining N" line printed below it. Unknown size therefore renders the
		* percent slot as unknown copy and an unfilled, indeterminate track.
		*/
		function CreditBar({ label, remain, size, unlimited, t }) {
			if (unlimited === true) {
				const quotaText = t("unlimitedQuota");
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: quotaGroupStyle,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: quotaLabelStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: quotaText })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: progressTrackStyle,
							role: "progressbar",
							"aria-label": label,
							"aria-valuetext": quotaText
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: bodyStyle,
							children: quotaText
						})
					]
				});
			}
			const sizeKnown = size > 0;
			const detail = sizeKnown ? t("exactRemaining", {
				remain: formatNumber(remain),
				size: formatNumber(size)
			}) : t("creditPackageUnknownSize", { remain: formatNumber(remain) });
			const percent = sizeKnown ? remain / size * 100 : void 0;
			const display = percent === void 0 ? t("percentUnknown") : t("percentRemaining", { percent: new Intl.NumberFormat(void 0, { maximumFractionDigits: 1 }).format(percent) });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: quotaGroupStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: quotaLabelStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: display })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: progressTrackStyle,
						role: "progressbar",
						"aria-label": label,
						...percent === void 0 ? { "aria-valuetext": detail } : {
							"aria-valuemin": 0,
							"aria-valuemax": 100,
							"aria-valuenow": percent
						},
						children: percent === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: progressFillStyle(percent) })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: detail
					})
				]
			});
		}
		/**
		* One model offer row: name, promotional badges, and the billing rate.
		*
		* The rate sits under the name rather than beside it because the row already
		* spends its horizontal budget on badges; stacking keeps long model names and
		* several badges from squeezing the rate into an ellipsis.
		*/
		function ModelOfferRow({ model, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: modelOfferStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: quotaLabelStyle,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: model.name }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: modelBadgeStyle,
						children: [model.badges?.map((badge) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: modelBadgeChipStyle,
							children: modelBadgeLabel(badge, t)
						}, badge)), model.free === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: modelBadgeChipStyle,
							children: t("freeModel")
						}) : null]
					})]
				}), model.credits === void 0 ? model.rateUnknown === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: modelRateStyle,
					children: t("rateUnknown")
				}) : null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: modelRateStyle,
					children: t("rate", { rate: model.credits })
				})]
			});
		}
		/**
		* Context window and model visibility, one row per catalog model.
		*
		* The list is driven by the full current catalog, not by context metadata:
		* hiding a model is a statement about the picker, and a model without a
		* declared window is still hideable — its row just shows an em dash where the
		* capacity would be. Rows with a window keep the original ordering (largest
		* first); rows without one trail at the end in catalog order.
		*
		* Each row is one <label>, so the checkbox is named by its row without a
		* duplicated aria string. The checkbox state comes from the status document
		* only — no optimistic flip — so a save that fails leaves the box where the
		* host's truth says it is, next to the failure notice `control` records.
		* Checkboxes render only when the document carries a visibility section (a
		* signed-in account with a stable user id); a uid-less credential shows the
		* plain capacity list rather than editing a bucket every such account would
		* share.
		*
		* Purely a report of the upstream's own numbers otherwise. The plugin offers
		* no tier picker: the CN catalog declares one capacity per model and publishes
		* no alternatives, so a menu there would mean inventing client-side policy.
		* The international document does declare alternatives (`supportedLengths`),
		* and they are shown as a secondary figure rather than merged into one number —
		* the default is the budget actually requested, while the larger value is a
		* ceiling the upstream would accept.
		*/
		function ContextTable({ models, t, useMaximumContextWindow, contextPreferenceDisabled, onUseMaximumContextWindow, visibility, visibilityControlsDisabled, visibilityToggling, onVisibilityToggle }) {
			const rows = [...models ?? []].sort((a, b) => {
				if (a.contextWindow === void 0) return b.contextWindow === void 0 ? 0 : 1;
				if (b.contextWindow === void 0) return -1;
				return b.contextWindow - a.contextWindow;
			});
			const canSelectMaximum = rows.some((model) => model.maxContextWindow !== void 0 && model.maxContextWindow > (model.defaultContextWindow ?? model.contextWindow ?? 0));
			const showPreference = onUseMaximumContextWindow !== void 0 && (canSelectMaximum || useMaximumContextWindow === true);
			if (rows.length === 0 && !showPreference) return null;
			const hidden = new Set(visibility?.disabled ?? []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: quotaListStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						style: quotaTitleStyle,
						children: t("contextHeading")
					}),
					showPreference && onUseMaximumContextWindow !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: contextPreferenceStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: useMaximumContextWindow === true,
							disabled: contextPreferenceDisabled,
							onChange: (event) => {
								onUseMaximumContextWindow(event.currentTarget.checked);
							}
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: contextPreferenceCopyStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("useMaximumContextWindow") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: modelRateStyle,
								children: t("useMaximumContextWindowHint")
							})]
						})]
					}) : null,
					visibility === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: t("visibilityIntro")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: quotaGroupStyle,
						children: rows.map((model) => {
							const capacity = model.contextWindow;
							const alternative = capacity !== void 0 && model.maxContextWindow !== void 0 && model.maxContextWindow > capacity ? model.maxContextWindow : void 0;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: quotaLabelStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: contextRowMainStyle,
									children: [visibility === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: !hidden.has(model.id),
										disabled: visibilityControlsDisabled || visibilityToggling.has(model.id),
										onChange: (event) => {
											onVisibilityToggle?.(model.id, event.currentTarget.checked);
										}
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: modelOfferStyle,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											style: modelBadgeStyle,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: model.name }),
												model.badges?.map((badge) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: modelBadgeChipStyle,
													children: modelBadgeLabel(badge, t)
												}, badge)),
												model.free === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: modelBadgeChipStyle,
													children: t("freeModel")
												}) : null
											]
										}), model.credits === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: modelRateStyle,
											children: model.credits
										})]
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: modelOfferStyle,
									children: [capacity === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: modelRateStyle,
										"aria-label": t("contextUnknown"),
										children: "—"
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: { textAlign: "right" },
										children: formatTokens(capacity)
									}), alternative !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: modelRateStyle,
										children: t("contextUpTo", { size: formatTokens(alternative) })
									}) : capacity !== void 0 && model.defaultContextWindow !== void 0 && model.defaultContextWindow < capacity ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: modelRateStyle,
										children: t("contextDefault", { size: formatTokens(model.defaultContextWindow) })
									}) : null]
								})]
							}, model.id);
						})
					})
				]
			});
		}
		/**
		* Compact token count for display: the catalog's own round numbers (`200000`,
		* `1000000`) read better as `200K` / `1M`, and no precision is lost because
		* these values are always whole thousands.
		*/
		function formatTokens(tokens) {
			if (tokens >= 1e6 && tokens % 1e6 === 0) return `${tokens / 1e6}M`;
			if (tokens >= 1e3 && tokens % 1e3 === 0) return `${tokens / 1e3}K`;
			return String(tokens);
		}
		/**
		* Reasoning-effort detection section: consent switches, per-model detection,
		* and the recorded observations.
		*
		* Two deliberate UX rules from the plan (§3.1, §3.2):
		* - the confirmation is shown *before* any request, and its copy states the
		*   credit caveat;
		* - a `non-validating` result is presented as an observation about the
		*   parameter ("this model does not check it"), never as a statement that a
		*   level is unsupported.
		*/
		function ProbeSection({ probe, models, t, onDetect, onClear, busy }) {
			const [pending, setPending] = (0, react.useState)();
			const [runningModel, setRunningModel] = (0, react.useState)();
			(0, react.useEffect)(() => {
				if (pending !== void 0 && !probe.candidates.includes(pending)) setPending(void 0);
			}, [pending, probe.candidates]);
			const runningArmed = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (runningModel === void 0) return;
				if (busy || probe.running) {
					runningArmed.current = true;
					return;
				}
				if (!runningArmed.current) return;
				runningArmed.current = false;
				setRunningModel(void 0);
			}, [
				runningModel,
				busy,
				probe.running
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: quotaListStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						style: quotaTitleStyle,
						children: t("probeHeading")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: t("probeIntro")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: t("probeConsentHint")
					}),
					probe.running ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: t("probeRunningGeneric")
					}) : null,
					probe.candidates.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: t("probeResultEmpty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: quotaGroupStyle,
						children: probe.candidates.map((id) => {
							const result = probe.results.find((entry) => entry.id === id);
							const name = models?.find((model) => model.id === id)?.name ?? result?.name ?? id;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: modelOfferStyle,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: probeRowStyle,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: name }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											style: probeRowEndStyle,
											children: [result === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: modelBadgeChipStyle,
												children: result.validation === "validating" && result.efforts.length > 0 ? result.efforts.join(" / ") : t(result.validation === "non-validating" ? "probeResultNotValidating" : "probeResultUnknown")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: buttonStyle$1,
												disabled: probe.running || busy,
												onClick: () => {
													setPending(id);
												},
												children: runningModel === id ? t("probeRunning", { model: name }) : t(result === void 0 ? "probeStart" : "probeRedetect")
											})]
										})]
									}),
									result === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: modelRateStyle,
										children: t("probeResultAt", { time: formatTime(result.probedAt) })
									}),
									pending === id ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: confirmBoxStyle,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: bodyStyle,
											children: t("probeConfirmBody", { model: name })
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: confirmRowStyle$1,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: buttonStyle$1,
												onClick: () => {
													setPending(void 0);
												},
												children: t("cancel")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: primaryButtonStyle$1,
												disabled: probe.running || busy,
												onClick: () => {
													setRunningModel(id);
													setPending(void 0);
													onDetect(id);
												},
												children: t("probeConfirmAction")
											})]
										})]
									}) : null
								]
							}, id);
						})
					}),
					probe.results.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: buttonStyle$1,
						disabled: busy,
						onClick: () => {
							onClear();
						},
						children: t("probeClear")
					})
				]
			});
		}
		/** Render WorkBuddy sign-in state and credit as one expandable card. */
		function WorkBuddyPluginCard({ t, variant = CN_CARD_VARIANT }) {
			if (t === void 0) throw new Error("WorkBuddy plugin card requires its translation function");
			const [open, setOpen] = (0, react.useState)(false);
			/**
			* The document to render. `undefined` means *not read yet*, which is a
			* distinct state from "signed out": seeding this with a signed-out document
			* told an already-signed-in user they were signed out for the whole first
			* round trip (and forever, if the read never settled).
			*/
			const [status, setStatus] = (0, react.useState)();
			/**
			* Whether the last **successful** read found a usable credential.
			*
			* Kept apart from `status` because the poll's liveness must depend on what the
			* account actually is, not on what the card last displayed: a failed read
			* leaves this untouched, so a transient failure cannot disarm the interval,
			* while a genuine signed-out answer still stops it.
			*
			* `undefined` therefore means "no successful read yet", which is also the
			* condition that decides whether a failed read has anything to preserve.
			*/
			const [signedIn, setSignedIn] = (0, react.useState)();
			/**
			* Why the most recent read failed, when it did. Rendered as a notice beside
			* whatever document is still on screen, rather than replacing it.
			*/
			const [readFailure, setReadFailure] = (0, react.useState)();
			const [busy, setBusy] = (0, react.useState)(false);
			/**
			* The model ids whose visibility writes are in flight, empty when none are.
			* Deliberately NOT the card-wide `busy` (that flag drives the Refresh
			* buttons' labels, which must not claim a refresh the user never pressed)
			* and deliberately per-row rather than whole-list: a visibility write only
			* adds or removes one model's id, so the rows are independent — locking
			* every checkbox for one row's write made the whole list visibly blink for
			* no correctness gain. A set, because two writes can be open at once when
			* the user moves down the list; only the rows being written lock.
			*/
			const [togglingModels, setTogglingModels] = (0, react.useState)(() => /* @__PURE__ */ new Set());
			const [tab, setTab] = (0, react.useState)("status");
			const mounted = (0, react.useRef)(true);
			/**
			* Identity of the newest read that may write. Assigned when a read *starts*,
			* so a response is superseded by anything begun after it — "the response whose
			* request started last wins". Without this, a slow poll begun before a manual
			* action could settle after the action's own refresh and restore the older
			* document.
			*/
			const readSeq = (0, react.useRef)(0);
			/** Manual requests in flight, so unmount can abort them like the poll's. */
			const manualControllers = (0, react.useRef)(/* @__PURE__ */ new Set());
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
					for (const controller of manualControllers.current) controller.abort();
					manualControllers.current.clear();
				};
			}, []);
			/** Register a manual request's controller so unmount aborts it. */
			const trackController = (0, react.useCallback)(() => {
				const controller = new AbortController();
				manualControllers.current.add(controller);
				return controller;
			}, []);
			/**
			* Read the status document and apply it under the two policies the card's
			* correctness rests on:
			*
			* - a non-document body (empty, `null`, a non-JSON page) is a failed read, not
			*   something to store and then dereference in the render;
			* - a failed read never discards a document already on screen. It is recorded
			*   and shown as a notice beside that document; only when nothing has been
			*   read yet does the failure itself become the rendered state.
			*
			* Returns whether this read produced the current document.
			*/
			const refresh = (0, react.useCallback)(async (signal) => {
				const seq = ++readSeq.current;
				const current = () => mounted.current && signal?.aborted !== true && seq === readSeq.current;
				try {
					const response = await fetch(variant.statusPath, {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...signal === void 0 ? {} : { signal }
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					if (!isWorkBuddyWebStatus(value)) throw new Error(t("statusResponseInvalid"));
					if (!current()) return false;
					setStatus(value);
					if (value.status === "signed-in") setSignedIn(true);
					else if (value.status === "signed-out") setSignedIn(false);
					setReadFailure(void 0);
					return true;
				} catch (error) {
					const message = error instanceof Error ? error.message : t("requestFailed");
					if (current()) {
						setReadFailure(message);
						setStatus((previous) => previous === void 0 ? {
							status: "error",
							message
						} : previous);
					}
					return false;
				}
			}, [t, variant.statusPath]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const controller = new AbortController();
				refresh(controller.signal);
				return () => {
					controller.abort();
				};
			}, [open, refresh]);
			(0, react.useEffect)(() => {
				if (!open || signedIn === false) return;
				const controller = new AbortController();
				const timer = window.setInterval(() => {
					refresh(controller.signal);
				}, POLL_INTERVAL_MS);
				return () => {
					window.clearInterval(timer);
					controller.abort();
				};
			}, [
				open,
				refresh,
				signedIn
			]);
			const manualRefresh = async () => {
				setBusy(true);
				const controller = trackController();
				try {
					await refresh(controller.signal);
				} finally {
					manualControllers.current.delete(controller);
					if (mounted.current) setBusy(false);
				}
			};
			/**
			* Ask the host to re-read the credential and re-fetch this variant's catalog.
			*
			* Shares the probe route's key and guards: it is a write that spends an
			* upstream request, so it does not belong on the read-only status GET. A
			* failure is surfaced through the refreshed document's `catalog.error` rather
			* than thrown away, so the reason survives the round trip.
			*/
			const refreshModels = (0, react.useCallback)(async () => {
				const key = status?.status === "signed-in" ? status.probeKey : void 0;
				if (key === void 0) return;
				setBusy(true);
				const controller = trackController();
				try {
					const response = await fetch(variant.probePath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-WorkBuddy-Probe-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify({ action: "refresh" })
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setReadFailure(error instanceof Error ? error.message : t("requestFailed"));
					manualControllers.current.delete(controller);
					return;
				} finally {
					if (mounted.current) setBusy(false);
				}
				try {
					await refresh(controller.signal);
				} finally {
					manualControllers.current.delete(controller);
				}
			}, [
				refresh,
				status,
				t,
				trackController,
				variant.probePath
			]);
			/**
			* Run one control action and refresh the card's state afterwards.
			*
			* The key travels in a header, not the body: it authorizes the write, and
			* the host never accepts a prompt, a sentinel, or a model outside its own
			* catalog from here.
			*/
			const control = (0, react.useCallback)(async (action) => {
				const key = status?.status === "signed-in" ? status.probeKey : void 0;
				if (key === void 0) return;
				const visibility = action.action === "set-model-visibility";
				if (visibility) setTogglingModels((previous) => new Set(previous).add(action.model));
				else setBusy(true);
				const controller = trackController();
				try {
					const response = await fetch(variant.probePath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Workbuddy-Probe-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify(action)
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) {
						const message = typeof value === "object" && value !== null && "error" in value ? String(value["error"]) : `HTTP ${response.status}`;
						throw new Error(message);
					}
					if ((action.action === "set-maximum-context-window" || action.action === "set-model-visibility") && (typeof value !== "object" || value === null || value["state"] !== "updated")) {
						const state = typeof value === "object" && value !== null ? value["state"] : void 0;
						if (action.action === "set-model-visibility" && state === "stale-account") {
							await refresh(controller.signal);
							throw new Error(t("visibilityStaleAccount"));
						}
						const reason = typeof value === "object" && value !== null && "reason" in value ? String(value["reason"]) : t("requestFailed");
						throw new Error(reason);
					}
					await refresh(controller.signal);
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setReadFailure(error instanceof Error ? error.message : t("requestFailed"));
				} finally {
					manualControllers.current.delete(controller);
					if (!mounted.current) return;
					if (visibility) setTogglingModels((previous) => {
						const next = new Set(previous);
						next.delete(action.model);
						return next;
					});
					else setBusy(false);
				}
			}, [
				refresh,
				status,
				t,
				trackController,
				variant.probePath
			]);
			/**
			* Start a detection. Confirmation happens inline in the section, so this is
			* only ever called after the user has already agreed.
			*/
			const confirmDetect = (0, react.useCallback)((modelId) => {
				control({
					action: "probe",
					model: modelId
				});
			}, [control]);
			const title = t(variant.titleKey);
			const label = status === void 0 ? t("loading") : status.status === "signed-in" ? status.nickname === void 0 ? t("signedInAs", { nickname: "" }).trimEnd().replace(/[:：]$/, "") : t("signedInAs", { nickname: status.nickname }) : status.status === "error" ? t("requestFailed") : t("signedOut");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: "dshc-surface", style: cardStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					style: headerStyle,
					"aria-expanded": open,
					"aria-label": `${t(open ? "collapse" : "expand")}: ${title}`,
					onClick: () => {
						setOpen(!open);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: headTextStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: nameStyle,
							children: title
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: descriptionStyle,
							children: t(variant.introKey)
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						"aria-hidden": "true",
						style: {
							...chevronStyle,
							transform: open ? "rotate(180deg)" : "none"
						},
						children: "⌄"
					})]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: cardBodyStyle,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							style: quotaTitleStyle,
							children: t("accountHeading")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: rowStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: statusStyle,
								role: "status",
								"aria-busy": status === void 0,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									"aria-hidden": "true",
									style: dotStyle(status === void 0 ? "loading" : status.status)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label })]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle$1,
								disabled: busy,
								onClick: () => {
									manualRefresh();
								},
								children: busy ? t("refreshing") : t("refresh")
							})]
						}),
						readFailure === void 0 || signedIn === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: errorStyle,
							children: t("statusRefreshFailed", { message: readFailure })
						}),
						status?.status === "signed-in" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							status.expiresAt === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: bodyStyle,
								children: t("accessTokenExpires", { time: formatTime(status.expiresAt) })
							}),
							status.catalog === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: rowStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: bodyStyle,
									children: [status.catalog.source === "live" && status.catalog.fetchedAt !== void 0 ? t("catalogLive", { time: formatTime(status.catalog.fetchedAt) }) : status.catalog.source === "saved" && status.catalog.fetchedAt !== void 0 ? t("catalogSaved", { time: formatTime(status.catalog.fetchedAt) }) : t("catalogFallback"), status.catalog.appVersion === void 0 ? "" : ` · ${t("catalogAppVersion", { version: status.catalog.appVersion })}`]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: buttonStyle$1,
									disabled: busy,
									onClick: () => {
										refreshModels();
									},
									children: busy ? t("refreshingModels") : t("refreshModels")
								})]
							}),
							status.catalog?.error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: errorStyle,
								children: t("catalogError", { message: status.catalog.error })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								role: "tablist",
								style: tabBarStyle,
								children: [
									"status",
									"context",
									"details"
								].map((id) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									role: "tab",
									"aria-selected": tab === id,
									onClick: () => {
										setTab(id);
									},
									style: {
										...tabStyle,
										...tab === id ? tabActiveStyle : {}
									},
									children: t(id === "status" ? "tabStatus" : id === "context" ? "tabContext" : "tabDetails")
								}, id))
							}),
							tab === "status" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: tabPanelStyle,
								children: [
									status.credits === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: quotaListStyle,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: rowStyle,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
												style: quotaTitleStyle,
												children: t("creditsHeading")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: bodyStyle,
												children: status.credits.unlimited === true ? t("creditsTotalUnlimited") : t("creditsTotal", { total: formatNumber(status.credits.total) })
											})]
										}), status.credits.cycleResetTime === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: descriptionStyle,
											children: t("cycleResetAt", { time: formatCycleReset(status.credits.cycleResetTime) })
										})]
									}),
									status.creditsError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										style: errorStyle,
										children: t("creditsError", { message: status.creditsError })
									}),
									status.probe === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProbeSection, {
										probe: status.probe,
										models: status.models,
										t,
										busy,
										onDetect: confirmDetect,
										onClear: () => {
											control({ action: "clear" });
										}
									})
								]
							}) : tab === "context" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: tabPanelStyle,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ContextTable, {
									models: status.models,
									t,
									contextPreferenceDisabled: busy,
									/**
									 * 最大窗口偏好：**只看后端给不给这个字段**，不再按卡片 id 门控。
									 *
									 * 后端只在「国际版槽位 + 能写设置」时下发 `useMaximumContextWindow`
									 * （见 providers/workbuddy/index.js 的 maximumContextWindowField），
									 * 所以这个字段在不在，就是"该不该显示复选框"的完整答案。早先这里
									 * 额外钉了 `variant.id === AI_CARD_VARIANT.id`（= workbuddy2），
									 * 于是 workbuddy4/5 这些国际版槽位即使拿到字段也永远不显示复选框。
									 */
									...status.useMaximumContextWindow !== void 0 ? {
										useMaximumContextWindow: status.useMaximumContextWindow,
										onUseMaximumContextWindow: (enabled) => {
											control({
												action: "set-maximum-context-window",
												enabled
											});
										}
									} : {},
									visibility: status.visibility,
									visibilityControlsDisabled: busy,
									visibilityToggling: togglingModels,
									onVisibilityToggle: (modelId, visible) => {
										control({
											action: "set-model-visibility",
											model: modelId,
											visible,
											account: status.visibility?.account ?? ""
										});
									}
								})
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: tabPanelStyle,
								children: [status.credits === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: quotaListStyle,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
										style: quotaTitleStyle,
										children: t("creditsDetailHeading")
									}), status.credits.accounts.filter((account) => account.packageName === "enterprise" || account.remain > 0 || account.unlimited === true).map((account, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CreditBar, {
										label: account.packageName === "enterprise" ? t("packageEnterprise") : account.packageName,
										remain: account.remain,
										size: account.size,
										unlimited: account.unlimited,
										t
									}, `${account.packageName}-${String(index)}`))]
								}), status.models === void 0 || status.models.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: quotaListStyle,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
										style: quotaTitleStyle,
										children: t("modelsHeading")
									}), status.models.filter((model) => model.free === true || (model.badges?.length ?? 0) > 0).map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelOfferRow, {
										model,
										t
									}, model.id))]
								})]
							})
						] }) : null,
						status?.status === "signed-out" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: status.reason === void 0 ? bodyStyle : errorStyle,
							children: status.reason ?? t(variant.signedOutKey)
						}) : null,
						status?.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: errorStyle,
							children: status.message
						}) : null
					]
				}) : null]
			});
		}
		//#endregion
		/**
		* [本地补丁 2026-09-23] composer 下方的一行：渠道 / 倍率 / 积分余量 + 签到。
		*
		* 动机：这些信息原本跟在 model.name 后缀里（宿主侧 withCatalogDisplay），
		* 而 DSH 核心 composer 底部行 .uV2eYG_row 是 flex-wrap:wrap、右组
		* .uV2eYG_trailing 又是 flex:none 不可收缩 —— 长模型名会把整组挤到第二行。
		* 本地已停用那个后缀（宿主 displaySuffix 直接返回 undefined），座位只留短名，
		* 这三项改在此处渲染（conversation.composer.dock 槽）。
		*
		* 刷新策略：宿主对该状态接口不做缓存，每次请求都会实时打一次 WorkBuddy
		* 账单接口。这一行是装饰信息，所以只在挂载 / 获得焦点 / 标签页重新可见时
		* 拉，5 分钟做底，隐藏时不拉。
		*
		* 还原：从 ~/.dsh/dsh-patch-backups/ 取回 client.js.<时间戳>.orig。
		*/
		/** 装饰行的兑底刷新间隔（毫秒）：5 分钟。 */
		const META_REFRESH_MS = 3e5;
		/** 焦点/可见性抖动保护：30 秒内不重复拉。 */
		const META_MIN_GAP_MS = 3e4;
		/** 当天已签到的记忆（`${account}:${day}`）：模块级，跨重挂载保留。 */
		const checkedInByDay = /* @__PURE__ */ new Map();
		const metaLineStyle = {
			color: "var(--dsw-alias-label-tertiary)",
			textAlign: "right",
			width: "100%",
			paddingRight: "8px",
			fontSize: "12px",
			lineHeight: "18px",
			fontVariantNumeric: "tabular-nums",
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis"
		};
		const metaCheckinButtonStyle = {
			font: "inherit",
			color: "var(--dsw-alias-state-business-primary)",
			background: "0 0",
			border: "none",
			cursor: "pointer",
			padding: "0 2px"
		};
		const metaCheckinDoneStyle = {
			color: "var(--dsw-alias-state-success-primary)"
		};
		/** 本地日期串（YYYY-MM-DD），用作"今天"的键。 */
		function localDayKey() {
			const now = /* @__PURE__ */ new Date();
			return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
		}
		function WorkBuddyMetaLine({ directory, t }) {
			const subscribe = (0, react.useCallback)((listener) => directory.subscribe(listener), [directory]);
			const snapshot = (0, react.useCallback)(() => directory.getSnapshot(), [directory]);
			const selection = (0, react.useSyncExternalStore)(subscribe, snapshot, snapshot).current;
			const variant = selection == null ? void 0 : CARD_VARIANTS.find((card) => card.id === selection.provider);
			const statusPath = variant === void 0 ? void 0 : variant.statusPath;
			const [status, setStatus] = (0, react.useState)();
			const [claim, setClaim] = (0, react.useState)("idle");
			const [claimNote, setClaimNote] = (0, react.useState)();
			const loadRef = (0, react.useRef)();
			(0, react.useEffect)(() => {
				if (statusPath === void 0) return;
				let alive = true;
				let lastAt = 0;
				const controller = new AbortController();
				const load = async (force) => {
					if (!force) {
						if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
						if (Date.now() - lastAt < META_MIN_GAP_MS) return;
					}
					lastAt = Date.now();
					try {
						const response = await fetch(statusPath, {
							credentials: "same-origin",
							headers: { accept: "application/json" },
							signal: controller.signal
						});
						if (!response.ok) return;
						const value = await response.json().catch(() => void 0);
						if (alive && !controller.signal.aborted && isWorkBuddyWebStatus(value)) setStatus(value);
					} catch {
						/* 只读装饰：失败静默，绝不影响输入 */
					}
				};
				loadRef.current = load;
				const onFocus = () => {
					void load(false);
				};
				const onVisibility = () => {
					if (document.visibilityState === "visible") void load(false);
				};
				void load(true);
				const timer = window.setInterval(() => {
					void load(false);
				}, META_REFRESH_MS);
				window.addEventListener("focus", onFocus);
				document.addEventListener("visibilitychange", onVisibility);
				return () => {
					alive = false;
					controller.abort();
					window.clearInterval(timer);
					window.removeEventListener("focus", onFocus);
					document.removeEventListener("visibilitychange", onVisibility);
					loadRef.current = void 0;
				};
			}, [statusPath]);
			/** 账号 + 今天 = 签到记忆的键；换账号或跨天自动重置。 */
			const account = status?.visibility?.account ?? status?.nickname;
			const dayKey = account === void 0 ? void 0 : `${account}:${localDayKey()}`;
			(0, react.useEffect)(() => {
				if (dayKey === void 0) return;
				setClaim(checkedInByDay.has(dayKey) ? "done" : "idle");
				setClaimNote(void 0);
			}, [dayKey]);
			if (variant === void 0 || selection == null) return null;
			const checkinPath = statusPath === void 0 ? void 0 : `${statusPath.slice(0, -"/status".length)}/checkin`;
			const entry = status?.models?.find((model) => model.id === selection.model);
			const rate = entry?.credits === void 0 ? "—" : entry.credits;
			const credits = status?.credits === void 0 ? "—" : status.credits.unlimited === true ? t("unlimitedQuota") : formatNumber(status.credits.total);
			const onCheckin = async () => {
				if (checkinPath === void 0 || claim === "busy") return;
				setClaim("busy");
				setClaimNote(void 0);
				try {
					const response = await fetch(checkinPath, {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json" }
					});
					const body = await response.json().catch(() => void 0);
					const state = body?.state;
					if (state === "claimed" || state === "already-claimed") {
						setClaim("done");
						if (dayKey !== void 0) checkedInByDay.set(dayKey, true);
						if (loadRef.current !== void 0) void loadRef.current(true);
					} else {
						setClaim("failed");
						setClaimNote(typeof body?.message === "string" && body.message !== "" ? body.message : `HTTP ${response.status}`);
					}
				} catch (error) {
					setClaim("failed");
					setClaimNote(error instanceof Error ? error.message : String(error));
				}
			};
			const checkinTitle = claim === "failed" && claimNote !== void 0 ? t("checkinFailed", { message: claimNote }) : t("checkinHint");
			const checkinNode = claim === "done"
				? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					key: "checkin",
					style: metaCheckinDoneStyle,
					children: ["✓ ", t("checkinDone")]
				})
				: claim === "busy"
					? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						key: "checkin",
						style: metaCheckinDoneStyle,
						children: t("checkinBusy")
					})
					: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						key: "checkin",
						type: "button",
						style: metaCheckinButtonStyle,
						title: checkinTitle,
						onClick: onCheckin,
						children: claim === "failed" ? t("checkinRetry") : t("checkinAction")
					});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: metaLineStyle,
				title: `${selection.provider}/${selection.model}`,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						key: "meta",
						children: t("metaLine", {
							channel: selection.provider,
							rate,
							credits
						})
					}),
					" · ",
					checkinNode
				]
			});
		}
		//#region src/client/WorkBuddyConfigPage.tsx
		/**
		* The cards' list; the page supplies no other chrome. A semantic `<ul>` —
		* each card below is an `<li>` — with the user-agent list defaults cleared so
		* only the column/gap rhythm remains, keeping the layout identical to the
		* flex column it replaced while giving the page real list semantics.
		*/
		const pageStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 12,
			listStyle: "none",
			margin: 0,
			padding: 0
		};
		/**
		* Render the bundle's configuration: one status card per WorkBuddy variant.
		*
		* Both variants share one page. DSH 0.1.6 replaced the settings section's
		* keyed `settings.plugin.item` slot — dispatched once per served settings
		* namespace, which is why the two variants used to be two cards — with the
		* Plugins page's `plugins.bundle.config`, keyed by the bundle's package name.
		* A bundle therefore carries exactly one configuration entry, so the cards are
		* stacked here instead of being dispatched separately. (The 0.1.5 settings tab
		* and its two dispatched cards still exist on 0.1.5 hosts; this page only
		* mounts where the Plugins page declares its slot.)
		*/
		function WorkBuddyConfigPage({ view, t }) {
			if (view === "summary") return t("intro");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
				style: pageStyle,
				children: CARD_VARIANTS.map((variant) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkBuddyPluginCard, {
					t,
					variant
				}, variant.id))
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** Plugin-card copy registered under the settings.workbuddy locale namespace. */
		const en = {
			title: "DSH WorkBuddy Connect",
			intro: "Use the models in the WorkBuddy desktop app directly in DSH — zero configuration, ready out of the box.",
			titleAI: "DSH WorkBuddy AI Connect",
			introAI: "Use the models in the WorkBuddy AI international desktop app directly in DSH — zero configuration, ready out of the box.",
			expand: "Expand",
			collapse: "Collapse",
			loading: "Loading account…",
			signedOut: "Not signed in",
			signedOutHint: "Sign in once in the WorkBuddy desktop app; this plugin follows that sign-in automatically.",
			signedOutHintAI: "Sign in once in the WorkBuddy AI desktop app; this plugin follows that sign-in automatically.",
			title1: "WorkBuddy account 1",
			title2: "WorkBuddy account 2",
			intro1: "Models from WorkBuddy account 1 (set WORKBUDDY1_AUTH_FILE to its credential file).",
			intro2: "Models from WorkBuddy account 2 (set WORKBUDDY2_AUTH_FILE to its credential file).",
			signedOutHint1: "Point WORKBUDDY1_AUTH_FILE at account 1's plaintext credential file.",
			signedOutHint2: "Point WORKBUDDY2_AUTH_FILE at account 2's plaintext credential file.",
			title3: "WorkBuddy Enterprise",
			intro3: "Models from the enterprise WorkBuddy account (set WORKBUDDY3_AUTH_FILE to its credential file). Enterprise credit is read from its own quota endpoint.",
			signedOutHint3: "Point WORKBUDDY3_AUTH_FILE at the enterprise account's plaintext credential file.",
			signedInAs: "Signed in as {nickname}",
			accessTokenExpires: "Access token expires {time} (refresh is automatic)",
			creditsHeading: "Remaining credit",
			metaLine: "Channel {channel} · Rate {rate} · Credit {credits}",
			checkinAction: "Check in",
			checkinBusy: "Checking in…",
			checkinDone: "Checked in",
			checkinRetry: "Retry check-in",
			checkinHint: "Claim today’s check-in credit",
			checkinFailed: "Check-in failed: {message}",
			tabStatus: "Status",
			tabContext: "Context window",
			tabDetails: "Credit details",
			creditsDetailHeading: "By package",
			creditsTotal: "Total: {total}",
			creditsTotalUnlimited: "Total: Unlimited",
			unlimitedQuota: "Unlimited",
			packageEnterprise: "Enterprise quota",
			cycleResetAt: "Resets {time}",
			percentRemaining: "{percent}% remaining",
			percentUnknown: "Remaining share unknown",
			exactRemaining: "{remain} / {size} remaining",
			creditPackageUnknownSize: "{remain} remaining",
			creditsError: "Credit unavailable: {message}",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			refreshModels: "Refresh model list",
			refreshingModels: "Refreshing models…",
			catalogLive: "Model list updated {time}",
			catalogSaved: "Showing the saved model list from {time}",
			catalogFallback: "Showing the built-in model list (not yet updated from WorkBuddy)",
			catalogError: "Last update failed: {message}",
			catalogAppVersion: "App version {version}",
			requestFailed: "Request failed",
			statusRefreshFailed: "Refresh failed: {message} — showing the last known state",
			statusResponseInvalid: "WorkBuddy returned an unreadable status reply",
			accountHeading: "Account",
			modelsHeading: "Model offers",
			contextHeading: "Context window",
			contextUpTo: "up to {size}",
			contextDefault: "default {size}",
			contextUnknown: "no declared context window",
			useMaximumContextWindow: "Use the largest declared context window",
			useMaximumContextWindowHint: "Applies to WorkBuddy AI models that offer a larger window.",
			visibilityIntro: "Uncheck a model to hide it from the model picker. Saved per signed-in account; chats already using a hidden model keep working.",
			visibilityStaleAccount: "The signed-in account changed — this change was not saved.",
			freeModel: "Free",
			badgeLimitedFree: "Limited-time free",
			badgeNightDiscount: "Night discount",
			badgeFreeNow: "Free now",
			rate: "{rate} credits per message",
			rateUnknown: "Price unavailable — refresh to update",
			probeConfirmAction: "Confirm",
			probeHeading: "Reasoning effort detection",
			probeResultNoLevels: "No tested levels were accepted.",
			probeIntro: "Some models reason but declare no selectable effort levels. Detecting which levels a model accepts sends a few real requests that may consume credit.",
			probeConsentHint: "Each detection sends test requests to one model to confirm its available reasoning levels, and may consume a small amount of credit.",
			probeStart: "Detect",
			probeRedetect: "Detect again",
			probeRunning: "Detecting {model}…",
			probeRunningGeneric: "Detecting…",
			probeClear: "Clear detected results",
			probeCandidates: "Detectable models: {count}",
			probeConfirmBody: "Send test requests to {model} to confirm its available reasoning levels. May consume a small amount of credit.",
			cancel: "Cancel",
			probeResultVerified: "Verified levels: {levels}",
			probeResultNotValidating: "This model does not check the effort parameter",
			probeResultUnknown: "Detection did not complete",
			probeResultAt: "Detected {time}",
			probeResultEmpty: "No detectable models right now.",
			probeFailed: "Detection failed: {message}"
		};
		const zh = {
			title: "DSH WorkBuddy Connect",
			intro: "在 DSH 中直接使用 WorkBuddy 桌面 App 包含的模型，开箱即用，无需额外配置。",
			titleAI: "DSH WorkBuddy AI Connect",
			introAI: "在 DSH 中直接使用 WorkBuddy AI 国际版桌面 App 包含的模型，开箱即用，无需额外配置。",
			expand: "展开",
			collapse: "收起",
			loading: "正在读取账号…",
			signedOut: "未登录",
			signedOutHint: "在 WorkBuddy 桌面 App 里登录一次即可，插件会自动跟随当前登录的账号。",
			signedOutHintAI: "在 WorkBuddy AI 国际版桌面 App 里登录一次即可，插件会自动跟随当前登录的账号。",
			title1: "WorkBuddy 账号 1",
			title2: "WorkBuddy 账号 2",
			intro1: "使用 WorkBuddy 账号 1 的模型（把 WORKBUDDY1_AUTH_FILE 指向它的凭据文件）。",
			intro2: "使用 WorkBuddy 账号 2 的模型（把 WORKBUDDY2_AUTH_FILE 指向它的凭据文件）。",
			signedOutHint1: "请把 WORKBUDDY1_AUTH_FILE 指向账号 1 的明文凭据文件。",
			signedOutHint2: "请把 WORKBUDDY2_AUTH_FILE 指向账号 2 的明文凭据文件。",
			title3: "WorkBuddy 企业版",
			intro3: "使用企业版 WorkBuddy 账号的模型（把 WORKBUDDY3_AUTH_FILE 指向它的凭据文件）；额度按企业版自己的周期总额读取。",
			signedOutHint3: "请把 WORKBUDDY3_AUTH_FILE 指向企业版账号的明文凭据文件。",
			signedInAs: "已登录：{nickname}",
			accessTokenExpires: "访问令牌 {time} 过期（自动续期）",
			creditsHeading: "剩余积分",
			metaLine: "渠道 {channel} · 倍率 {rate} · 积分余量 {credits}",
			checkinAction: "签到",
			checkinBusy: "签到中…",
			checkinDone: "已签到",
			checkinRetry: "重试签到",
			checkinHint: "领取今日签到积分",
			checkinFailed: "签到失败：{message}",
			tabStatus: "状态",
			tabContext: "上下文窗口",
			tabDetails: "积分详情",
			creditsDetailHeading: "按套餐",
			creditsTotal: "合计：{total}",
			creditsTotalUnlimited: "合计：不限额",
			unlimitedQuota: "不限额",
			packageEnterprise: "企业额度",
			cycleResetAt: "重置时间：{time}",
			percentRemaining: "剩余 {percent}%",
			percentUnknown: "剩余占比未知",
			exactRemaining: "剩余 {remain} / {size}",
			creditPackageUnknownSize: "剩余 {remain}",
			creditsError: "积分查询失败：{message}",
			refresh: "刷新",
			refreshing: "正在刷新…",
			refreshModels: "刷新模型列表",
			refreshingModels: "正在刷新模型…",
			catalogLive: "模型列表更新于 {time}",
			catalogSaved: "当前显示已保存的模型列表，更新于 {time}",
			catalogFallback: "当前显示内置模型列表（尚未从 WorkBuddy 更新）",
			catalogError: "上次更新失败：{message}",
			catalogAppVersion: "App 版本 {version}",
			requestFailed: "请求失败",
			statusRefreshFailed: "刷新失败：{message} — 当前显示的是上次成功获取的状态",
			statusResponseInvalid: "WorkBuddy 返回的状态数据无法识别",
			accountHeading: "账号",
			modelsHeading: "模型优惠",
			contextHeading: "上下文窗口",
			contextUpTo: "最高 {size}",
			contextDefault: "默认 {size}",
			contextUnknown: "未声明上下文窗口",
			useMaximumContextWindow: "使用上游声明的最大上下文窗口",
			useMaximumContextWindowHint: "仅作用于 WorkBuddy AI 中声明了更大窗口的模型。",
			visibilityIntro: "取消勾选即可在模型选择器中隐藏该模型；按当前登录账号分别保存，已在用该模型的会话不受影响。",
			visibilityStaleAccount: "登录账号已切换——本次修改未保存。",
			freeModel: "免费",
			badgeLimitedFree: "限时免费",
			badgeNightDiscount: "夜间折扣",
			badgeFreeNow: "限时免费",
			rate: "{rate} 积分/次",
			rateUnknown: "价格未知 — 刷新后更新",
			probeConfirmAction: "确认检测",
			probeHeading: "推理档位检测",
			probeResultNoLevels: "本次测试的档位均未被接受。",
			probeIntro: "部分模型具备思考能力，但没有声明可选档位。检测会发送少量真实请求，可能消耗积分。",
			probeConsentHint: "每次检测会向该模型发送探测请求，以确认可用推理档位，可能消耗少量积分。",
			probeStart: "开始检测",
			probeRedetect: "重新检测",
			probeRunning: "正在检测 {model}…",
			probeRunningGeneric: "正在检测…",
			probeClear: "清除已探测结果",
			probeCandidates: "可检测模型：{count} 个",
			probeConfirmBody: "向 {model} 发送探测请求，以确认可用推理档位。可能消耗少量积分。",
			cancel: "取消",
			probeResultVerified: "已验证接受的档位：{levels}",
			probeResultNotValidating: "该模型不校验该参数",
			probeResultUnknown: "检测未完成",
			probeResultAt: "检测于 {time}",
			probeResultEmpty: "当前没有可检测的模型。",
			probeFailed: "检测失败：{message}"
		};
		//#endregion
		//#region src/client/index.tsx
		/** Stable browser-plugin name. */
		const name = "dsh-workbuddy-connect-client";
		/**
		* The bundle's package name, which is also this half's configuration key.
		*
		* The Plugins page dispatches `plugins.bundle.config` by the bundle's package
		* name, so the key has to spell exactly what the profile installs.
		*/
		const BUNDLE_NAME = "dsh-workbuddy-connect";
		/**
		* Client services required by this browser half.
		*
		* DSH 0.1.2 removed `@deepseek-ai/dsh-client-runtime` (the package that used to
		* hold the browser `ClientContext` alias and the `slots` service), so the
		* services come from narrower packages: the `slots` registry lives in
		* `@deepseek-ai/dsh-client-ui-renderer` and `locale` in
		* `@deepseek-ai/dsh-client-locale`. Neither slot owner is named here on
		* purpose: `settings.plugin.item`'s declarer (`…-ui-settings-plugins`) is
		* absent from 0.1.6+ hosts and `plugins.bundle.config`'s declarer
		* (`…-ui-plugin-manager`) is absent from 0.1.5 hosts, and the seam choice is
		* made by slot-declaration lifetime, not by activation order — `ctx.slots.inject`
		* fires whenever the declaring package commits the slot, before or after this
		* fiber starts.
		*/
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.session"
		];
		/** Prefix every guarded client contribution's degradation logs with this. */
		const CLIENT_CONTRIBUTION_FAILED = "[dsh-workbuddy-connect] client contribution failed to load (host provider unaffected):";
		/** Disposer handed back when a deferred registration degraded: nothing to undo. */
		const NOOP_DISPOSER = () => {};
		/**
		* Run ONE browser-side contribution, degrading its failure to a `console.error`
		* instead of throwing into the DSH loader. Returns the contribution's own
		* value on success, or `undefined` when it degraded — the deferred slot
		* callbacks below substitute `NOOP_DISPOSER` for that, because the slot
		* runtime always expects a disposer back.
		*
		* Every contribution is guarded at BOTH boundaries where it can throw:
		*
		* 1. the eager `ctx.slots.inject(...)` / `ctx.inject(...)` call itself, which
		*    runs synchronously inside `apply()` — e.g. a slot-API shape break such as
		*    the rc.6→rc.7 `id`→`key` rename;
		* 2. the deferred callback, which the slot runtime invokes later — when the
		*    owner commits the slot's declaration, or when the injected services
		*    arrive — long after `apply()` has returned, where no enclosing try/catch
		*    could still catch it.
		*
		* The pair is what makes the contributions independent: a failure in one
		* settings seam, or in the probe control, leaves every other registration
		* intact. Guards are for THIS browser half only; the host half reports its own
		* errors through `ctx.logger`.
		*/
		function guardClientContribution(label, fn) {
			try {
				return fn();
			} catch (error) {
				console.error(`${CLIENT_CONTRIBUTION_FAILED} ${label}`, error);
				return;
			}
		}
		/**
		* Register the card copy and both settings-surface seams, one guarded
		* contribution at a time.
		*
		* A DSH slot-API breaking change degrades to a `console.error` per
		* contribution instead of throwing into the DSH loader and raising the red
		* "Failed to load plugins" banner; because each contribution carries its own
		* guard, one failing registration never takes the others with it (the old
		* settings cards survive a broken Plugins-page seam, and the probe control
		* survives either). The host provider keeps working throughout: the
		* `workbuddy` model channel is unaffected, and `dsh-workbuddy-connect status`
		* reports host health via the heartbeat file.
		*
		* The tests import this function directly (`tests/client-fallback.spec.ts`),
		* so its isolation semantics are pinned against the real entry — keep any
		* change to the guarded structure in sync with that spec.
		*/
		function apply(ctx, options) {
			const namespace = "settings.workbuddy";
			guardClientContribution("settings copy", () => {
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-workbuddy-connect: settings copy");
			});
			const t = ctx.locale.bind(namespace);
			for (const [index, variant] of CARD_VARIANTS.entries()) {
				const label = `settings.plugin.item card "${variant.id}"`;
				guardClientContribution(label, () => {
					ctx.slots.inject("settings.plugin.item", () => guardClientContribution(label, () => ctx.slots.register({
						name: "settings.plugin.item",
						key: variant.id,
						priority: 30 - index,
						inject: () => ({
							t,
							variant
						})
					}, WorkBuddyPluginCard)) ?? NOOP_DISPOSER);
				});
			}
			guardClientContribution("plugins.bundle.config page", () => {
				ctx.slots.inject("plugins.bundle.config", () => guardClientContribution("plugins.bundle.config page", () => ctx.slots.register({
					name: "plugins.bundle.config",
					key: "dsh-workbuddy-connect",
					locale: namespace
				}, WorkBuddyConfigPage)) ?? NOOP_DISPOSER);
			});
			/* [本地补丁 2026-09-23] 把「渠道 · 倍率 · 积分余量 · 签到」挂到 composer 下方的 dock 槽。 */
			/* [dsh-connect 2026-09-24] 三合一后「渠道 · 倍率 · 积分余量 · 签到」这些信息
			 * 已并进统一面板的按钮里，由 lib/index.js 传 options.skipDock 拦掉，
			 * 免得 composer 下方同时出现两行。其余贡献（设置卡片等）照旧。 */
			if (!options || options.skipDock !== true) guardClientContribution("conversation meta line", () => {
				ctx.inject(["modelDirectories"], (scope) => {
					guardClientContribution("conversation meta line", () => {
						scope.slots.inject("conversation.composer.dock", () => guardClientContribution("conversation meta line", () => scope.slots.register({
							name: "conversation.composer.dock",
							id: "workbuddy-meta",
							order: 20,
							inject: (sessionId) => ({
								directory: scope.modelDirectories.directoryFor(sessionId).store,
								t
							})
						}, WorkBuddyMetaLine) ?? NOOP_DISPOSER));
					});
				});
			});
		}
		//#endregion
		exports.BUNDLE_NAME = BUNDLE_NAME;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		
			return module.exports;
		})();

		// ══ dsh-trae-connect 的客户端半侧（原样搬入，独立作用域）══
		const traeClient = (() => {
			var module = { exports: {} };
			var exports = module.exports;
			Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		
		
		

		/** 只用 createElement，不 require jsx-runtime —— 少一个依赖面。 */
		const react = require("react");

		//#region 常量
		/** 与宿主侧 index.js 里的 TRAE_STATUS_ROUTE / TRAE_CHECKIN_ROUTE 必须逐字一致。 */
		const STATUS_PATH = "/plugins/dsh-trae-connect/status";
		const CHECKIN_PATH = "/plugins/dsh-trae-connect/checkin";
		/** 选中模型所属的 provider id。 */
		const PROVIDER_ID = "trae";

		/** 底刷新间隔：这一行是装饰信息，不值得频繁打上游。 */
		const REFRESH_MS = 300000;
		/** 焦点/可见性抖动的保护间隔。 */
		const MIN_GAP_MS = 30000;

		/**
		 * 当天已签到的记忆，键是 `${账号}:${本地日期}`。
		 *
		 * 模块级而不是组件级：DSH 会在切换会话时重挂载这个组件，放组件里会导致
		 * 「签到完了、切个会话回来又变成未签到」。服务端本来就是幂等的，
		 * 这里只是让界面别闪。
		 */
		const checkedInByDay = new Map();

		const lineStyle = {
			color: "var(--dsw-alias-label-tertiary)",
			textAlign: "right",
			width: "100%",
			paddingRight: "8px",
			fontSize: "12px",
			lineHeight: "18px",
			fontVariantNumeric: "tabular-nums",
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis",
		};
		const linkStyle = {
			font: "inherit",
			color: "var(--dsw-alias-state-business-primary)",
			background: "0 0",
			border: "none",
			cursor: "pointer",
			padding: "0 2px",
		};
		const doneStyle = { color: "var(--dsw-alias-state-success-primary)" };
		/** 槽契约异常时的空目录：永远没有选中项，组件因此不渲染任何东西。 */
		const EMPTY_DIRECTORY = {
			subscribe: () => () => {},
			getSnapshot: () => ({ current: undefined }),
		};
		//#endregion

		//#region 工具
		/** 本地日期（YYYY-MM-DD）。用本地而不是 UTC，否则时区一偏就跨天。 */
		function localDayKey() {
			const now = new Date();
			return [
				now.getFullYear(),
				String(now.getMonth() + 1).padStart(2, "0"),
				String(now.getDate()).padStart(2, "0"),
			].join("-");
		}

		/** 数字展示：整数不带小数，小数最多两位（顺带加千分位）。 */
		function formatNumber(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "—";
			return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
		}

		/** 后端契约的最小校验：形状不对就当没读到，绝不把半成品放进 state。 */
		function isStatusDocument(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
			const status = value.status;
			return status === "signed-out" || status === "signed-in";
		}
		//#endregion

		//#region 组件
		/**
		 * composer 下方那一行。
		 *
		 * 刷新策略与 WorkBuddy 那条一致：只在挂载 / 窗口获得焦点 / 标签页重新可见时
		 * 拉，5 分钟兜底，页面隐藏时不拉 —— 宿主对状态接口不做缓存，每次请求都会
		 * 实打实打一次 Trae 的额度接口。
		 */
		function TraeMetaLine(props) {
			/**
			 * `directory` 正常一定由槽的 inject 提供；万一 DSH 换了槽契约，
			 * 这里退化成一个空目录而不是让渲染抛错（渲染期抛错会连累整个 composer）。
			 */
			const directory = props.directory ?? EMPTY_DIRECTORY;
			const t = props.t;

			const subscribe = react.useCallback((listener) => directory.subscribe(listener), [directory]);
			const snapshot = react.useCallback(() => directory.getSnapshot(), [directory]);
			const selection = react.useSyncExternalStore(subscribe, snapshot, snapshot).current;

			const [status, setStatus] = react.useState(undefined);
			const [claim, setClaim] = react.useState("idle");
			const [note, setNote] = react.useState(undefined);

			/** 只有选中 trae 的模型时才需要这些网络请求。 */
			// `getSnapshot().current` 没选中模型时是 `null` 而非 `undefined` ——
			// 用 `!== undefined` 判断会放过 null，下一句读 `.provider` 就抛。
			const active = selection != null && selection.provider === PROVIDER_ID;
			const loadRef = react.useRef(undefined);

			react.useEffect(() => {
				if (!active) {
					setStatus(undefined);
					return undefined;
				}
				let alive = true;
				let lastAt = 0;
				const controller = new AbortController();
				const load = async (force) => {
					if (!force) {
						if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
						if (Date.now() - lastAt < MIN_GAP_MS) return;
					}
					lastAt = Date.now();
					try {
						const response = await fetch(STATUS_PATH, {
							credentials: "same-origin",
							headers: { accept: "application/json" },
							signal: controller.signal,
						});
						if (!response.ok) return;
						const value = await response.json().catch(() => undefined);
						if (alive && !controller.signal.aborted && isStatusDocument(value)) setStatus(value);
					} catch {
						/* 只读装饰：失败静默，绝不影响输入框 */
					}
				};
				loadRef.current = load;
				const onFocus = () => { void load(false); };
				const onVisibility = () => {
					if (document.visibilityState === "visible") void load(false);
				};
				void load(true);
				const timer = window.setInterval(() => { void load(false); }, REFRESH_MS);
				window.addEventListener("focus", onFocus);
				document.addEventListener("visibilitychange", onVisibility);
				return () => {
					alive = false;
					controller.abort();
					window.clearInterval(timer);
					window.removeEventListener("focus", onFocus);
					document.removeEventListener("visibilitychange", onVisibility);
					loadRef.current = undefined;
				};
			}, [active]);
			/** 换账号或跨天要重置签到记忆。 */
			const account = status === undefined ? undefined : status.account;
			const dayKey = account === undefined || account === "" ? undefined : `${account}:${localDayKey()}`;
			react.useEffect(() => {
				if (dayKey === undefined) return;
				setClaim(checkedInByDay.has(dayKey) ? "done" : "idle");
				setNote(undefined);
			}, [dayKey]);

			/** 记住了「今天已签」时，也要让按钮显示成已签（服务端可能还没被重新拉取）。 */
			const checkedInNow =
				(status !== undefined && status.checkin !== undefined && status.checkin.checkedIn === true) ||
				(dayKey !== undefined && checkedInByDay.has(dayKey));

			if (!active) return null;

			const accountLabel = status === undefined ? undefined : status.account;
			const credits = status === undefined ? undefined : status.credits;
			const creditsText =
				status === undefined
					? t("loading")
					: status.creditsError !== undefined
						? t("creditsUnavailable")
						: credits === undefined
							? t("loading")
							: credits.remain !== undefined && credits.total !== undefined
								? t("creditsPair", { remain: formatNumber(credits.remain), total: formatNumber(credits.total) })
								: credits.remain !== undefined
									? t("creditsSolo", { remain: formatNumber(credits.remain) })
									: "—";

			const reward =
				status === undefined || status.checkin === undefined ? undefined : status.checkin.credits;

			const onCheckin = async () => {
				if (claim === "busy") return;
				setClaim("busy");
				setNote(undefined);
				try {
					const response = await fetch(CHECKIN_PATH, {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json" },
					});
					const body = await response.json().catch(() => undefined);
					const state = body === undefined ? undefined : body.state;
					if (state === "claimed" || state === "already-claimed") {
						setClaim("done");
						if (dayKey !== undefined) checkedInByDay.set(dayKey, true);
						if (loadRef.current !== undefined) void loadRef.current(true);
					} else {
						setClaim("failed");
						const message = body !== undefined && typeof body.message === "string" && body.message !== "" ? body.message : `HTTP ${response.status}`;
						setNote(state === "disabled" ? t("checkinDisabled") : message);
					}
				} catch (error) {
					setClaim("failed");
					setNote(error instanceof Error ? error.message : String(error));
				}
			};

			const checkinTitle =
				claim === "failed" && note !== undefined
					? t("checkinFailed", { message: note })
					: reward !== undefined
						? t("checkinRewardHint", { credits: formatNumber(reward) })
						: t("checkinHint");

			let checkinNode;
			if (checkedInNow && claim !== "busy") {
				checkinNode = react.createElement("span", { key: "checkin", style: doneStyle }, "✓ " + t("checkinDone"));
			} else if (claim === "busy") {
				checkinNode = react.createElement("span", { key: "checkin", style: doneStyle }, t("checkinBusy"));
			} else {
				checkinNode = react.createElement(
					"button",
					{ key: "checkin", type: "button", style: linkStyle, title: checkinTitle, onClick: onCheckin },
					claim === "failed" ? t("checkinRetry") : reward !== undefined ? t("checkinActionWith", { credits: formatNumber(reward) }) : t("checkinAction"),
				);
			}

			const segments = [t("channelLine", { channel: status !== undefined && status.channel ? status.channel : "Trae", credits: creditsText })];
			if (accountLabel !== undefined && accountLabel !== "") segments.push(accountLabel);

			return react.createElement(
				"div",
				{
					style: lineStyle,
					title: `${PROVIDER_ID}/${selection.model} · ${checkinTitle}`,
				},
				react.createElement("span", { key: "meta" }, segments.join(" · ")),
				" · ",
				checkinNode,
			);
		}
		//#endregion

		//#region 文案
		const zh = {
			channelLine: "渠道 {channel} · 剩余积分 {credits}",
			creditsPair: "{remain} / {total}",
			creditsSolo: "{remain}",
			creditsUnavailable: "查询失败",
			loading: "读取中…",
			checkinAction: "签到",
			checkinActionWith: "签到 +{credits}",
			checkinBusy: "签到中…",
			checkinDone: "已签到",
			checkinRetry: "重试签到",
			checkinHint: "领取今日签到积分",
			checkinRewardHint: "领取今日签到积分（+{credits}）",
			checkinDisabled: "Trae 当前未开放签到",
			checkinFailed: "签到失败：{message}",
		};
		const en = {
			channelLine: "Channel {channel} · Credit {credits}",
			creditsPair: "{remain} / {total}",
			creditsSolo: "{remain}",
			creditsUnavailable: "unavailable",
			loading: "loading…",
			checkinAction: "Check in",
			checkinActionWith: "Check in +{credits}",
			checkinBusy: "Checking in…",
			checkinDone: "Checked in",
			checkinRetry: "Retry check-in",
			checkinHint: "Claim today’s check-in credit",
			checkinRewardHint: "Claim today’s check-in credit (+{credits})",
			checkinDisabled: "Trae check-in is not open right now",
			checkinFailed: "Check-in failed: {message}",
		};
		//#endregion

		//#region 插件入口
		/** 稳定浏览器插件名。 */
		const name = "dsh-trae-connect-client";
		const inject = ["slots", "locale"];

		/** 某个贡献抛错时降级成 console.error，不要毒死整个客户端加载器。 */
		const CONTRIBUTION_FAILED = "[dsh-trae-connect] client contribution failed to load (host provider unaffected):";
		function guard(label, fn) {
			try {
				return fn();
			} catch (error) {
				console.error(CONTRIBUTION_FAILED + " " + label, error);
				return undefined;
			}
		}

		function apply(ctx, options) {
			const namespace = "settings.trae";
			guard("copy", () => {
				ctx.effect(() => ctx.locale.register(namespace, { zh, en }), "dsh-trae-connect: copy");
			});
			const t = ctx.locale.bind(namespace);

			/* [dsh-connect 2026-09-24] 三合一后「渠道 · 倍率 · 积分余量 · 签到」这些信息
			 * 已并进统一面板的按钮里，由 lib/index.js 传 options.skipDock 拦掉，
			 * 免得 composer 下方同时出现两行。其余贡献（设置卡片等）照旧。 */
			if (!options || options.skipDock !== true) guard("conversation meta line", () => {
				ctx.inject(["modelDirectories"], (scope) => {
					guard("conversation meta line", () => {
						scope.slots.inject("conversation.composer.dock", () =>
							guard("conversation composer dock", () =>
								scope.slots.register(
									{
										name: "conversation.composer.dock",
										id: "trae-meta",
										order: 21,
										inject: (sessionId) => ({
											directory: scope.modelDirectories.directoryFor(sessionId).store,
											t,
										}),
									},
									TraeMetaLine,
								),
							),
						);
					});
				});
			});
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		
			return module.exports;
		})();

		// ══ dsh-qoder-connect 的客户端半侧（原样搬入，独立作用域）══
		const qoderClient = (() => {
			var module = { exports: {} };
			var exports = module.exports;
			Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		
		
		

		/** 只用 createElement，不 require jsx-runtime —— 少一个依赖面。 */
		const react = require("react");

		//#region 常量
		/** 与宿主侧 index.js 里的 QODER_STATUS_ROUTE / QODER_CHECKIN_ROUTE 必须逐字一致。 */
		const STATUS_PATH = "/plugins/dsh-qoder-connect/status";
		const CHECKIN_PATH = "/plugins/dsh-qoder-connect/checkin";
		/** 选中模型所属的 provider id（单实例时代的兜底）。 */
		const PROVIDER_ID = "qoder1";
		/** 多实例：provider id 前缀；qoder1 / qoder2 / ... 全部由这个 dock 接管。 */
		const PROVIDER_PREFIX = "qoder";
		/** provider id -> 状态路由。首个实例沿用旧的无编号路径。 */
		function statusPathFor(providerId) {
			const n = /^qoder(\d+)$/.exec(String(providerId ?? ""))?.[1];
			return n === "1" || n === undefined ? STATUS_PATH : `/plugins/dsh-qoder-connect/${n}/status`;
		}
		/** provider id -> 签到路由。 */
		function checkinPathFor(providerId) {
			const n = /^qoder(\d+)$/.exec(String(providerId ?? ""))?.[1];
			return n === "1" || n === undefined ? CHECKIN_PATH : `/plugins/dsh-qoder-connect/${n}/checkin`;
		}

		/** 底刷新间隔：这一行是装饰信息，不值得频繁打上游。 */
		const REFRESH_MS = 300000;
		/** 焦点/可见性抖动的保护间隔。 */
		const MIN_GAP_MS = 30000;

		const lineStyle = {
			color: "var(--dsw-alias-label-tertiary)",
			textAlign: "right",
			width: "100%",
			paddingRight: "8px",
			fontSize: "12px",
			lineHeight: "18px",
			fontVariantNumeric: "tabular-nums",
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis",
		};
		const linkStyle = {
			font: "inherit",
			color: "var(--dsw-alias-state-business-primary)",
			background: "0 0",
			border: "none",
			cursor: "pointer",
			padding: "0 2px",
		};
		const doneStyle = { color: "var(--dsw-alias-state-success-primary)" };
		const warnStyle = { color: "var(--dsw-alias-state-warning-primary)" };
		//#endregion

		//#region 工具
		/** 数字展示：整数不带小数，小数最多两位（顺带加千分位）。 */
		function formatNumber(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "—";
			return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
		}

		/** 后端契约的最小校验：形状不对就当没读到，绝不把半成品放进 state。 */
		function isStatusDocument(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
			const status = value.status;
			return status === "signed-out" || status === "signed-in";
		}
		//#endregion

		//#region 组件
		/**
		 * composer 下方那一行。
		 *
		 * 刷新策略与另外两条渠道一致：只在挂载 / 窗口获得焦点 / 标签页重新可见时拉，
		 * 5 分钟兜底，页面隐藏时不拉 —— 宿主对状态接口不做缓存，每次请求都会实打实
		 * 打一次 Qoder 的额度接口。
		 */
		function QoderMetaLine(props) {
			const directory = props.directory;
			const t = props.t;

			const subscribe = react.useCallback((listener) => directory.subscribe(listener), [directory]);
			const snapshot = react.useCallback(() => directory.getSnapshot(), [directory]);
			const selection = react.useSyncExternalStore(subscribe, snapshot, snapshot).current;

			const [status, setStatus] = react.useState(undefined);
			const [claim, setClaim] = react.useState("idle");
			const [note, setNote] = react.useState(undefined);
			const loadRef = react.useRef(undefined);

			/** 只有选中 qoder1 的模型时才需要这些网络请求。 */
			// `getSnapshot().current` 没选中模型时是 `null` 而非 `undefined` ——
			// 用 `!== undefined` 判断会放过 null，下一句读 `.provider` 就抛。
			const active = selection != null && typeof selection.provider === "string" && selection.provider.startsWith(PROVIDER_PREFIX);
			const statusPath = active ? statusPathFor(selection.provider) : "";
			const checkinPath = active ? checkinPathFor(selection.provider) : "";

			react.useEffect(() => {
				if (!active) {
					setStatus(undefined);
					return undefined;
				}
				let alive = true;
				let lastAt = 0;
				const controller = new AbortController();
				const load = async (force) => {
					if (!force) {
						if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
						if (Date.now() - lastAt < MIN_GAP_MS) return;
					}
					lastAt = Date.now();
					try {
						const response = await fetch(statusPath, {
							credentials: "same-origin",
							headers: { accept: "application/json" },
							signal: controller.signal,
						});
						if (!response.ok) return;
						const value = await response.json().catch(() => undefined);
						if (alive && !controller.signal.aborted && isStatusDocument(value)) setStatus(value);
					} catch {
						/* 只读装饰：失败静默，绝不影响输入框 */
					}
				};
				loadRef.current = load;
				const onFocus = () => { void load(false); };
				const onVisibility = () => {
					if (document.visibilityState === "visible") void load(false);
				};
				void load(true);
				const timer = window.setInterval(() => { void load(false); }, REFRESH_MS);
				window.addEventListener("focus", onFocus);
				document.addEventListener("visibilitychange", onVisibility);
				return () => {
					alive = false;
					controller.abort();
					window.clearInterval(timer);
					window.removeEventListener("focus", onFocus);
					document.removeEventListener("visibilitychange", onVisibility);
					loadRef.current = undefined;
				};
			}, [active]);

			/** 换账号要重置「刚刚领过」的记忆。 */
			const account = status === undefined ? undefined : status.account;
			react.useEffect(() => {
				setClaim("idle");
				setNote(undefined);
			}, [account]);

			if (!active) return null;

			// —— 倍率：来自目录里当前这个模型的 price_factor（宿主已格式化成 "0.8×"）。——
			const entry = status === undefined || status.models === undefined
				? undefined
				: status.models.find((model) => model.id === selection.model);
			const rate = entry === undefined
				? "—"
				: entry.free === true
					? t("rateFree")
					: entry.rate !== undefined && entry.rate !== null && entry.rate !== ""
						? entry.rate
						: "—";

			// —— 额度余量 ——
			const quota = status === undefined ? undefined : status.quota;
			let quotaText;
			if (status === undefined) {
				quotaText = t("loading");
			} else if (status.status === "signed-out") {
				quotaText = t("signedOut");
			} else if (status.quotaError !== undefined) {
				quotaText = t("quotaUnavailable");
			} else if (quota === undefined) {
				quotaText = t("loading");
			} else if (quota.enterprise === true) {
				quotaText = t("quotaEnterprise");
			} else if (quota.unlimited === true) {
				quotaText = t("quotaUnlimited");
			} else if (quota.remaining !== undefined && quota.total !== undefined) {
				quotaText = t("quotaPair", { remain: formatNumber(quota.remaining), total: formatNumber(quota.total) });
			} else if (quota.used !== undefined) {
				quotaText = t("quotaUsed", { used: formatNumber(quota.used) });
			} else {
				quotaText = "—";
			}

			// —— 签到 ——
			const checkin = status === undefined || status.status !== "signed-in" ? undefined : status.checkin;
			const checkinBroken = status !== undefined && status.status === "signed-in" && status.checkinError !== undefined;
			const claimable = checkin !== undefined && checkin.claimable === true;

			const onCheckin = async () => {
				if (claim === "busy" || !claimable) return;
				setClaim("busy");
				setNote(undefined);
				try {
					const response = await fetch(checkinPath, {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json" },
					});
					const body = await response.json().catch(() => undefined);
					const state = body === undefined ? undefined : body.state;
					if (state === "claimed") {
						setClaim("done");
						if (loadRef.current !== undefined) void loadRef.current(true);
						return;
					}
					if (state === "already-claimed") {
						setClaim("none");
						return;
					}
					// `manual-required` = 有奖可领，但只有桌面 App 能领（正常路径）。
					setClaim("manual");
					const message = body !== undefined && typeof body.message === "string" && body.message !== ""
						? body.message
						: `HTTP ${response.status}`;
					setNote(message);
				} catch (error) {
					setClaim("failed");
					setNote(error instanceof Error ? error.message : String(error));
				}
			};

			let checkinNode;
			let checkinTitle;
			if (checkinBroken) {
				checkinTitle = status.checkinError;
				checkinNode = react.createElement("span", { key: "checkin" }, t("checkinUnavailable"));
			} else if (claim === "busy") {
				checkinTitle = t("checkinBusy");
				checkinNode = react.createElement("span", { key: "checkin" }, t("checkinBusy"));
			} else if (claim === "manual") {
				checkinTitle = note !== undefined ? note : t("checkinManualHint");
				checkinNode = react.createElement("span", { key: "checkin", style: warnStyle }, t("checkinManual"));
			} else if (claim === "failed") {
				checkinTitle = t("checkinFailed", { message: note === undefined ? "" : note });
				checkinNode = react.createElement(
					"button",
					{ key: "checkin", type: "button", style: linkStyle, title: checkinTitle, onClick: onCheckin },
					t("checkinRetry"),
				);
			} else if (status === undefined || status.status !== "signed-in") {
				// 未登录 / 还没读到：不显示签到，免得给出假的可点状态。
				checkinTitle = t("checkinHint");
				checkinNode = react.createElement("span", { key: "checkin" }, t("checkinNone"));
			} else if (checkableNow(checkin, claim)) {
				checkinTitle = t("checkinClaimableHint");
				checkinNode = react.createElement(
					"button",
					{ key: "checkin", type: "button", style: linkStyle, title: checkinTitle, onClick: onCheckin },
					t("checkinAction"),
				);
			} else if (checkin === undefined) {
				checkinTitle = t("checkinHint");
				checkinNode = react.createElement("span", { key: "checkin" }, t("loading"));
			} else if (checkin.supported === false) {
				checkinTitle = checkin.reason !== undefined ? checkin.reason : t("checkinHint");
				checkinNode = react.createElement("span", { key: "checkin" }, t("checkinNone"));
			} else if (checkin.claimable !== true) {
				checkinTitle = checkin.reason !== undefined ? checkin.reason : t("checkinNone");
				checkinNode = react.createElement("span", { key: "checkin", style: doneStyle }, "✓ " + t("checkinNothing"));
			} else {
				checkinTitle = t("checkinHint");
				checkinNode = react.createElement("span", { key: "checkin" }, t("checkinNone"));
			}

			const channel = status !== undefined && typeof status.channel === "string" && status.channel !== ""
				? status.channel
				: selection.provider;

			const headline = t("metaLine", { channel, rate, quota: quotaText });

			return react.createElement(
				"div",
				{
					style: lineStyle,
					title: `${selection.provider}/${selection.model} · ${checkinTitle}`,
				},
				react.createElement("span", { key: "meta" }, headline),
				" · ",
				checkinNode,
			);
		}

		/**
		 * 现在能不能点签到。
		 *
		 * `claim === "done"` 是「刚刚这一轮确实领到了」（服务端真的回了 claimed），
		 * 之后按钮变成已领 —— 但 `manual` / `none` 不锁死，因为用户可能刚在 App 里
		 * 领完回来，下一次刷新就会自然变成「今日无可领」。
		 */
		function checkableNow(checkin, claim) {
			if (claim === "done" || claim === "manual") return false;
			return checkin !== undefined && checkin.claimable === true;
		}
		//#endregion

		//#region 文案
		const zh = {
			metaLine: "渠道 {channel} · 倍率 {rate} · 额度余量 {quota}",
			quotaPair: "{remain} / {total}",
			quotaUsed: "已用 {used}",
			quotaUnlimited: "不限量",
			quotaEnterprise: "按组织计量",
			quotaUnavailable: "查询失败",
			signedOut: "未登录",
			loading: "读取中…",
			rateFree: "免费",
			checkinAction: "签到",
			checkinBusy: "查询中…",
			checkinManual: "去 App 领取",
			checkinNothing: "今日无可领",
			checkinNone: "无签到活动",
			checkinUnavailable: "签到不可用",
			checkinRetry: "重试签到",
			checkinHint: "查看今日签到状态",
			checkinClaimableHint: "Qoder CN 今日有可领取的奖励，但领取动作在桌面 App 内嵌页面里，本插件没有可调用的接口。",
			checkinManualHint: "请打开 Qoder CN 的用量面板（左下角礼物图标）领取今日奖励。",
			checkinFailed: "签到失败：{message}",
		};
		const en = {
			metaLine: "Channel {channel} · Rate {rate} · Quota {quota}",
			quotaPair: "{remain} / {total}",
			quotaUsed: "used {used}",
			quotaUnlimited: "unlimited",
			quotaEnterprise: "org-metered",
			quotaUnavailable: "unavailable",
			signedOut: "not signed in",
			loading: "loading…",
			rateFree: "free",
			checkinAction: "Check in",
			checkinBusy: "Checking…",
			checkinManual: "Claim in App",
			checkinNothing: "nothing to claim",
			checkinNone: "no campaign",
			checkinUnavailable: "check-in unavailable",
			checkinRetry: "Retry check-in",
			checkinHint: "Show today’s check-in status",
			checkinClaimableHint: "Qoder CN has a reward to claim today, but claiming happens inside a page hosted by the desktop app — this plugin has no callable endpoint for it.",
			checkinManualHint: "Open Qoder CN’s usage panel (gift icon, bottom-left) to claim today’s reward.",
			checkinFailed: "Check-in failed: {message}",
		};
		//#endregion

		//#region 插件入口
		/** 稳定浏览器插件名。 */
		const name = "dsh-qoder-connect-client";
		const inject = ["slots", "locale"];

		/** 某个贡献抛错时降级成 console.error，不要毒死整个客户端加载器。 */
		const CONTRIBUTION_FAILED = "[dsh-qoder-connect] client contribution failed to load (host provider unaffected):";
		function guard(label, fn) {
			try {
				return fn();
			} catch (error) {
				console.error(CONTRIBUTION_FAILED + " " + label, error);
				return undefined;
			}
		}

		function apply(ctx, options) {
			const namespace = "settings.qoder";
			guard("copy", () => {
				ctx.effect(() => ctx.locale.register(namespace, { zh, en }), "dsh-qoder-connect: copy");
			});
			const t = ctx.locale.bind(namespace);

			/* [dsh-connect 2026-09-24] 三合一后「渠道 · 倍率 · 积分余量 · 签到」这些信息
			 * 已并进统一面板的按钮里，由 lib/index.js 传 options.skipDock 拦掉，
			 * 免得 composer 下方同时出现两行。其余贡献（设置卡片等）照旧。 */
			if (!options || options.skipDock !== true) guard("conversation meta line", () => {
				ctx.inject(["modelDirectories"], (scope) => {
					guard("conversation meta line", () => {
						scope.slots.inject("conversation.composer.dock", () =>
							guard("conversation composer dock", () =>
								scope.slots.register(
									{
										name: "conversation.composer.dock",
										id: "qoder-meta",
										order: 22,
										inject: (sessionId) => ({
											directory: scope.modelDirectories.directoryFor(sessionId).store,
											t,
										}),
									},
									QoderMetaLine,
								),
							),
						);
					});
				});
			});
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		
			return module.exports;
		})();

		// ══ dsh-connect 面板 的客户端半侧（原样搬入，独立作用域）══
		const panelClient = (() => {
			var module = { exports: {} };
			var exports = module.exports;
			Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		
		
		

		const react = require("react");
		/** `createPortal` 在 react-dom 上，不在 react 上 —— 写成 react.createPortal 是 undefined。 */
		const reactDom = require("react-dom");

		//#region 常量

		/** 与宿主侧 index.js 的字面量必须逐字一致。 */
		const STATUS_PATH = "/plugins/dsh-connect/status";
		const CHECKIN_PATH = "/plugins/dsh-connect/checkin";
		const SETTINGS_PATH = "/plugins/dsh-connect/settings";
		const MODELS_PATH = "/plugins/dsh-connect/models";
		/**
		 * Trae 两个槽位的控制面根路径。
		 *
		 * `/login` 与 `/keepalive` 都是「状态路由把结尾换成动作名」派生的
		 * （见 providers/trae/index.js 的 registerTraeStatusRoutes），所以这里也按
		 * 同样的规则拼 —— 多实例的序号只出现在中间那一段。
		 */
		const TRAE_BASE_PATH = "/plugins/dsh-trae-connect";
		const AUTH_PATH = "/plugins/dsh-connect/auth";
		/**
		 * 渠道管理动作（禁用 / 启用 / 删除）**共用 `/auth` 端点** ——
		 * 独立路由在 DSH 里注册不生效（详见宿主 panel.js 里那段说明）。
		 */
		const CHANNELS_PATH = AUTH_PATH;
		/** 渠道管理动作的协议字段名（不能用 `action`，见下）。 */
		const CHANNELS_OP_FIELD = "op";

		/** 弹窗打开时的刷新间隔。面板关着时**不轮询** —— 一次扇出会打 5 个上游额度接口。 */
		const OPEN_REFRESH_MS = 120000;
		/** 焦点/可见性抖动的保护间隔。 */
		const MIN_GAP_MS = 15000;

		const CHECKIN_STATES = {
			busy: { key: "checkinBusy", tone: "muted" },
			claimable: { key: "checkinClaim", tone: "action" },
			claimed: { key: "checkinClaimed", tone: "ok" },
			done: { key: "checkinDone", tone: "ok" },
			manual: { key: "checkinManual", tone: "warn" },
			/**
			 * 渠道**明确**不支持签到（企业版账号、活动未开放）—— 与 `unavailable`
			 * （现在问不到，重试可能就好）分开：这一态不给动作入口，只给一个灰色说明。
			 */
			unsupported: { key: "checkinUnsupported", tone: "muted" },
			unavailable: { key: "checkinUnavailable", tone: "muted" },
			"signed-out": { key: "checkinNone", tone: "muted" },
			unknown: { key: "checkinUnknown", tone: "muted" },
			failed: { key: "checkinRetry", tone: "error" },
		};

		//#endregion

		//#region 样式

		/**
		 * 侧栏条目的样式表。
		 *
		 * 侧栏里已有的条目（用量统计 / 上下文洞察 / 设置）都是「图标 + 文字」的整行
		 * 无边框行，hover 只换一层底色 —— 这里照抄宿主菜单项的语言：`gap: 8px`、
		 * `padding: 7px 10px`、`border-radius: 8px`、hover 用 `-interactive-bg-hover`；
		 * 「可签 N」用宿主 tag 的 warning 配色（12% 底色 + warn 前景）。
		 *
		 * 内联样式写不了 `:hover` / `:focus-visible`，所以这一块走 <style>，
		 * 布局之外的东西仍按本文件惯例内联。
		 */
		const HUB_CSS = [
			".dshc-side{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;padding:7px 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--dsh-content-font-size-secondary, 13px);line-height:18px;text-align:left;cursor:pointer;transition:background .12s ease,color .12s ease}",
			".dshc-side:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dshc-side:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}",
			".dshc-side__ico{display:inline-flex;flex:none;align-items:center;justify-content:center;width:16px;height:16px;color:inherit}",
			".dshc-side__ico svg{width:16px;height:16px}",
			".dshc-side__label{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}",
			".dshc-side__tag{flex:none;padding:1px 8px;border-radius:999px;font-size:11px;line-height:17px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)}",
			".dshc-side__count{flex:none;font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}",
			".dshc-side--rail{position:relative;justify-content:center;padding:7px 0}",
			".dshc-side--rail .dshc-side__label,.dshc-side--rail .dshc-side__tag,.dshc-side--rail .dshc-side__count{display:none}",
			".dshc-side__badge{position:absolute;top:4px;right:calc(50% - 10px);width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary)}",
		].join("");

		/**
		 * 注入侧栏样式：`<style>` 放 head，不参与条目 diff。
		 * 判据是 DOM 里有没有该节点，不用模块标记——节点被清掉时标记仍是 true，
		 * 样式就再也补不回来（图标随之铺开、间距消失）。
		 */
		function ensureHubStyle() {
			try { ensurePolishStyle(); } catch (error) {}
			if (typeof document === "undefined" || document.head === undefined) return;
			if (document.head.querySelector('style[data-dsh-connect="sidebar-entry"]') !== null) return;
			const node = document.createElement("style");
			node.setAttribute("data-dsh-connect", "sidebar-entry");
			node.textContent = HUB_CSS;
			document.head.appendChild(node);
		}

		/**
		 * 侧栏图标：中心节点 + 三个卫星 —— 一个"渠道汇聚"的记号，跟随文字色。
		 * `width`/`height` 写在 SVG 上：只给 viewBox 的话，样式一旦没生效就会铺开。
		 */
		const HUB_ICON = react.createElement(
			"svg",
			{
				width: "16",
				height: "16",
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.3,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
			},
			react.createElement("circle", { cx: "8", cy: "8", r: "2.1" }),
			react.createElement("circle", { cx: "8", cy: "2.9", r: "1.5" }),
			react.createElement("circle", { cx: "3.6", cy: "12.1", r: "1.5" }),
			react.createElement("circle", { cx: "12.4", cy: "12.1", r: "1.5" }),
			react.createElement("path", { d: "M8 4.4v1.5M6.4 9.6 4.6 10.9M9.6 9.6l1.8 1.3" }),
		);

		const S = {
			scrim: { position: "fixed", inset: 0, zIndex: 9998, background: "transparent" },
			/**
			 * 弹窗骨架：竖向三段 —— **头部固定 / 内容滚动 / 底部固定**。
			 *
			 * 这是这次布局调整的要点：改之前所有东西（标题、摘要、五行渠道、一键签到、
			 * 认证区、偏好区）堆在一个滚动体里，渠道一多就得滚到底才能按"一键签到"，
			 * 而那个按钮看起来又不属于底部。现在它钉在底部，内容区自己滚。
			 *
			 * `overflow: hidden` 是为了让内部滚动条被圆角裁掉；`maxHeight` 用 vh + px 双上限，
			 * 小窗口时仍留出页面边距。
			 */
			popover: {
				position: "fixed",
				zIndex: 9999,
				boxSizing: "border-box",
				display: "flex",
				flexDirection: "column",
				width: "min(560px, calc(100vw - 32px))",
				maxHeight: "min(68vh, 640px)",
				overflow: "hidden",
				borderRadius: "12px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-1)",
				boxShadow: "var(--dsw-shadow-lv2, 0 8px 28px rgba(0,0,0,.18))",
				color: "var(--dsw-alias-label-primary)",
				fontSize: "13px",
			},
			/** 头部：标题在左，操作按钮在右。 */
			panelHead: { display: "flex", alignItems: "center", gap: "6px", flex: "none", padding: "12px 14px 10px" },
			/** 摘要行：贴在头部下方、**不参与滚动**，滚多远都能看见总数。 */
			panelMeta: {
				flex: "none",
				padding: "0 14px 10px",
				color: "var(--dsw-alias-label-tertiary)",
				fontSize: "12px",
				lineHeight: "18px",
				fontVariantNumeric: "tabular-nums",
			},
			/** 内容区：唯一可滚动的部分。 */
			panelBody: { flex: "1 1 auto", minHeight: "0", overflowY: "auto", overflowX: "hidden", padding: "0 14px 6px" },
			card: {
				boxSizing: "border-box",
				padding: "12px",
				borderRadius: "10px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-module-platform)",
				color: "var(--dsw-alias-label-primary)",
				fontSize: "13px",
			},
			/**
			 * 卡片嵌入设置页（layout:"card"）时的**滚动上限**（2026-10-08 加）。
			 *
			 * 设置页外层不归本插件管，内容一高就溢出到可视区外 —— 用户实测：4 个
			 * WorkBuddy 账号时认证区直接画到方框下面，点不到。给卡片本体一个高度
			 * 上限让它**内部滚动**。上限用固定 px 而非 vh：vh 在设置页里量的是整屏，
			 * 会显得过高。弹窗布局不需要（panelBody 自己会滚）。
			 *
			 * 只能放在使用点：`layout` 是 HubPanel 的 prop，S 是外层常量，够不着。
			 */
			cardScroll: { maxHeight: "560px", overflowY: "auto" },
			/** 一条渠道。行间靠 borderTop 分隔，第一行由 rowFirst 去掉顶线。 */
			row: { display: "flex", flexDirection: "column", gap: "6px", padding: "10px 0", borderTop: "1px solid var(--dsw-alias-border-l2)" },
			rowFirst: { borderTop: "none", paddingTop: "2px" },
			rowHead: { display: "flex", alignItems: "center", gap: "8px", minHeight: "24px" },
			/** 第二行：额度 / 重置时间 / 模型数。允许换行，窄窗口不挤成一条。 */
			rowSub: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
			name: { fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
			account: { color: "var(--dsw-alias-label-tertiary)", fontVariantNumeric: "tabular-nums" },
			spacer: { marginLeft: "auto" },
			quota: { color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums" },
			muted: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px" },
			/**
			 * 说明块：整块浅底 + 内边距。用于"这一页是干什么的"（认证页顶部）——
			 * 一行灰字压不住导语的分量，看起来会像注释而不是说明。
			 */
			hint: {
				padding: "8px 10px",
				borderRadius: "8px",
				background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,.08))",
				color: "var(--dsw-alias-label-tertiary)",
				fontSize: "12px",
				lineHeight: "18px",
			},
			/** 单行省略：落点路径很长，别把行撑破。 */
			ellipsis: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			chip: {
				font: "inherit",
				fontSize: "12px",
				lineHeight: "20px",
				height: "22px",
				padding: "0 8px",
				borderRadius: "6px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "transparent",
				color: "var(--dsw-alias-label-secondary)",
				cursor: "pointer",
				/**
				 * chip 是 flex 行里的小按钮：行空间不足时 flex 默认允许收缩，
				 * 宽度小于文字宽度后 22px 高的按钮逐字换行 → 文字"变竖"。
				 * nowrap 禁换行、flex:none 禁收缩，两头堵死（改名行展开时最明显）。
				 */
				whiteSpace: "nowrap",
				flex: "none",
			},
			modelList: {
				display: "flex",
				flexDirection: "column",
				gap: "2px",
				maxHeight: "180px",
				overflowY: "auto",
				marginTop: "2px",
				paddingLeft: "10px",
				borderLeft: "2px solid var(--dsw-alias-border-l2)",
			},
			modelItem: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "12px", lineHeight: "20px" },
			modelName: { color: "var(--dsw-alias-label-secondary)" },
			modelId: { color: "var(--dsw-alias-label-tertiary)", fontVariantNumeric: "tabular-nums" },
			textarea: {
				flex: "1 1 auto",
				minWidth: "0",
				font: "inherit",
				fontSize: "12px",
				lineHeight: "16px",
				padding: "5px 8px",
				borderRadius: "6px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "transparent",
				color: "var(--dsw-alias-label-primary)",
				resize: "vertical",
			},
			bar: { height: "4px", borderRadius: "2px", background: "var(--dsw-alias-border-l2)", overflow: "hidden" },
			barFill: { height: "100%", background: "var(--dsw-alias-brand-primary)" },
			/** 行内次要按钮（签到 / 认证）。统一 26px 高，与 chip 形成两级尺寸。 */
			linkBtn: {
				font: "inherit",
				fontSize: "12px",
				lineHeight: "20px",
				minHeight: "26px",
				padding: "2px 12px",
				borderRadius: "6px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "transparent",
				color: "var(--dsw-alias-state-business-primary)",
				cursor: "pointer",
			},
			/** 主按钮：底部的"一键签到"。整行撑满，是这张弹窗唯一的强调动作。 */
			primaryBtn: {
				font: "inherit",
				fontSize: "13px",
				fontWeight: 600,
				lineHeight: "20px",
				minHeight: "32px",
				padding: "5px 14px",
				borderRadius: "8px",
				border: "none",
				background: "var(--dsw-alias-button-primary-fill)",
				color: "var(--dsw-alias-label-primary-foreground)",
				cursor: "pointer",
			},
			disabledBtn: { opacity: 0.55, cursor: "default" },
			/** 底部动作条：钉在弹窗底部，不随内容滚动。 */
			footer: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				flexWrap: "wrap",
				flex: "none",
				padding: "10px 14px 12px",
				borderTop: "1px solid var(--dsw-alias-border-l2)",
			},
			title: { fontWeight: 600, fontSize: "14px", lineHeight: "20px", marginRight: "auto" },
		};

		const TONE = {
			ok: "var(--dsw-alias-state-success-primary)",
			warn: "var(--dsw-alias-state-warning-primary)",
			error: "var(--dsw-alias-state-error-primary)",
			action: "var(--dsw-alias-state-business-primary)",
			muted: "var(--dsw-alias-label-tertiary)",
		};

		const DOT = { signed: "#2ea043", warn: "#d29922", off: "#8b949e" };

		//#endregion

		//#region 工具

		/**
		 * 文案函数兜底：locale 未绑定时 `ctx.locale.bind()` 拿到的可能不是函数，
		 * 取不到就回落到 key。绝不让"翻不出文案"升级成"渲染期抛错"。
		 */
		function safeT(t) {
			return (key, vars) => {
				try {
					const value = typeof t === "function" ? t(key, vars) : undefined;
					return typeof value === "string" && value !== "" ? value : key;
				} catch {
					return key;
				}
			};
		}

		/** 后端契约的最小校验；形状不对就当没读到，绝不把半成品放进 state。 */
		function isStatusDocument(value) {
			return (
				typeof value === "object" &&
				value !== null &&
				Array.isArray(value.channels) &&
				typeof value.summary === "object" &&
				value.summary !== null
			);
		}

		function stateDot(row) {
			if (row.state === "signed-in") {
				if (row.checkin !== undefined && row.checkin.state === "claimable") return DOT.warn;
				return DOT.signed;
			}
			return DOT.off;
		}

		/** 把一条签到结果并回它所在的行（只改 checkin，不动额度）。 */
		function mergeClaim(rows, result) {
			return rows.map((row) =>
				row.id === result.id
					? {
							...row,
							checkin: {
								state: result.state,
								...(result.note === undefined ? {} : { note: result.note }),
								...(result.campaignUrl === undefined ? {} : { campaignUrl: result.campaignUrl }),
							},
						}
					: row,
			);
		}

		//#endregion

		//#region 数据

		/**
		 * 状态拉取。
		 *
		 * `live` 为 true（弹窗打开）时定时刷新；关着时只在挂载/焦点/可见性变化时拉一次 ——
		 * 一次状态请求会在宿主侧扇出 5 个渠道，其中 4 个要打上游额度接口，不能当装饰随便轮询。
		 *
		 * ⚠️ `live` **只管刷新节奏**，不再决定要不要自动签到：所有调用点一律带 `auto=1`，
		 * 是否真的领取由宿主的 `autoCheckin` 偏好门控。原因见下面 `load()` 里那段注释。
		 */
		function useHubStatus(live) {
			const [status, setStatus] = react.useState(undefined);
			const [loadedAt, setLoadedAt] = react.useState(0);
			const loadRef = react.useRef(undefined);

			react.useEffect(() => {
				let alive = true;
				let lastAt = 0;
				const controller = new AbortController();
				const load = async (force) => {
					if (!force) {
						if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
						if (Date.now() - lastAt < MIN_GAP_MS) return;
					}
					lastAt = Date.now();
					try {
						/**
						 * **一律带 `auto=1`**，由宿主按 `autoCheckin` 偏好决定要不要顺带领取
						 * （见 panel.js 的 `HUB_STATUS_ROUTE`）——客户端这边不分叉。
						 *
						 * ## 为什么这里不能分叉（2026-09-27 用户报障）
						 *
						 * 曾经：只有弹窗那份（`live === true`）带 auto，角标那份不带，
						 * 于是**角标恒显示「可签 2」，而同一时刻弹窗里显示「已签」** ——
						 * 侧栏和面板互相矛盾，用户看到的就是"角标显示不准"。
						 *
						 * 根因是 **workbuddy 的「今天签没签」没有任何只读来源**：
						 * 它的签到看板（`POST /v2/billing/meter/checkin-status`）在活动未开放时
						 * 整份都是默认值，实测**当天已签到也依然如此** ——
						 * 上游返回 `{active:false, today_checked_in:false, streak_days:0,
						 * week_progress:[false×7], total_credits:0, theme_name:"", season:0}`，
						 * 而同一账号 `daily-checkin`（幂等 POST）明确回
						 * `10001 / "今天已签到，请明天再来"`。
						 * ⇒ 只读路径**在原理上**判不出来，只能猜；猜出来的 `claimable`
						 * 不是"可签"，是"不知道"。既然唯一可靠来源是 POST，那条路就
						 * 必须能发 POST，而不能只在弹窗里发。
						 *
						 * 两条路同源之后两种偏好下都自洽：
						 * - `autoCheckin` 开着（默认）：都自动签、都拿真实状态 ⇒ 角标 = 面板；
						 * - 关掉：都不签、都显示提示性的「可签」⇒ 也一致。
						 *
						 * `live` 只再控制**轮询节奏**（面板开着才定时刷新），不再影响是否自动签到。
						 */
						const response = await fetch(`${STATUS_PATH}?auto=1`, {
							credentials: "same-origin",
							headers: { accept: "application/json" },
							signal: controller.signal,
						});
						if (!response.ok) return;
						const value = await response.json().catch(() => undefined);
						if (alive && !controller.signal.aborted && isStatusDocument(value)) {
							setStatus(value);
							setLoadedAt(Date.now());
						}
					} catch {
						/* 只读装饰：失败静默，绝不影响输入框 */
					}
				};
				loadRef.current = load;
				void load(true);
				const onFocus = () => void load(false);
				const onVisibility = () => {
					if (document.visibilityState === "visible") void load(false);
				};
				window.addEventListener("focus", onFocus);
				document.addEventListener("visibilitychange", onVisibility);
				let timer;
				if (live === true) timer = window.setInterval(() => void load(false), OPEN_REFRESH_MS);
				return () => {
					alive = false;
					controller.abort();
					if (timer !== undefined) window.clearInterval(timer);
					window.removeEventListener("focus", onFocus);
					document.removeEventListener("visibilitychange", onVisibility);
					loadRef.current = undefined;
				};
			}, [live]);

			const reload = react.useCallback(() => {
				const fn = loadRef.current;
				if (fn !== undefined) void fn(true);
			}, []);

			return { status, setStatus, loadedAt, reload };
		}

		//#endregion

		//#region 组件

		/** 小按钮的"激活"态：brand 色文字 + 同色边框。 */
		const ON = { color: "var(--dsw-alias-brand-primary, currentColor)", borderColor: "var(--dsw-alias-brand-primary, currentColor)" };

		/**
		 * 认证行「更新模型」：重抓该渠道最新目录。
		 * Trae 由服务端先跑导出脚本；新模型不在禁用黑名单里，返回即自动可见。
		 * 结果用**向左浮出的气泡**呈现（绝对定位、不占行宽），否则窄行里这串字会把
		 * 旁边的按钮挤出框。
		 */
		function RefreshModelsButton(props) {
			const { row, t, onUpdated } = props;
			const [busy, setBusy] = react.useState(false);
			const [note, setNote] = react.useState(null);
			const timer = react.useRef(null);

			const showNote = (next) => {
				setNote(next);
				if (timer.current !== null) clearTimeout(timer.current);
				timer.current = setTimeout(() => setNote(null), 6000);
			};
			react.useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);

			const run = async () => {
				if (busy) return;
				setBusy(true);
				setNote(null);
				try {
					const response = await fetch(AUTH_PATH, {
						method: "POST",
						credentials: "same-origin",
						headers: { "content-type": "application/json", accept: "application/json" },
						body: JSON.stringify({ op: "refresh", channel: row.id }),
					});
					const body = await response.json().catch(() => undefined);
					if (response.ok !== true || body?.ok === false) {
						showNote({ tone: "error", text: body?.error ?? t("refreshFailed") });
					} else {
						const added = Array.isArray(body?.added) ? body.added : [];
						// 档位变化：changed 含"从无到有"，gained/lost 是它的子集提示。
						const effortChanged = Array.isArray(body?.efforts?.changed) ? body.efforts.changed : [];
						if (added.length > 0) {
							showNote({ tone: "ok", text: t("refreshAdded", { count: String(added.length), names: added.slice(0, 6).join(", ") + (added.length > 6 ? "…" : "") }) });
						} else if (effortChanged.length > 0) {
							showNote({ tone: "ok", text: t("refreshEfforts", { count: String(effortChanged.length) }) });
						} else {
							showNote({ tone: "muted", text: t("refreshCurrent", { count: String(body?.count ?? "") }) });
						}
						onUpdated?.();
					}
				} catch (error) {
					showNote({ tone: "error", text: String(error) });
				} finally {
					setBusy(false);
				}
			};

			return react.createElement(
				"span",
				{ style: { position: "relative", display: "inline-flex", flex: "none" } },
				react.createElement(
					"button",
					{
						type: "button",
						style: { ...S.chip, ...(busy ? S.disabledBtn : {}) },
						disabled: busy,
						title: t("refreshModelsHint"),
						onClick: () => void run(),
					},
					busy ? t("refreshBusy") : t("refreshModels"),
				),
				note === null
					? null
					: react.createElement(
							"span",
							{
								style: {
									position: "absolute",
									right: "calc(100% + 8px)",
									top: "50%",
									transform: "translateY(-50%)",
									zIndex: 50,
									// 固定宽度而不是 maxWidth：气泡贴在按钮左侧时可用空间被
									// 压窄，只给 maxWidth 会塌成一个字一列。220px 足够放下
									// 「已是最新（24 个模型）」，长模型名清单再在内部换行。
									width: "220px",
									boxSizing: "border-box",
									padding: "4px 8px",
									borderRadius: "6px",
									whiteSpace: "normal",
									overflowWrap: "anywhere",
									fontSize: "12px",
									lineHeight: "16px",
									textAlign: "left",
									color: note.tone === "error" ? TONE.error : note.tone === "ok" ? TONE.ok : TONE.muted,
									background: "var(--dsw-alias-surface-raised, #fff)",
									border: "1px solid var(--dsw-alias-border-subtle, rgba(0,0,0,0.08))",
									boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
								},
							},
							note.text,
						),
			);
		}

		/** 单条渠道行。 */
		function ChannelRow(props) {
			const { row, t, busy, onCheckin, onToggleModel, onToggleAll, onToggleMaximumContext, onTraeLogin, onTraeKeepalive, busyAll, first } = props;
			const checkin = row.checkin === undefined ? { state: "unknown" } : row.checkin;
			const meta = CHECKIN_STATES[checkin.state] ?? CHECKIN_STATES.unknown;
			const credits = row.credits;

			/** 模型清单及其禁用状态（勾选 = 在模型选择器里显示）。 */
			const models = Array.isArray(row.models) ? row.models : [];
			const disabledCount = models.filter((model) => model.disabled === true).length;
			const [showModels, setShowModels] = react.useState(false);
			const [busyModel, setBusyModel] = react.useState(undefined);
			const toggleModel = async (model) => {
				if (busyModel !== undefined) return;
				setBusyModel(model.id);
				try {
					await onToggleModel(row, model.id, model.disabled !== true);
				} finally {
					setBusyModel(undefined);
				}
			};

			/**
			 * Trae 槽位的「续期 / 登录」两个动作，以及最近一次的结果。
			 *
			 * 为什么只给 Trae：其余渠道都能自己续（workbuddy 有 sweep、qoder 有 PAT
			 * 交换、codearts 走 OAuth 面板）。Trae 的 refresh token 是**一次性**的，
			 * 而且桌面端几乎从不主动续期 —— 链一旦被插件烧掉，只能重新走浏览器授权码
			 * 登录。这两个按钮就是它唯一的救命入口，所以放在行头而不是藏进设置页。
			 */
			const [traeBusy, setTraeBusy] = react.useState("");
			const [traeNote, setTraeNote] = react.useState(undefined);
			const runTrae = async (kind, action) => {
				if (traeBusy !== "") return;
				setTraeBusy(kind);
				setTraeNote(undefined);
				try {
					const message = await action(row);
					if (message !== undefined && message !== "") setTraeNote(message);
				} catch (error) {
					setTraeNote(error instanceof Error ? error.message : String(error));
				} finally {
					setTraeBusy("");
				}
			};
			const traeDisabled = traeBusy !== "" || row.disabled === true;
			const traeActions =
				row.kind !== "trae" || typeof onTraeLogin !== "function"
					? []
					: [
							react.createElement(
								"button",
								{
									key: "trae-renew",
									type: "button",
									style: { ...S.linkBtn, ...(traeDisabled ? S.disabledBtn : {}) },
									disabled: traeDisabled,
									title: t("traeRenewHint"),
									onClick: () => void runTrae("renew", onTraeKeepalive),
								},
								traeBusy === "renew" ? t("traeRenewBusy") : t("traeRenew"),
							),
							react.createElement(
								"button",
								{
									key: "trae-login",
									type: "button",
									style: { ...S.linkBtn, ...(traeDisabled ? S.disabledBtn : {}) },
									disabled: traeDisabled,
									title: t("traeLoginHint"),
									onClick: () => void runTrae("login", onTraeLogin),
								},
								traeBusy === "login" ? t("traeLoginBusy") : t("traeLoginAction"),
							),
						];
			const right =
				meta.tone === "action" || meta.tone === "error" ? (
					react.createElement(
						"button",
						{
							key: "act",
							type: "button",
							style: { ...S.linkBtn, ...(busy === true ? S.disabledBtn : {}) },
							disabled: busy === true,
							title: t(meta.key),
							onClick: () => onCheckin(row),
						},
						busy === true ? t("checkinBusy") : t(meta.key),
					)
				) : checkin.campaignUrl !== undefined ? (
					react.createElement(
						"a",
						{
							key: "act",
							href: checkin.campaignUrl,
							target: "_blank",
							rel: "noreferrer",
							style: { ...S.linkBtn, textDecoration: "none", color: TONE[meta.tone] },
							title: checkin.note === undefined ? t(meta.key) : checkin.note,
						},
						t(meta.key),
					)
				) : (
					react.createElement(
						"span",
						{
							key: "act",
							/**
							 * 不支持做成**虚边标签**而不是一行灰字：它和"已签/未知"不是一类东西
							 * —— 那两个是状态，这个是"这个渠道压根没有这个动作"，需要一眼看出
							 * 是"有意如此"而不是"没渲染出来"。虚线边框是"不可操作"的通用暗示。
							 */
							style:
								checkin.state === "unsupported"
									? { ...S.chip, cursor: "default", color: TONE[meta.tone], borderStyle: "dashed" }
									: { color: TONE[meta.tone], fontSize: "12px" },
							title: checkin.note,
						},
						t(meta.key),
					)
				);

			const quotaText =
				credits === undefined
					? row.creditsError !== undefined
						? t("creditsUnavailable")
						: row.state === "signed-out"
							? t("signedOut")
							: "—"
					: credits.label !== undefined
						? `${t("creditsLabel")} ${credits.label}`
						: t("creditsUnknown");

			const sub =
				row.state === "signed-in"
					? [
							react.createElement("span", { key: "q", style: S.quota }, quotaText),
							credits !== undefined && (typeof credits.creditExpiry === "string" || typeof credits.resetAt === "string")
								? react.createElement("span", { key: "r", style: S.muted, title: credits.creditExpiryEstimated === true ? ([credits.creditExpiryPolicy].concat(Array.isArray(credits.creditExpiryUrls) ? credits.creditExpiryUrls : []).filter(Boolean).join(String.fromCharCode(10))) : "" }, typeof credits.creditExpiry === "string" ? (credits.creditExpiryEstimated === true ? t("creditExpiryEstimated", { time: formatCycleReset(credits.creditExpiry) }) : t("creditExpiry", { time: formatCycleReset(credits.creditExpiry) })) : t("resetAt", { time: formatCycleReset(credits.resetAt) }))
								: null,
							// 个人版的额度是几十个"裂变包"加起来的，点明包数免得这个数字显得来历不明。
							credits !== undefined && typeof credits.packages === "number"
								? react.createElement(
										"span",
										{ key: "pk", style: S.muted },
										t("creditsPackages", { count: String(credits.packages) }),
									)
								: null,
							models.length > 0
								? react.createElement(
										"button",
										{
											key: "m",
											type: "button",
											/**
											 * 有模型被隐藏时换成警示色。
											 *
											 * "模型选择器里没有模型"最常见的成因就是这里的隐藏名单被写满了，
											 * 而它原来和普通 chip 长得一模一样，很容易被当成装饰忽略掉。
											 */
											style: disabledCount === 0 ? S.chip : { ...S.chip, color: TONE.warn, borderColor: TONE.warn },
											title: t("modelsHint"),
											onClick: () => setShowModels((value) => !value),
										},
										t("modelsSelected", { selected: String(models.length - disabledCount), count: String(models.length) }),
									)
								: row.modelCount !== undefined
									? react.createElement("span", { key: "m", style: S.muted }, t("models", { count: String(row.modelCount) }))
									: null,
							/**
							 * 「最大上下文窗口」开关 —— 紧挨模型数，因为它管的就是这批模型的窗口。
							 *
							 * 后端只对国际版槽位下发 `maximumContextWindow`（见 panel.js 的
							 * normalizeChannel），所以字段在不在就是"该不该显示"的答案。
							 *
							 * ⚠️ 它是**全局**偏好（settings 里只有一个键）：在这里点，所有国际版
							 * 槽位一起变。tooltip 里写明了，免得以为是单槽位设置。
							 */
							row.maximumContextWindow === undefined
								? null
								: react.createElement(
										"button",
										{
											key: "ctx",
											type: "button",
											style: row.maximumContextWindow === true ? { ...S.chip, ...ON } : S.chip,
											disabled: busy === true,
											title: t(row.maximumContextWindow === true ? "maxContextOnHint" : "maxContextOffHint"),
											onClick: () => onToggleMaximumContext(row, row.maximumContextWindow !== true),
										},
										t(row.maximumContextWindow === true ? "maxContextOn" : "maxContextOff"),
									),
						].filter(Boolean)
					: [
							react.createElement(
								"span",
								{ key: "e", style: S.muted },
								row.state === "signed-out"
									? `${t("signedOut")} · ${row.credentialHint ?? ""}`
									: row.error ?? t("unavailable"),
							),
						];

			return react.createElement(
				"div",
				{ style: first === true ? { ...S.row, ...S.rowFirst } : S.row },
				react.createElement(
					"div",
					{ style: S.rowHead },
					react.createElement("span", {
						style: {
							width: "8px",
							height: "8px",
							borderRadius: "50%",
							// 被禁用的渠道连状态点都该是灰的 —— 它已经不参与任何动作了
							background: row.disabled === true ? DOT.off : stateDot(row),
							flex: "none",
						},
					}),
					react.createElement("span", { style: S.name }, row.displayName),
					/**
					 * Trae 的产品标签（现役是 `Trae CN（IDE）`；`TRAE SOLO CN（已并入 Trae CN IDE）`
					 * 只出现在还拿着并入前那份旧快照的机器上）。
					 *
					 * 为什么单列一个小 chip 而不是拼进 displayName：displayName 是用户在
					 * 认证页「改名」写的，插件覆盖它等于吃掉用户的命名。两条产品线共用同一份
					 * 凭据文件（最后一次导出者赢），界面上没有这一格就看不出当前接的是哪个
					 * 产品 —— 而「模型比预期少」「倍率空白」多半就是导出时选错了产品。
					 */
					row.productLabel != null && row.productLabel !== ""
						? react.createElement(
								"span",
								{
									key: "p",
									style: { ...S.chip, flex: "none" },
									title: t("productHint", { product: row.productLabel }),
								},
								row.productLabel,
							)
						: null,
					row.disabled === true
						? react.createElement(
								"span",
								{
									style: { ...S.chip, cursor: "default", color: TONE.muted, borderStyle: "dashed" },
									title: t("authDeleteWarn"),
								},
								t("channelDisabled"),
							)
						: null,
					row.account === undefined ? null : react.createElement("span", { style: S.account }, row.account),
					react.createElement("span", { style: S.spacer }),
					...traeActions,
					right,
				),
				react.createElement("div", { style: S.rowSub }, ...sub),
				traeNote === undefined ? null : react.createElement("div", { style: S.muted }, traeNote),
				credits !== undefined && typeof credits.progress === "number"
					? react.createElement(
							"div",
							{ style: S.bar },
							react.createElement("div", {
								className: "dshc-polish-bar", style: { ...S.barFill, width: `${Math.max(0, Math.min(1, credits.progress)) * 100}%` },
							}),
						)
					: null,
				// —— 模型配置：勾选 = 在模型选择器里显示；取消勾选即"禁用" ——
				showModels && models.length > 0
					? react.createElement(
							"div",
							{ style: S.modelList },
							react.createElement(
							"div",
							{ key: "cap", style: { ...S.modelItem, justifyContent: "space-between", cursor: "default" } },
							react.createElement("span", { style: S.muted }, t("modelsCaption")),
							react.createElement(
								"span",
								{ style: { display: "inline-flex", gap: "6px", flex: "none" } },
								react.createElement(
									"button",
									{ type: "button", style: { ...S.chip, ...(busyAll === true ? S.disabledBtn : {}) }, disabled: busyAll === true, onClick: () => onToggleAll(row, false) },
									t("modelsAllOn"),
								),
								react.createElement(
									"button",
									{
										type: "button",
										style: { ...S.chip, ...(busyAll === true ? S.disabledBtn : {}) },
										disabled: busyAll === true,
										title: t("modelsAllOffHint"),
										onClick: () => onToggleAll(row, true),
									},
									t("modelsAllOff"),
								),
							),
						),
							...models.map((model) =>
								react.createElement(
									"label",
									{ key: model.id, style: S.modelItem, title: model.id },
									react.createElement("input", {
										type: "checkbox",
										checked: model.disabled !== true,
										disabled: busyModel !== undefined,
										onChange: () => void toggleModel(model),
									}),
									react.createElement("span", { style: S.modelName }, model.name),
									/**
									 * 倍率（消耗乘数）。
									 *
									 * 宿主早就把它放进 `models[].rate` 了（workbuddy 形如 `x0.79`、
									 * qoder 形如 `0.5×`），但客户端一直没渲染 —— 所以面板里从来
									 * 看不到倍率，容易让人以为"没取到"。这里补上；没这个字段的
									 * 渠道（如 trae，上游本地缓存里就没有）就不显示，不占位。
									 */
									typeof model.rate === "string" && model.rate !== ""
										? react.createElement("span", { style: { ...S.muted, flex: "none" } }, model.rate)
										: null,
									react.createElement("span", { style: S.modelId }, model.id),
								),
							),
						)
					: null,
			);
		}

		/** 偏好区（弹窗底部 / 卡片底部共用）。 */
		function Preferences(props) {
			const { prefs, t, onPatch, busy } = props;
			const box = (key, labelKey) =>
				react.createElement(
					"label",
					{ key, style: { display: "inline-flex", alignItems: "center", gap: "6px", cursor: "pointer" } },
					react.createElement("input", {
						type: "checkbox",
						checked: prefs[key] === true,
						disabled: busy === true,
						onChange: (event) => onPatch({ [key]: event.target.checked }),
					}),
					react.createElement("span", null, t(labelKey)),
				);
			return react.createElement(
				"div",
				{ style: { display: "flex", gap: "16px", flexWrap: "wrap", paddingTop: "8px" } },
				box("autoCheckin", "prefAutoCheckin"),
			);
		}

		/** 面板主体：渠道列表 + 汇总 + 一键签到 + 偏好。 */
		/**
		 * 认证区：各渠道的凭据落点 + 粘贴框。
		 *
		 * 安全约定：**密钥只写文件（0600），不回显、不进 settings.json**。
		 * 页面只拿得到"落点路径 + 当前登录状态"，读不回密钥内容。
		 */
		/**
		 * 认证页里的一行。
		 *
		 * **默认折叠**：只露"是谁 / 登没登 / 落点在哪 / 一个[粘贴]按钮"。
		 * 以前五行各自常驻一个 textarea，一屏塞不下、必须整体滚动 —— 而绝大多数时间
		 * 用户只是想看"哪个渠道掉了"，并不需要看到输入框。
		 *
		 * 折叠起来还有个副作用好处：长文本粘贴框只在需要时才占据滚动高度，
		 * 滚轮就不会在"到底该滚谁"上打结。
		 */
		function AuthRow(props) {
			const { row, t, draft, note, busy, onChange, onSave, onAction, onUpdated, renameDraft, onRenameChange, renaming, onRenameToggle, onRenameCommit } = props;
			const [open, setOpen] = react.useState(false);
			/**
			 * 删除分两步：先变"确认删除"，再点才真删。
			 * 不用 `window.confirm` —— 在 DSH 的 webview 里它未必弹出，而"点两次"在哪都可靠。
			 */
			const [confirming, setConfirming] = react.useState(false);
			const signedIn = row.state === "signed-in";
			const configured = row.configured === true;
			const disabled = row.disabled === true;
			const canWrite = row.writable === true;
			const path = row.targetPath === null || row.targetPath === undefined ? row.source ?? "" : row.targetPath;
			return react.createElement(
				"div",
				{ style: S.row },
				react.createElement(
					"div",
					{ style: S.rowHead },
					react.createElement("span", {
						style: { width: "8px", height: "8px", borderRadius: "50%", background: signedIn ? DOT.signed : DOT.off, flex: "none" },
					}),
					react.createElement("span", { style: S.name }, renaming === true ? "" : row.displayName),
					// 改名：点「改名」就地展开输入框，确认提交（op=update）。
					renaming === true
						? react.createElement(
								"span",
								{ style: { display: "inline-flex", gap: "4px", flex: "1 1 auto", minWidth: "0" } },
								react.createElement("input", {
									value: renameDraft,
									style: { ...S.chip, flex: "1 1 auto", minWidth: "0" },
									autoFocus: true,
									onChange: (event) => onRenameChange(event.target.value),
									onKeyDown: (event) => {
										if (event.key === "Enter") onRenameCommit();
										if (event.key === "Escape") onRenameToggle();
									},
								}),
								react.createElement(
									"button",
									{
										type: "button",
										style: { ...S.chip, ...(renameDraft.trim() === "" ? S.disabledBtn : {}) },
										disabled: renameDraft.trim() === "" || busy === true,
										onClick: onRenameCommit,
									},
									t("authRenameOk"),
								),
								react.createElement(
									"button",
									{ type: "button", style: S.chip, onClick: onRenameToggle },
									t("authCancel"),
								),
							)
						: react.createElement("span", { style: S.spacer }),
					// 更新模型放最前；结果向左浮出（见组件内的绝对定位），不占这一行宽度。
					configured && signedIn === true
						? react.createElement(RefreshModelsButton, { row, t, onUpdated })
						: null,
					renaming === true
						? null
						: react.createElement(
								"button",
								{ type: "button", style: S.chip, onClick: onRenameToggle, title: t("authRename") },
								t("authRename"),
							),
					react.createElement(
						"span",
						{ style: { ...S.muted, color: disabled ? TONE.muted : signedIn ? TONE.ok : TONE.muted } },
						configured
							? disabled
								? t("channelDisabled")
								: signedIn
									? t("authSignedIn")
									: t("authSignedOut")
							: t("authIdle"),
					),
					canWrite
						? react.createElement(
								"button",
								{ type: "button", style: { ...S.chip, ...(open ? ON : {}) }, onClick: () => setOpen((value) => !value) },
								open ? t("authCollapse") : configured ? t("authPaste") : t("authAdd"),
							)
						: null,
					/**
					 * 扫码登录入口已从面板移除：DSH 桌面宿主里点击面板内的外部链接会把
					 * 面板顶掉，弹窗形态整体不可用。WorkBuddy 授权请走 CLI 工作流——
					 * `node scripts/workbuddy-login.mjs workbuddy1`（可让 AI 代跑，
					 * 输出授权链接 → 用户在任意浏览器打开扫码 → 凭据自动写入）。
					 */
					// 禁用 / 启用：只对已配置的槽位有意义
					configured
						? react.createElement(
								"button",
								{ type: "button", style: S.chip, onClick: () => onAction(disabled ? "enable" : "disable", row) },
								disabled ? t("channelEnable") : t("channelDisable"),
							)
						: null,
					// 空槽位同样支持删除注册表条目。
					react.createElement(
								"button",
								{
									type: "button",
									style: { ...S.chip, ...(confirming ? { color: TONE.error, borderColor: TONE.error } : {}) },
									title: t("authDeleteWarn"),
									onClick: () => {
										if (!confirming) {
											setConfirming(true);
											return;
										}
										setConfirming(false);
										onAction("delete", row);
									},
								},
								confirming ? t("authConfirmDelete") : t("authDelete"),
							),
				),
				react.createElement(
					"div",
					{ style: { ...S.muted, ...S.ellipsis }, title: path },
					configured ? path : t("authSlotHint"),
				),
				canWrite ? null : react.createElement("div", { style: { ...S.muted, color: TONE.warn } }, t("authNoTarget")),
				open && canWrite
					? react.createElement(
							"div",
							{ style: { display: "flex", gap: "6px", alignItems: "flex-start" } },
							react.createElement("textarea", {
								value: draft,
								placeholder: row.hint ?? "",
								rows: 3,
								style: S.textarea,
								onChange: (event) => onChange(event.target.value),
							}),
							react.createElement(
								"button",
								{
									type: "button",
									style: { ...S.chip, flex: "none", ...(busy || draft.trim() === "" ? S.disabledBtn : {}) },
									disabled: busy === true || draft.trim() === "",
									onClick: onSave,
								},
								busy === true ? t("authSaving") : t("authSave"),
							),
						)
					: null,
				note === undefined ? null : react.createElement("div", { style: S.muted }, note),
			);
		}


		/**
		 * 扫码登录入口已从面板移除：DSH 桌面宿主里点击面板内的外部链接会把面板
		 * 整体顶掉（window.open 与 <a> 都不可用），弹窗形态在该宿主里无法工作。
		 * WorkBuddy 授权改走 CLI 工作流：
		 *   node scripts/workbuddy-login.mjs workbuddy1            # 出链接并轮询到完成
		 *   node scripts/workbuddy-login.mjs workbuddy1 --url-only # 只输出链接
		 * AI 可直接代跑，把链接交给用户在任意浏览器打开扫码即可。
		 */

		/** 认证区主体：拉 /auth，逐渠道一行。 */
		function AuthSection(props) {
			const { t } = props;
			const [rows, setRows] = react.useState(undefined);
			const [drafts, setDrafts] = react.useState({});
			const [notes, setNotes] = react.useState({});
			const [busy, setBusy] = react.useState(undefined);
			/** 添加渠道表单（受控）：kind / id / displayName。 */
			const [adding, setAdding] = react.useState(false);
			const [nextSlot, setNextSlot] = react.useState(undefined);
			const [newKind, setNewKind] = react.useState("workbuddy");
			/**
			 * 新渠道的区域：`cn`（国区版）/ `global`（WorkBuddy AI 国际版）。
			 * 两个客户端是独立安装、协议相同，只差上游 host 与凭据 basename —— 所以这是
			 * 用户在**添加渠道时**要选的一件事，而不是靠槽位号猜（见 channel-registry.js）。
			 */
			const [newRegion, setNewRegion] = react.useState("cn");
			/**
			 * 新槽位是否**跟随桌面 App 的登录态**（只有国际版有意义）。
			 *
			 * 默认关：新增槽位的用途是多账号，跟随桌面 App 只会一起变成同一个号；
			 * 更糟的是"刚添加、还没认证"的空槽位会立刻借 App 里那份凭据看起来已登录，
			 * 把一整套模型漏进模型选择器。要复用桌面端登录态的用户可以在这里勾上
			 * （旧的国际版槽位本来就等同勾选，行为不变）。
			 */
			const [newFollowDesktop, setNewFollowDesktop] = react.useState(false);
			const [newId, setNewId] = react.useState("");
			const [newName, setNewName] = react.useState("");
			/**
			 * 自定义路由（`kind === "custom"`）的三个字段：上游地址 / 路径 / 模型清单。
			 *
			 * 这三样合起来就定义了「一条任意 API 路由」—— 剩下唯一缺的是密钥，
			 * 而密钥不进注册表（注册表是面板与 provider 共用的明文 JSON），
			 * 所以拆成两步：先建槽位，再在行内「粘贴」把密钥落到 connect-auth/<id>.key。
			 * 这也顺手统一了心智：所有渠道都是「先有槽位、再喂凭据」。
			 */
			const [newBaseUrl, setNewBaseUrl] = react.useState("");
			const [newApiPath, setNewApiPath] = react.useState("");
			const [newModels, setNewModels] = react.useState("");
			const [formNote, setFormNote] = react.useState(undefined);
			/** 行内改名的草稿：channelId → 输入值。 */
			const [renames, setRenames] = react.useState({});
			const [renaming, setRenaming] = react.useState(undefined);

			/**
			 * 提交按钮的门槛：custom 额外要求 baseUrl 与模型清单都非空。
			 *
			 * 不在宿主里兜底（宿主当然也校验），而是**在这里先拦住** —— 让按钮自己变灰，
			 * 用户不用点一次才知道缺什么。
			 */
			const customFormBlocked =
				newId === "" ||
				(newKind === "custom" && (newBaseUrl === "" || newModels.trim() === "")) ||
				busy === "__form";

			const load = react.useCallback(async () => {
				try {
					const response = await fetch(AUTH_PATH, { credentials: "same-origin", headers: { accept: "application/json" } });
					const body = await response.json().catch(() => undefined);
					if (body !== undefined && Array.isArray(body.channels)) {
						setRows(body.channels);
						if (typeof body.nextWorkbuddySlot === "number") setNextSlot(body.nextWorkbuddySlot);
					}
				} catch {
					/* 只读装饰：失败静默 */
				}
			}, []);
			react.useEffect(() => {
				void load();
			}, [load]);

			// 「+ 添加渠道」展开时把表单滚进视野：scrollIntoView 沿真实 DOM 找
			// 实际可滚的祖先逐层滚动,弹窗 / 设置页 tab / 页面窗口都适用。
			const addRef = react.useRef(null);
			react.useEffect(() => {
				if (adding) addRef.current?.scrollIntoView({ block: "nearest" });
			}, [adding]);

			const save = async (row, secret) => {
				setBusy(row.id);
				try {
					const response = await fetch(AUTH_PATH, {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json", "content-type": "application/json" },
						body: JSON.stringify({ channel: row.id, secret }),
					});
					const body = await response.json().catch(() => undefined);
					const message = response.ok
						? body?.note ?? t("authSaved")
						: body?.message ?? body?.error ?? `HTTP ${response.status}`;
					setNotes((prev) => ({ ...prev, [row.id]: message }));
					if (response.ok) {
						setDrafts((prev) => ({ ...prev, [row.id]: "" }));
						void load();
					}
				} catch (error) {
					setNotes((prev) => ({ ...prev, [row.id]: String(error) }));
				} finally {
					setBusy(undefined);
				}
			};

			/**
			 * 渠道管理动作：create / update / disable / enable / delete。
			 *
			 * 统一形状：`{ op, ...payload }`。disable / enable / delete 的 payload 是
			 * `{ channel: 渠道 id }`；create 是 `{ kind, id, displayName }`；
			 * update 是 `{ channel, displayName }`。
			 */
			const act = async (action, payload) => {
				const key =
					action === "create"
						? "__form"
						: action === "update"
							? `__rename:${payload.channel}`
							: payload.channel;
				setBusy(key);
				try {
					const response = await fetch(CHANNELS_PATH, {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json", "content-type": "application/json" },
						// 字段名是 `op` 不是 `action`：`action` 被 DSH 当保留字段吃掉（详见宿主 panel.js 的说明）。
						body: JSON.stringify({ op: action, ...payload }),
					});
					const body = await response.json().catch(() => undefined);
					const message = response.ok
						? body?.note
						: body?.message ?? body?.error ?? `HTTP ${response.status}`;
					if (action === "create") {
						setFormNote(message);
						if (response.ok) {
							setAdding(false);
							setNewId("");
							setNewName("");
							setNewBaseUrl("");
							setNewApiPath("");
							setNewModels("");
						}
					} else if (action === "update") {
						setNotes((prev) => ({ ...prev, [payload.channel]: message }));
						if (response.ok) setRenaming(undefined);
					} else {
						setNotes((prev) => ({ ...prev, [key]: response.ok ? undefined : message }));
					}
					void load();
				} catch (error) {
					if (action === "create") setFormNote(String(error));
					else setNotes((prev) => ({ ...prev, [key]: String(error) }));
				} finally {
					setBusy(undefined);
				}
			};

			if (rows === undefined) return react.createElement("div", { style: S.muted }, t("loading"));
			/**
			 * 分成两组：已配置的（能登录/粘贴/禁用/删除/改名）与空闲槽位（同样一套操作）。
			 *
			 * 分组是为了让"加渠道"这件事**看得见** —— 以前失败的地方不是缺功能，而是
			 * 空闲槽位根本不出现在界面上，用户不知道还能再加。
			 */
			const group = (title, list) =>
				list.length === 0
					? []
					: [
							react.createElement("div", { key: `h:${title}`, style: { ...S.muted, paddingTop: "6px" } }, title),
							...list.map((row) =>
								react.createElement(AuthRow, {
									key: row.id,
									row,
									t,
									draft: drafts[row.id] ?? "",
									note: notes[row.id],
									busy: busy === row.id || busy === `__rename:${row.id}`,
									onChange: (value) => setDrafts((prev) => ({ ...prev, [row.id]: value })),
									onSave: () => void save(row, drafts[row.id] ?? ""),
									onAction: (action, target) => void act(action, { channel: target.id }),
									onUpdated: () => void load(),
									// 改名（update）：行内展开一个小输入框，确认后提交。
									renameDraft: renames[row.id] ?? row.displayName,
									onRenameChange: (value) => setRenames((prev) => ({ ...prev, [row.id]: value })),
									renaming: renaming === row.id,
									onRenameToggle: () => {
										if (renaming === row.id) {
											setRenaming(undefined);
											return;
										}
										setRenames((prev) => ({ ...prev, [row.id]: row.displayName }));
										setRenaming(row.id);
									},
									onRenameCommit: () => {
										const value = (renames[row.id] ?? "").trim();
										if (value === "" || value === row.displayName) {
											setRenaming(undefined);
											return;
										}
										void act("update", { channel: row.id, displayName: value });
									},
								}),
							),
						];

			/** 添加渠道表单：kind 下拉 + id 预填 + 显示名。 */
			const addForm =
				adding === false
					? react.createElement(
							"button",
							{ type: "button", style: { ...S.chip, alignSelf: "flex-start", marginTop: "4px" }, onClick: () => {
								setNewKind("workbuddy");
								setNewId(nextSlot === undefined ? "" : `workbuddy${nextSlot}`);
								setNewName("");
								setNewRegion("cn");
								setNewFollowDesktop(false);
								setNewBaseUrl("");
								setNewApiPath("");
								setNewModels("");
								setFormNote(undefined);
								setAdding(true);
							} },
							t("authAddChannel"),
						)
					: react.createElement(
							"div",
							{ ref: addRef, style: { display: "flex", flexDirection: "column", gap: "6px", padding: "8px 10px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px" } },
							react.createElement(
								"label",
								{ style: { display: "flex", alignItems: "center", gap: "8px" } },
								react.createElement("span", { style: S.muted }, t("authFormKind")),
								react.createElement(
									"select",
									{
										value: newKind,
										style: S.chip,
										onChange: (event) => {
											const kind = event.target.value;
											setNewKind(kind);
											// trae / qoder 单例：id 钉死为 kind，用户不用填；
											// workbuddy 多实例：预填下一个空号；
											// custom 的 id 是**线路名**（同时当 provider id、凭据文件名与模型组名），
											// 没有可预测形状，必须自己填，所以清空。
											if (kind === "workbuddy") setNewId(nextSlot === undefined ? "" : `workbuddy${nextSlot}`);
											else if (kind === "custom") setNewId("");
											else setNewId(kind);
										},
									},
									react.createElement("option", { value: "workbuddy" }, "WorkBuddy"),
									react.createElement("option", { value: "trae" }, "Trae"),
									react.createElement("option", { value: "qoder" }, "Qoder"),
									// 第四项就是「别的 api 路由」：自带 baseUrl 的 OpenAI 兼容上游。
									// 它不绑任何厂商插件，只要求对方接受 POST <baseUrl><apiPath>。
									react.createElement("option", { value: "custom" }, t("authKindCustom")),
								),
							),
							newKind === "workbuddy"
								? react.createElement(
										"label",
										{ style: { display: "flex", alignItems: "center", gap: "8px" } },
										react.createElement("span", { style: S.muted }, t("authFormRegion")),
										react.createElement(
											"select",
											{
												value: newRegion,
												style: S.chip,
												onChange: (event) => setNewRegion(event.target.value),
											},
											react.createElement("option", { value: "cn" }, t("authRegionCn")),
											react.createElement("option", { value: "global" }, t("authRegionGlobal")),
										),
									)
								: null,
							newKind === "workbuddy" || newKind === "custom"
								? react.createElement(
										"label",
										{ style: { display: "flex", alignItems: "center", gap: "8px" } },
										react.createElement("span", { style: S.muted }, t("authFormId")),
										react.createElement("input", {
											value: newId,
											style: { ...S.chip, flex: "1 1 auto" },
											placeholder: newKind === "custom" ? t("authCustomIdPlaceholder") : "workbuddy4",
											onChange: (event) => setNewId(event.target.value.trim()),
										}),
									)
								: null,
							/**
							 * 「跟随桌面 App」开关：只在「国际版 + 新槽位」时出现。
							 *
							 * 国区槽位没有这个概念（它的默认读法就是插件自己的凭据文件），
							 * 所以这里不显示 —— 不给出一个点了没区别的开关。
							 */
							newKind === "workbuddy" && newRegion === "global"
								? react.createElement(
										"label",
										{ style: { display: "flex", alignItems: "center", gap: "8px" } },
										react.createElement("input", {
											type: "checkbox",
											checked: newFollowDesktop === true,
											onChange: (event) => setNewFollowDesktop(event.target.checked),
										}),
										react.createElement("span", { style: S.muted }, t("authFormFollowDesktop")),
									)
								: null,
							/**
							 * —— 自定义路由（kind === "custom"）的字段 ——
							 *
							 * baseUrl + apiPath 拼出真正的 POST 目标。这里刻意**不做**「拉 /models 自动发现」：
							 * 那需要一个已经能用的密钥，而密钥是下一步才粘的。让用户在拿到密钥的前提下
							 * 手填模型名，比给一个「点了必然报错」的按钮更省事。
							 */
							newKind === "custom"
								? react.createElement(
									"div",
									{ style: { display: "flex", flexDirection: "column", gap: "6px" } },
									react.createElement("label", { style: { display: "flex", alignItems: "center", gap: "8px" } },
										react.createElement("span", { style: { ...S.muted, flex: "none" } }, t("authFormBaseUrl")),
										react.createElement("input", {
											value: newBaseUrl,
											style: { ...S.chip, flex: "1 1 auto" },
											placeholder: "https://api.example.com/v1",
											onChange: (event) => setNewBaseUrl(event.target.value.trim()),
										}),
									),
									react.createElement("label", { style: { display: "flex", alignItems: "center", gap: "8px" } },
										react.createElement("span", { style: { ...S.muted, flex: "none" } }, t("authFormApiPath")),
										react.createElement("input", {
											value: newApiPath,
											style: { ...S.chip, flex: "1 1 auto" },
											placeholder: "/chat/completions",
											onChange: (event) => setNewApiPath(event.target.value.trim()),
										}),
									),
									react.createElement("label", { style: { display: "flex", alignItems: "flex-start", gap: "8px" } },
										react.createElement("span", { style: { ...S.muted, flex: "none", paddingTop: "4px" } }, t("authFormModels")),
										react.createElement("textarea", {
											value: newModels,
											style: { ...S.chip, flex: "1 1 auto", minHeight: "46px", resize: "vertical" },
											rows: 2,
											placeholder: t("authCustomModelsPlaceholder"),
											onChange: (event) => setNewModels(event.target.value),
										}),
									),
									react.createElement("div", { style: S.muted }, t("authCustomHint")),
								)
							: null,
							react.createElement(
								"label",
								{ style: { display: "flex", alignItems: "center", gap: "8px" } },
								react.createElement("span", { style: S.muted }, t("authFormName")),
								react.createElement("input", {
									value: newName,
									style: { ...S.chip, flex: "1 1 auto" },
									placeholder: newKind === "workbuddy" ? "WorkBuddy 账号 4" : newKind === "trae" ? "Trae" : newKind === "qoder" ? "Qoder CN" : t("authCustomNamePlaceholder"),
									onChange: (event) => setNewName(event.target.value),
								}),
							),
							react.createElement(
								"div",
								{ style: { display: "flex", gap: "6px" } },
								react.createElement(
									"button",
									{
										type: "button",
										style: { ...S.linkBtn, ...(customFormBlocked ? S.disabledBtn : {}) },
										disabled: customFormBlocked,
										onClick: () => void act("create", {
											kind: newKind,
											id: newId,
											displayName: newName,
											// custom 的三个字段：宿主的 create 分支只在 kind==="custom" 时校验它们。
											...newKind === "custom" ? { baseUrl: newBaseUrl, apiPath: newApiPath, models: newModels } : {},
											...newKind === "workbuddy" ? { region: newRegion } : {},
											...newKind === "workbuddy" && newRegion === "global" ? { followDesktop: newFollowDesktop === true } : {},
										}),
									},
									busy === "__form" ? t("authSaving") : t("authCreate"),
								),
								react.createElement(
									"button",
									{ type: "button", style: S.chip, onClick: () => setAdding(false) },
									t("authCancel"),
								),
							),
							formNote === undefined
								? null
								: react.createElement("div", { style: { ...S.muted, whiteSpace: "pre-wrap" } }, formNote),
						);

			return react.createElement(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "6px" } },
				react.createElement(
					"div",
					{ style: S.hint },
					react.createElement("div", null, t("authIntro")),
					react.createElement("div", { style: { marginTop: "4px" } }, t("authMigrate")),				),
				...group(t("authSectionActive"), rows.filter((row) => row.configured === true)),
				...group(t("authSectionIdle"), rows.filter((row) => row.configured !== true)),
				addForm,
			);
		}

		function HubPanel(props) {
			const { t, status, setStatus, reload, layout } = props;
			const [claim, setClaim] = react.useState("idle");
			const [busyId, setBusyId] = react.useState(undefined);
			const [note, setNote] = react.useState(undefined);
			const [patchBusy, setPatchBusy] = react.useState(false);
			const [busyAll, setBusyAll] = react.useState(undefined);
			/**
			 * 弹窗分两页：`channels`（渠道状态 + 一键签到）与 `auth`（认证）。
			 *
			 * 为什么不是"在同一页往下堆"：两者共用一条滚动流时，认证区一展开就把渠道行
			 * 顶下去、整页都得滚；而且滚轮落在 textarea 上还会被吃掉，手感就是"滚不动"。
			 * 拆成两页后各自独占滚动区，谁也不挤谁。
			 */
			const [view, setView] = react.useState("channels");

			const rows = status === undefined ? [] : status.channels;
			const summary = status === undefined ? undefined : status.summary;
			const prefs = status === undefined ? undefined : status.preferences;

			/** 一键签到：先落每行结果，再整体刷一次（顺带把新额度带回来）。 */
			const onCheckinAll = async () => {
				if (claim === "busy") return;
				setClaim("busy");
				setNote(undefined);
				try {
					const response = await fetch(CHECKIN_PATH, {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json" },
					});
					const body = await response.json().catch(() => undefined);
					if (body === undefined || !Array.isArray(body.results)) {
						setClaim("failed");
						setNote(`HTTP ${response.status}`);
						return;
					}
					if (status !== undefined) {
						let next = status.channels;
						for (const result of body.results) next = mergeClaim(next, result);
						setStatus({ ...status, channels: next, summary: { ...status.summary } });
					}
					setClaim("done");
					reload();
				} catch (error) {
					setClaim("failed");
					setNote(error instanceof Error ? error.message : String(error));
				}
			};

			const onCheckinOne = async (row) => {
				if (busyId !== undefined) return;
				setBusyId(row.id);
				try {
					const response = await fetch(`${CHECKIN_PATH}/${encodeURIComponent(row.id)}`, {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json" },
					});
					const body = await response.json().catch(() => undefined);
					if (body !== undefined && status !== undefined) {
						setStatus({ ...status, channels: mergeClaim(status.channels, body) });
					}
					reload();
				} catch {
					/* 单渠道失败：下一次刷新会自然纠正 */
				} finally {
					setBusyId(undefined);
				}
			};

			/** 全选 / 全不选：让宿主一次写完该渠道的所有模型条目。 */
			const onToggleAll = async (row, disabled) => {
				if (busyAll !== undefined) return;
				setBusyAll(row.id);
				try {
					const response = await fetch(MODELS_PATH, {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json", "content-type": "application/json" },
						body: JSON.stringify({ channel: row.provider, all: true, disabled }),
					});
					if (!response.ok) return;
					if (status !== undefined) {
						setStatus({
							...status,
							channels: status.channels.map((channel) =>
								channel.id === row.id
									? { ...channel, models: (channel.models ?? []).map((model) => ({ ...model, disabled })) }
									: channel,
							),
						});
					}
				} catch {
					/* 写失败就不动 UI，用户重试即可 */
				} finally {
					setBusyAll(undefined);
				}
			};

			/** 勾选/取消一个模型：写回面板设置，并就地更新这一行（避免整份重拉）。 */
			const onToggleModel = async (row, modelId, disabled) => {
				try {
					const response = await fetch(MODELS_PATH, {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json", "content-type": "application/json" },
						body: JSON.stringify({ channel: row.provider, model: modelId, disabled }),
					});
					if (!response.ok) return;
					if (status !== undefined) {
						setStatus({
							...status,
							channels: status.channels.map((channel) =>
								channel.id === row.id
									? {
											...channel,
											models: (channel.models ?? []).map((model) =>
												model.id === modelId ? { ...model, disabled } : model,
											),
										}
									: channel,
							),
						});
					}
				} catch {
					/* 写失败就不动 UI，用户重试即可 */
				}
			};

			/**
			 * 切换「取上游声明的最大上下文窗口」。
			 *
			 * 走的是面板自己的 `/settings`（写 `useMaximumContextWindow`），不是
			 * provider 的探针路由：这个偏好本来就是面板设置段里的一个键，走同一条路
			 * 才只有一处写入白名单、一处权限判定。
			 *
			 * ⚠️ 它是**全局**的：后端写完会让宿主重列所有渠道的模型，所以这里把
			 * 每一行的 `maximumContextWindow` 一起更新 —— 只改被点的那一行，会出现
			 * 「workbuddy4 显示已关、workbuddy5 还显示开着」而两者其实是同一个键。
			 */
			const onToggleMaximumContext = async (row, enabled) => {
				try {
					const response = await fetch(SETTINGS_PATH, {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json", "content-type": "application/json" },
						body: JSON.stringify({ useMaximumContextWindow: enabled }),
					});
					if (!response.ok || status === undefined) return;
					// 窗口档位变了 ⇒ 模型列表也变了（provider 会重新广告窗口），整份重拉。
					if (reload !== undefined) void reload();
				} catch {
					/* 写失败就不动 UI，用户重试即可 */
				}
			};

			const onPatch = async (patch) => {
				setPatchBusy(true);
				try {
					const response = await fetch(SETTINGS_PATH, {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json", "content-type": "application/json" },
						body: JSON.stringify(patch),
					});
					const body = await response.json().catch(() => undefined);
					if (response.ok && body !== undefined && status !== undefined) {
						setStatus({ ...status, preferences: body });
					}
				} catch {
					/* 写失败就保持原值，用户重试即可 */
				} finally {
					setPatchBusy(false);
				}
			};

			/**
			 * Trae 槽位的序号段：主槽 `trae` 走历史路径，`trae2` 起才带 `/2`。
			 *
			 * 规则必须和 providers/trae/index.js 的 `instanceId.slice("trae".length)`
			 * 逐字一致 —— 两边各算一遍是这类多实例路径最常见的漂移点。
			 */
			const traeSlotOf = (row) => {
				const suffix = typeof row.id === "string" && row.id.startsWith("trae") ? row.id.slice(4) : "";
				return suffix === "" ? TRAE_BASE_PATH : `${TRAE_BASE_PATH}/${suffix}`;
			};

			/**
			 * 续期：让插件用本槽自己的 refresh token 换一份新链。
			 *
			 * 失败最常见的原因是 `20101 refresh token is invalid` —— 那条链在服务端
			 * 已经死了，只能走登录。所以这里把探测结果原样回给用户，不做二次解读。
			 */
			const onTraeKeepalive = async (row) => {
				const response = await fetch(`${traeSlotOf(row)}/keepalive`, {
					method: "POST",
					credentials: "same-origin",
					headers: { accept: "application/json", "content-type": "application/json" },
					body: JSON.stringify({ action: "renew" }),
				});
				const body = await response.json().catch(() => undefined);
				if (body === undefined) return `HTTP ${response.status}`;
				if (body.state === "failed") return t("traeRenewFailed", { message: String(body.message ?? "") });
				const result = body.result;
				if (reload !== undefined) void reload();
				if (result !== undefined && result.renewed === true) {
					return t("traeRenewOk", { time: String(result.expiresAt ?? "") });
				}
				/** 没续成也要刷一次：needsLogin 会被插件置位，行上的提示会跟着变。 */
				return t("traeRenewFailed", { message: String(result?.reason ?? result?.code ?? "no-op") });
			};

			/**
			 * 登录：起一次回环授权会话并把 URL 交给系统浏览器。
			 *
			 * 为什么必须 `window.open` 而不是 `<a target="_blank">`：这个 URL 是**当场
			 * 生成**的（PKCE + 一次性回调端口），写成静态链接会指向上一次会话的端口。
			 * 弹窗被宿主拦掉时返回文案里带着 URL，用户仍可手动打开。
			 */
			const onTraeLogin = async (row) => {
				const response = await fetch(`${traeSlotOf(row)}/login`, {
					method: "POST",
					credentials: "same-origin",
					headers: { accept: "application/json", "content-type": "application/json" },
					body: JSON.stringify({ action: "start" }),
				});
				const body = await response.json().catch(() => undefined);
				if (body === undefined) return `HTTP ${response.status}`;
				if (body.state === "failed" || typeof body.url !== "string") {
					return t("traeLoginFailed", { message: String(body.message ?? "no url") });
				}
				try {
					window.open(body.url, "_blank", "noopener");
				} catch {
					/* 宿主拦弹窗：返回文案里带 URL，用户可手动打开 */
				}
				return t("traeLoginStarted", { url: body.url, port: String(body.port ?? "") });
			};
			const claimable = summary === undefined ? 0 : summary.claimable;
			const claimLabel =
				claim === "busy"
					? t("checkinAllBusy")
					: claimable === 0
						? t("checkinAllNone")
						: t("checkinAll", { count: String(claimable) });

			const summaryLine =
				summary === undefined
					? t("loading")
					: t("summaryLine", {
							signedIn: String(summary.signedIn),
							total: String(summary.total),
							done: String(summary.done),
							manual: String(summary.manual),
							// [dsh-connect 2026-09-27] 模板里有 {unsupported}，漏传会让汇总行
							// 原样显示出「不适用 {unsupported}」。
							unsupported: String(summary.unsupported),
						});

			const inAuth = view === "auth";
			const body = [
				// ① 头部（固定）：标题在左，动作在右。认证页里把它换成「返回」。
				react.createElement(
					"div",
					{ key: "head", style: S.panelHead },
					react.createElement("span", { style: S.title }, inAuth ? t("authTitle") : t("panelTitle")),
					inAuth
						? react.createElement(
								"button",
								{ key: "back", type: "button", style: S.linkBtn, onClick: () => setView("channels") },
								t("authBack"),
							)
						: react.createElement(
								"button",
								{ key: "auth", type: "button", style: S.linkBtn, onClick: () => setView("auth") },
								t("authTitle"),
							),
					react.createElement(
						"button",
						{
							key: "refresh",
							type: "button",
							style: S.linkBtn,
							onClick: () => reload(),
						},
						t("refresh"),
					),
				),
				// 摘要行只在渠道页有意义（认证页讲的是凭据，不是登录态汇总）。
				inAuth ? null : react.createElement("div", { key: "summary", style: S.panelMeta }, summaryLine),
				// ② 内容区（唯一可滚动）：两页共用同一个滚动容器，但各自独占内容。
				react.createElement(
					"div",
					{ key: "body", style: S.panelBody },
					inAuth
						? react.createElement(AuthSection, { t })
						: react.createElement(
								react.Fragment,
								null,
								...rows.map((row, index) =>
									react.createElement(ChannelRow, {
										key: row.id,
										row,
										t,
										first: index === 0,
										busy: busyId === row.id || claim === "busy",
										onCheckin: onCheckinOne,
										onToggleModel,
										onToggleAll,
										onToggleMaximumContext,
										onTraeLogin,
										onTraeKeepalive,
										busyAll: busyAll === row.id,
									}),
								),
								rows.length === 0 ? react.createElement("div", { key: "empty", style: S.muted }, t("loading")) : null,
								prefs === undefined
									? null
									: react.createElement(Preferences, { key: "prefs", prefs, t, onPatch, busy: patchBusy }),
							),
				),
				// ③ 底部动作条（固定）：只有渠道页有动作，认证页不摆按钮。
				inAuth
					? null
					: react.createElement(
							"div",
							{ key: "footer", style: S.footer },
							react.createElement(
								"button",
								{
									type: "button",
									style: {
										...S.primaryBtn,
										flex: "1 1 auto",
										...(claim === "busy" || claimable === 0 ? S.disabledBtn : {}),
									},
									disabled: claim === "busy" || claimable === 0,
									onClick: onCheckinAll,
								},
								claimLabel,
							),
							note === undefined
								? null
								: react.createElement(
										"span",
										{ style: { color: TONE.error, fontSize: "12px", flexBasis: "100%" } },
										t("checkinFailed", { message: note }),
									),
						),
			];

			/**
			 * 两种布局的根元素都必须是**有界高度的 flex 列**：panelBody 的
			 * `flex:1 1 auto; minHeight:0` 只在 flex 父级里生效，否则内容撑破
			 * 容器、被 overflow:hidden 裁走，界面上就是「没有滚动、点不到」。
			 *
			 * · card：设置页不给高度，卡片自带 px 上限（vh 在这里量的是整屏，会
			 *   显得过高）+ overflowY，与弹窗同构。
			 * · popover：外壳 S.popover 已有 maxHeight，根 div 被父高钳制即可。
			 */
			return react.createElement(
				"div",
				{
					className: layout === "card" ? "dshc-surface" : undefined,
					style:
						layout === "card"
							? { ...S.card, ...S.cardScroll, display: "flex", flexDirection: "column" }
							: { display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 },
				},
				...body,
			);
		}

		/**
		 * 左侧栏的「渠道中心」入口 —— 三合一后的**唯一**常驻入口。
		 *
		 * 它原来挂在 `conversation.composer.dock`（composer 下方居中那枚胶囊），和
		 * cost-meter 的角落芯片挤在同一条线上；而侧栏本来就是「用量统计 / 上下文洞察 /
		 * 记忆」这一列状态入口的老家，收进这里就不必再看 composer 下面那一排。
		 *
		 * 侧栏是 root 作用域：拿不到 sessionId，也就拿不到"当前选中的模型"，所以这里
		 * 只做汇总（N 渠道 / 可签 M），点开才是完整面板。原来胶囊右半那枚"直接给当前
		 * 渠道签到"依赖模型目录 —— 只有会话作用域才有 —— 那份能力在面板里按渠道逐条
		 * 保留，不再占着 composer 的位置。
		 *
		 * 状态只在挂载 / 窗口焦点变化时拉一次（角标是提示，不是承诺）；弹窗打开后由
		 * HubPanel 接管，按 OPEN_REFRESH_MS 刷新。
		 *
		 * ⚠️ 角标那份**也必须带 `auto=1`**（统一写在 `useHubStatus` 里，别在这里加分支）：
		 * 否则它与弹窗那份不同源，就会出现「角标说可签 2、弹窗说已签」这种自相矛盾
		 * （2026-09-27 用户报障）。两份 state 仍是各自独立的（弹窗开关不该重置角标），
		 * 但**取值来源相同**，所以显示结果一致。
		 */
		function HubSidebarEntry(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			/** 侧栏折叠成图标条时 `wide === false`。 */
			const wide = props.wide !== false;
			const { status } = useHubStatus(false);
			const [open, setOpen] = react.useState(false);
			const [pos, setPos] = react.useState(undefined);
			const buttonRef = react.useRef(null);
			/** 弹窗内独立维护一份 state（避免和条目那份互相覆盖）；**数据来源与它相同**。 */
			const panel = useHubStatus(open);

			ensureHubStyle();

			/** 沿用原来那枚胶囊的开关：偏好关掉整条就不渲染。 */
			const preferences = status === undefined ? undefined : status.preferences;
			const hidden = preferences !== undefined && preferences.showDockButton === false;

			/**
			 * 把条目的坐标算出来给弹层用。
			 *
			 * 必须在**打开之前**先算：首帧若没有 left/bottom，`position: fixed` 的元素会停在它
			 * 的 static 位置（通常在视口外），看起来就是"点了没反应"。
			 *
			 * 条目贴在视口左下角（侧栏底部），所以弹层朝**右上**长：左边贴在条目右缘外
			 * 10px，`bottom` 与条目底边对齐 —— 面板越高越往上顶，不会盖住侧栏本身，也
			 * 不会被视口下沿切掉。右边界仍按弹层宽度回收，避免溢出。
			 */
			const place = react.useCallback(() => {
				const node = buttonRef.current;
				if (node === null || node === undefined || typeof node.getBoundingClientRect !== "function") return;
				const rect = node.getBoundingClientRect();
				const width = Math.min(560, Math.max(320, window.innerWidth - 32));
				setPos({
					left: Math.min(rect.right + 10, Math.max(8, window.innerWidth - width - 12)),
					bottom: Math.max(8, window.innerHeight - rect.bottom),
				});
			}, []);

			react.useEffect(() => {
				if (!open) return undefined;
				place();
				const onDown = (event) => {
					const node = buttonRef.current;
					const panelNode = document.getElementById("dsh-connect-panel");
					if (node !== null && node.contains(event.target)) return;
					if (panelNode !== null && panelNode.contains(event.target)) return;
					setOpen(false);
				};
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("mousedown", onDown);
				document.addEventListener("keydown", onKey);
				window.addEventListener("resize", place);
				return () => {
					document.removeEventListener("mousedown", onDown);
					document.removeEventListener("keydown", onKey);
					window.removeEventListener("resize", place);
				};
			}, [open, place]);

			const onToggle = () => {
				place();
				setOpen((value) => !value);
			};

			/**
			 * 右侧尾标：有可签的就亮一枚 warning 标签（宿主 tag 的配色），
			 * 否则退回灰字"N 渠道" —— 两种状态都让这一行看得出内容量。
			 */
			const summary = status === undefined ? undefined : status.summary;
			const claimable = summary === undefined ? 0 : summary.claimable;
			const tail =
				summary === undefined
					? null
					: claimable > 0
						? react.createElement(
								"span",
								{ className: "dshc-side__tag" },
								t("sideTag", { claimable: String(claimable) }),
							)
						: react.createElement(
								"span",
								{ className: "dshc-side__count" },
								t("sideCount", { count: String(summary.total) }),
							);

			// 偏好关掉就整条消失 —— 放在所有 hook 之后，钩子顺序不受影响。
			if (hidden) return null;

			return react.createElement(
				react.Fragment,
				null,
				react.createElement(
					"button",
					{
						ref: buttonRef,
						type: "button",
						className: wide ? "dshc-side" : "dshc-side dshc-side--rail",
						title: t("triggerHint"),
						"aria-label": t("nav"),
						"aria-expanded": open ? "true" : "false",
						onClick: onToggle,
					},
					react.createElement("span", { className: "dshc-side__ico" }, HUB_ICON),
					wide ? react.createElement("span", { className: "dshc-side__label" }, t("nav")) : null,
					wide ? tail : null,
					// 折叠成图标条时没有文字，用右上角一个小圆点替代"可签"提示。
					wide || claimable === 0 ? null : react.createElement("span", { className: "dshc-side__badge" }),
				),
				open
					? reactDom.createPortal(
							react.createElement(
								react.Fragment,
								null,
								react.createElement("div", { style: S.scrim, onClick: () => setOpen(false) }),
								react.createElement(
									"div",
									{
										id: "dsh-connect-panel", className: "dshc-glass",
										style: pos === undefined ? S.popover : { ...S.popover, left: `${pos.left}px`, bottom: `${pos.bottom}px` },
									},
									react.createElement(HubPanel, {
										t,
										status: panel.status,
										setStatus: panel.setStatus,
										reload: panel.reload,
										layout: "popover",
									}),
								),
							),
							document.body,
						)
					: null,
			);
		}

		/** 宿主设置页的卡片形态：同一份面板，只是不弹层。 */
		function HubSettingsCard(props) {
			const { status, setStatus, reload } = useHubStatus(false);
			return react.createElement(HubPanel, { t: props.t, status, setStatus, reload, layout: "card" });
		}

		//#endregion

		//#region 文案

		const zh = {
			panelTitle: "渠道中心",
			nav: "渠道中心",
			refreshModels: "更新模型",
			refreshModelsHint: "从源头重抓最新模型目录（Trae 会现场从桌面端导出）",
			refreshBusy: "更新中…",
			refreshAdded: "新增 {count} 个模型，已自动勾选：{names}",
			refreshEfforts: "{count} 个模型的思考档位已更新",
			refreshCurrent: "已是最新（{count} 个模型）",
			refreshFailed: "更新失败",
			sideTag: "可签 {claimable}",
			sideCount: "{count} 渠道",
			triggerHint: "查看各渠道额度与签到状态，可一键签到",
			refresh: "刷新",
			loading: "读取中…",
			summaryLine: "已登录 {signedIn}/{total} · 已签 {done} · 不适用 {unsupported} · 待手动 {manual}",
			creditsLabel: "额度",
			creditsPackages: "{count} 个包",
			creditsUnknown: "额度未知",
			creditsUnavailable: "额度查询失败",
			resetAt: "重置 {time}", creditExpiry: "积分到期 {time}", creditExpiryEstimated: "积分到期（估算）{time}",
			models: "{count} 个模型",
			modelsSelected: "已选 {selected} / {count} 个模型",
			modelsHint: "点开配置该渠道在模型选择器里显示的模型",
			maxContextOn: "1M 上下文",
			maxContextOff: "默认窗口",
			maxContextOnHint: "正在用上游声明的最大窗口（如 deepseek-v4.1-flash 的 1M）。点击退回上游默认档。⚠️ 这是全局设置，所有国际版槽位一起变。",
			maxContextOffHint: "正在用上游声明的默认窗口（如 deepseek-v4.1-flash 的 300K）。点击改用最大窗口。⚠️ 这是全局设置，所有国际版槽位一起变。",
			productHint: "当前接入的产品：{product}（同一份凭据文件，由宿主导出时选择的产品决定）",
			modelsAllOffHint: "取消全部勾选 = 该渠道的模型不再出现在模型选择器里（仍然可以在这里全部勾回）",
			modelsCaption: "勾选 = 在模型选择器里显示；取消勾选即禁用该模型",
			modelsAllOn: "全选",
			modelsAllOff: "全不选",
			authTitle: "认证",
			authIntro: "怎么认证：把这段话发给 AI ——「跑 scripts/ 下的脚本配好 dsh-camel-pool 三个渠道的凭据，WorkBuddy 登录要轮询到成功为止；完成后汇报各渠道状态与模型数，提醒我重启 DSH」。WorkBuddy 由 AI 生成登录链接，在浏览器点开登录即可；Trae / Qoder 在自己的客户端导出凭据后点「粘贴」。",
			authSignedIn: "已登录",
			authSignedOut: "未登录",
			authNoTarget: "该渠道的凭据落点不可知（对应环境变量没设），请用导出脚本或改 compose",
			authSave: "保存",
			authSaving: "写入中…",
			authSaved: "已保存",
			authPaste: "粘贴",
			authCollapse: "收起",
			authBack: "返回",
			authMigrate: "凭据统一存 connect-auth/（0600，不进 settings），写入后最多 30 秒生效",
			channelDisabled: "已禁用",
			channelDisable: "禁用",
			channelEnable: "启用",
			authIdle: "空闲",
			authAdd: "添加",
			authDelete: "删除",
			authConfirmDelete: "确认删除",
			authSlotHint: "粘贴凭据即可启用这个槽位",
			authDeleteWarn: "删除会移除该槽位的凭据文件；不可撤销，但随时可以重新粘贴。",
			authSectionActive: "已配置",
			authSectionIdle: "空闲槽位（粘贴凭据即可添加渠道）",
			authAddChannel: "+ 添加渠道",
			authFormKind: "类型",
			authFormRegion: "区域",
			authRegionCn: "国区（WorkBuddy）",
			authRegionGlobal: "国际版（WorkBuddy AI）",
			authFormId: "渠道 ID",
			authFormName: "显示名称",
			authFormFollowDesktop: "跟随桌面 App 的登录态（默认关：这个槽位只认自己的凭据）",
			/** 自定义路由（kind === "custom"）：任意 OpenAI 兼容上游。 */
			authKindCustom: "自定义路由（任意 OpenAI 兼容 API）",
			authFormBaseUrl: "上游地址",
			authFormApiPath: "请求路径",
			authFormModels: "模型清单",
			authCustomIdPlaceholder: "线路名，如 my-proxy（小写字母开头，可含数字与连字符）",
			authCustomNamePlaceholder: "我的中转线路",
			authCustomModelsPlaceholder: "gpt-4o-mini\nclaude-3-5-sonnet\n（逗号或换行分隔，最多 64 个）",
			authCustomHint: "上游地址 + 路径拼成真正的 POST 目标（默认 /chat/completions）。建好槽位后在下面「粘贴」API Key —— 它会以 Authorization: Bearer 原样发出。provider 侧路由需要重启 DSH 才装载。",
			authCreate: "创建槽位",
			authCancel: "取消",
			authRename: "改名",
			authRenameOk: "保存名称",
			signedOut: "未登录",
			unavailable: "不可用",
			checkinClaim: "签到",
			checkinClaimed: "✓ 已领取",
			checkinDone: "✓ 已签到",
			checkinManual: "去 App 领取",
			checkinUnsupported: "不适用",
			checkinUnavailable: "无签到活动",
			checkinUnknown: "签到状态未知",
			checkinNone: "—",
			checkinBusy: "签到中…",
			checkinRetry: "重试签到",
			checkinAll: "一键签到（{count}）",
			checkinAllBusy: "签到中…",
			checkinAllNone: "今日无可签",
			checkinFailed: "签到请求失败：{message}",
			prefAutoCheckin: "打开面板时自动签到",
			prefShowDock: "在左侧栏显示渠道中心入口",
			/** Trae 槽位行头的两个动作（续期 / 登录）。文案只在这一层，别散到别处重复定义。 */
			traeRenew: "续期",
			traeRenewHint: "用本槽自己的 refresh token 换一份新链（一次性令牌，换完立刻原子落盘并回写桌面端）",
			traeRenewBusy: "续期中…",
			traeRenewOk: "已续期，新到期 {time}",
			traeRenewFailed: "续期失败：{message}",
			traeLoginAction: "登录",
			traeLoginHint: "走浏览器授权码登录（PKCE，回调打在 127.0.0.1 的回环端口）。refresh token 被判死时只有这条路",
			traeLoginBusy: "发起中…",
			traeLoginStarted: "已在浏览器打开登录页（回调端口 {port}）。若没弹出，手动打开：{url}",
			traeLoginFailed: "发起登录失败：{message}",
			traeNeedsLogin: "需要重新登录",
		};

		const en = {
			panelTitle: "Connect Hub",
			nav: "Connect Hub",
			refreshModels: "Refresh models",
			refreshModelsHint: "Re-fetch the latest model catalog from the source (Trae exports from the desktop app on the spot)",
			refreshBusy: "Updating…",
			refreshAdded: "{count} new model(s), auto-enabled: {names}",
			refreshEfforts: "Thinking levels updated for {count} model(s)",
			refreshCurrent: "Up to date ({count} models)",
			refreshFailed: "Update failed",
			sideTag: "{claimable} to claim",
			sideCount: "{count} channels",
			triggerHint: "See every channel's credit and check-in state; one-click check-in",
			refresh: "Refresh",
			loading: "Loading…",
			summaryLine: "Signed in {signedIn}/{total} · checked in {done} · n/a {unsupported} · manual {manual}",
			creditsLabel: "Credit",
			creditsPackages: "{count} packages",
			creditsUnknown: "credit unknown",
			creditsUnavailable: "credit unavailable",
			resetAt: "resets {time}", creditExpiry: "credits expire {time}", creditExpiryEstimated: "credits expire (est.) {time}",
			models: "{count} models",
			modelsSelected: "{selected} / {count} models on",
			modelsHint: "Pick which models this channel shows in the model picker",
			maxContextOn: "1M context",
			maxContextOff: "default window",
			maxContextOnHint: "Using the largest window the upstream declares (e.g. deepseek-v4.1-flash's 1M). Click to fall back to the upstream default. ⚠️ Global setting — changes every WorkBuddy AI slot.",
			maxContextOffHint: "Using the upstream default window (e.g. deepseek-v4.1-flash's 300K). Click to use the largest declared window. ⚠️ Global setting — changes every WorkBuddy AI slot.",
			productHint: "Connected product: {product} (one shared credential file — whichever product the host export picked)",
			modelsAllOffHint: "Unchecking all = this channel's models disappear from the model picker (tick them back here)",
			modelsCaption: "Checked = shown in the model picker; uncheck to disable a model",
			modelsAllOn: "All on",
			modelsAllOff: "All off",
			authTitle: "Auth",
			authIntro: "How to sign in: paste this to your AI — \"Set up the dsh-camel-pool channel credentials by following the AI quick-start in the README\". For WorkBuddy the AI workflow produces a login link — open it in any browser; for Trae / Qoder, export the credential from the client and press Paste.",
			authSignedIn: "signed in",
			authSignedOut: "signed out",
			authNoTarget: "This channel's credential path is unknown (its env var is unset); use the export script or change compose",
			authSave: "Save",
			authSaving: "Writing…",
			authSaved: "Saved",
			authPaste: "Paste",
			authCollapse: "Collapse",
			authBack: "Back",
			authMigrate: "Credentials live in connect-auth/ (0600, never in settings); applies within 30s of writing",
			channelDisabled: "disabled",
			channelDisable: "Disable",
			channelEnable: "Enable",
			authIdle: "idle",
			authAdd: "Add",
			authDelete: "Delete",
			authConfirmDelete: "Confirm delete",
			authSlotHint: "Paste a credential to use this slot",
			authDeleteWarn: "Delete removes this slot's credential file. Not reversible, but you can paste it again anytime.",
			authSectionActive: "Configured",
			authSectionIdle: "Idle slots (paste a credential to add a channel)",
			authAddChannel: "+ Add channel",
			authFormKind: "Type",
			authFormRegion: "Region",
			authRegionCn: "China (WorkBuddy)",
			authRegionGlobal: "International (WorkBuddy AI)",
			authFormId: "Channel ID",
			authFormName: "Display name",
			authFormFollowDesktop: "Follow the desktop app's sign-in (off by default: this slot uses only its own credential)",
			/** Custom route (kind === "custom"): any OpenAI-compatible upstream. */
			authKindCustom: "Custom route (any OpenAI-compatible API)",
			authFormBaseUrl: "Upstream URL",
			authFormApiPath: "Request path",
			authFormModels: "Models",
			authCustomIdPlaceholder: "route name, e.g. my-proxy (lowercase, digits and dashes)",
			authCustomNamePlaceholder: "My relay",
			authCustomModelsPlaceholder: "gpt-4o-mini\nclaude-3-5-sonnet\n(comma or newline separated, up to 64)",
			authCustomHint: "URL + path makes the real POST target (default /chat/completions). After creating the slot, paste the API key below — it is sent verbatim as Authorization: Bearer. The provider-side route loads on the next DSH restart.",
			authCreate: "Create slot",
			authCancel: "Cancel",
			authRename: "Rename",
			authRenameOk: "Save name",
			signedOut: "Not signed in",
			unavailable: "unavailable",
			checkinClaim: "Check in",
			checkinClaimed: "✓ Claimed",
			checkinDone: "✓ Checked in",
			checkinManual: "Claim in App",
			checkinUnsupported: "not applicable",
			checkinUnavailable: "no campaign",
			checkinUnknown: "check-in state unknown",
			checkinNone: "—",
			checkinBusy: "Checking…",
			checkinRetry: "Retry",
			checkinAll: "Check in all ({count})",
			checkinAllBusy: "Checking in…",
			checkinAllNone: "nothing to claim",
			checkinFailed: "Check-in request failed: {message}",
			prefAutoCheckin: "Auto check-in when the panel opens",
			prefShowDock: "Show the Connect Hub entry in the left sidebar",
			/** Trae slot row actions (renew / sign in). Copy lives only here. */
			traeRenew: "Renew",
			traeRenewHint: "Exchange this slot's own refresh token for a fresh chain (one-shot token: written atomically and echoed back to the desktop app)",
			traeRenewBusy: "Renewing…",
			traeRenewOk: "Renewed, new expiry {time}",
			traeRenewFailed: "Renew failed: {message}",
			traeLoginAction: "Sign in",
			traeLoginHint: "Browser auth-code sign-in (PKCE, callback on a 127.0.0.1 loopback port). This is the only way back once a refresh token is dead",
			traeLoginBusy: "Starting…",
			traeLoginStarted: "Login page opened (callback port {port}). If nothing opened, visit: {url}",
			traeLoginFailed: "Could not start sign-in: {message}",
			traeNeedsLogin: "sign-in required",
		};

		//#endregion

		//#region 插件入口

		const name = "dsh-connect-panel-client";
		const inject = ["slots", "locale"];

		/** 贡献失败时的统一前缀（加载期与渲染期共用）。 */
		const CONTRIBUTION_FAILED = "[dsh-connect] client contribution failed to load (host routes unaffected):";

		/**
		 * 贡献级错误边界。
		 *
		 * 槽位里的组件一旦渲染抛错，DSH 侧不一定有兜底 —— 而 composer 是输入区，
		 * 绝不能因为一个只读装饰挂掉。所以每个贡献都套一层：出错就渲染 null 并打日志。
		 * （与三个渠道插件"只读装饰：失败静默，绝不影响输入框"的约定一致。）
		 */
		class ContributionBoundary extends react.Component {
			constructor(props) {
				super(props);
				this.state = { failed: false };
			}
			static getDerivedStateFromError() {
				return { failed: true };
			}
			componentDidCatch(error) {
				console.error(CONTRIBUTION_FAILED + " render", error);
			}
			render() {
				return this.state.failed ? null : this.props.children;
			}
		}

		/** 把组件包进错误边界，再交给槽位。 */
		function guarded(Component) {
			function Guarded(props) {
				return react.createElement(ContributionBoundary, null, react.createElement(Component, props));
			}
			Guarded.displayName = `Guarded(${Component.name || "Contribution"})`;
			return Guarded;
		}

		/** 注册期抛错则降级成 console.error，不要毒死整个客户端加载器。 */
		function guard(label, fn) {
			try {
				return fn();
			} catch (error) {
				console.error(CONTRIBUTION_FAILED + " " + label, error);
				return undefined;
			}
		}

		function apply(ctx) {
			const namespace = "dsh-camel-pool";
			guard("copy", () => {
				ctx.effect(() => ctx.locale.register(namespace, { zh, en }), "dsh-connect: copy");
			});
			const t = ctx.locale.bind(namespace);

			// ux-v6：渠道中心插件已卸载，connect-hub 侧栏入口不再注册
			// （原 order 20 块已删除；额度面板 dsh-camel-pool-credits 仍在 order 21）。

			// Plugins 页贡献:0.1.x 宿主派发 `settings.plugin.item` 卡片
			// （key = 宿主 settings 命名空间）;0.2+ 改渲染 `settings.plugins.tab`
			// tab 条目(由 settings.section#plugins 的 children 表声明)。
			// slots.inject 只对已声明插槽触发 —— 两条 seam 并存即自动择路。
			guard("settings card", () => {
				guard("settings card (0.1.x seam)", () =>
					ctx.slots.inject("settings.plugin.item", () =>
						guard("connect hub settings card", () =>
							ctx.slots.register(
								{
									name: "settings.plugin.item",
									key: "dsh-camel-pool",
									priority: 25,
									inject: () => ({ t: safeT(t) }),
								},
								guarded(HubSettingsCard),
							),
						),
					),
				);
				guard("settings tab (0.2+ seam)", () =>
					ctx.slots.inject("settings.plugins.tab", () =>
						guard("connect hub settings tab", () =>
							ctx.slots.register(
								{
									name: "settings.plugins.tab",
									id: "dsh-camel-pool",
									order: 10,
									label: () => safeT(t)("panelTitle"),
									locale: namespace,
								},
								/**
								 * 新契约的 renderSlot 传空 props、用 `only: entry.id` 选中
								 * 本条目渲染；`t` 我们自己兜底，宿主若按 `locale` 注入了
								 * 更好的那份就以它为准。
								 */
								guarded(function HubSettingsTab(props) {
									return react.createElement(HubSettingsCard, {
										...(props ?? {}),
										t: typeof props?.t === "function" ? props.t : safeT(t),
									});
								}),
							),
						),
					),
				);
			});
		}

		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		
			return module.exports;
		})();

		// ══ 驼峰积分池 · 剩余额度专用面板（独立于渠道中心之外的第 5 份贡献）══
		// 数据源：GET /plugins/dsh-pool/status[?refresh=1]、/plugins/dsh-connect/settings
		// 交互要点：侧栏与弹窗共用一份状态（不再双请求）；自动签到可视化开关；
		// 路由额度条 + 熔断/探测失败标记；套餐搜索 + 0余额过滤 + 折叠；焦点管理与无障碍语义；
		// 页面隐藏暂停轮询、可见时补刷；错误/过期/关闭态明确提示；一键复制摘要。
		// 自动签到不在这里触发：panelClient 的 useHubStatus 一律带 ?auto=1，由宿主按
		// autoCheckin 偏好幂等领取；这里的按钮是手动兜底 + 开关设置。
		const poolCreditsClient = (() => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const react = require('react');
		const reactDom = require('react-dom');

		const POOL_STATUS_PATH = '/plugins/dsh-pool/status';
		const POOL_CHECKIN_PATH = "/plugins/dsh-connect/checkin";
		const POOL_SETTINGS_PATH = '/plugins/dsh-connect/settings';
		const POOL_USAGE_PATH = '/plugins/dsh-connect/usage';
		const POOL_PANEL_ID = 'dsh-camel-pool-credits-panel';
		const POLL_MS = 120000;
		const STYLE_ID = 'dsh-camel-pool-credits-style';
		const REQUEST_TIMEOUT_MS = 12000;
		const STALE_MS = 300000;
		const AUTO_EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
		const AUTO_EFFORT_SLOT_ID = 'dsh-camel-pool-auto-effort';
		const LOW_CREDIT = 500;
		const COLLAPSED_COUNT = 8;
		const EXPIRY_PREVIEW_COUNT = 2;

		const zh = {
		nav: '驼峰积分池',
		panelTitle: '驼峰积分池',
		caTitle: 'CodeArts 积分池',
		caShort: 'CodeArts',
		caOk: '正常',
		caTokenExpired: '凭据已过期，需重新登录',
		caReadFailed: '积分读取失败',
		caStale: '凭据待续期',
		caNoCredits: '暂无可用余额',
		caSignedOut: '未接入',
		caRelogin: '重新登录',
		caLoggingIn: '准备中…',
		caRefresh: '刷新余额',
		expiryTitle: '近期到期',
		expiryNone: '暂无到期数据',
		expiryMissing: '{count} 条未提供到期',
		expiryEstimated: '估算',
		expiryMore: '+{count} 项',
		routeStale: '离线 · {time}',
		routeStaleHint: '上游暂时连不上，显示的是上一次成功读取的余额',
		triggerHint: '查看积分池剩余额度、渠道路由与套餐明细',
		remaining: '剩余额度',
		loading: '读取中…',
		unavailable: '额度暂不可用',
		stale: '数据可能已过期，建议刷新',
		refresh: '刷新',
		refreshing: '刷新中…',
		close: '关闭面板',
		copy: '复制摘要',
		copied: '已复制',
		checkinAll: '一键签到',
		checkinBusy: '签到中…',
		checkinDone: '已提交领取',
		checkinFailed: '签到失败',
		checkinHint: '自动签到由宿主在打开界面时幂等领取，这里可手动补领',
		autoCheckin: '自动签到',
		autoCheckinOn: '已开启',
		autoCheckinOff: '已关闭',
		autoCheckinHint: '打开界面时自动领取可领签到',
		autoCheckinShort: '打开界面自动领签到',
		active: '已启用',
		inactive: '已关闭',
		disabledHint: '积分池已关闭，下拉恢复各平台原生分组',
		effortAuto: '自动最高思考档',
		order: '路由顺序',
		orderCredits: '按剩余额度优先',
		orderVoucher: '代金券优先',
		models: '{count} 模型',
		routes: '{count} 路由',
		routesTitle: '渠道路由（按优先级）',
		noRoutes: '暂无路由',
		accountsTitle: '套餐明细',
		searchPlaceholder: '搜索渠道或套餐…',
		hideZero: '仅看可用 ({count})',
		showZero: '全部套餐 ({count})',
		showAll: '展开全部 {count} 项',
		showLess: '收起',
		noMatch: '没有匹配的套餐',
		broken: '熔断 {count}',
		brokenNone: '无熔断',
		voucher: '代金券',
		remainingShort: '余 {value}',
		unlimitedQuota: '不限额',
		packages: '{count} 套餐',
		patch: '内核 {patch}',
		fetchedAt: '更新于 {time}',
		justNow: '刚刚',
		secondsAgo: '{n} 秒前',
		minutesAgo: '{n} 分前',
		hoursAgo: '{n} 小时前',
		errorTitle: '读取失败',
		retry: '重试',
		lowCredit: '偏低',
		probing: '探测中',
		routeError: '不可用',
		dialogLabel: '驼峰积分池额度面板',
		summaryCopied: '额度摘要已写入剪贴板',
		updatedLive: '额度已更新',
		costFirst: '按性价比排序',
		costFirstHint: '只重排这批精选模型：免费优先，其余按倍率从低到高',
		costFirstShort: '免费优先，低倍率靠前',
		voucherFirstPref: '代金券优先',
		voucherFirstHint: '开启后先走代金券；关闭时按积分最早过期顺序调用',
		voucherFirstShort: '先扣代金券，否则按到期',
		poolEnabled: '启用积分池',
		poolEnabledHint: '开 → 下拉只显示合并模型；关 → 下拉恢复各平台原生分组（可选不同平台）',
		poolEnabledShort: '合并各渠道模型到统一下拉列表',
		voucherBalance: '阿里云百炼代金券',
		voucherSpend: '已用 {value}',
		voucherBudget: '总额 {value}',
		expiresSoonest: '到期 {time}',
		coupons: '{count} 张券',
		freeUntil: '免费至 {time}',
		freeLeft: '剩 {d}天{h}小时',
		freeNow: '限时免费',
		noOffers: '当前没有限时免费模型',
		modelOffers: '限时免费',
		expiry: '到期 {time}',
		rate: '倍率 {value}',
		sortBy: '列表排序',
		modelLibrary: '模型库',
		curatedCount: '精选 {count}',
		curatedBadge: '白名单',
		routeSource: '来源',
		libFree: '免费',
		libHint: '对话模型下拉即此列表',
		showRoutes: '显示路由来源',
		showRoutesHint: '打开后在模型名后标注来自哪个渠道；关闭时下拉只显示干净模型名',
		showRoutesShort: '在模型名后标注渠道来源',
		autoBoost: '切模型自动提档',
		autoBoostHint: '打开后切模型会自动把思考强度拉到最高档（更慢更细）；默认关闭，保留你选的强度',
		autoBoostShort: '切换时拉满思考强度',
		burnExpiring: '当日积分优先烧',
		burnExpiringHint: '打开后优先消耗当天午夜就作废的签到余额（如华为每日 100 积分），烧完自动切别的路由；默认开启',
		burnExpiringShort: '优先消耗当日作废签到额度',
		libOptsTitle: '路由与显示偏好',
		usageTitle: '用量统计',
		detailTitle: '明细与设置',
		tabOverview: '概览',
		tabUsage: '用量',
		tabDetail: '明细',
		usageDay: '今日',
		usageWeek: '本周',
		usageMonth: '本月',
		usageAll: '累计',
		usageRange: '区间',
		usageCredits: '积分消耗',
		usageTokens: 'Token 合计',
		usageInput: '输入',
		usageOutput: '输出',
		usageCache: '缓存命中',
		usageRequests: '请求 / 失败',
		usageByPlatform: '按平台',
		usageEmpty: '暂无用量记录',
		usageTopModels: '常用',
		usageTrend: '近 14 天趋势',
		usageLedger: '账本',
		usageNote: '积分为余额下降量估算，含套餐重置/赠包过期等非消费变动，仅供参考；Token 取响应 usage 字段',
		usageWarn: '累计积分消耗含非消费性余额变动（套餐重置 / 赠送包过期），仅供参考，不等于实际扣费',
		usageFailed: '用量读取失败',
		usageSuccess: '成功率 {value}%',
		usageShare: '占请求 {value}%',
		showIdle: '显示空闲平台 ({count})',
		hideIdle: '隐藏空闲平台',
		};
		const en = {
		nav: 'Camel Pool',
		panelTitle: 'Camel Pool',
		caTitle: 'CodeArts pool',
		caShort: 'CodeArts',
		caOk: 'OK',
		caTokenExpired: 'Credential expired, sign in again',
		caReadFailed: 'Credits read failed',
		caStale: 'Credential needs renewal',
		caNoCredits: 'No available credits',
		caSignedOut: 'Not connected',
		caRelogin: 'Sign in again',
		caLoggingIn: 'Preparing…',
		caRefresh: 'Refresh',
		expiryTitle: 'Expiring soon',
		expiryNone: 'No expiry data',
		expiryMissing: '{count} without expiry',
		expiryEstimated: 'est.',
		expiryMore: '+{count} more',
		routeStale: 'offline · {time}',
		routeStaleHint: 'upstream unreachable; showing the last good reading',
		triggerHint: 'Show pooled credits, routes and package details',
		remaining: 'Remaining',
		loading: 'Loading…',
		unavailable: 'Credits unavailable',
		stale: 'Data may be stale, refresh recommended',
		refresh: 'Refresh',
		refreshing: 'Refreshing…',
		close: 'Close panel',
		copy: 'Copy summary',
		copied: 'Copied',
		checkinAll: 'Check in all',
		checkinBusy: 'Checking in…',
		checkinDone: 'Submitted',
		checkinFailed: 'Failed',
		checkinHint: 'Host claims idempotently on open; use this for a manual retry',
		autoCheckin: 'Auto check-in',
		autoCheckinOn: 'On',
		autoCheckinOff: 'Off',
		autoCheckinHint: 'Claim available check-ins automatically when the UI opens',
		autoCheckinShort: 'Auto-claim on open',
		active: 'Active',
		inactive: 'Disabled',
		disabledHint: 'Pool is disabled; the picker falls back to native per-channel groups',
		effortAuto: 'Highest effort (auto)',
		order: 'Order',
		orderCredits: 'Credits first',
		orderVoucher: 'Voucher first',
		models: '{count} models',
		routes: '{count} routes',
		routesTitle: 'Channel routes (by priority)',
		noRoutes: 'No routes',
		accountsTitle: 'Package details',
		searchPlaceholder: 'Search channel or package…',
		hideZero: 'Available ({count})',
		showZero: 'All ({count})',
		showAll: 'Show all {count}',
		showLess: 'Collapse',
		noMatch: 'No matching package',
		broken: 'broken {count}',
		brokenNone: 'No breakers',
		voucher: 'voucher',
		remainingShort: 'left {value}',
		unlimitedQuota: 'Unlimited',
		packages: '{count} pkgs',
		patch: 'kernel {patch}',
		fetchedAt: 'Updated {time}',
		justNow: 'just now',
		secondsAgo: '{n}s ago',
		minutesAgo: '{n}m ago',
		hoursAgo: '{n}h ago',
		errorTitle: 'Load failed',
		retry: 'Retry',
		lowCredit: 'Low',
		probing: 'Probing',
		routeError: 'Unavailable',
		dialogLabel: 'Camel Pool credits panel',
		summaryCopied: 'Summary copied to clipboard',
		updatedLive: 'Credits updated',
		costFirst: 'Sort by value',
		costFirstHint: 'Reorder only these curated models: free first, then lowest rate',
		costFirstShort: 'Free first, then lowest rate',
		voucherFirstPref: 'Voucher first',
		voucherFirstHint: 'Prefer vouchers; otherwise use credits expiring soonest',
		voucherFirstShort: 'Use vouchers before credits',
		poolEnabled: 'Enable pool',
		poolEnabledHint: 'On → picker lists merged models; off → native per-channel groups',
		poolEnabledShort: 'Merge all channels in model picker',
		voucherBalance: 'Aliyun Bailian vouchers',
		voucherSpend: 'used {value}',
		voucherBudget: 'budget {value}',
		expiresSoonest: 'exp {time}',
		coupons: '{count} coupons',
		freeUntil: 'Free until {time}',
		freeLeft: '{d}d {h}h left',
		freeNow: 'Limited-time free',
		noOffers: 'No limited-time free models right now',
		modelOffers: 'Free offers',
		expiry: 'exp {time}',
		rate: 'rate {value}',
		sortBy: 'List order',
		modelLibrary: 'Model library',
		curatedCount: '{count} curated',
		curatedBadge: 'allowlist',
		routeSource: 'via',
		libFree: 'Free',
		libHint: 'Mirrors conversation model picker',
		showRoutes: 'Show route source',
		showRoutesHint: 'On appends channel names; off keeps clean model names in the picker',
		showRoutesShort: 'Append channel name in picker',
		autoBoost: 'Auto-boost effort',
		autoBoostHint: 'When on, switching models raises thinking effort to the highest level (slower, deeper); off keeps your chosen effort',
		autoBoostShort: 'Max thinking effort on switch',
		burnExpiring: 'Burn expiring first',
		burnExpiringHint: 'When on, same-day check-in credits (e.g. Huawei daily 100) are consumed before other routes; on by default',
		burnExpiringShort: 'Prioritize same-day expiring credits',
		libOptsTitle: 'Routing & display preferences',
		usageTitle: 'Usage',
		detailTitle: 'Details & settings',
		tabOverview: 'Overview',
		tabUsage: 'Usage',
		tabDetail: 'Details',
		usageDay: 'Today',
		usageWeek: 'This week',
		usageMonth: 'This month',
		usageAll: 'All time',
		usageRange: 'Range',
		usageCredits: 'Credits used',
		usageTokens: 'Total tokens',
		usageInput: 'Input',
		usageOutput: 'Output',
		usageCache: 'Cache read',
		usageRequests: 'Requests / failed',
		usageByPlatform: 'By platform',
		usageEmpty: 'No usage yet',
		usageTopModels: 'Top',
		usageTrend: 'Last 14 days',
		usageLedger: 'Ledger',
		usageNote: 'credits estimated from balance drops (includes plan resets / bonus expiry), tokens from response usage',
		usageWarn: 'Cumulative credits include non-consumption balance changes (plan resets / bonus expiry); for reference only, not actual billing',
		usageFailed: 'Failed to load usage',
		usageSuccess: 'Success {value}%',
		usageShare: '{value}% of requests',
		showIdle: 'Show idle platforms ({count})',
		hideIdle: 'Hide idle platforms',
		};

		function safeT(fn) {
		return (key, params) => {
		try {
		const raw = typeof fn === 'function' ? fn(key, params) : undefined;
		const base = typeof raw === 'string' && raw !== '' && raw !== key ? raw : (zh[key] ?? en[key] ?? key);
		if (params === undefined) return base;
		return String(base).replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined ? m : String(params[k])));
		} catch {
		return zh[key] ?? en[key] ?? key;
		}
		};
		}

		function fmt(value) {
		if (value === null || value === undefined || value === '') return '—';
		const n = Number(value);
		if (!Number.isFinite(n)) return '—';
		return n.toLocaleString('zh-CN', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
		}
		function clock(ms) {
		if (!Number.isFinite(ms) || ms <= 0) return '';
		try { return new Date(ms).toLocaleString('zh-CN', { hour12: false }); } catch { return ''; }
		}
		function shortClock(v) {
		if (v === undefined || v === null || v === '') return '';
		const ms = typeof v === 'number' ? v : Date.parse(String(v));
		if (!Number.isFinite(ms) || ms <= 0) return String(v);
		const d = new Date(ms);
		const nowY = new Date().getFullYear();
		const y = d.getFullYear();
		const mo = String(d.getMonth() + 1).padStart(2, '0');
		const da = String(d.getDate()).padStart(2, '0');
		const hh = String(d.getHours()).padStart(2, '0');
		const mm = String(d.getMinutes()).padStart(2, '0');
		if (y !== nowY) return y + '-' + mo + '-' + da;
		return mo + '-' + da + ' ' + hh + ':' + mm;
		}
		function ago(ms, t) {
		if (!Number.isFinite(ms) || ms <= 0) return '';
		const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
		if (s < 5) return t('justNow');
		if (s < 60) return t('secondsAgo', { n: s });
		if (s < 3600) return t('minutesAgo', { n: Math.floor(s / 60) });
		return t('hoursAgo', { n: Math.floor(s / 3600) });
		}
		function pct(value, max) {
		const v = Number(value), m = Number(max);
		if (!Number.isFinite(v) || !Number.isFinite(m) || m <= 0 || v <= 0) return 0;
		return Math.max(2, Math.min(100, Math.round(v / m * 100)));
		}

		const PCSS = [
		'.dcp-side{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:inherit;font-size:13px;cursor:pointer;text-align:left;transition:background .15s ease}',
		'.dcp-side:hover,.dcp-side:focus-visible{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.1));outline:2px solid var(--dsw-alias-state-brand-primary,#4c7cf3);outline-offset:-2px}',
		'.dcp-side__ico{display:inline-flex;flex:none;width:16px;height:16px;color:var(--dsw-alias-state-ok-primary,#2e9e6b)}',
		'.dcp-side__ico--warn{color:var(--dsw-alias-state-warn-primary,#e0a020)}',
		'.dcp-side__label{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
		'.dcp-side__value{flex:none;font-variant-numeric:tabular-nums;font-weight:600;color:var(--dsw-alias-state-ok-primary,#2e9e6b)}',
		'.dcp-side__value--warn{color:var(--dsw-alias-state-warn-primary,#e0a020)}',
		'.dcp-side__value--off{color:var(--dsw-alias-label-tertiary,#888)}',
		'.dcp-side__dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-ok-primary,#2e9e6b)}',
		'.dcp-side__dot--warn{background:var(--dsw-alias-state-warn-primary,#e0a020)}',
		'.dcp-side__dot--off{background:var(--dsw-alias-label-tertiary,#888)}',
		'.dcp-side--rail{justify-content:center;padding:7px 0;position:relative}',
		'.dcp-side--rail .dcp-side__label,.dcp-side--rail .dcp-side__value{display:none}',
		'.dcp-side--rail .dcp-side__dot{position:absolute;top:5px;right:5px;width:5px;height:5px}',
		'.dcp-pop{position:fixed;z-index:9999;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-shadow-lv2,0 8px 28px rgba(0,0,0,.18));color:var(--dsw-alias-label-primary,#222);font-size:13px;backdrop-filter:blur(8px)}',
		'.dcp-pop:focus{outline:none}',
		'.dcp-head{display:flex;align-items:center;gap:8px;flex:none;padding:9px 14px;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.14));background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-state-brand-primary,#4c7cf3) 10%,transparent),transparent 72%)}',
		'.dcp-head__title{flex:1;min-width:0;display:flex;align-items:baseline;gap:8px;font-size:14px;font-weight:600;letter-spacing:.01em;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
		'.dcp-head__state{flex:none;font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums}',
		'.dcp-btn{flex:none;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:6px;background:transparent;color:inherit;font-size:12px;cursor:pointer;transition:background .15s ease,opacity .15s ease}',
		'.dcp-btn:hover:not(:disabled),.dcp-btn:focus-visible{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.1));outline:2px solid var(--dsw-alias-state-brand-primary,#4c7cf3);outline-offset:1px}',
		'.dcp-btn:disabled{opacity:.55;cursor:default}',
		'.dcp-btn--primary{border-color:var(--dsw-alias-state-brand-primary,#4c7cf3);color:var(--dsw-alias-state-brand-primary,#4c7cf3);background:color-mix(in srgb,var(--dsw-alias-state-brand-primary,#4c7cf3) 12%,transparent)}',
		'.dcp-btn--sm{padding:2px 8px;font-size:11px}',
		'.dcp-btn--icon{padding:2px 7px;font-size:15px;line-height:1.2}',
		'.dcp-live{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 14px;font-size:11px;color:var(--dsw-alias-state-warn-primary,#e0a020);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e0a020) 10%,transparent);border-bottom:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.12))}',
		'.dcp-live--err{color:var(--dsw-alias-state-error-primary,#d9534f);background:rgba(217,83,79,.08)}',
		'.dcp-live--sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
		'.dcp-cabar{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 14px;font-size:11px;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,#555)}',
		'.dcp-cabar--ok{background:color-mix(in srgb,var(--dsw-alias-state-ok-primary,#2e9e6b) 8%,transparent)}',
		'.dcp-cabar--warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e0a020) 12%,transparent);color:var(--dsw-alias-state-warn-primary,#e0a020)}',
		'.dcp-cabar__label{font-weight:600;flex:none}',
		'.dcp-cabar__value{flex:1;min-width:0;font-variant-numeric:tabular-nums;font-size:11px;font-weight:600}',
		'.dcp-cabar__tag{font-size:10px;font-weight:400;opacity:.95}',
		'.dcp-cabar .dcp-btn{font-size:11px;padding:2px 8px}',
		'.dcp-expbar{display:flex;align-items:center;gap:4px;flex-wrap:nowrap;padding:5px 9px;margin-bottom:9px;border-radius:8px;font-size:10px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.14));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.04));color:var(--dsw-alias-label-tertiary,#888);overflow:hidden}',
		'.dcp-expbar--open{flex-wrap:wrap}',
		'.dcp-expbar__label{font-weight:600;flex:none;color:var(--dsw-alias-label-secondary,#555);margin-right:2px}',
		'.dcp-expbar__chip{display:inline-flex;align-items:center;gap:3px;min-width:0;padding:1px 5px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.16));border-radius:5px;background:rgba(127,127,127,.05)}',
		'.dcp-expbar__name{max-width:74px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
		'.dcp-expbar__time{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#555)}',
		'.dcp-expbar__none{opacity:.8}',
		'.dcp-expbar__chip--est{border-style:dashed;opacity:.9}',
		'.dcp-expbar__toggle{flex:none;margin-left:auto;padding:1px 5px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-state-brand-primary,#4c7cf3);font-size:10px;font-weight:500;cursor:pointer}',
		'.dcp-expbar__toggle:hover{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.1))}',
		'.dcp-body{flex:1 1 auto;overflow:auto;padding:10px 14px 14px;scrollbar-width:thin;scroll-behavior:smooth}',
		'.dcp-total{padding:10px 12px;border-radius:10px;background:rgba(46,158,107,.10);background:color-mix(in srgb,var(--dsw-alias-state-ok-primary,#2e9e6b) 10%,transparent);box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 3px 12px rgba(46,158,107,.08);margin-bottom:8px}',
		'.dcp-total--off{background:rgba(127,127,127,.10);box-shadow:none}',
		'.dcp-total__top{display:flex;align-items:center;justify-content:space-between;gap:8px}',
		'.dcp-total__label{font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary,#555)}',
		'.dcp-total__badges{display:flex;align-items:center;gap:4px;flex-wrap:wrap}',
		'.dcp-total__main{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-top:2px;flex-wrap:wrap}',
		'.dcp-total__value{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.25;letter-spacing:-.02em;color:var(--dsw-alias-state-ok-primary,#2e9e6b)}',
		'.dcp-total__value--off{color:var(--dsw-alias-label-tertiary,#888)}',
		'.dcp-total__sub{margin-top:2px;font-size:11px;color:var(--dsw-alias-label-tertiary,#888)}',
		'.dcp-meta{display:flex;flex-wrap:wrap;gap:4px 8px;font-size:11px;color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums}',
		'.dcp-meta__item{display:inline-flex;align-items:center;gap:3px}',
		'.dcp-sec{margin-top:10px}',
		'.dcp-sec:first-child{margin-top:0}',
		'.dcp-sec__head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px}',
		'.dcp-sec__title{flex:1;display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;letter-spacing:.03em;color:var(--dsw-alias-label-secondary,#555);text-transform:uppercase}',
		'.dcp-sec__title::before{content:" ";width:3px;height:11px;border-radius:2px;background:var(--dsw-alias-state-brand-primary,#4c7cf3);opacity:.8}',
		'.dcp-row{display:flex;align-items:center;gap:8px;padding:4.5px 0;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.10))}',
		'.dcp-row:last-child{border-bottom:0}',
		'.dcp-row--zero{opacity:.52}',
		'.dcp-row__main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}',
		'.dcp-row__line{display:flex;align-items:center;gap:6px;min-width:0}',
		'.dcp-row__name{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px}',
		'.dcp-row__num{flex:none;font-variant-numeric:tabular-nums;font-size:11.5px;color:var(--dsw-alias-label-secondary,#555)}',
		'.dcp-row__bar{height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));overflow:hidden}',
		'.dcp-row__barfill{height:100%;border-radius:2px;background:var(--dsw-alias-state-ok-primary,#2e9e6b)}',
		'.dcp-row__barfill--low{background:var(--dsw-alias-state-warn-primary,#e0a020)}',
		'.dcp-row__barfill--err{background:var(--dsw-alias-state-error-primary,#d9534f)}',
		'.dcp-tag{flex:none;padding:1px 6px;border-radius:999px;font-size:10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-tertiary,#888)}',
		'.dcp-tag--ok{background:rgba(46,158,107,.14);color:var(--dsw-alias-state-ok-primary,#2e9e6b)}',
		'.dcp-tag--warn{background:rgba(224,160,32,.16);color:var(--dsw-alias-state-warn-primary,#e0a020)}',
		'.dcp-tag--err{background:rgba(217,83,79,.14);color:var(--dsw-alias-state-error-primary,#d9534f)}',
		'.dcp-tag--voucher{background:rgba(76,124,243,.14);color:var(--dsw-alias-state-brand-primary,#4c7cf3)}',
		'.dcp-switch{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:5px 8px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.14));border-radius:7px;background:transparent;color:inherit;font-size:11px;cursor:pointer;text-align:left}',
		'.dcp-switch:hover:not(:disabled),.dcp-switch:focus-visible{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.1));outline:2px solid var(--dsw-alias-state-brand-primary,#4c7cf3);outline-offset:-2px}',
		'.dcp-switch:disabled{opacity:.6;cursor:default}',
		'.dcp-switch__text{flex:1;min-width:0;font-weight:500;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
		'.dcp-switch__hint{display:block;margin-top:1px;font-size:9.5px;font-weight:400;color:var(--dsw-alias-label-tertiary,#888);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
		'.dcp-switch__track{flex:none;width:26px;height:15px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.28));position:relative;transition:background .15s ease}',
		'.dcp-switch__track--on{background:var(--dsw-alias-state-brand-primary,#4c7cf3)}',
		'.dcp-switch__knob{position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:50%;background:#fff;transition:transform .15s ease}',
		'.dcp-switch__track--on .dcp-switch__knob{transform:translateX(11px)}',
		'.dcp-filterbar{display:flex;align-items:center;gap:6px;margin-bottom:4px}',
		'.dcp-input{flex:1;min-width:0;box-sizing:border-box;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:6px;background:transparent;color:inherit;font-size:11px}',
		'.dcp-input:focus-visible{outline:2px solid var(--dsw-alias-state-brand-primary,#4c7cf3);outline-offset:1px}',
		'.dcp-more{margin-top:5px;width:100%;padding:4px;border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:6px;background:transparent;color:inherit;font-size:11px;cursor:pointer}',
		'.dcp-more:hover,.dcp-more:focus-visible{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.1));outline:2px solid var(--dsw-alias-state-brand-primary,#4c7cf3);outline-offset:1px}',
		'.dcp-note{margin-top:8px;display:flex;align-items:center;gap:8px;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#888);word-break:break-all}',
		'.dcp-note__text{flex:1;min-width:0;opacity:.85;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
		'.dcp-warn{color:var(--dsw-alias-state-warn-primary,#e0a020)}',
		'.dcp-err{color:var(--dsw-alias-state-error-primary,#d9534f)}',
		'.dcp-empty{padding:8px 0;font-size:11px;color:var(--dsw-alias-label-tertiary,#888);text-align:center}',
		'.dcp-skel{display:inline-block;width:38px;height:12px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16))}',
		'.dcp-card{margin-top:7px;padding:6px 10px;border-radius:8px;border:1px solid rgba(76,124,243,.26);background:rgba(76,124,243,.06)}',
		'.dcp-card__head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
		'.dcp-card__title{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#555)}',
		'.dcp-card__value{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-state-brand-primary,#4c7cf3)}',
		'.dcp-card__sub{margin-top:1px;font-size:10px;color:var(--dsw-alias-label-tertiary,#888)}',
		'.dcp-card__row{display:flex;align-items:center;gap:8px;padding:3px 0;border-top:1px dashed var(--dsw-alias-border-l3,rgba(127,127,127,.12));margin-top:3px;font-size:11px}',
		'.dcp-card__rowname{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
		'.dcp-offers{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:5px 8px;margin-top:8px;border-radius:7px;border:1px solid rgba(46,158,107,.22);background:rgba(46,158,107,.06);font-size:10px}',
		'.dcp-offers__label{font-weight:600;color:var(--dsw-alias-state-ok-primary,#2e9e6b);margin-right:2px}',
		'.dcp-offers__chip{display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:5px;background:rgba(46,158,107,.12);color:var(--dsw-alias-label-primary,#222)}',
		'.dcp-offers__sub{color:var(--dsw-alias-state-ok-primary,#2e9e6b);font-variant-numeric:tabular-nums}',
		'.dcp-tag--free{background:rgba(46,158,107,.16);color:var(--dsw-alias-state-ok-primary,#2e9e6b)}',
		'.dcp-expiry{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums}',
		'.dcp-switch--aux{padding:5px 8px}',
		'.dcp-switch--span{grid-column:1 / -1}',
		'.dcp-lib{margin-top:10px}',
		'.dcp-lib__head{display:flex;align-items:center;gap:6px;margin-bottom:4px}',
		'.dcp-lib__count{flex:none;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:600;background:color-mix(in srgb,var(--dsw-alias-state-brand-primary,#4c7cf3) 16%,transparent);color:var(--dsw-alias-state-brand-primary,#4c7cf3)}',
		'.dcp-lib__opts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;margin:4px 0 6px;padding:6px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.14));border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.04))}',
		'.dcp-lib__list{display:flex;flex-direction:column;gap:2px;max-height:176px;overflow:auto;scrollbar-width:thin;padding-right:2px}',
		'.dcp-lib__row{display:flex;align-items:center;gap:7px;padding:3.5px 6px;border:1px solid transparent;border-radius:6px;transition:background .15s ease,border-color .15s ease}',
		'.dcp-lib__row:hover{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.08));border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.12))}',
		'.dcp-lib__row:focus-within{outline:2px solid var(--dsw-alias-state-brand-primary,#4c7cf3);outline-offset:1px}',
		'.dcp-lib__rank{flex:none;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));font-size:10px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#888)}',
		'.dcp-lib__rank--top{background:color-mix(in srgb,var(--dsw-alias-state-ok-primary,#2e9e6b) 18%,transparent);color:var(--dsw-alias-state-ok-primary,#2e9e6b)}',
		'.dcp-lib__main{flex:1;min-width:0;display:flex;align-items:center;gap:6px}',
		'.dcp-lib__name{font-size:11.5px;font-weight:500;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
		'.dcp-lib__src{display:inline-flex;flex-wrap:wrap;align-items:center;gap:3px}',
		'.dcp-lib__chip{padding:0 5px;border-radius:999px;font-size:9px;line-height:14px;background:color-mix(in srgb,var(--dsw-alias-state-brand-primary,#4c7cf3) 12%,transparent);color:var(--dsw-alias-state-brand-primary,#4c7cf3)}',
		'.dcp-lib__chip--lead{display:none}',
		'.dcp-lib__tags{flex:none;display:flex;align-items:center;gap:4px}',
		'.dcp-lib__free{padding:1px 6px;border-radius:999px;font-size:9px;font-weight:600;background:rgba(46,158,107,.16);color:var(--dsw-alias-state-ok-primary,#2e9e6b)}',
		'.dcp-lib__rate{padding:1px 6px;border-radius:999px;font-size:9px;font-variant-numeric:tabular-nums;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-tertiary,#888)}',
		'.dcp-lib__effort{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;font-size:9px;font-weight:600;background:color-mix(in srgb,var(--dsw-alias-state-brand-primary,#4c7cf3) 12%,transparent);color:var(--dsw-alias-state-brand-primary,#4c7cf3)}',
		'.dcp-tabs{display:flex;gap:4px;flex:none;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.12))}',
		'.dcp-tab{flex:1;padding:4px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#555);font-size:12px;cursor:pointer;transition:background .15s ease,color .15s ease}',
		'.dcp-tab:hover{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.1))}',
		'.dcp-tab--on{background:color-mix(in srgb,var(--dsw-alias-state-brand-primary,#4c7cf3) 16%,transparent);color:var(--dsw-alias-state-brand-primary,#4c7cf3);font-weight:600}',
		'.dcp-usage{display:flex;flex-direction:column;gap:7px}',
		'.dcp-usage__tabs{display:flex;align-items:center;gap:4px;flex-wrap:wrap}',
		'.dcp-usage__tab{padding:3px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:6px;background:transparent;color:inherit;font-size:11px;cursor:pointer}',
		'.dcp-usage__tab--on{border-color:var(--dsw-alias-state-brand-primary,#4c7cf3);background:color-mix(in srgb,var(--dsw-alias-state-brand-primary,#4c7cf3) 12%,transparent);color:var(--dsw-alias-state-brand-primary,#4c7cf3);font-weight:600}',
		'.dcp-usage__range{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums}',
		'.dcp-usage__grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}',
		'.dcp-usage__stat{padding:6px 8px;border-radius:7px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06))}',
		'.dcp-usage__stat-label{font-size:10px;color:var(--dsw-alias-label-tertiary,#888)}',
		'.dcp-usage__stat-value{margin-top:2px;font-size:13.5px;font-weight:600;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
		'.dcp-usage__h3{margin-top:4px}',
		'.dcp-usage__plat{padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.10))}',
		'.dcp-usage__plat-head{display:flex;align-items:center;gap:8px}',
		'.dcp-usage__plat-name{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:11.5px;font-weight:500}',
		'.dcp-usage__muted{margin-top:2px;font-size:10px;color:var(--dsw-alias-label-tertiary,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
		'.dcp-usage__trend{display:flex;align-items:flex-end;gap:3px;height:52px;padding:3px 0}',
		'.dcp-usage__trend-col{flex:1;height:100%;display:flex;align-items:flex-end}',
		'.dcp-usage__trend-bar{width:100%;border-radius:3px 3px 0 0;background:var(--dsw-alias-state-brand-primary,#4c7cf3)}',
		'.dcp-usage__fail{color:var(--dsw-alias-state-error-primary,#d9534f);font-weight:600}',
		'.dcp-usage__trend-labels{display:flex;justify-content:space-between;font-size:10px;color:var(--dsw-alias-label-tertiary,#888)}',
		'.dcp-usage__foot{font-size:10px;color:var(--dsw-alias-label-tertiary,#888);line-height:1.4}',
		'.dcp-usage__warn{padding:7px 9px;border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e6a700) 14%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e6a700) 40%,transparent);color:var(--dsw-alias-state-warn-primary,#b97d00);font-size:10.5px;line-height:1.45}',
		'@media (prefers-reduced-motion: reduce){.dcp-side,.dcp-btn,.dcp-switch__track,.dcp-switch__knob,.dcp-lib__row,.dcp-body,.dcp-tab{transition:none;scroll-behavior:auto}}',
		].join('');
		function ensureStyle() {
		try { ensurePolishStyle(); } catch (error) {}
		if (typeof document === 'undefined' || document.head === undefined) return;
		if (document.getElementById(STYLE_ID) !== null) return;
		const node = document.createElement('style');
		node.id = STYLE_ID;
		node.textContent = PCSS;
		document.head.appendChild(node);
		}
		const POOL_ICON = react.createElement('svg', {
		width: '16', height: '16', viewBox: '0 0 16 16', fill: 'none',
		stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
		},
		react.createElement('path', { d: 'M2 11.5h12M3 11.5V8m3.3 3.5V5.5m3.4 6V7m3.3 4.5V3.5' }),
		react.createElement('path', { d: 'M2.5 3.2c2-1.6 4-1.6 5.5 0 1.5-1.6 3.5-1.6 5.5 0' }),
		);

		/** 只认我们自己那份状态文档，脏数据一律不进 state。 */
		function isPoolDoc(v) {
		return v !== null && typeof v === 'object' && v.provider === 'dsh-pool' && v.credits !== undefined && typeof v.credits === 'object';
		}

		// ---- 共享状态：侧栏与弹窗共用一份请求，避免双 fetch 与数字互相打架 ----
		let shared = { doc: undefined, at: 0, busy: false, error: '', prefs: undefined, prefsBusy: false };
		const listeners = new Set();
		const pendingTimers = new Set();
		function later(fn, ms) {
			const id = setTimeout(() => { pendingTimers.delete(id); fn(); }, ms);
			pendingTimers.add(id);
			return id;
		}
		function clearLater() {
			for (const id of Array.from(pendingTimers)) clearTimeout(id);
			pendingTimers.clear();
		}
		function emit() { for (const fn of Array.from(listeners)) { try { fn(); } catch { /* 单个订阅者出错不影响其余 */ } } }
		function patch(next) { shared = Object.assign({}, shared, next); emit(); }

		let inFlight = null;
		function loadPool(force) {
		if (inFlight !== null) return inFlight;
		patch({ busy: true, error: '' });
		const ctrl = new AbortController();
		const to = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
		const url = POOL_STATUS_PATH + (force === true ? '?refresh=1' : '');
		inFlight = fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' }, signal: ctrl.signal })
		.then(async (r) => {
		if (!r.ok) throw new Error('HTTP ' + r.status);
		const v = await r.json().catch(() => undefined);
		if (!isPoolDoc(v)) throw new Error('unexpected payload');
		patch({ doc: v, at: Date.now(), error: '' });
		})
		.catch((e) => { patch({ error: String((e && e.message) || e) }); })
		.finally(() => { clearTimeout(to); inFlight = null; patch({ busy: false }); });
		return inFlight;
		}
		function loadPrefs() {
		return fetch(POOL_SETTINGS_PATH, { credentials: 'same-origin', headers: { accept: 'application/json' } })
		.then((r) => (r.ok ? r.json() : undefined))
		.then((v) => { if (v !== null && typeof v === 'object' && 'autoCheckin' in v) patch({ prefs: v }); })
		.catch(() => { /* 设置读不到时开关保持禁用态 */ });
		}
		function setAutoCheckin(on) {
		patch({ prefsBusy: true });
		return fetch(POOL_SETTINGS_PATH, {
		method: 'POST', credentials: 'same-origin',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({ autoCheckin: on === true }),
		})
		.then((r) => (r.ok ? r.json() : undefined))
		.then((v) => { patch({ prefs: (v !== null && typeof v === 'object' && 'autoCheckin' in v) ? v : Object.assign({}, shared.prefs, { autoCheckin: on === true }) }); })
		.catch(() => { /* 失败时保留原值，下次打开会重读 */ })
		.finally(() => { patch({ prefsBusy: false }); });
		}
		function setPref(key, on) {
		const body = {}; body[key] = on === true;
		patch({ prefsBusy: true });
		return fetch(POOL_SETTINGS_PATH, {
		method: 'POST', credentials: 'same-origin',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify(body),
		})
		.then((r) => (r.ok ? r.json() : undefined))
		.then((v) => {
		const next = (v !== null && typeof v === 'object' && 'autoCheckin' in v) ? v : Object.assign({}, shared.prefs, body);
		patch({ prefs: next });
		later(() => { void loadPool(false); }, 400);
		})
		.catch(() => { /* 失败时保留原值，下次打开会重读 */ })
		.finally(() => { patch({ prefsBusy: false }); });
		}
		function clockIso(v) {
		if (v === undefined || v === null || v === '') return '';
		const ms = Date.parse(String(v));
		return Number.isFinite(ms) ? clock(ms) : String(v);
		}
		function expiryRaw(a) {
		if (!a || typeof a !== 'object') return '';
		const raw = a.endTimeMs ?? a.endTime ?? a.expireAt ?? a.expiresAt ?? a.expiry ?? a.expireTime;
		if (raw === undefined || raw === null || raw === '') return '';
		return raw;
		}
		function expiryText(a) {
		const raw = expiryRaw(a);
		if (raw === '') return '';
		return shortClock(raw);
		}
		function expiryFullText(a) {
		const raw = expiryRaw(a);
		if (raw === '') return '';
		const ms = typeof raw === 'number' ? raw : Date.parse(String(raw));
		return clock(ms) || String(raw);
		}
		function cleanAccountLabel(a, idx) {
		const r = String((a && a.route) || '').trim();
		const p = String((a && a.packageName) || '').trim();
		const shortRoute = r.includes(':') ? r.split(':').pop() : r;
		return { badge: shortRoute, name: p || shortRoute || ('account ' + (idx + 1)), full: [r, p].filter(Boolean).join(' · ') };
		}
		function freeLeft(v) {
		const ms = Date.parse(String(v || ''));
		if (!Number.isFinite(ms)) return '';
		const diff = ms - Date.now();
		if (diff <= 0) return '';
		return { d: Math.floor(diff / 86400000), h: Math.floor((diff % 86400000) / 3600000) };
		}
		function doCheckin() {
		return fetch(POOL_CHECKIN_PATH, { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' } })
		.then((r) => ({ ok: r.ok, body: r.json().catch(() => undefined) }));
		}
		function copySummary(t) {
		const s = shared.doc;
		if (s === undefined) return;
		const routes = Array.isArray(s.pool && s.pool.routes) ? s.pool.routes : [];
		const lines = [
		t('panelTitle'),
		t('remaining') + ': ' + fmt(s.credits && s.credits.total),
		t('models', { count: Array.isArray(s.models) ? s.models.length : 0 }) + ' / ' + t('routes', { count: routes.length }),
		t('order') + ': ' + ((s.pool && s.pool.voucherFirst) === true ? t('orderVoucher') : t('orderCredits')),
		];
		for (const r of routes) {
		lines.push('  - ' + String((r && (r.displayName || r.key)) || '?') + '  ' + t('remainingShort', { value: fmt(r && r.remaining) }));
		if (r && r.voucher === true && (Array.isArray(r.coupons) || Number.isFinite(Number(r.maxBudget)))) {
		lines.push('      ' + t('voucherBalance') + ' · ' + t('voucherBudget', { value: fmt(r.maxBudget) }) + ' · ' + t('voucherSpend', { value: fmt(r.spend) }) + (Array.isArray(r.coupons) ? ' · ' + t('coupons', { count: r.coupons.length }) : ''));
		}
		}
		const allModels = Array.isArray(s.models) ? s.models : [];
		for (const m of allModels) {
		if (m && (m.free === true || (m.freeUntil !== undefined && Date.parse(String(m.freeUntil)) > Date.now()))) {
		lines.push('  * ' + String((m.name || m.id) || '?') + '  ' + (m.freeUntil !== undefined ? t('freeUntil', { time: clockIso(m.freeUntil) }) : t('freeNow')));
		}
		}
		lines.push('');
		lines.push(t('modelLibrary') + ' · ' + t('curatedCount', { count: allModels.length }));
		for (let li = 0; li < allModels.length; li++) {
		const lm = allModels[li];
		const ln = String((lm && lm.name) || (lm && lm.id) || '?');
		const lt = (lm && lm.free === true) ? ' [' + t('libFree') + ']' : (lm && lm.rate !== undefined ? ' ' + t('rate', { value: fmt(lm.rate) }) : '');
		lines.push('  ' + String(li + 1) + '. ' + ln + lt);
		}
		lines.push(t('patch', { patch: String(s.patch || '-') }) + ' · ' + t('fetchedAt', { time: clock(shared.at) }));
		try { if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') navigator.clipboard.writeText(lines.join('\n')); } catch { /* 剪贴板不可用时静默 */ }
		}

		function usePool(live) {
		const [, bump] = react.useState(0);
		react.useEffect(() => {
		const fn = () => bump((v) => v + 1);
		listeners.add(fn);
		if (shared.doc === undefined && !shared.busy) void loadPool(false);
		if (shared.prefs === undefined) void loadPrefs();
		ensureStyle();
		return () => { listeners.delete(fn); };
		}, []);
		react.useEffect(() => {
		if (live !== true) return undefined;
		void loadPool(true);
		const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void loadPool(false); }, POLL_MS);
		const onVis = () => { if (document.visibilityState === 'visible') void loadPool(false); };
		document.addEventListener('visibilitychange', onVis);
		return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVis); };
		}, [live]);
		return Object.assign({}, shared, { reload: () => loadPool(true) });
		}

		function tokenTotal(obj) {
		const t = obj && obj.tokens ? obj.tokens : {};
		return Number(t.total) || (Number(t.input || 0) + Number(t.output || 0));
		}

		function useUsage(live) {
		const [doc, setDoc] = react.useState(undefined);
		const [failed, setFailed] = react.useState(false);
		const loadRef = react.useRef(undefined);
		react.useEffect(() => {
		if (live !== true) return undefined;
		let alive = true;
		let inFlight = false;
		const load = async () => {
		if (inFlight) return;
		inFlight = true;
		try {
		const response = await fetch(POOL_USAGE_PATH, { credentials: 'same-origin', headers: { accept: 'application/json' } });
		if (!response.ok) throw new Error(String(response.status));
		const value = await response.json();
		if (alive && value && value.ok === true && value.windows) { setDoc(value); setFailed(false); }
		} catch { if (alive) setFailed(true); }
		finally { inFlight = false; }
		};
		const safeLoad = () => { if (document.visibilityState !== 'hidden') void load(); };
		const onVis = () => { if (document.visibilityState === 'visible') void load(); };
		loadRef.current = load;
		void load();
		const timer = window.setInterval(safeLoad, POLL_MS);
		document.addEventListener('visibilitychange', onVis);
		return () => { alive = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVis); loadRef.current = undefined; };
		}, [live]);
		const reload = react.useCallback(() => { const fn = loadRef.current; if (fn !== undefined) void fn(); }, []);
		return { doc, failed, reload };
		}

		function UsageSection(props) {
		const t = props.t;
		const doc = props.doc;
		const [win, setWin] = react.useState('day');
		const [showIdle, setShowIdle] = react.useState(false); // ux-v33: 零活动平台默认折叠（Gemini Pro 等历史残留行不再占屏）
		if (doc === undefined || doc.windows === undefined) {
		return react.createElement('div', { className: 'dcp-sec' },
		react.createElement('div', { className: 'dcp-empty' }, props.failed ? t('usageFailed') : t('loading')),
		props.failed ? react.createElement('button', { type: 'button', className: 'dcp-btn', onClick: props.reload }, t('refresh')) : null);
		}
		const keys = ['day', 'week', 'month', 'all'];
		const labels = { day: 'usageDay', week: 'usageWeek', month: 'usageMonth', all: 'usageAll' };
		const w = doc.windows[win] || doc.windows.day;
		const platforms = Array.isArray(w.platforms) ? w.platforms : [];
		const trend = Array.isArray(doc.trend) ? doc.trend : [];
		const isIdlePlat = (p) => (Number(p.requests) || 0) === 0 && (Number(tokenTotal(p)) || 0) === 0 && (Number(p.credits) || 0) === 0;
		const idleCount = platforms.filter(isIdlePlat).length;
		const shownPlatforms = showIdle ? platforms : platforms.filter((p) => !isIdlePlat(p));
		const maxPlat = Math.max(1, ...platforms.map((p) => Number(p.requests) || 0));
		const maxTrend = Math.max(1, ...trend.map((d) => Number(d.requests) || 0));
		const stat = (label, value) => react.createElement('div', { key: label, className: 'dcp-usage__stat', title: label + ': ' + value },
		react.createElement('div', { className: 'dcp-usage__stat-label' }, label),
		react.createElement('div', { className: 'dcp-usage__stat-value' }, value));
		const rangeShort = String(w.from || '').slice(5) + ' ~ ' + String(w.to || '').slice(5);
		// ux-v34: 余额差记账曾把套餐重置/赠包过期累加成巨额假消耗，累计值远超当前额度时给出提示。
		const allCredits = Number(doc.windows && doc.windows.all && doc.windows.all.credits) || 0;
		const curCredits = Number(props.currentCredits);
		const creditsInflated = Number.isFinite(curCredits) && curCredits > 0 && allCredits > curCredits * 3 && (allCredits - curCredits) > 1000;
		return react.createElement('div', { className: 'dcp-usage' },
		react.createElement('div', { className: 'dcp-usage__tabs' },
		...keys.map((k) => react.createElement('button', {
		key: k, type: 'button', className: k === win ? 'dcp-usage__tab dcp-usage__tab--on' : 'dcp-usage__tab',
		onClick: () => setWin(k),
		}, t(labels[k]))),
		react.createElement('span', { className: 'dcp-usage__range', title: t('usageRange') + ' ' + String(w.from) + ' ～ ' + String(w.to) + ' · ' + String(doc.timezone) }, rangeShort)),
		react.createElement('div', { className: 'dcp-usage__grid' },
		stat(t('usageCredits'), fmt(w.credits)),
		stat(t('usageTokens'), fmt(tokenTotal(w))),
		stat(t('usageInput'), fmt(w.tokens && w.tokens.input)),
		stat(t('usageOutput'), fmt(w.tokens && w.tokens.output)),
		stat(t('usageCache'), fmt(w.tokens && w.tokens.cacheRead)),
		stat(t('usageRequests'), fmt(w.requests) + ' / ' + fmt(w.failed))),
		creditsInflated ? react.createElement('div', { className: 'dcp-usage__warn' }, t('usageWarn')) : null,
		react.createElement('div', { className: 'dcp-sec__title dcp-usage__h3' }, t('usageByPlatform')),
		platforms.length === 0
		? react.createElement('div', { className: 'dcp-empty' }, t('usageEmpty'))
		: react.createElement('div', null, ...shownPlatforms.map((p) => {
		const credits = Number(p.credits) || 0;
		const reqs = Number(p.requests) || 0;
		const models = Array.isArray(p.models) ? p.models.slice(0, 3) : [];
		const width = pct(reqs, maxPlat);
		const sharePct = (Number(w.requests) || 0) > 0 ? Math.round((reqs / (Number(w.requests) || 1)) * 100) : 0;
		// ux-v33：旧文案把「占总请求比」直接跟在 fail 后面写成 (94%)，Trae 12 请求全失败也显示 (1%)，
		// 读起来像失败率。改成成功率 + 明确标注的占比，fail>0 时标红。
		const servedN = Number(p.served) || 0;
		const failedN = Number(p.failed) || 0;
		const okRate = (servedN + failedN) > 0 ? Math.round((servedN / (servedN + failedN)) * 100) : null;
		const modelStr = models.length > 0 ? ' · ' + models.map((m) => String(m.name)).join(', ') : '';
		return react.createElement('div', { key: p.key, className: 'dcp-usage__plat' },
		react.createElement('div', { className: 'dcp-usage__plat-head' },
		react.createElement('span', { className: 'dcp-usage__plat-name' }, String(p.displayName || p.key)),
		react.createElement('span', { className: 'dcp-row__num' }, fmt(tokenTotal(p)) + ' tok · ' + fmt(reqs) + ' req')),
		react.createElement('div', { className: 'dcp-row__bar' },
		react.createElement('div', { className: 'dcp-row__barfill', style: { width: width + '%' } })),
		react.createElement('div', { className: 'dcp-usage__muted', title: modelStr ? t('usageTopModels') + ': ' + models.map((m) => String(m.name)).join(', ') : '' },
		fmt(credits) + ' cr · ok ' + fmt(p.served) + ' · ',
		react.createElement('span', { className: failedN > 0 ? 'dcp-usage__fail' : undefined }, 'fail ' + fmt(p.failed)),
		(okRate === null ? '' : ' · ' + t('usageSuccess', { value: okRate })) + ' · ' + t('usageShare', { value: sharePct }) + modelStr));
		})),
		idleCount > 0 ? react.createElement('button', { type: 'button', className: 'dcp-btn dcp-btn--sm', onClick: () => setShowIdle((v) => !v) }, showIdle ? t('hideIdle') : t('showIdle', { count: idleCount })) : null,
		react.createElement('div', { className: 'dcp-sec__title dcp-usage__h3' }, t('usageTrend')),
		react.createElement('div', { className: 'dcp-usage__trend' }, ...trend.map((d) => {
		const h = Math.max(2, Math.round(((Number(d.requests) || 0) / maxTrend) * 100));
		return react.createElement('div', {
		key: d.date, className: 'dcp-usage__trend-col',
		title: String(d.date) + ' · ' + fmt(d.requests) + ' req · ' + fmt(d.credits) + ' cr',
		}, react.createElement('div', { className: 'dcp-usage__trend-bar', style: { height: h + '%', opacity: (Number(d.requests) || 0) > 0 ? 1 : 0.25 } }));
		})),
		react.createElement('div', { className: 'dcp-usage__trend-labels' },
		react.createElement('span', null, trend.length > 0 ? String(trend[0].date).slice(5) : ''),
		react.createElement('span', null, trend.length > 0 ? String(trend[trend.length - 1].date).slice(5) : '')),
		react.createElement('div', { className: 'dcp-usage__foot' },
		t('usageLedger') + ': ' + String((doc.ledger && doc.ledger.days) || 0) + ' d · ' + t('usageNote')));
		}

		function PoolCreditsPanel(props) {
		const t = safeT(props && props.t);
		const st = usePool(true);
		const [view, setView] = react.useState('overview');
		const inUsage = view === 'usage';
		const usagePane = useUsage(inUsage);
		const onClose = typeof props.onClose === 'function' ? props.onClose : () => {};
		const [claim, setClaim] = react.useState('idle');
		const [copied, setCopied] = react.useState(false);
		const [expanded, setExpanded] = react.useState(false);
		const [expOpen, setExpOpen] = react.useState(false);
		const [hideZero, setHideZero] = react.useState(true); // ux-v29: 0 balance packages collapsed by default
		const [showAllRoutes, setShowAllRoutes] = react.useState(false); // ux-v29: routes collapsed by default
		const [query, setQuery] = react.useState('');
		const [caBusy, setCaBusy] = react.useState(false);
		react.useEffect(() => () => { clearLater(); }, []);
		const doc = st.doc;
		const total = doc === undefined ? undefined : Number(doc.credits && doc.credits.total);
		const accounts = doc === undefined ? [] : (Array.isArray(doc.credits && doc.credits.accounts) ? doc.credits.accounts : []);
		const routes = doc === undefined ? [] : (Array.isArray(doc.pool && doc.pool.routes) ? doc.pool.routes : []);
		const models = doc === undefined ? 0 : (Array.isArray(doc.models) ? doc.models.length : 0);
		const broken = doc === undefined ? [] : (Array.isArray(doc.pool && doc.pool.broken) ? doc.pool.broken : []);
		const voucherFirst = (doc && doc.pool && doc.pool.voucherFirst) === true;
		const isOff = doc !== undefined && doc.active === false;
		const isStale = doc !== undefined && st.at > 0 && (Date.now() - st.at) > STALE_MS;
		const hasError = st.error !== '';
		// ux-v32: 只剩 synthetic 路由（七牛）时 total 恒为 0、accounts 恒为空——旧条件会把
		// 它判成「不可用 / 探测中」，和下面那行「不限额」自相矛盾。 synthetic 路由活着就不算空。
		const hasSynthetic = routes.some((r) => r && r.syntheticBalance === true);
		const emptyCredits = doc !== undefined && !hasSynthetic && (!Number.isFinite(total) || (total === 0 && accounts.length === 0));
		let maxRemaining = 0;
		for (const r of routes) {
			const rawR = r && r.remaining;
			const n = (rawR === null || rawR === undefined || rawR === '') ? NaN : Number(rawR);
			if (Number.isFinite(n) && n > maxRemaining) maxRemaining = n;
		}
		const q = String(query || '').trim().toLowerCase();
		const positiveCount = accounts.filter((a) => Number(a && a.remain) > 0).length;
		const baseAccounts = hideZero ? accounts.filter((a) => Number(a && a.remain) > 0) : accounts;
		const filtered = q === '' ? baseAccounts : baseAccounts.filter((a) => (String((a && (a.route || '')) || '') + ' ' + String((a && (a.packageName || '')) || '')).toLowerCase().includes(q));
		// ux-v33：同渠道同名套餐聚合——截图里 8 行一模一样的「CodeBuddy个人版国内运营裂变包」
		// 只差到期日，逐行列出纯属噪音。按 (route, packageName) 合并：余额/总额求和、计数 ×N、
		// 到期取最早的一条。搜索先过滤再聚合，所以搜到的仍是原套餐。
		const groupedAccounts = (() => {
		const byKey = new Map();
		const out = [];
		for (const a of filtered) {
		const key = String((a && a.route) || '') + '|' + String((a && a.packageName) || '');
		let g = byKey.get(key);
		if (g === undefined) { g = { sample: a, count: 0, remain: 0, size: 0, hasSize: false, earliestMs: undefined }; byKey.set(key, g); out.push(g); }
		g.count += 1;
		const rem = Number(a && a.remain); if (Number.isFinite(rem)) g.remain += rem;
		const sz = Number(a && a.size); if (Number.isFinite(sz)) { g.size += sz; g.hasSize = true; }
		const raw = expiryRaw(a); const ms = typeof raw === 'number' ? raw : Date.parse(String(raw || ''));
		if (Number.isFinite(ms) && (g.earliestMs === undefined || ms < g.earliestMs)) g.earliestMs = ms;
		}
		return out;
		})();
		const shown = expanded || q !== '' ? groupedAccounts : groupedAccounts.slice(0, COLLAPSED_COUNT);
		const autoOn = (st.prefs && st.prefs.autoCheckin) === true;
		const costOn = (st.prefs && st.prefs.poolCostFirst) === true;
		const voucherPrefOn = (st.prefs && st.prefs.poolVoucherFirst) === true;
		const poolOn = (st.prefs && st.prefs.poolEnabled) !== false;
		const showRoutesOn = (st.prefs && st.prefs.poolShowRoutes) === true;
		const boostOn = (st.prefs && st.prefs.poolAutoBoostEffort) === true;
		const burnOn = (st.prefs && st.prefs.poolBurnExpiringFirst) !== false;
		const prefsReady = st.prefs !== undefined && !st.prefsBusy;
		const voucherRoutes = routes.filter((r) => r && r.voucher === true && (Array.isArray(r.coupons) || Number.isFinite(Number(r.maxBudget))));
		const voucherTotalRemain = voucherRoutes.reduce((s, r) => s + (Number.isFinite(Number(r && r.remaining)) ? Number(r.remaining) : 0), 0);
		const voucherBudget = voucherRoutes.reduce((s, r) => s + (Number.isFinite(Number(r && r.maxBudget)) ? Number(r.maxBudget) : 0), 0);
		const voucherSpend = voucherRoutes.reduce((s, r) => s + (Number.isFinite(Number(r && r.spend)) ? Number(r.spend) : 0), 0);
		const allCoupons = [];
		for (const r of voucherRoutes) {
			if (Array.isArray(r.coupons)) {
				for (const c of r.coupons) { if (c) allCoupons.push(c); }
			}
		}
		const couponCount = allCoupons.length;
		let soonest = '';
		for (const r of voucherRoutes) { const x = r && r.expiresSoonest; if (typeof x === 'string' && x !== '' && (soonest === '' || x < soonest)) soonest = x; }
		const offerModels = (doc === undefined || !Array.isArray(doc.models)) ? [] : doc.models.filter((m) => m && (m.free === true || (m.freeUntil !== undefined && Date.parse(String(m.freeUntil)) > Date.now()))).slice(0, 12);
		const singleCouponNo = couponCount === 1 ? String((allCoupons[0] && (allCoupons[0].no || allCoupons[0].id)) || '') : '';
		const voucherSummary = voucherRoutes.length === 0 ? null : react.createElement('div', { className: 'dcp-card' },
		react.createElement('div', { className: 'dcp-card__head' },
		react.createElement('span', { className: 'dcp-card__title' },
		t('voucherBalance'),
		react.createElement('span', { className: 'dcp-tag dcp-tag--voucher', title: singleCouponNo }, t('coupons', { count: couponCount })),
		),
		react.createElement('span', { className: 'dcp-card__value' }, fmt(voucherTotalRemain)),
		),
		react.createElement('div', { className: 'dcp-card__sub', title: soonest !== '' ? clockIso(soonest) : '' },
		t('voucherBudget', { value: fmt(voucherBudget) }) + ' · ' + t('voucherSpend', { value: fmt(voucherSpend) }) + (soonest !== '' ? ' · ' + t('expiresSoonest', { time: shortClock(soonest) }) : '') + (singleCouponNo ? ' · #' + singleCouponNo : ''),
		),
		couponCount > 1 ? allCoupons.map((c, j) => react.createElement('div', { className: 'dcp-card__row', key: String(j) },
		react.createElement('span', { className: 'dcp-card__rowname' }, String((c && (c.no || c.id || c.description)) || t('voucher'))),
		react.createElement('span', { className: 'dcp-row__num', title: c && c.expiryTime ? clockIso(c.expiryTime) : '' }, fmt(c && c.remaining) + (c && c.expiryTime ? ' · ' + shortClock(c.expiryTime) : '')),
		)) : null,
		);
		const offersList = offerModels.length === 0 ? null : react.createElement('div', { className: 'dcp-offers' },
		react.createElement('span', { className: 'dcp-offers__label' }, t('modelOffers')),
		offerModels.map((m, i) => {
		const left = freeLeft(m.freeUntil);
		const sub = left !== '' ? t('freeLeft', left) : (m && m.freeLabel ? String(m.freeLabel) : t('freeNow'));
		return react.createElement('span', {
		className: 'dcp-offers__chip', key: String((m && m.id) || '') + ':' + i,
		title: [m && m.freeLabel ? String(m.freeLabel) : '', m && m.freeUntil ? t('freeUntil', { time: clockIso(m.freeUntil) }) : ''].filter(Boolean).join(' · '),
		},
		react.createElement('span', null, String((m && (m.name || m.id)) || '?')),
		react.createElement('span', { className: 'dcp-offers__sub' }, sub),
		);
		}),
		);
		function auxSwitchRow(labelKey, shortKey, hintKey, on, onToggle, spanFull) {
		return react.createElement('button', {
		type: 'button', className: 'dcp-switch dcp-switch--aux' + (spanFull ? ' dcp-switch--span' : ''), onClick: onToggle,
		disabled: !prefsReady, 'aria-pressed': on ? 'true' : 'false',
		title: t(hintKey),
		'aria-label': t(labelKey) + ': ' + (on ? t('autoCheckinOn') : t('autoCheckinOff')),
		},
		react.createElement('span', { className: 'dcp-switch__text' }, t(labelKey),
		react.createElement('span', { className: 'dcp-switch__hint' }, t(shortKey))),
		react.createElement('span', { className: on ? 'dcp-switch__track dcp-switch__track--on' : 'dcp-switch__track' },
		react.createElement('span', { className: 'dcp-switch__knob' })),
		);
		}
		const auxPool = auxSwitchRow('poolEnabled', 'poolEnabledShort', 'poolEnabledHint', poolOn, () => void setPref('poolEnabled', !poolOn), true);
		const auxAutoCheckin = auxSwitchRow('autoCheckin', 'autoCheckinShort', 'autoCheckinHint', autoOn, () => void setAutoCheckin(!autoOn), false);
		const auxBurn = auxSwitchRow('burnExpiring', 'burnExpiringShort', 'burnExpiringHint', burnOn, () => void setPref('poolBurnExpiringFirst', !burnOn), false);
		const auxVoucher = auxSwitchRow('voucherFirstPref', 'voucherFirstShort', 'voucherFirstHint', voucherPrefOn, () => void setPref('poolVoucherFirst', !voucherPrefOn), false);
		const auxCost = auxSwitchRow('costFirst', 'costFirstShort', 'costFirstHint', costOn, () => void setPref('poolCostFirst', !costOn), false);
		const auxShowRoutes = auxSwitchRow('showRoutes', 'showRoutesShort', 'showRoutesHint', showRoutesOn, () => void setPref('poolShowRoutes', !showRoutesOn), false);
		const auxBoost = auxSwitchRow('autoBoost', 'autoBoostShort', 'autoBoostHint', boostOn, () => void setPref('poolAutoBoostEffort', !boostOn), false);

		const onCheckin = async () => {
		if (claim === 'busy') return;
		setClaim('busy');
		try {
		const r = await doCheckin();
		setClaim(r.ok ? 'done' : 'failed');
		later(() => { void loadPool(true); }, 1500);
		} catch { setClaim('failed'); }
		later(() => setClaim('idle'), 5000);
		};
		const onCopy = () => { copySummary(t); setCopied(true); later(() => setCopied(false), 2200); };

		const gqLang = (function () { try { return String((typeof navigator !== 'undefined' && navigator.language) || '').toLowerCase(); } catch { return ''; } })();
		const qt = (k, params) => {
			let out;
			try { out = t(k, params); } catch { out = undefined; }
			if (typeof out === 'string' && out !== k && out !== 'undefined' && out.indexOf('{') < 0) return out;
			const zhFirst = gqLang.indexOf('zh') === 0;
			const base = (zhFirst ? (zh[k] ?? en[k]) : (en[k] ?? zh[k])) ?? k;
			return String(base).replace(/\{(\w+)\}/g, (m, n) => (params && params[n] !== undefined) ? String(params[n]) : m);
		};

		// —— CodeArts 状态计算：正常态内嵌进概览卡片，异常态在顶部告警并提供重新登录 ——
		const ca = (doc && doc.codearts && typeof doc.codearts === 'object') ? doc.codearts : null;
		const caAuth = (doc && doc.codeartsAuth && typeof doc.codeartsAuth === 'object') ? doc.codeartsAuth : null;
		const caCredits = (ca && ca.credits && typeof ca.credits === 'object') ? ca.credits : null;
		const caCreditAccounts = (caCredits && Array.isArray(caCredits.accounts)) ? caCredits.accounts : [];
		const caAuthAccounts = (caAuth && Array.isArray(caAuth.accounts)) ? caAuth.accounts : [];
		const caLoggedIn = !!(ca && (ca.loggedIn === true || Number(ca.accountCount) > 0 || caCreditAccounts.length > 0 || caAuthAccounts.length > 0));
		const caRemain = caCredits ? Number(caCredits.remain) : NaN;
		const caTotalNum = caCredits ? Number(caCredits.total) : NaN;
		let caErr = '';
		for (const a of caCreditAccounts) { if (a && a.error) { caErr = String(a.error); break; } }
		if (caErr === '' && ca && ca.models && ca.models.error) caErr = String(ca.models.error);
		const caStale = caAuthAccounts.some((a) => a && a.stale === true) || caCreditAccounts.some((a) => a && a.stale === true);
		const caHealthy = caLoggedIn && !caStale && caErr === '';
		const caReason = caErr !== ''
			? (/security token has expired|APIG\.0602|token.{0,20}expir/i.test(caErr) ? qt('caTokenExpired') : qt('caReadFailed'))
			: (caStale ? qt('caStale') : (caLoggedIn ? qt('caNoCredits') : qt('caSignedOut')));
		const caValueText = caHealthy
			? ((Number.isFinite(caRemain) ? fmt(caRemain) : '—') + (Number.isFinite(caTotalNum) && caTotalNum > 0 ? ' / ' + fmt(caTotalNum) : ''))
			: '';
		function caLogin() {
			setCaBusy(true);
			fetch('/plugins/dsh-pool/codearts-oauth', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({ action: 'start' }),
			})
			.then((r) => r.json().catch(() => undefined))
			.then((b) => {
			if (b && b.ok === false) throw new Error(String(b.error || 'login failed'));
			if (b && b.url) { try { window.open(b.url, '_blank', 'noopener'); } catch (e) {} }
			[1200, 4000, 10000].forEach((ms) => later(() => { void st.reload(); }, ms));
			})
			.catch(() => {})
			.finally(() => setCaBusy(false));
		}
		const codeartsBar = (doc === undefined || caHealthy) ? null : react.createElement('div', {
			className: 'dcp-cabar dcp-cabar--warn', role: 'status',
		},
			react.createElement('span', { className: 'dcp-cabar__label' }, qt('caTitle')),
			react.createElement('span', { className: 'dcp-cabar__value', title: caErr || '' },
			react.createElement('span', { className: 'dcp-cabar__tag' }, caReason)),
			react.createElement('button', { type: 'button', className: 'dcp-btn dcp-btn--primary', disabled: caBusy, onClick: caLogin }, caBusy ? qt('caLoggingIn') : qt('caRelogin')));

		const head = react.createElement('div', { className: 'dcp-head' },
		react.createElement('span', { className: 'dcp-head__title', id: 'dcp-title' },
		t('panelTitle'),
		(!st.busy && st.at > 0) ? react.createElement('span', { className: 'dcp-head__state', title: t('fetchedAt', { time: clock(st.at) }) }, ago(st.at, t)) : null,
		),
		react.createElement('button', { type: 'button', className: 'dcp-btn', 'data-dcp-autofocus': '1', onClick: () => { if (inUsage) usagePane.reload(); void st.reload(); }, disabled: st.busy, 'aria-busy': st.busy ? 'true' : 'false' }, st.busy ? t('refreshing') : t('refresh')),
		react.createElement('button', { type: 'button', className: 'dcp-btn dcp-btn--icon', onClick: onClose, 'aria-label': t('close'), title: t('close') }, '×'),
		);
		const tabs = react.createElement('div', { className: 'dcp-tabs', role: 'tablist' },
		...[['overview', 'tabOverview'], ['usage', 'tabUsage'], ['detail', 'tabDetail']].map(([k, label]) =>
		react.createElement('button', {
		key: k, type: 'button', role: 'tab', className: view === k ? 'dcp-tab dcp-tab--on' : 'dcp-tab',
		'aria-selected': view === k ? 'true' : 'false', onClick: () => setView(k),
		}, t(label))));
		const showAlertLive = hasError || isStale;
		const live = react.createElement('div', {
		className: hasError ? 'dcp-live dcp-live--err' : (showAlertLive ? 'dcp-live' : 'dcp-live dcp-live--sr'),
		role: 'status', 'aria-live': 'polite',
		},
		react.createElement('span', null, hasError ? (t('errorTitle') + ' · ' + st.error) : (doc === undefined ? t('loading') : (isStale ? t('stale') : (st.busy ? t('refreshing') : t('updatedLive'))))),
		hasError ? react.createElement('button', { type: 'button', className: 'dcp-btn dcp-btn--sm', onClick: () => void st.reload() }, t('retry')) : null,
		);

		// —— 近期到期速览条（仅在概览展示，默认单行展示最近 2 项，点击可展开全部） ——
		const expRoutes = (Array.isArray(routes) ? routes : []).filter((r) => r && r.expiry);
		const expSorted = expRoutes.slice().sort((x, y) => {
		const ax = Date.parse(String(x.expiry)); const ay = Date.parse(String(y.expiry));
		return (Number.isFinite(ax) ? ax : Infinity) - (Number.isFinite(ay) ? ay : Infinity);
		});
		const expVisible = expOpen ? expSorted : expSorted.slice(0, EXPIRY_PREVIEW_COUNT);
		const expHiddenCount = Math.max(0, expSorted.length - EXPIRY_PREVIEW_COUNT);
		const expChips = expVisible.map((r) => {
		const est = r && r.expiryEstimated === true;
		const policyText = r && r.expiryPolicy ? String(r.expiryPolicy) : '';
		const urls = r && Array.isArray(r.expiryUrls) ? r.expiryUrls.filter(Boolean).join(String.fromCharCode(10)) : '';
		const title = [clockIso(r.expiry), policyText, urls].filter(Boolean).join(String.fromCharCode(10));
		return react.createElement('span', { className: 'dcp-expbar__chip' + (est ? ' dcp-expbar__chip--est' : ''), key: String(r.key), title },
		react.createElement('span', { className: 'dcp-expbar__name' }, String((r && (r.displayName || r.key)) || '?')),
		react.createElement('span', { className: 'dcp-expbar__time' }, (est ? qt('expiryEstimated') + ' ' : '') + shortClock(r.expiry)));
		});
		const expiryBar = (doc === undefined || expSorted.length === 0) ? null : react.createElement('div', { className: expOpen ? 'dcp-expbar dcp-expbar--open' : 'dcp-expbar', role: 'status' },
		react.createElement('span', { className: 'dcp-expbar__label' }, qt('expiryTitle')),
		expChips,
		expHiddenCount > 0 ? react.createElement('button', {
		type: 'button', className: 'dcp-expbar__toggle', onClick: () => setExpOpen((v) => !v),
		}, expOpen ? t('showLess') : qt('expiryMore', { count: expHiddenCount })) : null,
		);

		const totalCard = react.createElement('div', { className: isOff ? 'dcp-total dcp-total--off' : 'dcp-total' },
		react.createElement('div', { className: 'dcp-total__top' },
		react.createElement('span', { className: 'dcp-total__label' }, t('remaining')),
		react.createElement('div', { className: 'dcp-total__badges' },
		react.createElement('span', { className: isOff ? 'dcp-tag' : 'dcp-tag dcp-tag--ok' }, isOff ? t('inactive') : t('active')),
		broken.length > 0
		? react.createElement('span', { className: 'dcp-tag dcp-tag--warn' }, t('broken', { count: broken.length }))
		: react.createElement('span', { className: 'dcp-tag' }, t('brokenNone')),
		caHealthy && caValueText ? react.createElement('span', { className: 'dcp-tag dcp-tag--ok', title: qt('caTitle') }, qt('caShort') + ' ' + caValueText) : null,
		),
		),
		react.createElement('div', { className: 'dcp-total__main' },
		react.createElement('div', { className: isOff ? 'dcp-total__value dcp-total__value--off' : 'dcp-total__value' }, doc === undefined ? t('loading') : (emptyCredits ? t('unavailable') : (hasSynthetic && total === 0 ? t('unlimitedQuota') : fmt(total)))),
		react.createElement('div', { className: 'dcp-meta' },
		react.createElement('span', { className: 'dcp-meta__item' }, t('models', { count: models })),
		react.createElement('span', { className: 'dcp-meta__item' }, '· ' + t('routes', { count: routes.length })),
		react.createElement('span', { className: 'dcp-meta__item' }, '· ' + t('packages', { count: accounts.length })),
		),
		),
		(isOff || emptyCredits) ? react.createElement('div', { className: 'dcp-total__sub' }, isOff ? t('disabledHint') : t('probing')) : null,
		voucherSummary,
		);

		// ux-v29: routes default to only those with balance / error / stale / breaker.
		// Zero-balance healthy routes hide behind "show all" - first screen drops from 9-10 rows to 3-5.
		const brokenKeys = new Set(broken.map((b) => String(b && b.key)));
		// ux-v30: hiddenRouteCount 必须与 showAllRoutes 无关——此前展开后它变 0，
		// 按钮直接消失，再也收不回来（只能刷新面板）。
		const filteredRoutes = routes.filter((r) => {
			const rem = Number(r && r.remaining);
			return (Number.isFinite(rem) && rem > 0) || (r && r.error) || (r && r.stale === true) || brokenKeys.has(String(r && r.key)) || (r && r.syntheticBalance === true); // ux-v31: 无限量路由没有 remaining，但它活着（七牛 priority -1 最该优先烧）
		});
		const visibleRoutes = showAllRoutes ? routes : filteredRoutes;
		const hiddenRouteCount = routes.length - filteredRoutes.length;
		const routeRows = visibleRoutes.map((r) => {
		const rawRem = r && r.remaining;
		const remain = (rawRem === null || rawRem === undefined || rawRem === '') ? NaN : Number(rawRem);
		const hasNum = Number.isFinite(remain);
		const err = r && r.error;
		const low = hasNum && remain > 0 && remain < LOW_CREDIT;
		// ux-v33：进度条按本路由自己的总额算（余/总额），总额未知时才退回按最大路由相对算。
		const totalN = Number(r && r.total);
		const width = hasNum && Number.isFinite(totalN) && totalN > 0 ? Math.max(0, Math.min(100, (remain / totalN) * 100)) : pct(hasNum ? remain : 0, maxRemaining);
		const barClass = err ? 'dcp-row__barfill dcp-row__barfill--err' : (low ? 'dcp-row__barfill dcp-row__barfill--low' : 'dcp-row__barfill');
		const est = r && r.expiryEstimated === true;
		const policyText = r && r.expiryPolicy ? String(r.expiryPolicy) : '';
		const expTitle = [r && r.expiry ? clockIso(r.expiry) : '', policyText].filter(Boolean).join(String.fromCharCode(10));
		return react.createElement('div', { className: 'dcp-row', key: String(r && r.key) },
		react.createElement('div', { className: 'dcp-row__main' },
		react.createElement('div', { className: 'dcp-row__line' },
		react.createElement('span', { className: 'dcp-row__name' }, String((r && (r.displayName || r.key)) || '?')),
		r && r.voucher === true ? react.createElement('span', { className: 'dcp-tag dcp-tag--voucher' }, t('voucher')) : null,
		r && r.syntheticBalance === true ? react.createElement('span', { className: 'dcp-tag dcp-tag--ok' }, t('unlimitedQuota')) : null,
		err ? react.createElement('span', { className: 'dcp-tag dcp-tag--err' }, t('routeError')) : (low ? react.createElement('span', { className: 'dcp-tag dcp-tag--warn' }, t('lowCredit')) : null),
		r && r.stale === true ? react.createElement('span', { className: 'dcp-tag dcp-tag--warn', title: String((r && r.error) || '') || t('routeStaleHint') }, t('routeStale', { time: shortClock(r.lastGoodAt) || '—' })) : null,
		react.createElement('span', { className: 'dcp-row__num' }, t('remainingShort', { value: hasNum ? fmt(remain) + (Number.isFinite(totalN) && totalN > 0 ? ' / ' + fmt(totalN) : '') : (r && r.syntheticBalance === true ? t('unlimitedQuota') : '—') })),
		r && r.expiry ? react.createElement('span', { className: 'dcp-expiry', title: expTitle }, (est ? qt('expiryEstimated') + ' ' : '') + shortClock(r.expiry)) : null,
		),
		hasNum ? react.createElement('div', { className: 'dcp-row__bar' }, react.createElement('div', { className: barClass, style: { width: width + '%' } })) : null,
		),
		);
		});
		const routesSec = react.createElement('div', { className: 'dcp-sec' },
		react.createElement('div', { className: 'dcp-sec__head' },
		react.createElement('span', { className: 'dcp-sec__title' }, t('routesTitle')),
		react.createElement('span', { className: 'dcp-tag dcp-tag--ok' }, t('order') + ' · ' + (voucherFirst ? t('orderVoucher') : t('orderCredits'))),
		hiddenRouteCount > 0 ? react.createElement('button', { type: 'button', className: 'dcp-btn dcp-btn--sm', onClick: () => setShowAllRoutes((v) => !v) }, showAllRoutes ? t('showLess') : t('showAll', { count: routes.length })) : null,
		),
		routesSecEmpty(routes.length, t), routeRows,
		);

		// —— 明细页：偏好与签到统一为高密度 2 列面板 + 限免胶囊条 + 模型库 + 套餐明细 ——
		const prefsAndCheckinSec = react.createElement('div', { className: 'dcp-sec' },
		react.createElement('div', { className: 'dcp-sec__head' },
		react.createElement('span', { className: 'dcp-sec__title' }, t('libOptsTitle')),
		react.createElement('button', {
		type: 'button', className: 'dcp-btn dcp-btn--primary dcp-btn--sm', title: t('checkinHint'),
		onClick: () => void onCheckin(), disabled: claim === 'busy', 'aria-busy': claim === 'busy' ? 'true' : 'false',
		}, claim === 'busy' ? t('checkinBusy') : claim === 'done' ? t('checkinDone') : claim === 'failed' ? t('checkinFailed') : t('checkinAll')),
		),
		react.createElement('div', { className: 'dcp-lib__opts' },
		auxPool, auxAutoCheckin, auxBurn, auxVoucher, auxCost, auxShowRoutes, auxBoost,
		),
		offersList,
		);

		const libModels = (doc === undefined || !Array.isArray(doc.models)) ? [] : doc.models;
		const librarySec = react.createElement('div', { className: 'dcp-sec dcp-lib' },
		react.createElement('div', { className: 'dcp-lib__head' },
		react.createElement('span', { className: 'dcp-sec__title' }, t('modelLibrary')),
		react.createElement('span', { className: 'dcp-lib__effort', title: t('libHint') }, t('effortAuto')),
		react.createElement('span', { className: 'dcp-lib__count' }, t('curatedCount', { count: libModels.length })),
		),
		libModels.length === 0
		? react.createElement('div', { className: 'dcp-empty' }, t('loading'))
		: react.createElement('div', { className: 'dcp-lib__list' }, libModels.map((m, i) => {
		const nm = String((m && m.baseName) || (m && m.name) || (m && m.id) || '?');
		const labels = (m && Array.isArray(m.channelLabels)) ? m.channelLabels : [];
		const free = !!(m && m.free === true);
		const rateN = (m && m.rate !== undefined) ? Number(m.rate) : NaN;
		return react.createElement('div', { className: 'dcp-lib__row', key: String((m && m.id) || '') + ':' + i },
		react.createElement('span', { className: i < 5 ? 'dcp-lib__rank dcp-lib__rank--top' : 'dcp-lib__rank' }, String(i + 1)),
		react.createElement('div', { className: 'dcp-lib__main' },
		react.createElement('span', { className: 'dcp-lib__name', title: String((m && m.routeName) || nm) }, nm),
		showRoutesOn && labels.length > 0
		? react.createElement('div', { className: 'dcp-lib__src' },
		labels.map((L, k) => react.createElement('span', { className: 'dcp-lib__chip', key: String(k) }, String(L))),
		)
		: null,
		),
		react.createElement('div', { className: 'dcp-lib__tags' },
		free ? react.createElement('span', { className: 'dcp-lib__free' }, t('libFree')) : null,
		Number.isFinite(rateN) && rateN > 0 ? react.createElement('span', { className: 'dcp-lib__rate' }, t('rate', { value: fmt(rateN) })) : null,
		),
		);
		})),
		);

		const accountsSec = accounts.length === 0 ? null : react.createElement('div', { className: 'dcp-sec' },
		react.createElement('div', { className: 'dcp-sec__head' },
		react.createElement('span', { className: 'dcp-sec__title' }, t('accountsTitle') + ' · ' + t('packages', { count: groupedAccounts.length })),
		accounts.length > positiveCount ? react.createElement('button', { // ux-v31: 全零余额时 positiveCount===0，旧条件让按钮消失、账号区永久锁死
		type: 'button', className: hideZero ? 'dcp-btn dcp-btn--primary dcp-btn--sm' : 'dcp-btn dcp-btn--sm',
		onClick: () => setHideZero((v) => !v),
		}, hideZero ? t('showZero', { count: accounts.length }) : t('hideZero', { count: positiveCount })) : null,
		),
		react.createElement('div', { className: 'dcp-filterbar' },
		react.createElement('input', { className: 'dcp-input', type: 'search', value: query, placeholder: t('searchPlaceholder'),
		onChange: (e) => setQuery(e && e.target ? e.target.value : ''), 'aria-label': t('searchPlaceholder') }),
		),
		groupedAccounts.length === 0 ? react.createElement('div', { className: 'dcp-empty' }, t('noMatch')) : null,
		shown.map((g, i) => {
		const a = g.sample;
		const info = cleanAccountLabel(a, i);
		const isZero = Number.isFinite(g.remain) && g.remain <= 0;
		const expS = g.earliestMs === undefined ? '' : shortClock(g.earliestMs);
		return react.createElement('div', { className: isZero ? 'dcp-row dcp-row--zero' : 'dcp-row', key: String((a && a.route) || '') + ':' + String((a && a.packageName) || '') + ':' + i, title: info.full + (g.count > 1 ? ' · ×' + g.count : '') },
		info.badge ? react.createElement('span', { className: 'dcp-tag' }, info.badge) : null,
		react.createElement('span', { className: 'dcp-row__name' }, info.name),
		g.count > 1 ? react.createElement('span', { className: 'dcp-tag' }, '×' + g.count) : null,
		react.createElement('span', { className: 'dcp-row__num' }, fmt(g.remain) + (g.hasSize ? ' / ' + fmt(g.size) : '')),
		expS ? react.createElement('span', { className: 'dcp-expiry', title: g.earliestMs === undefined ? '' : clock(g.earliestMs) }, expS) : null,
		);
		}),
		expanded || q !== '' || groupedAccounts.length <= COLLAPSED_COUNT ? null : react.createElement('button', { type: 'button', className: 'dcp-more', onClick: () => setExpanded(true) }, t('showAll', { count: groupedAccounts.length })),
		expanded ? react.createElement('button', { type: 'button', className: 'dcp-more', onClick: () => setExpanded(false) }, t('showLess')) : null,
		);
		const note = react.createElement('div', { className: 'dcp-note' },
		react.createElement('span', { className: 'dcp-note__text' }, doc === undefined ? '' : t('patch', { patch: String(doc.patch || '-') }) + ' · ' + t('fetchedAt', { time: clock(st.at) })),
		react.createElement('button', { type: 'button', className: 'dcp-btn dcp-btn--sm', onClick: onCopy, disabled: doc === undefined }, copied ? t('copied') : t('copy')),
		);

		const overview = react.createElement(react.Fragment, null, totalCard, expiryBar, routesSec);
		const detail = react.createElement(react.Fragment, null, prefsAndCheckinSec, librarySec, accountsSec, note);
		const body = inUsage
		? react.createElement(UsageSection, { t, doc: usagePane.doc, failed: usagePane.failed, reload: usagePane.reload, currentCredits: total })
		: (view === 'detail' ? detail : overview);
		return react.createElement('div', { className: 'dcp-pop-inner', style: { display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' } },
		head, tabs, codeartsBar, inUsage ? null : live,
		react.createElement('div', { className: 'dcp-body' }, body),
		);
		}
		function routesSecEmpty(len, t) {
		// ux-v32: 一条路由都没有时旧版永远显示「加载中」——doc 已到、len 就是 0，不是还在加载。
		return len === 0 ? react.createElement('div', { className: 'dcp-empty' }, t('noRoutes')) : null;
		}

		/**
		 * 切换模型时自动把思考强度拨到该模型支持的最高档（Q2）。
		 * 只在「模型身份变化」时写入一次：用户手动改档后，lastKey 与当前 key 相同，不再回弹。
		 * 写入用 directory.select({provider, model, reasoningEffort})，与 codex-effort-slider 走同一目录服务。
		 */
		function AutoEffortWatcher(props) {
		  const scope = props && props.scope;
		  const sessionId = props && props.sessionId;
		  // 已自动写过档的「provider\0model」，用于在同模型内识别用户手动改档（不回弹）。
		  const lastKeyRef = react.useRef(null);
		  // 已尝试过的 key（store efforts 为空或 select 失败时不再反复重试，避免刷屏）。
		  const attemptedRef = react.useRef(null);
		  react.useEffect(() => {
		    if (!scope || !scope.modelDirectories || typeof sessionId !== 'string') return undefined;
		    let directory = null;
		    let unsubscribe = null;
		    let disposed = false;
		    const applyHighest = () => {
		      if (disposed || !directory) return;
		      let snap;
		      try { snap = directory.store.getSnapshot(); } catch { return; }
		      const current = snap && snap.current;
		      if (!current || typeof current.provider !== 'string' || typeof current.model !== 'string') return;
		      const key = current.provider + '\0' + current.model;
		      // 切到新模型：清掉「已尝试」标记，给新模型一次机会。
		      if (attemptedRef.current !== null && attemptedRef.current !== key) attemptedRef.current = null;
		      if (attemptedRef.current === key) return;
		      const groups = Array.isArray(snap.groups) ? snap.groups : [];
		      let efforts = [];
		      for (const g of groups) {
		        if (g && g.id === current.provider) {
		          const models = Array.isArray(g.models) ? g.models : [];
		          for (const m of models) {
		            if (m && m.id === current.model) {
		              efforts = m.reasoning && Array.isArray(m.reasoning.efforts) ? m.reasoning.efforts : [];
		            }
		          }
		        }
		      }
		      if (efforts.length === 0) return;
		      let top = null;
		      for (let i = AUTO_EFFORT_ORDER.length - 1; i >= 0; i--) {
		        const lv = AUTO_EFFORT_ORDER[i];
		        if (efforts.some((e) => e && e.id === lv)) { top = lv; break; }
		      }
		      if (top === null) { attemptedRef.current = key; return; }
		      const currentEffort = typeof current.reasoningEffort === 'string' && current.reasoningEffort.length > 0
		        ? current.reasoningEffort : null;
		      if (currentEffort === top) { lastKeyRef.current = key; attemptedRef.current = key; return; }
		      try {
		        const r = directory.select({ provider: current.provider, model: current.model, reasoningEffort: top });
		        Promise.resolve(r).catch(() => {});
		        lastKeyRef.current = key;
		        attemptedRef.current = key;
		      } catch { /* select 同步抛错：交给 store/下次快照处理 */ }
		    };
		    const resolve = () => {
		      try { directory = scope.modelDirectories.directoryFor(sessionId); } catch { directory = null; }
		      if (directory && directory.store && typeof directory.store.subscribe === 'function') {
		        try { unsubscribe = directory.store.subscribe(applyHighest); } catch { unsubscribe = null; }
		      }
		      if (directory && typeof directory.load === 'function') {
		        try { Promise.resolve(directory.load()).catch(() => {}); } catch {}
		      }
		      applyHighest();
		    };
		    resolve();
		    return () => {
		      disposed = true;
		      if (unsubscribe) { try { unsubscribe(); } catch {} }
		    };
		  }, [scope, sessionId]);
		  return null;
		}

		function PoolSidebarEntry(props) {
		const t = typeof props.t === 'function' ? props.t : (k) => (zh[k] ?? en[k] ?? k);
		const wide = props.wide !== false;
		const st = usePool(false);
		const [open, setOpen] = react.useState(false);
		const [pos, setPos] = react.useState(undefined);
		const btn = react.useRef(null);
		const panel = react.useRef(null);
		const doc = st.doc;
		const total = doc === undefined ? undefined : Number(doc.credits && doc.credits.total);
		const isOff = doc !== undefined && doc.active === false;
		const hasError = st.error !== '' && doc === undefined;
		const tone = hasError || isOff ? 'warn' : (doc === undefined ? 'off' : 'ok');
		const badge = hasError ? '!' : (isOff ? t('inactive') : (doc === undefined ? '…' : (Number.isFinite(total) ? fmt(total) : '—')));
		const labelText = t('nav') + (doc === undefined ? '' : ' · ' + t('remaining') + ' ' + (isOff ? t('inactive') : fmt(total)));

		const place = react.useCallback(() => {
		const node = btn.current;
		if (node === null || typeof node.getBoundingClientRect !== 'function') return;
		const rect = node.getBoundingClientRect();
		const vw = window.innerWidth, vh = window.innerHeight;
		const w = Math.min(440, Math.max(300, vw - 32));
		const h = Math.min(620, Math.max(320, vh * 0.72));
		let left = rect.right + 10;
		if (left + w + 12 > vw) left = rect.left - w - 10;
		if (left < 8) left = Math.max(8, Math.min(vw - w - 8, rect.left));
		let top = rect.bottom - h;
		if (top < 8) top = rect.top;
		if (top + h + 8 > vh) top = Math.max(8, vh - h - 8);
		setPos({ left: left, top: top, width: w, height: h });
		}, []);

		react.useEffect(() => {
		if (!open) return undefined;
		place();
		const focusId = setTimeout(() => {
		const root = panel.current || document.getElementById(POOL_PANEL_ID);
		if (root === null || root === undefined) return;
		const target = typeof root.querySelector === 'function' ? root.querySelector('[data-dcp-autofocus]') : null;
		if (target !== null && target !== undefined && typeof target.focus === 'function') target.focus();
		else if (typeof root.focus === 'function') root.focus();
		}, 0);
		const onDown = (e) => {
		if (btn.current !== null && typeof btn.current.contains === 'function' && btn.current.contains(e.target)) return;
		if (panel.current !== null && panel.current !== undefined && typeof panel.current.contains === 'function' && panel.current.contains(e.target)) return;
		setOpen(false);
		};
		const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
		document.addEventListener('mousedown', onDown);
		document.addEventListener('keydown', onKey);
		window.addEventListener('resize', place);
		return () => {
		clearTimeout(focusId);
		document.removeEventListener('mousedown', onDown);
		document.removeEventListener('keydown', onKey);
		window.removeEventListener('resize', place);
		if (btn.current !== null && typeof btn.current.focus === 'function') btn.current.focus();
		};
		}, [open, place]);

		const onPanelKey = (e) => {
		if (e.key !== 'Tab') return;
		const root = panel.current;
		if (root === null || root === undefined || typeof root.querySelectorAll !== 'function') return;
		const items = Array.from(root.querySelectorAll('button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])'));
		if (items.length === 0) return;
		const first = items[0], last = items[items.length - 1];
		if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
		else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
		};
		const toggle = () => { place(); setOpen((v) => !v); };
		const fallback = { left: 8, top: 8, width: Math.min(440, 380), height: 520 };
		const p = pos === undefined ? fallback : pos;

		return react.createElement(react.Fragment, null,
		react.createElement('button', {
		ref: btn, type: 'button', className: wide ? 'dcp-side' : 'dcp-side dcp-side--rail',
		title: labelText + ' — ' + t('triggerHint'), 'aria-label': labelText,
		'aria-expanded': open ? 'true' : 'false', 'aria-controls': POOL_PANEL_ID,
		'aria-busy': st.busy ? 'true' : 'false', onClick: toggle,
		},
		react.createElement('span', { className: tone === 'warn' ? 'dcp-side__ico dcp-side__ico--warn' : 'dcp-side__ico' }, POOL_ICON),
		wide ? react.createElement('span', { className: 'dcp-side__label' }, t('nav')) : null,
		wide ? react.createElement('span', { className: hasError || isOff ? 'dcp-side__value dcp-side__value--off' : (doc === undefined ? 'dcp-side__value dcp-side__value--warn' : 'dcp-side__value') }, badge) : null,
		react.createElement('span', { className: 'dcp-side__dot dcp-side__dot--' + (tone === 'warn' ? 'warn' : (tone === 'off' ? 'off' : 'ok')) }),
		),
		open ? reactDom.createPortal(react.createElement(react.Fragment, null,
		react.createElement('div', { style: { position: 'fixed', inset: 0, zIndex: 9998, background: 'transparent' }, onClick: () => setOpen(false), 'aria-hidden': 'true' }),
		react.createElement('div', {
		ref: panel, id: POOL_PANEL_ID, className: 'dcp-pop dshc-glass', role: 'dialog', 'aria-modal': 'true',
		'aria-labelledby': 'dcp-title', 'aria-label': t('dialogLabel'), tabIndex: -1, onKeyDown: onPanelKey,
		style: { left: p.left + 'px', top: p.top + 'px', width: p.width + 'px', maxHeight: p.height + 'px' },
		},
		react.createElement(PoolCreditsPanel, { t, onClose: () => setOpen(false) }),
		),
		), document.body) : null,
		);
		}

		const name = 'dsh-camel-pool-credits-client';
		const inject = ['slots', 'locale'];
		function apply(ctx) {
		const namespace = 'dsh-camel-pool-credits';
		let bound;
		try { bound = ctx.locale.bind(namespace); } catch { bound = undefined; }
		const t = safeT(bound);
		try { ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-camel-pool: credits copy'); } catch { /* 文案注册失败不影响面板 */ }
		try {
		ctx.slots.inject('sidebar.footer.action', () =>
		ctx.slots.register({
		name: 'sidebar.footer.action', id: 'dsh-camel-pool-credits', order: 21,
		label: () => t('nav'), locale: namespace,
		}, function PoolCreditsSlot(props) {
		return react.createElement(PoolSidebarEntry, { wide: props === undefined ? undefined : props.wide, t: typeof (props && props.t) === 'function' ? safeT(props.t) : t });
		}),
		);
		} catch (error) {
		console.error('[dsh-camel-pool] 积分池额度面板注册失败（其余贡献与宿主不受影响）：', error);
		}
		// Q2：切换模型时自动把思考强度拨到该模型支持的最高档。
		// 仅注册一个不可见锚点，不渲染任何 UI；档位写入由 AutoEffortWatcher 完成。
		// 必须声明 sessions / remote / remote.session：少声明会让 directoryFor(sessionId) 长期拿不到目录
		// （与 codex-effort-slider 同一服务访问契约）。
		try {
		ctx.inject(['slots', 'sessions', 'modelDirectories', 'remote', 'remote.session'], (scope) => {
		scope.slots.inject('conversation.input.right', () =>
		scope.slots.register({
		name: 'conversation.input.right', id: AUTO_EFFORT_SLOT_ID, order: 9999,
		inject: (sessionId) => ({ sessionId }),
		}, function AutoEffortSlot(props) {
		return react.createElement(AutoEffortWatcher, { scope, sessionId: props && props.sessionId });
		}),
		);
		});
		} catch (error) {
		console.error('[dsh-camel-pool] 自动最高档锚点注册失败（不影响其余功能）：', error);
		}
		}
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
		})();

		// ── CodeArts 客户端贡献：设置卡片（登录 / 账号管理 / 排队探测）──
		const codeartsClient = (() => {
		  var module = { exports: {} };
		  var exports = module.exports;
		  Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		  const react = require('react');
		  const STATUS_PATH = '/plugins/dsh-pool/status';
		  const OAUTH_PATH = '/plugins/dsh-pool/codearts-oauth';
		  const QUEUE_PATH = '/plugins/dsh-pool/codearts-queue';
		  const STYLE_ID = 'dsh-camel-pool-codearts-style';
		  const REQUEST_TIMEOUT_MS = 12000;
		  const NAMESPACE = 'dsh-camel-pool-codearts';

		  const zh = {
		    title: 'CodeArts', signedOut: '未登录 · 点此接入', credits: '积分余额', expiring: '即将过期',
		    checkin: '每日签到', claim: '签到', claiming: '签到中…', claimed: '已领取', already: '今日已签',
		    unsupported: '暂不可签', failed: '签到失败', requests: '请求', tokens: 'tokens',
		    queue: '排队位置', queueIdle: '未排队', probeQueue: '查询排队', accounts: '逐号明细', settings: '设置',
		    oauthLogin: '华为云账号登录', oauthHint: '在浏览器完成授权后自动回填；本机回调，凭据只存本机 0600。',
		    pasteLabel: '或粘贴 security_token', paste: '保存 token', pasteOk: 'token 已保存',
		    pasteHint: '粘贴纯 token 为降级态（仅对话可用；额度/签到需带 AK/SK 的 OAuth 登录）。',
		    logout: '登出', logoutAll: '登出全部', pause: '暂停', resume: '恢复', pin: '置顶', unpin: '取消置顶',
		    refresh: '刷新',
		    noAccounts: '还没有账号，先用华为云账号登录或粘贴 token', modelCount: '{count} 个模型',
		    accountCount: '{count} 个账号', expireAt: '到期 {time}', basic: '基础包', bonus: '赠送包',
		    onDemand: '按需包', stale: '凭据待续期', paused: '已暂停', pinned: '已置顶',
		    error: '读取失败', busy: '处理中…', close: '关闭', loggingIn: '登录链接准备中…',
		    oauthStarted: '已打开登录页，请完成授权',
		  };
		  const en = {
		    title: 'CodeArts', signedOut: 'Not signed in', credits: 'Credits', expiring: 'Expiring',
		    checkin: 'Daily check-in', claim: 'Check in', claiming: 'Claiming…', claimed: 'Claimed', already: 'Already claimed',
		    unsupported: 'Unavailable', failed: 'Check-in failed', requests: 'req', tokens: 'tokens',
		    queue: 'Queue', queueIdle: 'Idle', probeQueue: 'Probe queue', accounts: 'Per-account', settings: 'Settings',
		    oauthLogin: 'Sign in with Huawei Cloud', oauthHint: 'Finish in browser; loopback callback, credentials stay local.',
		    pasteLabel: 'Or paste security_token', paste: 'Save token', pasteOk: 'Token saved',
		    pasteHint: 'Pasted token is a fallback (chat only).', logout: 'Sign out', logoutAll: 'Sign out all',
		    pause: 'Pause', resume: 'Resume', pin: 'Pin', unpin: 'Unpin', refresh: 'Refresh',
		    noAccounts: 'No accounts yet', modelCount: '{count} models', accountCount: '{count} accounts',
		    expireAt: 'Expires {time}', basic: 'Basic', bonus: 'Bonus', onDemand: 'On-demand',
		    stale: 'Credential stale', paused: 'Paused', pinned: 'Pinned', error: 'Read failed', busy: 'Working…',
		    close: 'Close', loggingIn: 'Preparing login…', oauthStarted: 'Login page opened',
		  };

		  let boundT;
		  function t(key, vars) {
		    let s;
		    try { if (typeof boundT === 'function') s = boundT(key, vars); } catch (e) {}
		    if (typeof s !== 'string' || s === key) s = (zh[key] !== undefined ? zh[key] : key);
		    if (vars && typeof s === 'string') { for (const k in vars) s = s.split('{' + k + '}').join(String(vars[k])); }
		    return s;
		  }
		  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
		  function fmt(v) { return (Math.round(num(v) * 100) / 100).toLocaleString(); }
		  function clock(v) {
		    if (v === undefined || v === null || v === '') return '';
		    const ms = typeof v === 'number' ? v : Date.parse(String(v));
		    if (!Number.isFinite(ms)) return String(v);
		    const d = new Date(ms);
		    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
		  }

		  const CSS = [
		    '.dca-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));font-variant-numeric:tabular-nums;white-space:nowrap}',
		    '.dca-chip--link{cursor:pointer;border:0;color:inherit}',
		    '.dca-chip--link:hover{background:color-mix(in srgb,var(--dsw-alias-state-brand-primary,#4c7cf3) 16%,transparent)}',
		    '.dca-chip--warn{background:rgba(214,158,46,.16);color:var(--dsw-alias-state-warn-primary,#d69e2e)}',
		    '.dca-btn{border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.2));border-radius:7px;background:transparent;color:inherit;font-size:11px;padding:3px 9px;cursor:pointer}',
		    '.dca-btn:hover:not(:disabled){background:var(--dsw-alias-bg-hover,rgba(127,127,127,.1))}',
		    '.dca-btn:disabled{opacity:.55;cursor:default}',
		    '.dca-btn--primary{background:var(--dsw-alias-state-brand-primary,#4c7cf3);border-color:transparent;color:#fff}',
		    '.dca-pop{position:relative;width:min(460px,92vw);max-height:min(70vh,620px);overflow:auto;background:var(--dsw-alias-bg-layer-1,#1c1c1e);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.4);padding:14px;color:var(--dsw-alias-label-primary,#ddd);font-size:12px;box-sizing:border-box}',
		    '.dca-pop__hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;font-size:13px;font-weight:600}',
		    '.dca-acc{border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.16));border-radius:9px;padding:9px 10px;margin-bottom:8px}',
		    '.dca-acc__hd{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}',
		    '.dca-acc__name{font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
		    '.dca-kv{display:flex;flex-wrap:wrap;gap:4px 12px;color:var(--dsw-alias-label-tertiary,#999);font-size:11px}',
		    '.dca-bar{height:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.24));overflow:hidden;margin:7px 0}',
		    '.dca-bar__in{height:100%;background:var(--dsw-alias-state-brand-primary,#4c7cf3)}',
		    '.dca-row{display:flex;align-items:center;gap:8px;margin:8px 0;flex-wrap:wrap}',
		    '.dca-input{flex:1;min-width:0;padding:6px 9px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.2));border-radius:7px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));color:inherit;font-size:12px}',
		    '.dca-note{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;margin:4px 0 10px}',
		    '.dca-sw{display:flex;align-items:center;gap:9px;width:100%;box-sizing:border-box;padding:8px 9px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.16));border-radius:8px;background:transparent;color:inherit;font-size:12px;cursor:pointer;text-align:left;margin-top:6px}',
		    '.dca-sw__t{flex:1;min-width:0}', '.dca-sw__h{display:block;font-size:10px;color:var(--dsw-alias-label-tertiary,#999);margin-top:2px}',
		    '.dca-sw__k{flex:none;width:30px;height:17px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.3));position:relative}',
		    '.dca-sw__k--on{background:var(--dsw-alias-state-brand-primary,#4c7cf3)}',
		    '.dca-sw__b{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:transform .15s}',
		    '.dca-sw__k--on .dca-sw__b{transform:translateX(13px)}',
		  ].join('');
		  function ensureStyle() {
		    try { ensurePolishStyle(); } catch (error) {}
		    if (typeof document === 'undefined' || !document.head) return;
		    if (document.getElementById(STYLE_ID)) return;
		    const node = document.createElement('style');
		    node.id = STYLE_ID; node.textContent = CSS;
		    document.head.appendChild(node);
		  }

		  let shared = { doc: undefined, at: 0, busy: false, error: '' };
		  const listeners = new Set();
		  const pendingTimers = new Set();
		  function later(fn, ms) {
		    const id = setTimeout(function () { pendingTimers.delete(id); fn(); }, ms);
		    pendingTimers.add(id);
		    return id;
		  }
		  function clearLater() {
		    for (const id of Array.from(pendingTimers)) clearTimeout(id);
		    pendingTimers.clear();
		  }
		  function emit() { for (const fn of Array.from(listeners)) { try { fn(); } catch (e) {} } }
		  function patch(next) { shared = Object.assign({}, shared, next); emit(); }
		  function subscribe(fn) { listeners.add(fn); return function () { listeners.delete(fn); }; }
		  function snapshot() { return shared; }
		  function useShared() { return react.useSyncExternalStore(subscribe, snapshot, snapshot); }

		  let inFlight = null;
		  let forcePending = false;
		  function load(force) {
		    if (inFlight !== null) {
		      // 强制刷新不能被在飞请求静默吞掉：记下待办，等在飞请求收尾后补一次。
		      if (force === true) forcePending = true;
		      return inFlight;
		    }
		    patch({ busy: true, error: '' });
		    const ctrl = new AbortController();
		    const to = setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS);
		    inFlight = fetch(STATUS_PATH + (force === true ? '?refresh=1' : ''), { credentials: 'same-origin', headers: { accept: 'application/json' }, signal: ctrl.signal })
		      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json().catch(function () { return undefined; }); })
		      .then(function (v) { if (v && typeof v === 'object' && !Array.isArray(v)) patch({ doc: v, at: Date.now(), error: '' }); else throw new Error('unexpected payload'); })
		      .catch(function (e) { patch({ error: String((e && e.message) || e) }); })
		      .finally(function () { clearTimeout(to); inFlight = null; patch({ busy: false }); if (forcePending) { forcePending = false; void load(true); } });
		    return inFlight;
		  }
		  function post(path, payload) {
		    // POST 也要有时限：没有超时的 fetch 会让 busy 卡到页面卸载。
		    const ctrl = new AbortController();
		    const to = setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS);
		    return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(payload || {}), signal: ctrl.signal })
		      .then(function (r) { return r.json().catch(function () { return undefined; }).then(function (v) { return { ok: r.ok, body: v }; }); })
		      .finally(function () { clearTimeout(to); });
		  }
		  function pick(doc) {
		    const ca = (doc && doc.codearts) || undefined;
		    const auth = (doc && doc.codeartsAuth) || undefined;
				    const c = (ca && ca.credits) || {};
		    const accounts = Array.isArray(c.accounts) ? c.accounts : [];
		    const usage = (ca && ca.usage) || {};
		    const today = usage.today || {};
		    return { ca: ca, auth: auth, credits: c, accounts: accounts, usage: usage, today: today, queue: ca && ca.queue };
		  }

		  function SettingsBody() {
		    const st = useShared();
		    const d = pick(st.doc);
		    const [paste, setPaste] = react.useState('');
		    const [busy, setBusy] = react.useState('');
		    const [note, setNote] = react.useState('');
		    const authAccounts = (d.auth && Array.isArray(d.auth.accounts)) ? d.auth.accounts : [];
		    function act(name, payload) {
		      setBusy(name); setNote('');
		      post(OAUTH_PATH, Object.assign({ action: name }, payload || {}))
		        .then(function (r) {
		          const b = r.body || {};
		          if (!r.ok || b.ok === false) throw new Error(b.error || ('HTTP ' + (r.status || '')));
		          if (name === 'start' && b.url) {
		            try { window.open(b.url, '_blank', 'noopener'); } catch (e) {}
		            setNote(t('oauthStarted'));
		            [1200, 4000, 10000].forEach(function (ms) { later(function () { void load(false); }, ms); });
		          } else if (name === 'submit') { setPaste(''); setNote(t('pasteOk')); }
		          else setNote('');
		          later(function () { void load(true); }, 800);
		        })
		        .catch(function (e) { setNote(String((e && e.message) || e)); })
		        .finally(function () { setBusy(''); });
		    }
		    function probe() {
		      setBusy('queue');
		      post(QUEUE_PATH, {}).then(function () { later(function () { void load(false); }, 300); })
		        .catch(function () {}).finally(function () { setBusy(''); });
		    }
		    const accountRows = authAccounts.map(function (a, i) {
		      return react.createElement('div', { className: 'dca-acc', key: String(a.id || i) },
		        react.createElement('div', { className: 'dca-acc__hd' },
		          react.createElement('span', { className: 'dca-acc__name' }, String(a.label || a.userName || a.id)),
		          react.createElement('span', { className: 'dca-kv' }, (a.paused ? t('paused') : '') + (a.stale ? ' · ' + t('stale') : ''))),
		        react.createElement('div', { className: 'dca-row', style: { margin: 0 } },
		          react.createElement('button', { className: 'dca-btn', disabled: busy !== '', onClick: function () { act('pause', { account: a.id, paused: !a.paused }); } }, a.paused ? t('resume') : t('pause')),
		          react.createElement('button', { className: 'dca-btn', disabled: busy !== '', onClick: function () { act('pin', { account: a.id, pinned: !a.pinned }); } }, a.pinned ? t('unpin') : t('pin')),
		          react.createElement('button', { className: 'dca-btn', disabled: busy !== '', onClick: function () { act('logout', { account: a.id }); } }, t('logout'))));
		    });
		    return react.createElement(react.Fragment, null,
		      react.createElement('div', { className: 'dca-row' },
		        react.createElement('button', { className: 'dca-btn dca-btn--primary', disabled: busy === 'start', onClick: function () { act('start', {}); } }, busy === 'start' ? t('loggingIn') : t('oauthLogin'))),
		      react.createElement('div', { className: 'dca-note' }, t('oauthHint')),
		      react.createElement('div', { className: 'dca-row' },
		        react.createElement('input', { className: 'dca-input', type: 'password', autoComplete: 'off', placeholder: t('pasteLabel'), value: paste, onChange: function (e) { setPaste(e.target.value); } }),
		        react.createElement('button', { className: 'dca-btn', disabled: busy === 'submit' || !paste.trim(), onClick: function () { act('submit', { token: paste }); } }, busy === 'submit' ? t('busy') : t('paste'))),
		      react.createElement('div', { className: 'dca-note' }, t('pasteHint')),
		      authAccounts.length ? accountRows : react.createElement('div', { className: 'dca-note' }, t('noAccounts')),
		      authAccounts.length ? react.createElement('button', { className: 'dca-btn', disabled: busy !== '', onClick: function () { act('logout', {}); } }, t('logoutAll')) : null,
		      react.createElement('div', { className: 'dca-row' },
		        react.createElement('button', { className: 'dca-btn', disabled: busy === 'queue', onClick: probe }, busy === 'queue' ? t('busy') : t('probeQueue')),
		        react.createElement('button', { className: 'dca-btn', onClick: function () { void load(true); } }, t('refresh')),
		        react.createElement('span', { className: 'dca-note', style: { margin: 0 } }, t('modelCount', { count: num(d.ca && d.ca.modelCount) }))),
		      note ? react.createElement('div', { className: 'dca-note' }, note) : null,
		      st.busy ? react.createElement('div', { className: 'dca-note' }, t('busy')) : null);
		  }

		  function SettingsCard() {
		    react.useEffect(function () { ensureStyle(); void load(false); return function () { clearLater(); }; }, []);
		    return react.createElement('div', { className: 'dshc-polish-dca', style: { padding: '4px 2px' } }, react.createElement(SettingsBody, {}));
		  }

		  const name = NAMESPACE;
		  const inject = ['slots', 'locale'];
		  function apply(ctx) {
		    try { boundT = ctx.locale.bind(NAMESPACE); } catch (e) { boundT = undefined; }
		    try { ctx.effect(function () { return ctx.locale.register(NAMESPACE, { zh: zh, en: en }); }, 'dsh-camel-pool: codearts copy'); } catch (e) {}
		    try {
		      ctx.slots.inject('settings.plugin.item', function () {
		        return ctx.slots.register({ name: 'settings.plugin.item', key: 'dsh-camel-pool-codearts', priority: 26, inject: function () { return {}; } }, SettingsCard);
		      });
		    } catch (e) {}
		    try {
		      ctx.slots.inject('settings.plugins.tab', function () {
		        return ctx.slots.register({ name: 'settings.plugins.tab', id: 'dsh-camel-pool-codearts', order: 11, label: function () { return t('title'); }, locale: NAMESPACE }, SettingsCard);
		      });
		    } catch (e) {}
		  }
		  exports.apply = apply;
		  exports.inject = inject;
		  exports.name = name;
		  return module.exports;
		})();

		//#region 合并入口

		/** 四份贡献，按显示顺序：三个渠道各自的信息行在前，面板最后。 */
				// ── 进阶质感：作用域隔离的一次性样式注入 ─────────────────────────────
		// 判据取 DOM 里有没有该 <style>，不用模块标记：宿主清空 head 后仍能补回。
		// 基础层只用宿主原生 token，关掉 codex 玻璃时仍是原生观感；联动层只在
		// html[data-dsh-glass] 下复用 codex 的 --dsh-glass-* 材质，与其同一套
		// 背景 / 描边 / 投影 / 模糊，不另起一套玻璃，避免两套主题互相打架。
		const POLISH_CSS = [
			/* ① 弹层外壳：圆角对齐 codex 14px；保留宿主原生投影，叠一条 1px 内高光。 */
			'html body .dshc-glass{border-radius:14px!important;box-shadow:var(--dsw-shadow-lv2,0 8px 28px rgba(0,0,0,.18)),inset 0 1px 0 rgba(255,255,255,.45)!important;transition:box-shadow .15s ease,border-color .15s ease,background-color .15s ease}',
			'html body[data-ds-dark-theme] .dshc-glass{box-shadow:var(--dsw-shadow-lv2,0 8px 28px rgba(0,0,0,.18)),inset 0 1px 0 rgba(255,255,255,.08)!important}',
			/* ② 平铺卡片：只补表面，不改背景、不加模糊（与 codex 平铺玻璃模式一致）。 */
			'html body .dshc-surface,html body .dca-acc,html body .dcp-card,html body .dcp-lib__opts,html body .dcp-usage__stat,html body .dcp-switch{box-shadow:inset 0 1px 0 rgba(255,255,255,.35);transition:box-shadow .15s ease,border-color .15s ease,background-color .15s ease}',
			'html body[data-ds-dark-theme] .dshc-surface,html body[data-ds-dark-theme] .dca-acc,html body[data-ds-dark-theme] .dcp-card,html body[data-ds-dark-theme] .dcp-lib__opts,html body[data-ds-dark-theme] .dcp-usage__stat,html body[data-ds-dark-theme] .dcp-switch{box-shadow:inset 0 1px 0 rgba(255,255,255,.07)}',
			'html body .dshc-surface:hover,html body .dca-acc:hover{box-shadow:inset 0 1px 0 rgba(255,255,255,.45),0 4px 14px color-mix(in srgb,var(--dsw-alias-bg-mask-2,rgba(0,0,0,.35)) 16%,transparent)}',
			/* ③ 原本无过渡的控件补 150ms 颜色过渡；已有过渡的按钮/行保持原生，不覆盖。 */
			'html body .dca-btn,html body .dca-input,html body .dca-chip,html body .dcp-more,html body .dcp-usage__tab{transition:background-color .15s ease,color .15s ease,border-color .15s ease,box-shadow .15s ease}',
			'html body .dcp-btn:hover:not(:disabled),html body .dca-btn:hover:not(:disabled){box-shadow:inset 0 1px 0 rgba(255,255,255,.28)}',
			'html body[data-ds-dark-theme] .dcp-btn:hover:not(:disabled),html body[data-ds-dark-theme] .dca-btn:hover:not(:disabled){box-shadow:inset 0 1px 0 rgba(255,255,255,.08)}',
			/* ④ 数据条：数值刷新时宽度/高度平滑，不硬跳。 */
			'html body .dcp-row__barfill,html body .dca-bar__in,html body .dshc-polish-bar{transition:width .4s var(--ds-ease-in-out,ease)}',
			'html body .dcp-usage__trend-bar{transition:height .4s var(--ds-ease-in-out,ease),opacity .15s ease}',
			/* ⑤ 进场：codex 玻璃未启用时弹层淡入；启用时交给 codex 自带 dialog 动效，避免叠两层。 */
			'@keyframes dshc-rise{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}',
			'html:not([data-dsh-glass]) body .dshc-glass{animation:dshc-rise .18s var(--ds-ease-out,ease-out) both}',
			'html body .dshc-surface,html body .dshc-polish-dca{animation:dshc-rise .18s var(--ds-ease-out,ease-out) both}',
			/* ⑥ codex 玻璃联动：弹层接同一套材质拿到真毛玻璃；卡片只换描边与内高光，仍不开模糊。 */
			'html[data-dsh-glass] body .dshc-glass{background:var(--dsh-glass-card-raised,var(--dsw-alias-bg-layer-1))!important;border-color:var(--dsh-glass-rim,var(--dsw-alias-border-l2))!important;box-shadow:var(--dsh-glass-drop,var(--dsw-shadow-lv2,0 8px 28px rgba(0,0,0,.18))),var(--dsh-glass-edge,inset 0 1px 0 rgba(255,255,255,.1))!important;-webkit-backdrop-filter:blur(var(--dsh-glass-blur,14px));backdrop-filter:blur(var(--dsh-glass-blur,14px))}',
			'html[data-dsh-glass] body .dshc-surface,html[data-dsh-glass] body .dca-acc,html[data-dsh-glass] body .dcp-card,html[data-dsh-glass] body .dcp-lib__opts,html[data-dsh-glass] body .dcp-usage__stat,html[data-dsh-glass] body .dcp-switch{border-color:var(--dsh-glass-rim-soft,var(--dsw-alias-border-l2));box-shadow:var(--dsh-glass-edge,inset 0 1px 0 rgba(255,255,255,.08))}',
			'html[data-dsh-glass] body .dshc-surface:hover,html[data-dsh-glass] body .dca-acc:hover{border-color:var(--dsh-glass-rim,var(--dsw-alias-border-l2));box-shadow:var(--dsh-glass-edge,inset 0 1px 0 rgba(255,255,255,.08)),var(--dsh-glass-drop,0 8px 24px rgba(0,0,0,.08))}',
			'html[data-dsh-glass] body .dcp-total{outline:1px solid var(--dsh-glass-rim-soft,var(--dsw-alias-border-l2));outline-offset:-1px}',
			/* ⑦ 尊重系统「减弱动效」。 */
			'@media (prefers-reduced-motion: reduce){html body [class*="dshc-"],html body [class*="dcp-"],html body [class*="dca-"]{animation:none!important;transition:none!important;scroll-behavior:auto!important}}',
		].join('');
		function ensurePolishStyle() {
			if (typeof document === 'undefined' || !document.head) return;
			if (document.head.querySelector('style[data-dsh-camel-polish]') !== null) return;
			const node = document.createElement('style');
			node.setAttribute('data-dsh-camel-polish', '');
			node.textContent = POLISH_CSS;
			document.head.appendChild(node);
		}
		const CONTRIBUTIONS = [
			["dsh-workbuddy-connect", workbuddyClient],
			["dsh-trae-connect", traeClient],
			["dsh-qoder-connect", qoderClient],
			["panel", panelClient],
			["poolCredits", poolCreditsClient],
			["codearts", codeartsClient],
		];

		const name = "dsh-connect-client";
		/** 并集：四份贡献分别用到 slots / locale；modelDirectories 由各自的 inject 处理。 */
		const inject = ["slots", "locale"];

		/**
		 * 逐份 apply。**一份失败不连累其余** —— 面板挂了，三个渠道的信息行照旧。
		 */
		function apply(ctx) {
			try { ensurePolishStyle(); } catch (error) { console.error('[dsh-camel-pool] 质感样式注入失败（不影响功能）：', error); }
			for (const [label, contribution] of CONTRIBUTIONS) {
				try {
					const fn = contribution === null || contribution === undefined ? undefined : contribution.apply;
					if (typeof fn !== "function") throw new Error("该半侧没有导出 apply");
					// 三个渠道各自还会往 composer dock 注册一条信息行；三合一后那些信息已经
					// 并进面板按钮里了，用 skipDock 拦掉（只拦 dock，其余贡献照旧）。
					fn(ctx, label === "panel" ? undefined : { skipDock: true });
				} catch (error) {
					console.error(`[dsh-connect] ${label} 的客户端半侧加载失败（其余贡献与宿主不受影响）：`, error);
				}
			}
		}

		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	},
});
