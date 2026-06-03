# Agent 工作目录说明

本仓库是面向 AI Agent 协作开发的专用工作目录。

## 工作规则

- 以仓库根目录为工作目录，不要在仓库外创建项目文件。
- 开发前优先阅读 `AGENTS.md`、`README.md`、现有源码和相关配置；需要需求背景时再阅读本地 `docs/`。
- 不提交密钥、令牌、`.env` 或本地用户数据。
- `docs/` 为本地需求/架构资料目录，已加入 `.gitignore`，不要依赖其被版本控制。
- 构建产物、缓存、trace、workspace 数据不得提交。
- 使用 `corepack pnpm`，不要假设系统全局安装了 `pnpm`。

## 常用命令

安装依赖：

```bash
corepack pnpm install
```

开发运行：

```bash
corepack pnpm dev
```

修改后优先运行：

```bash
corepack pnpm typecheck
corepack pnpm build
```

## 本地配置约定

- `.env.example` 仅作为环境变量示例，真实 `.env*` 不得提交。
- 首次启动会在 Electron `userData` 目录生成 `settings.json`。
- OpenAI-compatible 配置项：`OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`。
- `workspaceDir` 默认在 Electron `userData/workspace`，工具文件读写必须限制在 workspace 内。
- trace 默认写入 Electron `userData/traces/*.jsonl`。

## 项目边界

- Renderer 不允许直接访问 Node/Electron 高权限 API。
- API Key 只能留在 Main Process 或本地 settings 中，不传给 Renderer。
- Agent Core 保持与 Electron/React/Live2D 解耦。
- 危险工具能力必须经过 Main Process 与权限确认流程。
- Live2D 只作为表现层，不能参与 Agent 决策。
- v0 暂不引入语音/TTS、MCP、浏览器自动化、长期记忆、多角色、插件系统、自动后台任务、全局鼠标键盘控制。

## 当前架构摘要

- `apps/desktop`：Electron Main/Preload/Renderer 桌面应用。
- `packages/shared`：IPC 常量、共享类型。
- `packages/agent-core`：模型适配器接口、工具注册、Agent loop、事件总线；不得依赖 Electron/React/Live2D。
- `packages/tools`：v0 工具定义和 runtime capability 接口；危险能力由宿主注入。
- `packages/model-openai-compatible`：OpenAI-compatible Chat Completions adapter。
- `packages/live2d`：AvatarDriver 抽象、占位驱动与状态映射。

## 当前待办方向

- 接入真实 Live2D 模型资源与 PixiJS/Cubism 驱动。
- 完善设置面板：API Key、workspace、base URL、model。
- 补充单元测试/集成测试。
- 完善权限策略持久化与 trace 回放 UI。
