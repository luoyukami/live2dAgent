# Agent 开发协作指南

本仓库是一个 AI Agent 桌面伴侣项目：Electron Main Process 承载高权限服务与 Agent Runtime，React Renderer 承载聊天/设置/调试 UI 与 Live2D 展示，workspace packages 提供共享类型、Agent Core、工具、模型适配器和 Live2D 抽象。本文是参与开发的入口文件，优先记录当前真实代码结构、边界约束、运行链路和常见修改路径。

## 工作规则

- 以仓库根目录为工作目录，不要在仓库外创建项目文件。
- 开发前优先阅读 `AGENTS.md`、`README.md`、相关源码和配置；需要需求背景时再阅读本地 `docs/`。
- 不提交密钥、令牌、`.env`、本地模型、trace、workspace、artifact 或其他用户数据。
- `docs/` 与 `local/` 当前均在 `.gitignore` 中，不要依赖它们被版本控制。
- 使用 `corepack pnpm`，不要假设系统全局安装了 `pnpm`。

## 常用命令

```bash
corepack pnpm install      # 安装 workspace 依赖
corepack pnpm dev          # 启动 Electron + Vite 开发环境
corepack pnpm typecheck    # tsc -b 类型检查 / project references 构建
corepack pnpm test         # Node test runner + tsx
corepack pnpm lint         # ESLint .ts/.tsx
corepack pnpm build        # tsc -b 后 electron-vite build
```

修改代码后优先运行 `corepack pnpm typecheck`。涉及行为逻辑、设置、权限、Agent Core、模型适配器、TTS、Main Process 服务或测试夹具时也运行 `corepack pnpm test`；交付或改动构建配置时运行 `corepack pnpm build`。

## Monorepo 结构

```text
apps/desktop/                               Electron 桌面应用
  src/main/                                  Main Process，高权限 Node/Electron API
    main.ts                                  启动入口、服务组装、live2d-local:// 协议、窗口创建
    window-manager.ts                        combined/dual 窗口管理、事件广播、鼠标穿透/hit-region
    ipc-handlers.ts                          ipcMain.handle 注册集中处
    runtime-mode.ts                          ws / http-legacy 运行时解析与降级
    agent-runtime-event-bridge.ts            AssistantRuntimeEvent → AgentEvent 桥接
    services/
      agent-service.ts                       Agent 编排、运行时选择、ToolRuntime 实现、TTS 调度
      settings-service.ts                    settings.json、env、本地 dev config 合并与校验
      permission-service.ts                  工具权限策略、审批 Promise、危险命令识别
      trace-service.ts                       JSONL trace 写入和读取，敏感/大载荷去除
      artifact-store.ts                      screenshot/audio/image/file-content/tool-output 等 artifact 存取
      prompt-service.ts                      dev-prompts/system.md 与 tool-overrides.json 管理
      live2d-model-json.ts                   model3.json 表情/动作自动合并与别名处理
      tts/
        tts-service.ts                       本地 TTS 编排、音色管理、音频文件写入
        local-tts-client.ts                  本地 TTS HTTP API 客户端
  src/preload/index.ts                       contextBridge 暴露 window.petAgent API
  src/renderer/                              React UI，无 Node/Electron 直接权限
    main.tsx                                 按 window-role 选择 AvatarApp/UiApp/App
    window-role.ts                           ?window=avatar|ui|combined 角色识别
    AvatarApp.tsx                            dual 模式 Live2D 专用窗口
    UiApp.tsx                                dual 模式聊天/设置/调试 UI 窗口
    App.tsx                                  combined 单窗口根组件
    renderer-shared.tsx                      共享设置表单、消息/附件辅助逻辑
    components/                              MessageBubble、ApprovalBubble、DebugPanel、TraceViewer、TtsSettingsSection 等
    hooks/                                   useTtsManager、useTtsPlayer
    audio/                                   useAudioRecorder 与 WAV 编码
    live2d/Live2DView.tsx                    PixiJS + Live2D 渲染、动作/表情绑定

packages/shared/                             共享类型、IPC 通道常量、settings schema、情绪/TTS 定义
packages/agent-core/                         与 Electron/React 解耦的 Agent 核心
  src/agent-session.ts                       HTTP legacy AgentSession
  src/runtime/                               WS AssistantRuntime、AssistantRun、RunController
  src/context/                               ContextManager 与 token budget
  src/conversation/                          ConversationManager
  src/model/                                 ModelMessage/ModelEvent/ProviderRuntime 等规范类型
  src/tools/                                 工具 schema 编码、结果截断、doom-loop 检测、运行工具链
  src/ws/                                    WS session、协议类型、错误定义
  src/emotion-*                              情绪标签解析与 prompt 注入
  src/tts-*                                  TTS 文本清理与 TTS 指令 prompt 注入
packages/tools/                              默认工具定义与 RuntimeToolContext 类型
packages/model-openai-compatible/            OpenAI-compatible HTTP adapter 与 MiMo/OpenAI-compatible WS runtime
packages/live2d/                             AvatarDriver 抽象、AgentEvent → avatar state、情绪绑定解析

local/                                       本地开发资源，gitignored，禁止提交
docs/                                        本地需求/设计资料，当前 gitignored
```

