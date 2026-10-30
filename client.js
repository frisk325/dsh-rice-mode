// dsh-rice-mode —— 浏览器侧
//
// 在页面右下角放一条三档胶囊：关 / 本轮 / 常开。
// 点一下切一档，通过 fetch 打到宿主插件注册的 /rice-mode/*。
//
// 设计约束：只追加独立的 fixed 元素，不改动任何既有布局与样式。

window.__ModuleLoader__.load({
	id: "dsh-rice-mode",
	factory: (require) => {
		var module = { exports: {} };

		var WRAP_ID = "dsh-rice-mode-wrap";
		var MODES = [
			{ v: 0, label: "关", color: "#666", bg: "#222" },
			{ v: 1, label: "本轮", color: "#1a1a1a", bg: "#ffd54f" },
			{ v: 2, label: "常开", color: "#1a1a1a", bg: "#ff8a65" },
		];

		var current = 0;
		var phase = null; // "armed" | "used" | null
		var sessionId = "";
		var busy = false;
		var online = true;

		/** 从宿主服务里读当前会话 id，读不到就留空（走全局那份状态） */
		function readSessionId() {
			var host = window.__riceModeHost;
			if (!host) return "";
			try {
				var sel = host.uiWorkspace && host.uiWorkspace.selection;
				var sid = sel && sel.getSnapshot && sel.getSnapshot();
				if (sid && typeof sid.sessionId === "string" && sid.sessionId) {
					sessionId = sid.sessionId;
					return sessionId;
				}
			} catch (e) {}
			try {
				var snap = host.sessions && host.sessions.list && host.sessions.list.getSnapshot();
				if (snap && typeof snap.current === "string" && snap.current) {
					sessionId = snap.current;
					return sessionId;
				}
			} catch (e) {}
			return "";
		}

		function api(url) {
			if (!sessionId) return url;
			return url + (url.indexOf("?") >= 0 ? "&" : "?") + "session=" + encodeURIComponent(sessionId);
		}

		function paint() {
			var wrap = document.getElementById(WRAP_ID);
			if (!wrap) return;
			var m = MODES[current] || MODES[0];
			wrap.style.background = online ? m.bg : "#333";
			wrap.style.color = online ? m.color : "#777";

			var text = m.label;
			// 「本轮」分两个阶段，让用户看得见到底生效了没有
			if (current === 1) {
				text = phase === "used" ? "本轮·生效中" : "本轮·待用";
			}

			wrap.textContent = online ? "🍚 " + text : "🍚 离线";
			wrap.title = online
				? current === 1
					? phase === "used"
						? "已注入，这一轮结束后自动关"
						: "已就绪，你下一条消息会带上（点击切下一档）"
					: "无限大白饭模式：" + m.label + "（点击切换）"
				: "连不上宿主插件，点一下重试";
		}

		function apply_() {
			if (typeof document === "undefined" || !document.body) return;
			var stale = document.getElementById(WRAP_ID);
			if (stale) stale.remove();

			var el = document.createElement("div");
			el.id = WRAP_ID;
			el.style.cssText = [
				"position:fixed",
				"right:12px",
				"bottom:150px",
				"z-index:9998",
				"padding:6px 12px",
				"border-radius:14px",
				"font-size:13px",
				"font-weight:600",
				"font-family:system-ui,-apple-system,sans-serif",
				"cursor:pointer",
				"user-select:none",
				"box-shadow:0 2px 8px rgba(0,0,0,.35)",
				"transition:background .15s,color .15s",
				"line-height:1.3",
			].join(";");
			el.onclick = function () {
				// 长按已经处理过的这一下，不要再切档
				if (suppressClick) {
					suppressClick = false;
					return;
				}
				if (busy || armed) return;
				busy = true;
				var next = (current + 1) % 3;
				fetch(api("/rice-mode/set?mode=" + next), {
					method: "POST",
					cache: "no-store",
					credentials: "same-origin",
				})
					.then(function (r) {
						return r.ok ? r.json() : Promise.reject();
					})
					.then(function (d) {
						if (d && typeof d.mode === "number") current = d.mode;
						phase = d.phase || null;
						online = true;
						paint();
					})
					.catch(function () {
						online = false;
						paint();
					})
					.finally(function () {
						busy = false;
					});
			};
			document.body.appendChild(el);

			// ---- 重启：长按胶囊触发 ----
			// 原来是独立一颗按钮，但右下角太挤，会挡到「回到最新」那颗。
			// 改成挂在胶囊上：短按切档，长按 700ms 进重启确认。
			var armed = false;
			var armTimer = null;
			var lpTimer = null;
			var suppressClick = false;

			function disarm() {
				armed = false;
				if (armTimer) {
					clearTimeout(armTimer);
					armTimer = null;
				}
				paint();
			}

			function doRestart() {
				el.textContent = "重启中…";
				el.style.background = "#1b5e20";
				el.style.color = "#fff";
				fetch("/app-restart", {
					method: "POST",
					cache: "no-store",
					credentials: "same-origin",
				})
					.then(function (r) {
						return r.ok ? r.json() : Promise.reject();
					})
					.then(function () {
						el.textContent = "重启中…";
					})
					.catch(function () {
						el.textContent = "重启失败";
						setTimeout(disarm, 1500);
					});
			}

			el.addEventListener("pointerdown", function () {
				suppressClick = false;
				lpTimer = setTimeout(function () {
					lpTimer = null;
					suppressClick = true;
					if (!armed) {
						armed = true;
						el.textContent = "确认重启？";
						el.style.background = "#c62828";
						el.style.color = "#fff";
						armTimer = setTimeout(disarm, 5000);
					} else {
						clearTimeout(armTimer);
						armTimer = null;
						doRestart();
					}
				}, 700);
			});
			el.addEventListener("pointerup", function () {
				if (lpTimer) {
					clearTimeout(lpTimer);
					lpTimer = null;
				}
			});
			el.addEventListener("pointercancel", function () {
				if (lpTimer) {
					clearTimeout(lpTimer);
					lpTimer = null;
				}
			});

			// 拉一次状态（按钮要跟着宿主变，所以做成可复用的）
			function sync() {
				if (busy) return;
				fetch(api("/rice-mode/status"), { cache: "no-store", credentials: "same-origin" })
					.then(function (r) {
						return r.ok ? r.json() : Promise.reject();
					})
					.then(function (d) {
						if (d && typeof d.mode === "number") current = d.mode;
						phase = d.phase || null;
						online = true;
						paint();
					})
					.catch(function () {
						online = false;
						paint();
					});
			}

			sync();

			// 每 10 秒对一次。宿主那边「本轮」到点是会自己回落的，
			// 按钮不刷新的话用户会以为还开着。
			if (window.__riceModeTimer) clearInterval(window.__riceModeTimer);
			window.__riceModeTimer = setInterval(sync, 10000);

			paint();
		}

		function apply(ctx) {
			apply_();

			// 尽力拿到「当前会话 id」，拿到之后状态就是按会话隔离的。
			// 拿不到也没关系，宿主会退回全局那一份。
			try {
				if (typeof ctx === "object" && typeof ctx.inject === "function") {
					ctx.inject(["sessions", "uiWorkspace"], function (host) {
						try {
							window.__riceModeHost = host;
							readSessionId();
							// 切会话时立刻换一份状态，不用等 10 秒轮询
							if (window.__riceModeSessionTimer) {
								clearInterval(window.__riceModeSessionTimer);
							}
							window.__riceModeSessionTimer = setInterval(function () {
								var before = sessionId;
								readSessionId();
								if (sessionId !== before) sync();
							}, 1500);
						} catch (e) {}
					});
				}
			} catch (e) {}

			// 页面切走再回来时补一次（SPA 有时会重建 body 子树）
			if (typeof ctx === "object" && typeof ctx.effect === "function") {
				ctx.effect(() => {
					return () => {
						var el = document.getElementById(WRAP_ID);
						if (el) el.remove();
					};
				}, "dsh-rice-mode: cleanup");
			}
		}

		module.exports.apply = apply;
		return module.exports;
	},
});
