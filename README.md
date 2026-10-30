# dsh-rice-mode

> 给 DSH 加一个「无限大白饭模式」开关：想让模型放开手脚干活的时候拨到开，平时关着省钱。

一个 DSH（DeepSeek Harness）插件。右下角一颗胶囊，三档切换，控制要不要往系统提示里注入下面这两句：

```
【无限大白饭模式】用量不限，正在极限测试，不要省 token。
充分想，写完整。该查的查，该跑的跑，别因为费事就跳过。
```

## 三档

```
🍚 关      不注入，平时的样子
🍚 本轮    只对当前这一轮生效，这一轮结束自动回落「关」
🍚 常开    一直注入，直到手动关
```

「一轮」指的是从你发出消息开始，到我做完这件事、回复出来为止，**中间所有工具调用都算在内**。

## 安装

```sh
cd $DSH_HOME/profiles/web
npm install file:/path/to/dsh-rice-mode
```

然后把它加进 `package.json` 的 `dsh.profile.bundles` 花名册：

```json
"dsh": {
  "profile": {
    "bundles": ["...", "dsh-rice-mode"]
  }
}
```

（0.2.0 内核只认这个花名册，光写 `dependencies` 不会加载，这是踩过的坑。）

**重启 DSH。**

## 用法

点胶囊切档。长按 0.7 秒变「确认重启？」，再长按一次重启 App —— 走 Shizuku，不用去后台划掉进程。

命令行也能操作：

```sh
curl -s http://127.0.0.1:3080/rice-mode/status
# {"ok":true,"mode":1,"updatedAt":1793358386458}

curl -s -X POST "http://127.0.0.1:3080/rice-mode/set?mode=2"
# mode: 0=关 1=本轮 2=常开
```

## 重启功能（仅安卓）

**这一段是安卓专有的，Windows / macOS / Linux 上没有。** 电脑端想重启直接关掉进程再启动就行，用不着 Shizuku。

App 是普通应用（`u0_a397`），直接 `am` 会被系统拒：

```
am start -n com.deepseek.harness/.MainActivity
→ Exception occurred while executing 'start'
```

所以借 Shizuku 的 shell 身份（uid 2000）：

```js
spawn("/system/bin/app_process", [
  `-Djava.class.path=${dex}`,
  "/system/bin",
  "--nice-name=rish",
  "rikka.shizuku.shell.ShizukuShellLoader",
  "-c", command,
]);
```

然后跑：

```sh
setsid sh -c 'sleep 2; am force-stop com.deepseek.harness; sleep 1.5; am start -n com.deepseek.harness/.MainActivity'
```

`setsid` 是为了让脚本脱离 rish 进程 —— App 被杀之后 `am start` 还得接着跑。

**没有 Shizuku 或者不在安卓上：** 胶囊长按会提示重启失败，切档功能照常能用。

## 原理

往 `systemPrompt` 注册一个 section，`text` 是个函数，每次组装提示词时按当前档位决定返回内容还是空串：

```js
ctx.systemPrompt.section({
  name: "dsh-rice-mode",
  order: 5200,
  interpolate: false,
  text: () => (mode === 0 ? "" : RICE_TEXT),
});
```

**「本轮」怎么知道结束了：** 内核在轮次状态变化时发 `agent/status`，payload 里 `status` 只有 `running` / `idle` 两种（见 `dsh-agent-loop/lib/index.js` 的 `setPhase`）。收到 `idle` 就把档位归零。

另有一条时间兜底：90 秒没有新的提示词组装，也当这一轮完了。两条路谁先到算谁。

## 踩过的坑

### 1. `app_process` 起不来：`cannot find "libz.so"`

DSH 的 Node 环境把 `LD_LIBRARY_PATH` 指到了自带的 `runtime/lib`，那里没有 `libz.so`。`app_process` 顺着那条路径找，直接链接失败：

```
CANNOT LINK EXECUTABLE "/system/bin/app_process": cannot find "libz.so"
from verneed[1] in DT_NEEDED list for "/apex/com.android.art/lib64/libunwindstack.so"
```

**解法：spawn 前删掉 `LD_LIBRARY_PATH` / `LD_PRELOAD` / `LD_DEBUG`**，让它回落到系统默认库路径。

### 2. dex 要压成只读

ART 拒绝加载「当前 uid 可写」的 dex（Android 15 起更严格）。每次调用前 `chmod 444`。

### 3. 设置页没有开放插槽

查过 `dsh-purge`：它只用 `conversation.input.right` 和 `shell.overlay` 两个 slot，没有设置页的。所以重启功能挂在了胶囊的长按上，没做进设置页。

`@deepseek-ai/dsh-client-ui-settings` 这个包确实存在，接口在 App 的 assets 里打包着，源码看不到。

### 4. `exports` vs `module.exports`

客户端 bundle 的 factory 体里如果写裸 `exports.apply = ...`，会报 `exports is not defined`（同一个 bug 在别的插件里也见过）。用 `module.exports.apply`。

## 兼容性

- 开发和测试环境：DSH `0.2.0-rc.2`
- 客户端插件用纯 DOM 注入（`position:fixed` 的独立元素），不依赖 React 版本
- 切档和注入功能跨平台，Windows / macOS / Linux 都能用
- **重启功能仅安卓**，且需要 Shizuku 已授权。其它平台长按会提示失败，别的功能不受影响

## 许可

MIT