## 运行时与核心数据流

### Runtime 模式

- `settings.agent.runtimeMode` 支持 `ws` 与 `http-legacy`，默认值在 `settings-service.ts` 中为 `ws`。
- `ws` 模式要求 `openaiBaseUrl` 是 `ws://` 或 `wss://`；若配置为 `http(s)://`，`runtime-mode.ts` 会降级到 `http-legacy`，避免聊天无响应。
- `http-legacy` 使用旧链路：`AgentSession` + `OpenAiCompatibleAdapter` + `/chat/completions`。

### WS 默认链路

```text
Renderer
  → preload window.petAgent.sendUserMessage()
  → IPC_CHANNELS.SEND_USER_MESSAGE
  → AgentService.sendUserMessage()
  → AssistantRuntime / AssistantRun / RunController
  → ConversationManager + ContextManager(token budget)
  → ProviderRuntime: MimoWsRuntime
  → WebSocket 模型服务
  → AssistantRuntimeEvent
  → AgentRuntimeEventBridge
  → AgentEvent / EventBus
  → TraceService + WindowManager.broadcastAgentEvent()
  → Renderer UI / Live2D / TTS
```

### HTTP legacy 链路

```text
Renderer
  → preload / IPC
  → AgentService
  → AgentSession.runUserMessage()
  → OpenAiCompatibleAdapter POST /chat/completions
  → AgentEvent / EventBus
  → TraceService + WindowManager.broadcastAgentEvent()
```

### 工具调用链

```text
LLM tool call
  → agent-core ToolRuntime/processToolCalls
  → PermissionService.check()
  → [auto] AgentService executor map
  → [需要确认] approval.pending 事件 → Renderer ApprovalBubble → approve/deny IPC
  → 工具结果写回 runtime，必要时继续模型循环
```

工具输出会经过结果大小控制；重复/疑似死循环工具调用由 `DoomLoopDetector` 保护。

### 多模态、重试与事件

- 录音由 Renderer 采集音频数据，经 `AUDIO_SAVE_RECORDING` 交给 Main 保存为 audio artifact；模型请求时再转为 `input_audio`，trace/IPC 不保存 base64。
- 图片粘贴/拖放通过 `IMAGE_SAVE` 保存为 image artifact；模型请求时转为 `image_url` content part。
- `RETRY_LAST_USER_MESSAGE` 用于 LLM 出错后重发最近一次用户消息 payload。
- 主要事件包括 `message.*`、`tool.*`、`approval.pending`、`emotion.set`、`image.*`、`tts.*`、`error` 等；Renderer 将事件映射为聊天消息、状态提示、TTS 状态和 Live2D 动作/表情。

## 窗口与 UI 架构

- `settings.ui.windowMode` 支持：
  - `dual`（默认）：Avatar 窗口 + UI 窗口。
  - `combined`：旧单窗口模式，由 `App.tsx` 承载聊天、设置、Live2D 和调试面板。
- dual 模式：
  - Avatar 窗口加载 `?window=avatar` → `AvatarApp.tsx`，透明置顶，主要展示 Live2D；支持长按拖拽、鼠标穿透与 avatar hit-region。
  - UI 窗口加载 `?window=ui` → `UiApp.tsx`，承载聊天、设置、调试、TTS 面板；支持 hidden/compact/detail 等显示状态。
  - 窗口控制 IPC 包括 `WINDOW_SHOW_COMPACT_INPUT`、`WINDOW_SHOW_DETAIL_PANEL`、`WINDOW_HIDE_UI`、`WINDOW_UI_COMMAND`、`WINDOW_SET_AVATAR_HIT_REGION`。
