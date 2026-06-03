# 桌面 Live2D Agent 小助手 v0 需求与架构文档

## 1. 项目目标

开发一个基于 Electron + TypeScript 的桌面小助手 / 小宠物应用。

它需要具备：

- 桌面透明窗口

- Live2D 角色显示

- 文本对话输入与气泡 UI

- 接入 OpenAI-compatible LLM

- Agent 可以提出工具调用

- 工具调用经过权限确认

- 支持基础桌面能力：
  
  - 截屏
  
  - 文件读写
  
  - 命令行执行
  
  - 剪贴板读写

- 保存完整 trace，便于调试和回放

v0 的目标是建立一个清晰、可扩展、可维护的最小 Agent Runtime，而不是做完整产品。

---

## 2. 技术栈

优先使用：

- TypeScript

- Electron

- React

- Vite / electron-vite

- pnpm workspace

- OpenAI-compatible API

- Live2D Web / PixiJS Live2D 封装

暂不引入：

- 语音输入

- TTS

- MCP

- browser-use

- 长期记忆

- 多角色系统

- 插件系统

- 自动后台任务

- 全局鼠标键盘控制

这些功能全部放到 v1 或之后。

---

## 3. 设计原则

### 3.1 Agent Core 必须和 UI 解耦

AgentCore 不应该依赖 Electron、React、Live2D 或任何 UI 组件。

AgentCore 只负责：

- 管理 messages

- 调用模型

- 解析 tool calls

- 发起 AgentAction

- 接收 ToolResult

- 生成 observation

- 继续循环

- 保存 trace event

### 3.2 Renderer 不能拥有高权限

Renderer 只负责展示 UI：

- Live2D

- 对话气泡

- 权限确认气泡

- 设置面板

- 状态显示

Renderer 不允许直接访问：

- fs

- child_process

- process.env

- shell

- screenshot

- clipboard

- ipcRenderer 原始对象

所有系统能力必须通过 preload 暴露的安全 API 调用。

### 3.3 所有危险能力必须经过 Main Process

Main Process 负责：

- shell 执行

- 文件读写

- 截图

- 剪贴板

- trace 保存

- 权限控制

- LLM API key 管理

- 创建窗口

### 3.4 Live2D 只是表现层

Live2D 不参与 agent 决策。

Live2D 只订阅 AgentEvent，例如：

- agent.thinking

- approval.pending

- tool.running

- tool.success

- tool.error

- agent.idle

---

## 4. 参考思想

项目核心 Agent Loop 参考 mini-swe-agent，但不能照搬其 bash-only 设计。

保留：

- 线性 messages history

- query → action → execute → observation → repeat

- Model / Runtime 分离

- Human approval

- Trace 保存

- 工具执行结果必须回写 messages

不要保留：

- bash-only action

- shell=True 直接执行

- 正则白名单权限系统

- stdout 魔法字符串结束任务

- CLI-first 交互

- UI 和 Agent 混在一起

---

## 5. 总体架构

```text
Electron App
├─ Main Process
│  ├─ WindowManager
│  ├─ AgentService
│  ├─ PermissionService
│  ├─ ToolRuntime
│  ├─ ShellRuntime
│  ├─ ScreenshotRuntime
│  ├─ FileRuntime
│  ├─ ClipboardRuntime
│  ├─ TraceService
│  └─ SettingsService
│
├─ Preload
│  └─ Safe typed bridge
│
├─ Renderer
│  ├─ Live2DView
│  ├─ ChatBubble
│  ├─ ApprovalBubble
│  ├─ SettingsPanel
│  └─ AgentStatusView
│
└─ Packages
   ├─ agent-core
   ├─ tools
   ├─ model-openai-compatible
   ├─ live2d
   └─ shared
```

---

## 6. 推荐目录结构

