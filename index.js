/**
 * dsh-rice-mode —— 无限大白饭模式
 *
 * 三档：
 *   0 = 关
 *   1 = 本轮（只对当前这一轮生效，这一轮结束后自动回落 0）
 *   2 = 一直开（直到手动关）
 *
 * 原理：往 systemPrompt 注册一个 section，text 是函数，
 * 每次组装提示词时按当前档位决定返回内容还是空串。
 *
 * 「本轮」怎么判断结束：靠 text() 的调用间隔。
 * 同一轮里每步推理都会重新组装提示词，间隔通常几十秒内；
 * 超过 WINDOW_MS 没有新的组装，就认为上一轮已经完了。
 */

export const name = "dsh-rice-mode";
export const inject = ["systemPrompt"];

import { spawn } from "node:child_process";
import { existsSync, chmodSync } from "node:fs";

/** 注入的正文 */
const RICE_TEXT = [
  "【无限大白饭模式】用量不限，正在极限测试，不要省 token。",
  "充分想，写完整。该查的查，该跑的跑，别因为费事就跳过。",
].join("\n");

/** 「本轮」模式判定结束的静默窗口：90 秒（只作兜底，主判据是 agent/status） */
const WINDOW_MS = 90_000;

/**
 * 每个会话一份状态。
 * 拿不到 sessionId 的时候退回 "_global"，此时行为跟以前的全局模式一样。
 */
const states = new Map();

function blankState() {
  return {
    mode: 0,
    /** "armed" | "used" | null，见 setMode 上的说明 */
    phase: null,
    lastAssemblyAt: 0,
    updatedAt: Date.now(),
  };
}

function stateOf(sid) {
  const key = sid || "_global";
  let s = states.get(key);
  if (!s) {
    s = blankState();
    states.set(key, s);
  }
  return s;
}

/** 从 assemble 传进来的 context 里尽量抠出 sessionId，抠不到就返回空串 */
function pickSessionId(context) {
  if (!context || typeof context !== "object") return "";
  const direct =
    context.sessionId ||
    context.session?.id ||
    context.session?.sessionId ||
    context.scope?.sessionId ||
    context.scope?.session?.id;
  return typeof direct === "string" ? direct : "";
}

/**
 * 「本轮」的两个阶段：
 *   "armed" —— 已点按钮，但真正的对话轮还没开始（可能这一轮还在跑）
 *   "used"  —— 新一轮已经开始，注入生效中
 * null 表示不在「本轮」状态。
 *
 * 关键：只有 used 撞上 idle 才归零。
 * armed 撞 idle 不动 —— 那说明用户是在上一轮跑完之后点的，
 * 要等他把下一条消息发出来才算用上。
 */
function setMode(sid, next) {
  const v = Number(next);
  if (!Number.isInteger(v) || v < 0 || v > 2) return false;
  const s = stateOf(sid);
  s.mode = v;
  s.updatedAt = Date.now();
  if (v === 1) {
    s.phase = "armed";
    s.lastAssemblyAt = 0;
  } else {
    s.phase = null;
    s.lastAssemblyAt = 0;
  }
  return true;
}

