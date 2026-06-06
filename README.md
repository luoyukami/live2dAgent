# Live2D Agent

Live2D Agent 是一个桌面 Live2D 小助手：它在 Electron 透明悬浮窗口中展示 Live2D/桌宠形象，通过 OpenAI-compatible Chat Completions API 与用户对话，并在权限控制下执行文件、Shell、截图、剪贴板等本地工具。

当前版本已包含聊天 UI、Agent Runtime、工具审批、安全工作区、Live2D 情绪映射、语音输入、trace/artifact 与调试面板等完整开发链路。

## 功能概览

- **桌面悬浮助手**：Electron 透明置顶窗口，React 聊天界面。
- **OpenAI-compatible 模型**：支持自定义 Base URL、API Key 和模型名。
- **受控工具调用**：`shell.run`、`file.read`、`file.write`、`clipboard.read`、`clipboard.write`、`screenshot.capture`、`task.finish`。
- **权限确认**：支持 `manual` / `confirm` / `auto` 运行模式，以及工具级 `permissive` / `ask` 策略。
- **安全工作区**：文件读写与 Shell 命令限制在 workspace 内。
- **Live2D 展示**：基于 PixiJS 和 `pixi-live2d-display-lipsyncpatch` 加载本地 `.model3.json`。
- **情绪驱动**：模型回复末尾的 `<emotion value="..." />` 标签可驱动表情/动作。
- **语音输入**：录制 WAV 音频，作为多模态音频附件发送给支持的模型。
- **Trace 与 Artifact**：JSONL 事件追踪、截图/音频/工具输出 artifact 保存。
- **调试面板**：查看事件、trace、最近模型请求/响应、手动执行工具、运行场景预设。

## 技术栈

- Electron 31
- React 18
- TypeScript 5.5
- Vite / electron-vite
- pnpm workspace
- PixiJS 7 + Live2D display patch
- OpenAI-compatible Chat Completions API
- Node 内置 test runner + `tsx`

## 快速开始

```bash
corepack pnpm install
corepack pnpm dev
```

启动后在设置面板中配置：

- API Key
- Base URL，例如 `https://api.openai.com/v1`
- 模型名，例如 `gpt-4o-mini` 或你的 OpenAI-compatible 服务模型名
- Workspace 目录（可选，默认在 Electron `userData/workspace`）
- Live2D 模型路径（可选）

也可以通过环境变量提供初始模型配置：

```bash
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

API Key 只在 Main Process 和本地 settings 中使用，不会传给 Renderer。

## 使用方式

### 对话

- 在底部输入框输入消息。
- `Enter` 发送，`Shift + Enter` 换行。
- 模型回复会显示在聊天区；工具消息可以折叠查看。

### 运行模式

顶部模式选择用于控制 Agent 工具调用：

- `manual`：阻止自动工具执行。
- `confirm`：需要用户确认工具调用。
- `auto`：按权限策略自动批准低风险工具。

当工具需要确认时，界面会显示确认气泡，包含工具名、风险级别和参数，可选择“允许”或“拒绝本轮工具调用”。

### 语音输入

- 点击麦克风按钮开始/停止录音。
- 窗口聚焦时可使用 `Ctrl/Cmd + Alt + V`。
- 当前录音格式为 WAV；录音会先保存为 artifact，再随消息作为音频附件发送给模型。
- 可在设置里关闭语音输入或关闭“将音频发送给模型”。

### Live2D

- 在设置中填写本地 `.model3.json` 路径。
- 开发环境若留空，会尝试使用 `local/玳瑁猫v1_vts/玳瑁猫v1_vts.model3.json`。
- Cubism Core JS 开发默认位置为 `local/live2dcubismcore.min.js`。
- 如果模型缺失或加载失败，会显示占位 Avatar。

### 调试面板

按 `Ctrl/Cmd + Shift + D` 打开调试面板。可使用：

- 运行状态概览
- Trace 事件查看与过滤
- 最近模型请求、响应、工具调用、权限结果
- 手动执行工具
- 场景预设一键发送
- 打开 trace / artifact / prompt / audio 文件夹
- Reload settings / prompt / Live2D

## 配置与数据位置

首次启动会在 Electron `userData` 目录生成运行数据：

```text
<userData>/settings.json                     主配置文件
<userData>/workspace/                         默认工作区
<userData>/traces/latest.jsonl                最近会话 trace
<userData>/traces/sessions/*.jsonl            历史会话 trace
<userData>/artifacts/screenshots/             截图
<userData>/artifacts/audio/                   录音
<userData>/artifacts/tool-output/             工具输出
<userData>/dev-prompts/system.md              可编辑 system prompt
<userData>/dev-prompts/tool-overrides.json    工具描述覆盖
```

开发环境还支持 `local/config.yaml` 作为本地启动配置（该目录已 gitignore）：

```yaml
settings:
  mode: confirm
  openaiBaseUrl: https://api.openai.com/v1
  openaiModel: gpt-4o-mini
  openaiApiKey: sk-...
  permissionMode: permissive
```

环境变量和 `local/config.yaml` 主要用于生成默认配置；如果已存在 `<userData>/settings.json`，持久化配置会覆盖这些默认值，缺失字段再回落到默认值。

## 开发与验证

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm lint
corepack pnpm build
```

仓库结构：

```text
apps/desktop/                         Electron 桌面端
packages/shared/                      共享类型、IPC 常量、settings schema
packages/agent-core/                  Agent loop、事件总线、工具注册、情绪管线
packages/tools/                       工具定义
packages/model-openai-compatible/     模型适配器
packages/live2d/                      Live2D 抽象与情绪绑定
```

## 安全与限制

- Renderer 不能直接访问 Node/Electron 高权限 API。
- API Key 不传给 Renderer。
- 文件读写和 Shell 命令必须位于 workspace 内。
- `shell.run` 当前使用 PowerShell，命令超时约 30 秒，输出会截断。
- 高风险 Shell 命令会被升级确认或拒绝。
- 截图、剪贴板读写等能力受权限策略控制。
- Live2D 当前主要面向本地模型路径。
- 当前音频输入以 WAV 为主；快捷键实现固定为 `Ctrl/Cmd + Alt + V`。
- 项目主要在 Windows 开发环境验证；Electron 跨平台能力不等同于所有工具后端已跨平台完善。
