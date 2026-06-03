# Live2D Agent

桌面 Live2D Agent 小助手 v0 骨架，基于 Electron + React + TypeScript + pnpm workspace。

## 当前已包含

- Electron 透明悬浮窗口与安全 preload 桥接
- React 聊天 UI、权限确认气泡、状态占位 Avatar
- Runtime 解耦的 Agent Core：模型适配器、工具注册、Agent loop、事件总线
- OpenAI-compatible Chat Completions adapter
- v0 工具定义与主进程执行能力：`shell.run`、`file.read`、`file.write`、`clipboard.read`、`clipboard.write`、`screenshot.capture`、`task.finish`
- confirm/manual/auto 权限模式与 JSONL trace 写入
- Live2D `AvatarDriver` 抽象与占位状态映射

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

注意：API Key 仅在 Main Process 使用，不会暴露给 Renderer。

## 验证

```bash
corepack pnpm typecheck
corepack pnpm build
```

## 待补充

- 接入真实 Live2D 模型资源与 PixiJS/Cubism 驱动
- 更完善的设置面板（API Key、workspace、base URL）
- 单元测试/集成测试
- 更细粒度的权限策略持久化与 trace 回放 UI
