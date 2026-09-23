# pi for VS Code

把 [pi](https://github.com/earendil-works/pi) coding agent 搬进 VS Code **右侧边栏**的图形前端，交互风格对齐 **Codex** 与 **Claude Code**：编辑器右上角一个按钮打开，一条流式对话、工具卡片、内联 diff、模型/思考等级、供应商与模型源管理、会话历史与分支，全程不离开编辑器。

引擎跑的是 pi 本体（`pi --mode rpc` 子进程），本扩展**只做前端**，不重新实现 agent 循环。

```
┌──────────────────────────────────────┐
│ π  session ▾        ● ready  ⚿ + ↻ ▤ │  header：会话 / 状态 / 操作
├──────────────────────────────────────┤
│  > fix the failing tests              │  user
│                                      │
│  I'll start by looking at the tests.  │  assistant（markdown）
│  ▸ Thinking                           │  可折叠思考
│  ┌ ⏺ Read  src/a.test.ts      12ms ┐ │  tool card
│  ├ ✎ Edit  src/a.ts       +4 -2    ┤ │  内联 diff
│  └ ⏺ Run   npm test         exit 1 ┘ │
├──────────────────────────────────────┤
│ [ @src/a.ts × ]                       │  attachments
│ Ask pi…  @ files  / commands  ! shell  │  composer
│ [✦ deepseek-v4.1-flash ▾]            │  model picker
│ ↑12.3k ↓4.5k ⚡58% 34% $0.12 [Compact] │  usage bar + 手动 compact
└──────────────────────────────────────┘
```

## 特性

- **流式对话**：assistant 文本、思考块、错误提示实时渲染；Markdown + 语法高亮（hljs），HTML 一律转义。
- **工具卡片**：bash / read / edit / write / grep / find / ls 各自有图标、标题、目标、耗时与状态；`edit`/`write` 渲染行级彩色 diff，输出流式增长。
- **内联 diff 与编辑器联动**：diff 卡片可「Open diff」在编辑器里以 `diff` 语言查看，「Open file」跳到真实文件与首个改动行。
- **运行中纠偏**：agent 工作时 composer 出现 `Steer / Queue` 切换 —— 插话在工具跑完后生效，排队等当前回合结束。
- **@ 引用、/ 命令与 ! shell**：`@` 模糊补全工作区文件（发送时由扩展读入内容并包成 `<file>` 上下文），`/` 补全 pi 的 extension commands、prompt templates 与 skills，`!` 开头直接调用 pi 的 `bash` RPC 执行 shell 命令（输出流式写入 Shell 卡片，可随 Stop 一起中断，结果会进入下一轮上下文）。
- **/skills 与 /plugins 查看能力**：两个内置命令打开「Skills & plugins」面板 —— Skills 列出 pi 上报的 `skill:*`（名称/描述/user·project/路径，点一下把 `/skill:name` 填进 composer）；Plugins 汇总 `~/.pi/agent/settings.json` 与 `.pi/settings.json` 里的 packages、本地 extensions，以及运行中引擎注册的 extension commands。
- **编辑器命令**：右键「Add Selection to pi」「Add File to pi」，或快捷键 `Ctrl+Alt+P` 聚焦对话、`Ctrl+Alt+N` 新建会话。
- **会话管理**：左上角标题随当前会话变化（显式名称 → 持久化会话标题 → 首条用户消息），历史列表、切换、重命名、删除，以及从任意用户消息「Branch a new session from this message」按 pi 的 fork 语义开新分支（分支按钮常驻可见）。
- **模型与思考**：按 provider 分组的模型选择器 + 思考等级切换，来自 pi 自己的模型清单。
- **供应商与模型源管理**：内置面板可直接增删 API Key（含自定义网关 baseUrl 覆盖）、新建 OpenAI/Anthropic/Google 兼容的自定义模型源（provider id + api + baseUrl + 模型列表），以及复用 pi 自身 PKCE 流程的订阅登录（Codex / Claude Pro·Max / Copilot / Grok / OpenRouter / Kimi / Meta / Radius）。每次保存都跑 `pi auth check` 验证，并自动重启引擎刷新模型列表。
- **用量实时统计 + 主动 compact**：composer 上方常驻一条用量栏 —— `↑` 上传（prompt）token、`↓` 下载（completion）token、`⚡` 缓存命中率（cacheRead / prompt）、上下文占用百分比与进度条（≥60% 变黄、≥85% 变红）、会话费用；流式过程中直接消费 `message_update.usage` 增量刷新，上下文占用用当前 prompt token 实时估算。右侧 `Compact` 按钮调用 pi 的 `compact` RPC 主动压缩上下文（运行中自动禁用），结果以压缩卡片渲染在对话里。
- **扩展 UI 协议**：pi 扩展的 `select / confirm / input / editor` 对话框与 `notify` 通知在 webview 内渲染。
- **信任门**：检测到 `.pi/*`、项目 skills 等需要信任的资源时先询问，决定写回 pi 自己的 `trust.json`，与 TUI 共享。
- **主题跟随**：全部使用 `--vscode-*` 变量，明暗主题自动适配。

## 安装

前置：Node ≥ 22.19，且已安装 pi CLI：

```bash
npm install -g @earendil-works/pi-coding-agent
pi auth check   # 确认至少配置了一个 provider
```

然后任选其一：

```bash
# 从源码构建 VSIX
npm install
npm run package          # 产出 pi-vscode-0.1.0.vsix
code --install-extension pi-vscode-0.1.0.vsix
```

开发调试：用 VS Code 打开本目录，按 `F5` 启动 Extension Development Host。

## 使用

1. 打开一个文件夹作为工作区。
2. 点编辑器右上角的 **π** 按钮（或 `Ctrl+Alt+P`）在右侧边栏打开对话；也可以从命令面板执行 `pi: Open pi Chat`。
3. 首次若目录含项目级资源，先决定是否信任。
4. 需要凭据时点对话头部（header）的钥匙按钮：填 API Key、加自定义模型源、或走订阅登录。每个功能只保留一个入口：新建会话 `+`、供应商钥匙、重启引擎 `↻`、日志 `▤`，其余同名入口已移除（命令面板与快捷键仍然可用）。
5. 直接描述任务；`@` 引文件、`/` 用命令。

## 设置

| 键 | 默认 | 说明 |
|---|---|---|
| `pi.executablePath` | `""` | pi CLI 路径。留空自动探测：扩展内置包 → 全局 npm → PATH 上的 `pi`。可指向可执行文件、包目录或 `dist/bundle/cli.js`。 |
| `pi.extraArgs` | `[]` | 追加给 `pi --mode rpc` 的参数，如 `--no-extensions`。 |
| `pi.tools` | `""` | 工具白名单（`--tools`），逗号分隔。 |
| `pi.excludeTools` | `""` | 工具黑名单（`--exclude-tools`）。 |
| `pi.approveProjectResources` | `false` | 直接信任项目级资源，等价 `pi --approve`。 |
| `pi.showThinking` | `true` | 是否渲染思考块。 |
| `pi.engineIdleTimeoutMinutes` | `30` | 引擎空闲回收时间，`0` 表示常驻。 |

## 架构

| 层 | 实现 |
|---|---|
| 引擎 | `pi --mode rpc` 子进程（JSONL over stdin/stdout）。扩展启动时用 Node（PATH 上的 `node`，回退 `process.execPath` + `ELECTRON_RUN_AS_NODE`）跑 pi 的 `dist/bundle/cli.js`。 |
| 监督 | `EngineInstance` 状态机（idle→starting→ready→stopping→stopped / crashed），每个工作区一个，空闲回收；`RpcPeer` 按 `id` 关联响应并路由事件。 |
| 状态 | `ChatModel` 消费 pi 事件流，产出有序 `ChatItem[]` + `Meta`；granular 消息（`item` / `delta` / `meta`）推给 webview，重载时用 `state` 全量恢复。 |
| 呈现 | React webview（侧边栏 `pi.chat`），纯渲染 + 用户意图回传；无 Node 能力，CSP 收紧。 |
| 管理面 | 会话列表直接读 `~/.pi/agent/sessions/<safePath>/*.jsonl`；信任决定读写 pi 的 `trust.json`；凭据与模型源读写 pi 的 `auth.json` / `models.json`（严格按文档 schema，写后即 `pi auth check` 验证）；OAuth 走 pi-ai 的 PKCE loader；其余全部走 RPC。 |

代码地图：

```
src/
  extension.ts              # activate：注册视图 / 命令 / diff provider
  engine/
    locate-pi.ts            # 找 pi CLI（设置 → 包 → PATH）
    pi-process.ts           # spawn + 进程树收尾
    engine-instance.ts      # 子进程监督 + RPC 命令封装
    rpc-peer.ts             # 请求/响应 + 事件路由 + 扩展 UI
    rpc-frames.ts           # JSONL 分帧（LF-only，不用 readline）
    engine-registry.ts      # 每工作区一个引擎 + 空闲回收
  chat/
    chat-controller.ts      # 编排：引擎生命周期、命令分发、刷新
    chat-model.ts           # pi 事件 → ChatItem/Meta
    chat-view.ts            # WebviewViewProvider + CSP/HTML
    diff-provider.ts        # pi-diff: 只读虚拟文档（diff 高亮）
  sessions/
    session-store.ts        # 会话文件列表/删除
    trust.ts                # 项目信任检测与读写
  providers/
    auth-store.ts           # auth.json 读写 + pi auth check
    models-config.ts        # models.json 合并写（自定义模型源）
    oauth.ts                # pi-ai PKCE loader 桥接
    provider-service.ts     # 凭据/模型源编排
  shared/protocol.ts        # host <-> webview 契约
  shared/provider-catalog.ts# provider/API 目录（host 与 webview 共用）
media/src/                  # React webview（components/ + styles.css）
```

## 开发

```bash
npm install
npm run typecheck     # tsc --noEmit（strict + noUncheckedIndexedAccess）
npm test              # 13 个用例：ChatModel 事件归约、diff 解析、auth/models 文件读写
npm run build         # esbuild 打两个包：dist/extension.js、dist/webview.js+css
npm run watch         # 增量构建
npm run smoke         # 用真实 pi 走 启动 → get_state/模型/命令 → 停止
npm run package       # 构建 VSIX
```

`npm run smoke` 会真的拉起本机 pi，验证 RPC 桥路是否通；不需要模型调用，不产生费用。

## 已知边界

- 视图固定在右侧边栏（secondary sidebar），需要 VS Code ≥ 1.101。
- 一次只驱动一个工作区（多根工作区取第一个）。
- 图片附件：协议已支持（`prompt.images`），composer 暂只做文件/选区引用。
- 会话列表按 pi 的默认 session 目录扫描；自定义 `--session-dir` 未纳入。
- 依赖用户已安装 pi；扩展不内置 pi 运行时（VSIX 体积小、升级跟随 `npm i -g`）。

## License

MIT