- Renderer 不得直接使用 Node/Electron API；所有能力必须经 preload 的 `window.petAgent` 走 IPC。

## TTS 子系统

- TTS 设置位于 `settings.tts`，默认关闭；默认本地服务地址为 `http://127.0.0.1:50001`。
- Main Process：`TtsService` 负责健康检查、音色注册/删除/重命名、音频生成和本地音频文件写入；`LocalTtsClient` 调用外部本地 TTS API。
- Renderer：`useTtsManager` 管理消息音频状态，`useTtsPlayer` 播放音频，`TtsSettingsSection` 提供设置 UI。
- 支持手动生成、assistant 消息后自动生成、生成后自动播放。
- 情感增强模式：
  - `default_mapping`：根据情绪使用默认 TTS 情绪指令。
  - `llm_controlled`：通过 prompt 要求模型输出 `[[TTS_INSTRUCTION:...]]`，再由 agent-core 提取；送 TTS 前必须用 `sanitizeTextForTts()` 清理 `<emotion>`、TTS 指令标签和 Markdown。
- TTS 输出当前写入 `settings.tts.audioOutputDir` 或默认 `<userData>/tts-audio`，以本地音频路径流转；不要把音频 base64 写入 trace。

## 工具与权限模型

当前默认工具（`packages/tools/src/index.ts`）：

- `shell.run`：在 workspace 内执行 PowerShell 命令，30s 超时，stdout/stderr 截断。
- `file.read` / `file.write`：读写 workspace 内 UTF-8 文件。
- `clipboard.read` / `clipboard.write`：读写系统剪贴板文本。
- `screenshot.capture`：截屏并保存 PNG artifact。
- `task.finish`：结束当前任务并传回总结/状态。

权限相关概念：

- Agent 运行模式：`manual` / `confirm` / `auto`。当前 `manual` 会要求工具确认；`confirm` 与 `auto` 的主要差异尚未在权限层细分。
- 工具权限模式：`settings.permissions.mode` 为 `permissive` 或 `ask`；当前默认是 `permissive`。
- 权限级别：`safe`、`workspace_read`、`workspace_write`、`screen_read`、`clipboard_read`、`clipboard_write`、`shell`、`dangerous`。
- 默认权限策略常量在 `packages/shared/src/schemas.ts`：`safe`、`workspace_read` 自动；`workspace_write`、`clipboard_*`、`shell` 每次确认；`screen_read` 每会话确认一次；`dangerous` 拒绝。实际审批还会受 `settings.permissions.mode` 影响：`permissive` 下除危险/高影响操作外倾向自动批准。
- `PermissionService` 会识别高影响 shell 命令，例如 `rm -rf`、`Remove-Item -Recurse -Force`、`format`、`diskpart`、`reg delete` 等。
- `dangerous` 级别默认拒绝；`file.*` 与 `shell.run` 必须限制在 `workspaceDir` 内，artifact、Live2D 资源和 TTS 音频路径按各自服务的白名单/目录策略处理。

## 本地配置约定

- `.env.example` 仅作为环境变量示例，真实 `.env*` 不得提交。
- 首次启动会在 Electron `userData` 目录生成 `settings.json`。
- 默认 workspace：`<userData>/workspace`。
- Trace：`<userData>/traces/latest.jsonl` 与 `<userData>/traces/sessions/*.jsonl`。
- Artifact：`<userData>/artifacts/`，包括 `screenshots/`、`audio/`、`images/`、`file-content/`、`tool-output/` 等类型。
- 当前实际生效的角色/用户信息入口是 `settings.promptPresets`：`rolePrompt` 默认是“小花”猫娘助手人设，`userInfoPrompt` 用于稳定用户信息；最终 system prompt 由 agent-core 组合并按设置注入情绪/TTS 指令。
- `<userData>/dev-prompts/tool-overrides.json` 可用于工具说明覆盖；`system.md` 仍由 `PromptService` 管理，但当前主链路不以它作为实际 system prompt 来源。

配置合并规则：