```text
pet-agent/
├─ apps/
│  └─ desktop/
│     ├─ src/
│     │  ├─ main/
│     │  │  ├─ main.ts
│     │  │  ├─ window-manager.ts
│     │  │  ├─ ipc-handlers.ts
│     │  │  └─ services/
│     │  │     ├─ agent-service.ts
│     │  │     ├─ permission-service.ts
│     │  │     ├─ trace-service.ts
│     │  │     └─ settings-service.ts
│     │  │
│     │  ├─ preload/
│     │  │  └─ index.ts
│     │  │
│     │  └─ renderer/
│     │     ├─ App.tsx
│     │     ├─ live2d/
│     │     ├─ chat/
│     │     ├─ approval/
│     │     └─ settings/
│     │
│     └─ electron.vite.config.ts
│
├─ packages/
│  ├─ agent-core/
│  │  └─ src/
│  │     ├─ agent-session.ts
│  │     ├─ model-adapter.ts
│  │     ├─ tool-registry.ts
│  │     ├─ observation-formatter.ts
│  │     ├─ events.ts
│  │     └─ types.ts
│  │
│  ├─ tools/
│  │  └─ src/
│  │     ├─ runtime.ts
│  │     ├─ shell.ts
│  │     ├─ screenshot.ts
│  │     ├─ file.ts
│  │     └─ clipboard.ts
│  │
│  ├─ model-openai-compatible/
│  │  └─ src/
│  │     └─ openai-compatible-adapter.ts
│  │
│  ├─ live2d/
│  │  └─ src/
│  │     ├─ avatar-driver.ts
│  │     └─ pixi-live2d-driver.ts
│  │
│  └─ shared/
│     └─ src/
│        ├─ ipc.ts
│        ├─ schemas.ts
│        └─ constants.ts
│
├─ package.json
├─ pnpm-workspace.yaml
└─ tsconfig.base.json
```

---

## 7. 核心 Agent Loop

AgentCore 应实现如下循环：

```text
user message
  ↓
append to messages
  ↓
model.query(messages, tools)
  ↓
assistant message with actions
  ↓
permission check
  ↓
runtime.execute(actions)
  ↓
tool results
  ↓
format observations
  ↓
append observations to messages
  ↓
repeat until no actions or task.finish
```

基础伪代码：

```ts
class AgentSession {
  messages: AgentMessage[] = []

  constructor(
    private model: ModelAdapter,
    private tools: ToolRegistry,
    private runtime: ToolRuntime,
    private approval: PermissionController,
    private trace: TraceStore,
    private events: EventBus,
  ) {}

  async runUserMessage(text: string) {
    this.addMessage({
      role: "user",
      content: text,
    })

    while (true) {
      this.events.emit({ type: "agent.thinking" })

      const assistantMessage = await this.model.query({
        messages: this.messages,
        tools: this.tools.getDefinitions(),
      })

      this.addMessage(assistantMessage)

      const actions = assistantMessage.actions ?? []

      if (actions.length === 0) {
        this.events.emit({ type: "agent.idle" })
        break
      }

      const decision = await this.approval.check(actions)

      if (decision.status === "denied") {
        this.addMessage({
          role: "user",
          content: `User denied actions: ${decision.reason}`,
          extra: { type: "approval.denied", decision },
        })
        continue
      }

      const results = await this.runtime.executeMany(decision.actions)
      const observations = this.model.formatObservations(results)

      for (const obs of observations) {
        this.addMessage(obs)
      }

      if (actions.some(a => a.tool === "task.finish")) {
        this.events.emit({ type: "agent.idle" })
        break
      }
    }
  }

  private addMessage(message: AgentMessage) {
    this.messages.push(message)
    this.trace.appendMessage(message)
    this.events.emit({ type: "message.added", message })
  }
}
```

---

## 8. 核心类型

### 8.1 AgentMessage

