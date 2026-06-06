---
description: Start Electron dev and debug renderer with Chrome DevTools MCP
agent: build
---

$ARGUMENTS

请调试本项目的 Electron renderer。按这个流程执行。目标是跑通测试流程、定位问题并输出证据；不要修改项目代码，除非用户明确要求修复。

1. 先检查 `http://127.0.0.1:9222/json/version` 是否可访问。
2. 如果不可访问，先判断是否已有旧的 Electron/dev 进程：
   - Windows PowerShell: `Get-CimInstance Win32_Process | Where-Object { $_.Name -in @("electron.exe","node.exe","corepack.exe","pnpm.exe") -and $_.CommandLine -like "*live2dAgent*" } | Select-Object ProcessId,Name,CreationDate,CommandLine | ConvertTo-Json -Depth 3`
   - macOS/Linux: `ps -ef | grep -E 'electron|pnpm|node' | grep live2dAgent | grep -v grep`
   - 如果有旧进程但 `9222` 不通，说明可能是旧实例未启用 remote debugging。仅在这些进程明显属于本项目 dev server 时停止它们；不要停止无关进程。
3. 用 shell 在后台启动开发服务器。必须使用 `corepack pnpm`，不要假设全局 `pnpm` 可用：
   - macOS/Linux: `mkdir -p .tmp && (corepack pnpm dev > .tmp/electron-dev.log 2>&1 & echo $! > .tmp/electron-dev.pid)`
   - Windows PowerShell: `if (-not (Test-Path -LiteralPath ".tmp")) { New-Item -ItemType Directory -Path ".tmp" | Out-Null }; $workdir = (Get-Location).Path; $log = Join-Path $workdir ".tmp\electron-dev.log"; $err = Join-Path $workdir ".tmp\electron-dev.err.log"; $p = Start-Process -FilePath "cmd.exe" -ArgumentList "/d", "/c", "corepack pnpm dev 1>> `"$log`" 2>> `"$err`"" -WorkingDirectory $workdir -WindowStyle Hidden -PassThru; $p.Id | Out-File -Encoding ascii ".tmp\electron-dev.pid"; "started pid=$($p.Id)"`
   - 禁止直接运行 `corepack pnpm dev`；只能运行上面的后台启动器命令。
   - `corepack pnpm dev` 是长期运行命令；后台启动命令输出 `started pid=...` 后应立即继续下一步，不要等待 dev server 退出。
   - 如果后台启动器命令超过 5 秒未返回，视为启动器异常，不要继续等待；读取日志和进程命令行后报告阻塞点。
4. 启动后有限轮询 `http://127.0.0.1:9222/json/version` 和 `http://127.0.0.1:9222/json/list`：
   - 最多轮询 10 次，每次间隔约 1 秒。
   - 如果 10 次后仍不可访问，停止轮询，读取 `.tmp/electron-dev.log`、`.tmp/electron-dev.err.log` 和进程命令行，输出阻塞点。
   - 不要无限轮询。
5. 在 `/json/list` 中寻找 Electron renderer / Vite target：
   - 优先选择 `url` 为 `http://localhost:5173/` 或页面标题为 `Live2D Agent` 的 target。
   - 如果同时存在 `devtools://...` target，明确忽略它；那是 DevTools 自身页面。
6. 使用 chrome-devtools MCP 连接并检查：
   - console errors / warnings
   - failed network requests
   - React root 是否正常渲染
   - `window.petAgent` 是否存在，以及 preload API 是否注入成功
   - Live2D canvas / model 资源是否加载
   - 页面截图
7. 判断结果时注意这些常见情况：
   - 能看到 Electron DevTools 窗口，不等于 `9222` CDP HTTP endpoint 已开启；必须以 `/json/version` 可访问为准。
   - `Start-Process` / 后台启动返回后，dev server 仍会继续运行；这不是卡住。
   - 如果 `#root` 存在但子节点为 0，检查 console 和 `window.petAgent`。若出现 `Cannot read properties of undefined (reading 'getSettings')`，优先定位为 preload API 未注入导致 React 崩溃。
   - 如果 network 请求都是 200 但没有 Live2D canvas，先确认 React root 和 preload 是否正常；Live2D 未加载可能只是上游渲染失败的后果。
8. 输出问题定位、证据和建议修改点，但不要立刻执行修复工作。
