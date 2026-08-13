/**
 * dsh-cost-chip client bundle — the web panel half of the plugin.
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
	id: "dsh-cost-chip",
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
		// Position (left/top) is state-driven so the chip can be dragged.
		const chipStyle = {
			position: "fixed",
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
			touchAction: "none",
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

		// ── drag & position helpers ────────────────────────────────────────────

		const POS_STORAGE_KEY = "dsh-command-cost:chip-pos"; // 键名保留旧值，升级后位置记忆不丢
		/** Movement threshold (px) that turns a press into a drag. */
		const DRAG_THRESHOLD = 4;

		/** Default dock position: bottom-left, matching the pre-drag layout. */
		function defaultPos() {
			const vh = typeof window !== "undefined" ? window.innerHeight : 800;
			return { left: 16, top: Math.max(8, vh - 119) };
		}

		function loadPos() {
			try {
				if (typeof window !== "undefined") {
					const raw = window.localStorage.getItem(POS_STORAGE_KEY);
					if (raw) {
						const p = JSON.parse(raw);
						if (Number.isFinite(p.left) && Number.isFinite(p.top)) return { left: p.left, top: p.top };
					}
				}
			} catch { /* private mode etc. */ }
			return null;
		}

		function savePos(p) {
			try {
				if (typeof window !== "undefined") window.localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(p));
			} catch { /* ignore */ }
		}

		function clearPos() {
			try {
				if (typeof window !== "undefined") window.localStorage.removeItem(POS_STORAGE_KEY);
			} catch { /* ignore */ }
		}

		/** Clamp a chip position inside the viewport (exported for tests). */
		function clampPos(pos, width, height) {
			const vw = (typeof window !== "undefined" && Number.isFinite(window.innerWidth)) ? window.innerWidth : 600;
			const vh = (typeof window !== "undefined" && Number.isFinite(window.innerHeight)) ? window.innerHeight : 800;
			return {
				left: Math.min(Math.max(0, pos.left), Math.max(0, vw - width)),
				top: Math.min(Math.max(0, pos.top), Math.max(0, vh - height)),
			};
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
			const [pos, setPos] = react.useState(() => loadPos() ?? defaultPos());
			const [dragging, setDragging] = react.useState(false);
			const chipRef = react.useRef(null);
			const posRef = react.useRef(pos);
			posRef.current = pos;
			const dragRef = react.useRef(null);

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

			// Keep the chip inside the viewport when the window resizes.
			react.useEffect(() => {
				const onResize = () => {
					const el = chipRef.current;
					if (!el) return;
					setPos((p) => clampPos(p, el.offsetWidth, el.offsetHeight));
				};
				if (typeof window !== "undefined") window.addEventListener("resize", onResize);
				return () => {
					if (typeof window !== "undefined") window.removeEventListener("resize", onResize);
				};
			}, []);

			// ── drag handlers ───────────────────────────────────────────────────
			const onPointerDown = (e) => {
				if (e.button !== undefined && e.button !== 0) return;
				if (e.target && typeof e.target.closest === "function" && e.target.closest("button")) return;
				dragRef.current = {
					startX: e.clientX,
					startY: e.clientY,
					startLeft: posRef.current.left,
					startTop: posRef.current.top,
					dragging: false,
					pointerId: e.pointerId,
				};
				try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
			};
			const onPointerMove = (e) => {
				const d = dragRef.current;
				if (!d || e.pointerId !== d.pointerId) return;
				const dx = e.clientX - d.startX;
				const dy = e.clientY - d.startY;
				if (!d.dragging && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
				if (!d.dragging) {
					d.dragging = true;
					setDragging(true);
				}
				const el = chipRef.current;
				const w = el ? el.offsetWidth : 400;
				const h = el ? el.offsetHeight : 60;
				setPos(clampPos({ left: d.startLeft + dx, top: d.startTop + dy }, w, h));
			};
			const onPointerUp = (e) => {
				const d = dragRef.current;
				if (!d || e.pointerId !== d.pointerId) return;
				dragRef.current = null;
				setDragging(false);
				try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
				if (d.dragging) savePos(posRef.current);
			};
			// Double-click anywhere on the chip (not the button) resets to the
			// default bottom-left dock and forgets the saved position.
			const onDoubleClick = (e) => {
				if (e.target && typeof e.target.closest === "function" && e.target.closest("button")) return;
				clearPos();
				setPos(defaultPos());
			};

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
			// children ride in props.children and `key` is the THIRD argument
			// (variadic children would land in the key slot and render nothing,
			// and keys inside props trigger a React warning — both caught by the
			// SSR assertions).
			const chip = react_jsx_runtime.jsx("div", {
				ref: chipRef,
				style: { ...chipStyle, left: pos.left, top: pos.top, cursor: dragging ? "grabbing" : "grab" },
				title: title + "\ndrag to move · double-click to reset position",
				onPointerDown,
				onPointerMove,
				onPointerUp,
				onDoubleClick,
				children: [
					react_jsx_runtime.jsx("div", {
						style: { fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" },
						children: modelLine,
					}, "model"),
					react_jsx_runtime.jsx("div", {
						style: { display: "flex", alignItems: "center", gap: 10, whiteSpace: "nowrap" },
						children: [
							...(report
								? [
									react_jsx_runtime.jsx("span", { style: { flex: "none" }, children: report.periodBadge }, "period"),
									react_jsx_runtime.jsx("span", { style: { flex: "none", color: "var(--dsw-alias-label-secondary, #a1a1aa)" }, children: fmtCompact(showTokens) + " tok" }, "tokens"),
									react_jsx_runtime.jsx("span", { style: { flex: "none", color: "var(--dsw-alias-state-business-primary, #60a5fa)", fontWeight: 700 }, children: report.currencySymbol + report.cost.total.toFixed(4) }, "money"),
								]
								: [
									react_jsx_runtime.jsx("span", { style: { flex: "none", color: "var(--dsw-alias-label-secondary, #a1a1aa)" }, children: "加载中…" }, "loading"),
								]),
							react_jsx_runtime.jsx("button", {
								style: btnStyle,
								type: "button",
								disabled: refreshing,
								onClick: () => void load(),
								children: "↻",
							}, "refresh"),
						],
					}, "sub"),
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
		exports.clampPos = clampPos;
		return module.exports;
	}
});
