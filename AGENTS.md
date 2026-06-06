# Agent 开发协作指南

本仓库是一个 AI Agent 协作开发项目：Electron 桌面端承载 React 聊天 UI、Live2D 展示层、OpenAI-compatible Agent Runtime、受控工具执行、权限确认、trace 与 artifact 诊断链路。本文面向参与开发的 Agent，优先记录真实代码结构、边界约束和常见修改路径。

## 工作规则

- 以仓库根目录为工作目录，不要在仓库外创建项目文件。
- 开发前优先阅读 `AGENTS.md`、`README.md`、现有源码和相关配置；需要需求背景时再阅读本地 `docs/`。
- 不提交密钥、令牌、`.env`、本地模型、trace、workspace 或其他用户数据。
- `docs/` 与 `local/` 当前均在 `.gitignore` 中，不要依赖它们被版本控制。
- 使用 `corepack pnpm`，不要假设系统全局安装了 `pnpm`。

## 常用命令

```bash
corepack pnpm install      # 安装 workspace 依赖
corepack pnpm dev          # 启动 Electron + Vite 开发环境
corepack pnpm typecheck    # tsc -b 类型检查 / 项目引用构建
corepack pnpm test         # Node test runner + tsx
corepack pnpm lint         # ESLint .ts/.tsx
corepack pnpm build        # tsc -b 后 electron-vite build
```

修改代码后优先运行 `corepack pnpm typecheck`。涉及行为逻辑、设置、权限、Agent Core、模型适配器或服务层时也运行 `corepack pnpm test`；交付或改动构建配置时运行 `corepack pnpm build`。

## Monorepo 结构

```text
apps/desktop/                         Electron 桌面应用
  src/main/                            Main Process，高权限 Node/Electron API
    main.ts                            启动入口，创建服务、注册 IPC、创建窗口
    window-manager.ts                  透明置顶窗口与渲染进程事件推送
    ipc-handlers.ts                    ipcMain.handle 注册集中处
    services/
      agent-service.ts                 组装 AgentSession、模型适配器、工具执行器
      settings-service.ts              settings.json、env、本地 dev config 合并与校验
      permission-service.ts            工具权限策略、审批 Promise、危险命令识别
      trace-service.ts                 JSONL trace 写入和读取
      artifact-store.ts                截图、音频、工具输出等 artifact 存取
      prompt-service.ts                用户可编辑 system.md / tool-overrides.json
  src/preload/index.ts                 contextBridge 暴露 window.petAgent API
  src/renderer/                        React UI，无 Node/Electron 直接权限
    App.tsx                            聊天、设置、录音、Live2D、调试面板主状态
    components/                        DebugPanel、TraceViewer、ManualActionInjector 等
    audio/                             useAudioRecorder 与 WAV 编码
    live2d/Live2DView.tsx              PixiJS + Live2D 渲染

packages/shared/                       共享类型、IPC 通道常量、settings schema、情绪定义
packages/agent-core/                   与 Electron/React 解耦的 AgentSession、事件总线、工具注册、情绪管线
packages/tools/                        工具定义与 RuntimeToolContext 类型
packages/model-openai-compatible/      OpenAI-compatible Chat Completions adapter
packages/live2d/                       AvatarDriver 抽象与情绪绑定解析

local/                                 本地开发资源，gitignored，禁止提交
docs/                                  本地需求/设计资料，当前 gitignored
```

## 核心数据流

1. Renderer 通过 `window.petAgent.sendUserMessage()` 调用 preload。
2. Preload 使用 `IPC_CHANNELS` 调用 Main Process 的 `ipcMain.handle`。
3. `AgentService` 调用 `AgentSession.runUserMessage()`，注入模型适配器、工具定义和权限控制。
4. `OpenAiCompatibleAdapter` 调用 OpenAI-compatible `/chat/completions`，支持 tool calls 与音频附件转 `input_audio`。
5. `AgentSession` 解析 assistant 尾部 `<emotion value="..." />`，发出 `message.added`、`emotion.set`、`tool.*`、`approval.pending` 等事件。
6. 工具调用先经过 `PermissionService`；需要审批时 Renderer 显示确认气泡，批准/拒绝后 Agent loop 继续。
7. 所有事件写入 `TraceService`，同时推送到 Renderer；Renderer 将事件映射为聊天消息、状态提示和 Live2D 动作/表情。

## 工具与权限模型

当前默认工具：

- `shell.run`：在 workspace 内执行 PowerShell 命令，30s 超时，stdout/stderr 截断。
- `file.read` / `file.write`：读写 workspace 内 UTF-8 文件。
- `clipboard.read` / `clipboard.write`：读写系统剪贴板文本。
- `screenshot.capture`：截屏并保存 PNG artifact。
- `task.finish`：结束当前任务并传回总结/状态。

权限相关概念：

- Agent 运行模式：`manual` / `confirm` / `auto`。
- 工具权限策略：`permissions.mode` 为 `permissive` 或 `ask`。
- 权限级别：`safe`、`workspace_read`、`workspace_write`、`screen_read`、`clipboard_read`、`clipboard_write`、`shell`、`dangerous`。
- `PermissionService` 会识别高影响 shell 命令，例如 `rm -rf`、`Remove-Item -Recurse -Force`、`format`、`diskpart`、`shutdown`、`reg delete` 等。
- `dangerous` 级别默认拒绝；所有路径类能力必须限制在 `workspaceDir` 内。

## 本地配置约定

