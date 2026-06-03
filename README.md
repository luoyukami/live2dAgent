# Live2D Agent

桌面 Live2D Agent 小助手。它以透明悬浮窗口展示一个 Live2D/桌宠形象，并通过 OpenAI-compatible 模型提供对话和受控工具调用能力。

> 当前项目处于 v0 骨架阶段，重点是打通安全架构、Agent Runtime、权限确认和桌面应用基础链路。

## 当前已包含

- Electron 透明悬浮窗口与安全 preload 桥接
- React 聊天 UI、权限确认气泡、状态占位 Avatar
- Runtime 解耦的 Agent Core：模型适配器、工具注册、Agent loop、事件总线
- OpenAI-compatible Chat Completions adapter
- v0 工具定义与主进程执行能力：`shell.run`、`file.read`、`file.write`、`clipboard.read`、`clipboard.write`、`screenshot.capture`、`task.finish`
- confirm/manual/auto 权限模式与 JSONL trace 写入
- Live2D `AvatarDriver` 抽象与占位状态映射

## 技术栈

- Electron
- React
- TypeScript
- Vite / electron-vite
- pnpm workspace
- OpenAI-compatible Chat Completions API

## 开发

```bash
corepack pnpm install
corepack pnpm dev
```

## 配置

首次启动会在 Electron `userData` 目录生成 `settings.json`。也可以复制 `.env.example` 中的变量到运行环境：

- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`

API Key 仅在 Main Process 使用，不会暴露给 Renderer。

## 验证

```bash
corepack pnpm typecheck
corepack pnpm build
```

## 安全设计

- Renderer 不直接访问 Node/Electron 高权限 API。
- 文件、命令行、截图、剪贴板等能力都经由 Main Process 执行。
- 默认权限模式为 `confirm`，危险工具调用需要用户确认。