export function apply(ctx) {
  // ---- 系统提示注入 ----
  const section = {
    name: "dsh-rice-mode",
    order: 5200,
    interpolate: false,
    text: (context) => {
      const s = stateOf(pickSessionId(context));
      if (s.mode === 0) return "";
      if (s.mode === 2) return RICE_TEXT;

      // mode === 1
      if (!s.phase) return "";
      s.lastAssemblyAt = Date.now();
      return RICE_TEXT;
    },
  };

  try {
    const host = ctx?.systemPrompt?.ctx || ctx;
    if (host?.systemPrompt?.section) {
      const dispose = host.systemPrompt.section(section);
      if (typeof ctx.effect === "function" && typeof dispose === "function") {
        ctx.effect(() => dispose, "dsh-rice-mode: prompt section");
      }
    }
  } catch (err) {
    // 服务还没就绪时静默跳过，下次 apply 再来
  }

  // ---- 用 agent/status 精确判定「本轮」的起止 ----
  // status 只有 "running" / "idle" 两种（见 dsh-agent-loop 的 setPhase）。
  //
  // 状态机（按会话各跑一份）：
  //   点按钮        → mode=1, phase="armed"
  //   收到 running  → phase="used"（新一轮开始，注入从这里生效）
  //   收到 idle     → 只有 used 才归零；armed 不动
  //
  // 为什么 armed 撞 idle 不归零：用户常常是在我还跑着的时候点的按钮，
  // 点完这一轮结束就会来一次 idle。要是那时候归零，他下一条消息就白点了。
  // 老的实现就是这么丢的。
  try {
    if (typeof ctx.on === "function") {
      ctx.on("agent/status", (payload) => {
        const status = payload && payload.status;
        const sid = pickSessionId(payload);
        // 事件里没带 sessionId 就作用到全部 —— 保守起见，宁可多关不乱开
        const targets = sid
          ? [stateOf(sid)]
          : Array.from(states.values());

        for (const s of targets) {
          if (s.mode !== 1) continue;

          if (status === "running" && s.phase === "armed") {
            s.phase = "used";
            s.updatedAt = Date.now();
            continue;
          }

          if (status === "idle" && s.phase === "used") {
            s.mode = 0;
            s.phase = null;
            s.lastAssemblyAt = 0;
            s.updatedAt = Date.now();
          }
        }
      });
    }
  } catch (err) {
    // 挂不上就只能靠手动关
  }

  // ---- 给客户端用的 HTTP 端点 ----
  try {
    ctx.inject(["webServer"], (host) => {
      if (!host?.webServer?.register) return;

      const json = (res, code, obj) => {
        res.writeHead(code, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(obj));
      };

      // 读状态  ?session=<sid>
      host.webServer.register(
        {
          kind: "exact",
          path: "/rice-mode/status",
          handler: async (req, res) => {
            let sid = "";
            try {
              const u = new URL(req.url, "http://localhost");
              sid = u.searchParams.get("session") || "";
            } catch {}

            const s = stateOf(sid);

            // 兜底：used 状态下长时间没有提示词组装，说明事件漏了，强制收
            if (
              s.mode === 1 &&
              s.phase === "used" &&
              s.lastAssemblyAt > 0 &&
              Date.now() - s.lastAssemblyAt > WINDOW_MS
            ) {
              s.mode = 0;
              s.phase = null;
              s.lastAssemblyAt = 0;
              s.updatedAt = Date.now();
            }
            json(res, 200, {
              ok: true,
              mode: s.mode,
              phase: s.phase,
              session: sid || "_global",
              updatedAt: s.updatedAt,
            });
          },
        },
        "dsh-rice-mode: status",
      );

      // 设档位  ?mode=0|1|2&session=<sid>
      host.webServer.register(
        {
          kind: "exact",
          path: "/rice-mode/set",
          handler: async (req, res) => {
            let raw = "";
            if (req.method === "POST") {
              for await (const chunk of req) raw += chunk;
            }
            let value;
            let sid = "";
            try {
              const u = new URL(req.url, "http://localhost");
              value = u.searchParams.get("mode");
              sid = u.searchParams.get("session") || "";
            } catch {}
            if (value == null && raw) {
              try {
                value = JSON.parse(raw).mode;
              } catch {}
            }
            if (!setMode(sid, value)) {
              json(res, 400, { ok: false, error: "mode 必须是 0 / 1 / 2" });
              return;
            }
            const s = stateOf(sid);
            json(res, 200, {
              ok: true,
              mode: s.mode,
              phase: s.phase,
              session: sid || "_global",
              updatedAt: s.updatedAt,
            });
          },
        },
        "dsh-rice-mode: set",
      );

      // 重启 App —— 走 Shizuku 通道。
      // App 自己是普通应用（u0_a397），直接 am 会被拒；靠 rish 借 shell 身份。
      host.webServer.register(
        {
          kind: "exact",
          path: "/app-restart",
          handler: async (req, res) => {
            let dry = false;
            try {
              const u = new URL(req.url, "http://localhost");
              dry = u.searchParams.get("dry") === "1";
            } catch {}

            if (dry) {
              // 只验证通道能不能用，不动 App
              const r = await rishExec("echo rish-ok; id -u", 15000);
              json(res, r.ok ? 200 : 500, r);
              return;
            }

            json(res, 200, { ok: true, message: "2 秒后重启，请等它自己回来" });
            const pkg = "com.deepseek.harness";
            const act = "com.deepseek.harness/.MainActivity";
            // setsid 让脚本脱离本进程：App 被杀之后，后面的 am start 还要接着跑
            const script = `sleep 2; am force-stop ${pkg}; sleep 1.5; am start -n ${act}`;
            rishExec(
              `setsid sh -c '${script}' >/dev/null 2>&1 & echo queued`,
              6000,
            ).catch(() => {});
          },
        },
        "dsh-rice-mode: app-restart",
      );
    });
  } catch (err) {
    // webServer 不可用就算了，客户端会显示离线
  }
}

/** 候选 rish dex 路径，按顺序找第一个存在的 */
function findRishDex() {
  const cands = [
    process.env.SHIZUKU_DEX,
    "/data/user/0/com.deepseek.harness/files/payload/rish/rish_shizuku.dex",
    "/data/user/0/com.deepseek.harness/files/rish/rish_shizuku.dex",
  ].filter(Boolean);
  for (const p of cands) {
    try {
      if (existsSync(p)) return p;
    } catch {}
  }
  return null;
}

/** 借 Shizuku 以 shell 身份跑一条命令（复刻 dsh-tool-shizuku 的做法） */
function rishExec(command, timeoutMs = 20000) {
  const dex = findRishDex();
  if (!dex) {
    return Promise.resolve({ ok: false, error: "找不到 rish_shizuku.dex" });
  }
  // ART 拒绝加载「当前 uid 可写」的 dex，先压成只读
  try {
    chmodSync(dex, 0o444);
  } catch {}

  const appId = process.env.SHIZUKU_APP_ID || "com.deepseek.harness";
  // 这一行是关键：DSH 的 Node 环境把 LD_LIBRARY_PATH 指到了自带的 runtime/lib，
  // app_process 顺着那条路径找不到 libz.so，直接 "CANNOT LINK EXECUTABLE"。
  // 删掉这几个 LD_*，让它回落到系统默认库路径。
  const env = { ...process.env };
  delete env.LD_LIBRARY_PATH;
  delete env.LD_PRELOAD;
  delete env.LD_DEBUG;
  env.RISH_APPLICATION_ID = appId;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        "/system/bin/app_process",
        [
          `-Djava.class.path=${dex}`,
          "/system/bin",
          "--nice-name=rish",
          "rikka.shizuku.shell.ShizukuShellLoader",
          "-c",
          command,
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
      return;
    }
    let out = "";
    let err = "";
    let done = false;
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) =>
      finish({ ok: false, error: String((e && e.message) || e) }),
    );
    child.on("close", (code) =>
      finish({
        ok: code === 0,
        exit_code: code,
        stdout: out.trim(),
        stderr: err.trim(),
      }),
    );
  });
}

export default { name, inject, apply };