- `.env.example` 仅作为环境变量示例，真实 `.env*` 不得提交。
- 首次启动会在 Electron `userData` 目录生成 `settings.json`。
- 默认 workspace：`<userData>/workspace`。
- Trace：`<userData>/traces/latest.jsonl` 与 `<userData>/traces/sessions/*.jsonl`。
- Artifact：`<userData>/artifacts/`，其中截图在 `screenshots/`，音频在 `audio/`。
- 用户可编辑 prompt：`<userData>/dev-prompts/system.md` 与 `tool-overrides.json`。

配置合并规则：

1. 代码默认值会先结合环境变量：`OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`、`AGENT_MODE`。
2. 开发环境本地配置 `local/config.yaml` 参与默认值生成（仅 `NODE_ENV=development` 或存在 `ELECTRON_RENDERER_URL` 时读取）。环境变量优先于 `local/config.yaml`。
3. 若已存在 `<userData>/settings.json`，持久化配置会覆盖上述默认值；缺失字段再由默认值补齐。

`local/config.yaml` 支持的简化格式：

```yaml
settings:
  mode: confirm
  openaiBaseUrl: https://api.openai.com/v1
  openaiModel: gpt-4o-mini
  openaiApiKey: sk-...
  permissionMode: permissive
```

`local/` 已加入 `.gitignore`，但仍要避免把真实 API Key、模型资源或用户素材复制到可提交路径。

## Live2D 开发约定

- 开发默认 Cubism Core JS：`local/live2dcubismcore.min.js`。
- 开发默认模型：`local/玳瑁猫v1_vts/玳瑁猫v1_vts.model3.json`。
- 若 `settings.json` 中 `live2d.modelPath` 为空，开发环境会自动尝试回落到上述本地模型。
- Renderer 只通过受控逻辑和 `live2d-local://` 协议加载 Live2D 展示资源；协议侧必须做目录白名单校验。
- Live2D 层只响应 Agent 状态/情绪，不得参与 Agent 决策、权限判断或工具执行。
- 更换模型时只修改本地 `settings.json` 或 `local/` 内容，不要把模型路径硬编码进 Agent Core。

## 安全边界

- Renderer 不允许直接访问 Node/Electron 高权限 API；只能通过 preload 的 `window.petAgent` 通信。
- API Key 只能存在于 Main Process、环境变量或本地 settings 中；传给 Renderer 的 `PublicSettings` 只能暴露 `hasApiKey`。
- `packages/agent-core` 保持与 Electron/React/Live2D/Node I/O 解耦。
- 工具执行、权限确认、文件系统、shell、截图、剪贴板都必须在 Main Process 受控完成。
- `file.*`、`shell.run`、artifact 读取等路径必须经过 realpath / inside workspace 校验，防止路径逃逸。
- Trace 不应写入 API Key 或音频 base64 等敏感大载荷；音频通过 artifact 引用传递。
- 非打包开发环境可能打开 Electron 远程调试端口，勿把该行为误带到生产安全假设中。

## 常见修改路径

### 新增或修改工具

1. `packages/tools/src/`：定义工具 schema、权限级别、说明和执行函数类型。
2. `packages/tools/src/index.ts`：加入默认工具列表导出。
3. `apps/desktop/src/main/services/agent-service.ts`：在执行器映射中接入 Main Process 实现。
4. `apps/desktop/src/main/services/permission-service.ts`：如有新权限或风险策略，更新审批逻辑。
5. Renderer：如需展示新工具摘要、风险标签或手动执行 UI，同步更新相关组件。
6. 测试：优先补 `packages/*/src/**/*.test.ts` 或 `apps/desktop/src/main/services/**/*.test.ts`。

### 新增 IPC API

1. `packages/shared/src/constants.ts`：增加 `IPC_CHANNELS`。
2. `packages/shared/src/ipc.ts` / `schemas.ts`：补请求、响应和共享类型。
3. `apps/desktop/src/preload/index.ts`：暴露到 `window.petAgent`。
4. `apps/desktop/src/main/ipc-handlers.ts`：注册 handler。
5. `apps/desktop/src/renderer/env.d.ts`：更新 Renderer 侧类型。

### 新增设置项

1. `packages/shared/src/schemas.ts`：更新 `AppSettings` / `PublicSettings` / patch 类型。
2. `apps/desktop/src/main/services/settings-service.ts`：补默认值、sanitize、public patch 白名单、持久化合并逻辑。
3. `apps/desktop/src/main/services/agent-service.ts`：如设置影响运行时，确保 reconfigure 后生效。
4. `apps/desktop/src/renderer/App.tsx`：补设置面板和表单同步。
5. 添加或更新 settings-service 测试。

### 新增包

1. `pnpm-workspace.yaml` 已覆盖 `packages/*` 和 `apps/*`。
2. 根 `tsconfig.json` 增加 project reference。
3. 相关消费方的 `tsconfig.json` 和 `package.json` 增加引用/依赖。
4. 如 desktop 需源码别名，更新 `apps/desktop/electron.vite.config.ts`。
5. 若新增测试路径，更新根 `package.json` 的 `test` 脚本 glob。

## 测试注意事项

- 当前使用 Node 内置 test runner：`node:test` + `node:assert`，通过 `tsx` 转译 TypeScript。
- 不使用 Jest/Vitest/Mocha。
- 根 `test` 脚本显式列出测试 glob；新增不在 glob 内的测试不会自动运行。
- 修改测试文件或测试夹具时，确保 `corepack pnpm test` 覆盖到实际文件。

## 禁止提交

- `.env`、`.env.local`、任何真实凭证或 token。
- `local/` 下的 Live2D 模型、Cubism Core JS、用户素材和本地配置。
- `docs/` 本地资料，除非先调整 `.gitignore` 并确认要纳入版本控制。
- `node_modules/`、`dist/`、`dist-types/`、`out/`、`.tsbuildinfo`、source map。
- workspace、traces、screenshots、artifact 等运行时数据。
