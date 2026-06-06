---
description: Start Electron dev and debug renderer with Chrome DevTools MCP
agent: build
---

$ARGUMENTS

请调试本项目的 Electron renderer。按这个流程执行：

1. 先检查 `http://127.0.0.1:9222/json/version` 是否可访问。
2. 如果不可访问，用 shell 在后台启动开发服务器：
   - macOS/Linux: `mkdir -p .tmp && (pnpm dev > .tmp/electron-dev.log 2>&1 & echo $! > .tmp/electron-dev.pid)`
   - Windows PowerShell: `mkdir .tmp -Force; Start-Process -FilePath pnpm -ArgumentList "dev" -RedirectStandardOutput ".tmp/electron-dev.log" -RedirectStandardError ".tmp/electron-dev.err.log"`
3. 启动后轮询 `http://127.0.0.1:9222/json/list`，直到出现 Electron renderer target。
4. 使用 chrome-devtools MCP 连接并检查：
   - console errors / warnings
   - failed network requests
   - React root 是否正常渲染
   - Live2D canvas / model 资源是否加载
   - 页面截图
5. 如果有多个 target，选择 Electron renderer / Vite 页面，不要选择 DevTools 自身页面。
6. 输出问题定位、证据和建议修改点，但不要立刻执行修复工作。