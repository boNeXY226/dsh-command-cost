/**
 * dsh-command-cost client bundle — the web panel half of the plugin.
 *
 * A hand-written `dsh.client` bundle (no build step). The host passes the
 * current session id through the `conversation.input.dock` slot inject
 * factory, and the component renders a FLOATING cost chip pinned to the
 * viewport's top-right corner through a React portal to `document.body` —
 * deliberately outside the slot layout, so no dock/container styling can
 * hide it. All visuals are inline styles: no injected stylesheet, no class
 * names, no nested fragment structure — the chip is a single div with one
 * text node and one button child.
 *
 * The chip shows the session's model, the current 🔴/🟢 billing period, live
 * token totals and the estimated cost, with a manual refresh button, a
 * 5-second auto-refresh, and an immediate refetch whenever the tokenUsage
 * projection changes.
 *
 * Cost/period data comes from the host's `/cost-panel/data?session=<id>`
 * JSON route (single source of truth: prices and config live in the host
 * plugin). Live token totals come from the `tokenUsage` session projection
 * the dsh-token-meter already pushes to the client.
 */
window.__ModuleLoader__.load({
	id: "dsh-command-cost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react_dom = null;
		try {
			react_dom = require("react-dom");
		} catch {
			react_dom = null;
		}

		// Theme-aware colors: read the app's own CSS variables so the chip
		// follows dark/light switching; the fallbacks match the dark theme.
		const chipStyle = {
			position: "fixed",
			left: 16,
			bottom: 51,
			zIndex: 2147483000,
			display: "flex",
			flexDirection: "column",
			alignItems: "flex-start",
			gap: 3,
			maxWidth: "min(480px, calc(100vw - 32px))",
			padding: "6px 12px",
			border: "1px solid var(--dsw-alias-border-l1, #3f3f46)",
			borderRadius: 14,
			background: "var(--dsw-alias-bg-base, #18181b)",
			color: "var(--dsw-alias-label-primary, #f4f4f5)",
			boxShadow: "0 2px 14px rgba(0,0,0,0.45)",
			fontSize: 12,
			lineHeight: "18px",
			userSelect: "none",
			cursor: "default",
		};
		const btnStyle = {
			width: 26,
			height: 26,
			flex: "none",
			color: "var(--dsw-alias-label-tertiary, #a1a1aa)",
			cursor: "pointer",
			background: "transparent",
			border: "none",
			borderRadius: 999,
			display: "inline-flex",
			justifyContent: "center",
			alignItems: "center",
			padding: 0,
			fontSize: 14,
		};

		function fmtCompact(n) {
			if (n >= 1e9) return (n / 1e9).toFixed(2) + "G"
			if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"
			if (n >= 1e3) return (n / 1e3).toFixed(1) + "K"
			return String(Math.round(n))
		}

		/**
		 * The floating cost chip. `useProjection` is bound by the slot renderer
		 * for the current session; `sessionId` comes from the inject factory.
		 */
		function CostDock({ useProjection, sessionId }) {
			const usage = useProjection("tokenUsage");
			const [report, setReport] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [refreshing, setRefreshing] = react.useState(false);

			const liveTotal = usage
				? (usage.uncachedInputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
				: null;

			const load = react.useCallback(async () => {
				if (!sessionId) return;
				setRefreshing(true);
				try {
					const res = await fetch("/cost-panel/data?session=" + encodeURIComponent(sessionId));
					const data = await res.json();
					if (data && data.ok === true) {
						setReport(data);
						setError(null);
					} else {
						setError(data?.error ?? "http-" + res.status);
					}
				} catch (cause) {
					setError(String(cause?.message ?? cause));
				} finally {
					setRefreshing(false);
				}
			}, [sessionId]);

			react.useEffect(() => { void load(); }, [load, liveTotal]);
			react.useEffect(() => {
				const timer = setInterval(() => void load(), 5000);
				return () => clearInterval(timer);
			}, [load]);

			const showTokens = report ? report.tokens.total : (liveTotal ?? 0);
			const modelLine = report
				? (report.provider ? report.provider + " · " : "") + (report.model ?? "?")
				: (error ? "费用面板不可用" : "会话费用");
			const title = report
				? "model " + (report.provider ?? "?") + " · " + (report.model ?? "?")
					+ "\nperiod " + report.periodBadge + " (Beijing " + report.clock + ")"
					+ "\nprice row " + report.rowName + " · " + report.tierLabel
					+ "\noriginal input " + report.prices.original.input + " / peak " + (report.prices.peak?.input ?? "-") + " / off-peak " + (report.prices.offPeak?.input ?? "-") + " " + report.currencySymbol + " per 1M tokens"
				: "Session token cost";

			// NOTE: the automatic jsx-runtime signature is jsx(type, props, key) —
			// children must ride in props.children (variadic children would land
			// in the `key` slot and render nothing, as the SSR test caught).
			const chip = react_jsx_runtime.jsx("div", {
				style: chipStyle,
				title,
				children: [
					react_jsx_runtime.jsx("div", {
						key: "model",
						style: { fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" },
						children: modelLine,
					}),
					react_jsx_runtime.jsx("div", {
						key: "sub",
						style: { display: "flex", alignItems: "center", gap: 10, whiteSpace: "nowrap" },
						children: [
							...(report
								? [
									react_jsx_runtime.jsx("span", { key: "period", style: { flex: "none" }, children: report.periodBadge }),
									react_jsx_runtime.jsx("span", { key: "tokens", style: { flex: "none", color: "var(--dsw-alias-label-secondary, #a1a1aa)" }, children: fmtCompact(showTokens) + " tok" }),
									react_jsx_runtime.jsx("span", { key: "money", style: { flex: "none", color: "var(--dsw-alias-state-business-primary, #60a5fa)", fontWeight: 700 }, children: report.currencySymbol + report.cost.total.toFixed(4) }),
								]
								: [
									react_jsx_runtime.jsx("span", { key: "loading", style: { flex: "none", color: "var(--dsw-alias-label-secondary, #a1a1aa)" }, children: "加载中…" }),
								]),
							react_jsx_runtime.jsx("button", {
								key: "refresh",
								style: btnStyle,
								type: "button",
								disabled: refreshing,
								onClick: () => void load(),
								children: "↻",
							}),
						],
					}),
				],
			});

			// Portal to document.body: escapes every slot container, so no
			// dock layout or ancestor style can hide the chip.
			if (react_dom?.createPortal && typeof document !== "undefined") {
				return react_dom.createPortal(chip, document.body);
			}
			return chip;
		}

		/** Client cordis services this plugin needs from the client runtime. */
		const inject = ["slots"];

		/**
		 * Client plugin body: the dock slot registration supplies the current
		 * session id; the component itself renders through a body portal.
		 */
		function apply(ctx) {
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "cost",
				order: 20,
				inject: (sessionId) => ({ sessionId }),
			}, CostDock));
		}

		exports.CostDock = CostDock;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
