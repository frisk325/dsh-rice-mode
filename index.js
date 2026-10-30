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

/** 「本轮」模式判定结束的静默窗口：90 秒 */
const WINDOW_MS = 90_000;

/** 当前档位 0/1/2 */
let mode = 0;
/** 上一次组装提示词的时间 */
let lastAssemblyAt = 0;
/** 状态变动时间，给客户端轮询用 */
let updatedAt = Date.now();

function setMode(next) {
  const v = Number(next);
  if (!Number.isInteger(v) || v < 0 || v > 2) return false;
  mode = v;
  updatedAt = Date.now();
  // 切到「本轮」时，把窗口重置，避免刚切就以为上一轮还在跑
  if (v === 1) lastAssemblyAt = 0;
  return true;
}

export function apply(ctx) {
  // ---- 系统提示注入 ----
  const section = {
    name: "dsh-rice-mode",
    order: 5200,
    interpolate: false,
    text: () => {
      if (mode === 0) return "";

      if (mode === 1) {
        const now = Date.now();
        // 已经有上一次记录，且静默超过窗口 → 上一轮结束，回落
        if (lastAssemblyAt > 0 && now - lastAssemblyAt > WINDOW_MS) {
          mode = 0;
          updatedAt = now;
          lastAssemblyAt = 0;
          return "";
        }
        lastAssemblyAt = now;
        return RICE_TEXT;
      }

      // mode === 2
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

  // ---- 精确判定「本轮结束」 ----
  // 内核在轮次状态变化时发 agent/status，status 只有 "running" / "idle"。
  // 收到 idle 就说明这一轮真完了，「本轮」档当场回落。
  // 时间窗口那条仍然留着兜底：万一事件没挂上，靠它也能收。
  try {
    if (typeof ctx.on === "function") {
      ctx.on("agent/status", (payload) => {
        const status = payload && payload.status;
        if (status === "idle" && mode === 1) {
          mode = 0;
          lastAssemblyAt = 0;
          updatedAt = Date.now();
        }
      });
    }
  } catch (err) {
    // 挂不上就算了，后面还有时间兜底
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

      // 读状态
      host.webServer.register(
        {
          kind: "exact",
          path: "/rice-mode/status",
          handler: async (req, res) => {
            // 顺手做一次惰性过期判断
            if (
              mode === 1 &&
              lastAssemblyAt > 0 &&
              Date.now() - lastAssemblyAt > WINDOW_MS
            ) {
              mode = 0;
              updatedAt = Date.now();
            }
            json(res, 200, { ok: true, mode, updatedAt });
          },
        },
        "dsh-rice-mode: status",
      );

      // 设档位  ?mode=0|1|2
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
            try {
              const u = new URL(req.url, "http://localhost");
              value = u.searchParams.get("mode");
            } catch {}
            if (value == null && raw) {
              try {
                value = JSON.parse(raw).mode;
              } catch {}
            }
            if (!setMode(value)) {
              json(res, 400, { ok: false, error: "mode 必须是 0 / 1 / 2" });
              return;
            }
            json(res, 200, { ok: true, mode, updatedAt });
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