1. 代码默认值会先结合环境变量：`OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`、`AGENT_MODE`、`REASONING_EFFORT`。
2. 开发环境本地配置 `local/config.yaml` 参与默认值生成（仅 `NODE_ENV=development` 或存在 `ELECTRON_RENDERER_URL` 时读取）。环境变量优先于 `local/config.yaml`。
3. 若已存在 `<userData>/settings.json`，持久化配置会覆盖上述默认值；缺失字段再由默认值补齐。

`local/config.yaml` 支持的简化格式：

```yaml
settings:
  mode: confirm
  openaiBaseUrl: https://api.openai.com/v1
  openaiModel: gpt-4o-mini
  openaiApiKey: sk-...
  reasoningEffort: low
  permissionMode: permissive
```

`local/` 已加入 `.gitignore`，但仍要避免把真实 API Key、模型资源、TTS 样本或用户素材复制到可提交路径。

## Live2D 开发约定

- 开发默认 Cubism Core JS：`local/live2dcubismcore.min.js`。
- 开发默认模型：`local/玳瑁猫v1_vts/玳瑁猫v1_vts.model3.json`。
- 若 `settings.json` 中 `live2d.modelPath` 为空，开发环境会自动尝试回落到上述本地模型。
- Renderer 只通过受控逻辑和 `live2d-local://` 协议加载 Live2D 展示资源；协议侧必须做目录白名单和 realpath 校验。
- `live2d-model-json.ts` 会尝试自动合并模型目录中的 `.exp3.json`、`.motion3.json` 并处理常见别名，改动模型发现逻辑时要覆盖不同模型目录结构。
- Live2D 层只响应 Agent 状态/情绪和 UI 交互，不得参与 Agent 决策、权限判断或工具执行。
- 更换模型时只修改本地 `settings.json` 或 `local/` 内容，不要把模型路径硬编码进 Agent Core。

## 安全边界

- Renderer 不允许直接访问 Node/Electron 高权限 API；只能通过 preload 的 `window.petAgent` 通信。
- API Key 只能存在于 Main Process、环境变量或本地 settings 中；传给 Renderer 的 `PublicSettings` 只能暴露 `hasApiKey`。
- `packages/agent-core` 保持与 Electron/React/Live2D/Node I/O 解耦；文件系统、shell、剪贴板、截图、TTS 文件写入等能力只在 Main Process 实现。
- 路径类能力必须按所属服务做边界校验：`file.*` / `shell.run` 限制在 workspace；artifact 限制在 artifact store；Live2D 协议资源限制在允许的模型目录；TTS 音频路径需避免越权读取/写入。
- Trace 不应写入 API Key、音频 base64、图片 base64 或其他敏感大载荷；音频/图片通过 artifact 引用传递。
- WS 运行时是长连接，改连接/重连/降级逻辑时要保证错误可见、资源可释放、不会产生悬挂 run。
- 非打包开发环境可能打开 Electron 远程调试端口（可通过环境变量关闭），勿把该行为误带到生产安全假设中。

## 常见修改路径

### 新增或修改工具

1. `packages/tools/src/`：定义工具 schema、权限级别、说明和执行函数类型。
2. `packages/tools/src/index.ts`：加入默认工具列表导出。
3. `apps/desktop/src/main/services/agent-service.ts`：在执行器映射中接入 Main Process 实现。
4. `apps/desktop/src/main/services/permission-service.ts`：如有新权限或风险策略，更新审批逻辑。
5. `packages/agent-core/src/tools/`：如影响 schema 编码、工具结果限制或循环检测，同步更新。
6. Renderer：如需展示新工具摘要、风险标签或手动执行 UI，同步更新相关组件。
7. 测试：优先补 `packages/*/src/**/*.test.ts` 或 `apps/desktop/src/main/**/*.test.ts`。

### 新增 IPC API

1. `packages/shared/src/constants.ts`：增加 `IPC_CHANNELS`。
2. `packages/shared/src/ipc.ts` / `schemas.ts`：补请求、响应和共享类型。
3. `apps/desktop/src/preload/index.ts`：暴露到 `window.petAgent`。
4. `apps/desktop/src/main/ipc-handlers.ts`：注册 handler。
5. `apps/desktop/src/renderer/env.d.ts`：更新 Renderer 侧类型。
6. 如属于 Main → Renderer 推送事件，同步检查 `WindowManager` 广播和 Renderer 订阅处理。