```ts
type AgentMessage = {
  id: string
  role: "system" | "user" | "assistant" | "tool"
  content: string | MultimodalContent[]
  actions?: AgentAction[]
  toolCallId?: string
  createdAt: number
  extra?: Record<string, unknown>
}
```

### 8.2 AgentAction

```ts
type AgentAction = {
  id: string
  tool: ToolName
  args: unknown
  source: "llm" | "user" | "system"
  createdAt: number
}
```

### 8.3 ToolResult

```ts
type ToolResult = {
  actionId: string
  tool: ToolName
  ok: boolean
  content: string
  data?: unknown
  error?: {
    code: string
    message: string
    recoverable: boolean
  }
  artifacts?: ToolArtifact[]
  startedAt: number
  endedAt: number
}
```

### 8.4 ToolDefinition

```ts
type ToolDefinition = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  permission: PermissionLevel
}
```

---

## 9. v0 工具列表

v0 只实现以下工具。

### 9.1 shell.run

用于在 workspace 内执行命令。

```ts
{
  name: "shell.run",
  description: "Run a shell command inside the configured workspace.",
  permission: "shell",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string" }
    },
    required: ["command"]
  }
}
```

限制：

- 每次执行必须确认

- cwd 必须在 workspace 内

- 默认 timeout 30 秒

- stdout/stderr 必须截断

- 默认不继承完整环境变量

- 明显危险命令直接拒绝

### 9.2 screenshot.capture

用于截取当前屏幕。

```ts
{
  name: "screenshot.capture",
  description: "Capture the current screen and return an image observation.",
  permission: "screen_read",
  inputSchema: {
    type: "object",
    properties: {
      displayId: { type: "string" }
    }
  }
}
```

限制：

- 第一次使用必须确认

- 可支持本 session 内记住授权

- 截图作为 artifact 保存

### 9.3 file.read

只允许读取 workspace 内文件。

```ts
{
  name: "file.read",
  description: "Read a file inside the workspace.",
  permission: "workspace_read",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" }
    },
    required: ["path"]
  }
}
```

### 9.4 file.write

只允许写入 workspace 内文件。

```ts
{
  name: "file.write",
  description: "Write a file inside the workspace.",
  permission: "workspace_write",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" }
    },
    required: ["path", "content"]
  }
}
```

### 9.5 clipboard.read

读取系统剪贴板。

```ts
{
  name: "clipboard.read",
  description: "Read text from the system clipboard.",
  permission: "clipboard_read",
  inputSchema: {
    type: "object",
    properties: {}
  }
}
```

限制：

- 每次必须确认

### 9.6 clipboard.write

写入系统剪贴板。

```ts
{
  name: "clipboard.write",
  description: "Write text to the system clipboard.",
  permission: "clipboard_write",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" }
    },
    required: ["text"]
  }
}
```

限制：

- 每次必须确认

### 9.7 task.finish

显式结束当前任务。

```ts
{
  name: "task.finish",
  description: "Finish the current task with a summary.",
  permission: "safe",
  inputSchema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      status: {
        type: "string",
        enum: ["success", "failed", "cancelled"]
      }
    },
    required: ["summary", "status"]
  }
}
```

---

## 10. 权限模型

### 10.1 AgentMode

```ts
type AgentMode = "manual" | "confirm" | "auto"
```

含义：

- manual：只执行用户明确发起的动作

- confirm：LLM 可以提出动作，但执行前需要确认

- auto：低风险动作自动执行，高风险动作仍然确认

v0 默认使用 confirm。

### 10.2 PermissionLevel

```ts
type PermissionLevel =
  | "safe"
  | "workspace_read"
  | "workspace_write"
  | "screen_read"
  | "clipboard_read"
  | "clipboard_write"
  | "shell"
  | "dangerous"
```

### 10.3 默认策略

```ts
const defaultPolicy = {
  safe: "auto",
  workspace_read: "auto",
  workspace_write: "confirm_each",
  screen_read: "confirm_once_per_session",
  clipboard_read: "confirm_each",
  clipboard_write: "confirm_each",
  shell: "confirm_each",
  dangerous: "deny",
}
```

---

## 11. Preload API

Preload 只暴露安全 API。

```ts
window.petAPI = {
  sendUserMessage(text: string): Promise<void>
  approveAction(actionId: string): Promise<void>
  denyAction(actionId: string, reason?: string): Promise<void>
  setAgentMode(mode: AgentMode): Promise<void>
  onAgentEvent(handler: (event: AgentEvent) => void): Unsubscribe
}
```

不要暴露：

- ipcRenderer

- fs

- child_process

- process

- process.env

- shell 原始能力

---

## 12. AgentEvent

Renderer、Live2D、气泡 UI 全部通过 AgentEvent 更新状态。

```ts
type AgentEvent =
  | { type: "agent.idle" }
  | { type: "agent.thinking" }
  | { type: "message.added"; message: AgentMessage }
  | { type: "approval.pending"; actions: AgentAction[] }
  | { type: "approval.approved"; actionIds: string[] }
  | { type: "approval.denied"; actionIds: string[]; reason?: string }
  | { type: "tool.started"; action: AgentAction }
  | { type: "tool.finished"; result: ToolResult }
  | { type: "tool.error"; result: ToolResult }
  | { type: "agent.error"; error: string }
```

---

## 13. Live2D 设计

定义 AvatarDriver 接口：

```ts
interface AvatarDriver {
  load(modelPath: string): Promise<void>
  setExpression(name: string): Promise<void>
  playMotion(group: string, index?: number): Promise<void>
  setLipSync(value: number): void
  dispose(): Promise<void>
}
```

状态映射：

```text
agent.idle              → idle
agent.thinking          → thinking
approval.pending        → waiting_approval
tool.started            → running_tool
tool.finished ok=true   → success
tool.error              → error
agent.error             → error
```

v0 只需要实现：

- 加载 Live2D 模型

- 待机动作

- thinking 表情

- waiting_approval 表情

- success 表情

- error 表情

不需要口型同步，不需要语音驱动。

---

## 14. Trace 设计

v0 使用 JSONL 文件保存 trace。

路径：

```text
userData/
├─ settings.json
├─ traces/
│  ├─ latest.jsonl
│  └─ 2026-06-03T12-00-00.jsonl
├─ screenshots/
└─ models/
   └─ live2d/
```

Trace event 示例：

```json
{"type":"message.added","message":{},"time":1710000000000}
{"type":"approval.pending","actions":[],"time":1710000000001}
{"type":"approval.approved","actionIds":["act_1"],"time":1710000000002}
{"type":"tool.started","action":{},"time":1710000000003}
{"type":"tool.finished","result":{},"time":1710000000004}
```

要求：

- 每条模型输出必须保存

- 每个 action 必须保存

- 每个 permission decision 必须保存

- 每个 tool result 必须保存

- 错误也必须保存

- 截图 artifact 只保存路径引用，不直接塞进 JSONL

---

## 15. ModelAdapter

v0 只实现 OpenAI-compatible adapter。

接口：

```ts
interface ModelAdapter {
  query(input: {
    messages: AgentMessage[]
    tools: ToolDefinition[]
  }): Promise<AgentMessage>

  formatObservations(results: ToolResult[]): AgentMessage[]
}
```

要求：

- 支持 OpenAI-compatible Chat Completions tool calling

- 把 provider tool call 转成 AgentAction

- 把 ToolResult 转成 tool observation message

- 保存 raw response 到 message.extra.rawResponse

- 模型格式错误时生成可回放错误信息

---

## 16. Settings

v0 使用简单 settings.json。

```ts
type Settings = {
  model: {
    baseUrl: string
    apiKey: string
    modelName: string
  }

  workspace: {
    path: string
  }

  agent: {
    mode: AgentMode
    maxSteps: number
  }

  live2d: {
    modelPath: string
  }
}
```