### 新增设置项

1. `packages/shared/src/schemas.ts`：更新 `AppSettings` / `PublicSettings` / patch 类型与默认值相关类型。
2. `apps/desktop/src/main/services/settings-service.ts`：补默认值、deep merge、sanitize、public patch 白名单、持久化合并逻辑。
3. `apps/desktop/src/main/services/agent-service.ts`：如设置影响运行时，确保 reconfigure 后生效。
4. Renderer：`UiApp.tsx`、`App.tsx` 或 `renderer-shared.tsx` 中补设置面板和表单同步。
5. 添加或更新 `settings-service` 测试。

### 修改 Agent Runtime / 模型适配器

1. 先确认影响的是 `ws`、`http-legacy` 还是两者。
2. WS 默认路径通常涉及 `packages/agent-core/src/runtime/`、`context/`、`conversation/`、`ws/` 与 `packages/model-openai-compatible/src/ws/`。
3. HTTP legacy 路径通常涉及 `packages/agent-core/src/agent-session.ts` 与 `packages/model-openai-compatible/src/openai-compatible-adapter.ts`。
4. 同步检查 `apps/desktop/src/main/agent-runtime-event-bridge.ts`，确保新 runtime 事件能映射到 Renderer 所需 `AgentEvent`。
5. 运行 agent-core 与 model-openai-compatible 相关测试；必要时补 run-controller、ws-session、adapter 测试。

### 修改 TTS

1. Main 服务：`apps/desktop/src/main/services/tts/`。
2. Renderer 状态/播放：`apps/desktop/src/renderer/hooks/useTtsManager.ts`、`useTtsPlayer.ts`。
3. 设置 UI：`TtsSettingsSection.tsx` 与共享 settings form。
4. 文本清理/LLM 指令：`packages/agent-core/src/tts-text-sanitizer.ts`、`tts-instruction-prompt.ts`。
5. 注意不要把原始音频写入 trace；TTS 输出当前以本地音频路径引用，录音/图片/截图等使用 artifact 引用。

### 修改窗口 / Live2D UI

1. 窗口生命周期与 OS 能力：`window-manager.ts`。
2. dual 模式 Avatar：`AvatarApp.tsx`、`Live2DView.tsx`、hit-region IPC。
3. dual 模式 UI：`UiApp.tsx` 与 `renderer-shared.tsx`。
4. combined 模式兼容：`App.tsx`。
5. 修改默认窗口设置时同步 `UiSettings`、`settings-service` 默认值和设置 UI。

### 新增包

1. `pnpm-workspace.yaml` 已覆盖 `packages/*` 和 `apps/*`。
2. 根 `tsconfig.json` 增加 project reference。
3. 相关消费方的 `tsconfig.json` 和 `package.json` 增加引用/依赖。
4. 如 desktop 需源码别名，更新 `apps/desktop/electron.vite.config.ts`。
5. 若新增测试路径，更新根 `package.json` 的 `test` 脚本 glob。

## 测试注意事项

- 当前使用 Node 内置 test runner：`node:test` + `node:assert`，通过 `tsx` 转译 TypeScript。
- 不使用 Jest/Vitest/Mocha。
- 根 `test` 脚本显式列出测试 glob：`packages/agent-core/src/**/*.test.ts`、`packages/live2d/src/**/*.test.ts`、`packages/model-openai-compatible/src/**/*.test.ts`、`packages/shared/src/**/*.test.ts`、`apps/desktop/src/main/**/*.test.ts`。
- 新增测试文件必须放入上述 glob，或同步更新根 `package.json` 的 `test` 脚本。
- 修改测试文件或测试夹具时，确保 `corepack pnpm test` 覆盖到实际文件。

## 禁止提交

- `.env`、`.env.local`、任何真实凭证或 token。
- `local/` 下的 Live2D 模型、Cubism Core JS、TTS 样本、用户素材和本地配置。
- `docs/` 本地资料，除非先调整 `.gitignore` 并确认要纳入版本控制。
- `node_modules/`、`dist/`、`dist-types/`、`out/`、`.tsbuildinfo`、source map、`.d.ts.map`、`.js.map`。
- workspace、traces、screenshots、artifact、TTS 输出音频、`.tmp/` 等运行时数据。