注意：

- apiKey 不能暴露给 renderer

- renderer 只能通过受控 API 修改设置

- 后续可以替换成系统 keychain

---

## 17. v0 最小验收目标

### 17.1 UI 启动

- Electron 应用可以启动

- 显示透明窗口

- Live2D 模型可以加载

- 有文本输入框 / 气泡

### 17.2 普通聊天

- 用户输入一句话

- Agent 调用 LLM

- 返回文本

- 显示在气泡中

- Live2D 从 thinking 回到 idle

### 17.3 截图闭环

用户输入：

```text
帮我看看当前屏幕上有什么。
```

期望流程：

```text
LLM 生成 screenshot.capture action
PermissionService 请求确认
Renderer 显示权限气泡
用户点击允许
Main Process 截图
ToolResult 写入 trace
截图作为 observation 回给模型
模型总结屏幕内容
Renderer 显示回答
Live2D 播放 success 状态
```

### 17.4 Shell 闭环

用户输入：

```text
在当前项目里运行 npm test。
```

期望流程：

```text
LLM 生成 shell.run action
PermissionService 请求确认
Renderer 展示命令
用户点击允许
Main Process 在 workspace 内执行命令
stdout/stderr 截断
ToolResult 写入 trace
observation 回给模型
模型总结结果
```

### 17.5 拒绝闭环

当 LLM 请求执行 shell.run 时，用户点击拒绝。

期望：

```text
拒绝信息写入 messages
拒绝事件写入 trace
模型下一轮知道用户拒绝了该动作
Agent 不应假设工具已经执行
```

---

## 18. v0 明确不做

不要实现以下功能：

- 语音输入

- TTS

- 唤醒词

- 长期记忆

- MCP

- 浏览器自动化

- 全局鼠标控制

- 全局键盘输入

- 多 Agent

- 复杂插件系统

- Workflow 编排

- 任务后台调度

- 云同步

- 用户账号系统

---

## 19. 开发顺序建议

### Phase 1：项目骨架

- pnpm workspace

- Electron + React 启动

- Main / preload / renderer 分离

- typed IPC

- 基础窗口

### Phase 2：Agent Core

- AgentMessage / AgentAction / ToolResult 类型

- AgentSession

- EventBus

- TraceStore

- ToolRegistry

### Phase 3：Model Adapter

- OpenAI-compatible client

- tool calling schema

- provider response → AgentAction

- ToolResult → observation

### Phase 4：Tool Runtime

- file.read

- file.write

- clipboard.read

- clipboard.write

- screenshot.capture

- shell.run

### Phase 5：Permission

- confirm mode

- approval.pending event

- approveAction / denyAction IPC

- 拒绝回写 messages

### Phase 6：Renderer UI

- ChatBubble

- ApprovalBubble

- AgentStatusView

- SettingsPanel

### Phase 7：Live2D

- AvatarDriver

- PixiLive2DDriver

- 状态映射

- idle / thinking / approval / success / error

### Phase 8：验收闭环

- 普通聊天

- 截图分析

- shell.run

- 拒绝动作

- trace 回放检查

---

## 20. 最重要的约束

任何开发 agent 在实现时必须遵守：

1. 不要让 renderer 直接拥有 Node 权限。

2. 不要让 Live2D 组件调用工具。

3. 不要让 ToolRuntime 直接操作 UI。

4. 不要把 agent loop 写进 React 组件。

5. 不要默认自动执行 shell。

6. 不要在 workspace 外读写文件。

7. 不要跳过 PermissionService。

8. 不要静默丢弃 tool result。

9. 不要把 API key 传给 renderer。

10. 不要在 v0 里扩展语音、MCP、浏览器自动化、长期记忆等非必要功能。

核心目标是先完成一个安全、可回放、可维护的最小 Agent Runtime。
