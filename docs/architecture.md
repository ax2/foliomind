# FolioMind 架构边界

## 设计原则

1. 桌面层负责产品体验、权限、凭证、生命周期和审计，不重新实现 Pi Agent。
2. Pi 只通过 stdin/stdout JSONL RPC 与 Rust Host 通信，不自行监听公网端口。
3. 长期 `QVERIS_API_KEY` 不进入 Pi 环境。Host 为每次运行签发短期 capability，并限定 executor 为 loopback。
4. 数据调用遵循 `Search → Inspect → Call`；调用结果必须保留 source、as-of、execution ID 和费用字段。
5. 第一版不连接真实券商，不提供自动交易，不承诺收益。

自选标的、盯盘规则和站内通知统一保存在 Host 管理的 `user-state.json` 中。桌面端写入 Tauri 应用配置目录并使用临时文件原子替换；浏览器预览使用版本化 `localStorage`，只作为演示状态，不宣称已完成真实查询。

本地 Web 调试时，桌面 Host 额外监听固定回环地址 `127.0.0.1:43123`。Web UI 先通过允许的 localhost Origin 获取一次性会话令牌，再以 `X-FolioMind-Host` 请求头访问配置、凭据、用户状态和 Pi API。长期 QVeris API Key 由 Host 写入操作系统凭据库；Linux 未运行 Secret Service 时回退到权限为 `0600` 的用户配置文件，不进入浏览器存储。Host 只返回“已配置”状态。该 HTTP 入口仅允许回环请求和本地开发 Origin，不作为公网服务。

盯盘服务由 WebView 调度（桌面端每 30 秒检查到期规则），同一时间只允许一条 Pi 检查任务，避免与用户对话并发占用 Runtime。每次检查都要求 Pi 使用内置 `qveris-finance-research` Skill 执行 `Search → Inspect → Call`，要求返回带 `triggered`、来源和数据截至时间的结构化结果；触发结果、失败和预览模式提示都会写入站内消息，用户可在消息中心标记已读。

QVeris 的 `session_id`、响应视图、返回模式和最大响应大小属于 Host 策略字段，不向模型暴露，也不接受 Skill 覆盖。Host 会对查询、标识符、候选工具数量和调用参数体设置独立上限，再写入本轮 `product_run_id`。

回环 executor 同时最多处理 16 个连接；槽位在连接处理线程退出时由 RAII 自动归还。达到上限的新连接会在读取请求体或创建线程前立即收到 `503`，避免异常本地连接利用读取或上游超时无限堆积线程。

每个 executor 维护 run-scoped 取消信号和活动下游 socket 注册表。停止 Runtime 时，Host 会拒绝新连接、关闭所有已接收连接，并取消仍在等待响应头或响应体的 QVeris 工具/模型请求；上游返回后会再次检查取消状态，避免已观察到停止信号的旧 run 写入成功审计或响应。`stop()` 最多等待 1 秒让连接 guard 退出后再返回；若同步 socket 写入未及时响应关闭信号，线程仍可能在系统写超时前短暂收尾，但不会继续等待上游网络响应。

模型网关的成功 SSE 响应由 Host 以 close-delimited HTTP 流逐块转发并及时 flush，避免 Pi 等待整轮网关响应结束后才开始处理；流式与非流式响应均受 16 MiB 总大小限制。JSON 和非成功响应继续完整缓冲，以便保留确定的状态码与错误正文。

WebView 按 Pi RPC 的 `message_update.assistantMessageEvent` 与 `contentIndex` 累积文本增量，并以 `message_end.message` 覆盖为最终权威内容。整个过程只维护一条助手消息；超时、拒绝或 Runtime 异常会原位替换临时内容，避免残留半截回答或重复错误消息。

流式增量以纯文本呈现，避免每个 token 重建 Markdown 语法树；收到最终消息后再通过按需加载的 React AST 渲染器展示 CommonMark/GFM。渲染器忽略原始 HTML 和远程图片，只允许无凭据的 HTTPS 来源链接，模型输出不会进入 `dangerouslySetInnerHTML`。桌面端通过受 capability scope 约束的 Tauri Opener 将链接交给系统浏览器，普通 Web 预览使用隔离的新窗口。

用户停止分析时，前端通过同一条受管 RPC 通道发送 Pi `abort` 命令，并在收到 `message_end(stopReason=aborted)` 与 `agent_settled` 后结束本轮生命周期。取消中的状态禁止重复提交或重复取消；若取消命令被拒绝，则仅在原分析仍未结束时恢复运行状态，避免覆盖并发到达的正常结果。

取消命令本身也有独立的 pending 锁：即使 Pi 先报告本轮已经完成，前端仍会暂时禁止下一轮提交，直到 abort RPC 返回，避免迟到的取消请求误作用于下一轮分析。

应用收到 Tauri `ExitRequested` 或 `Exit` 事件时会幂等关闭本轮回环代理、拒绝尚未完成的 RPC，并显式终止和回收 Pi 子进程，避免桌面窗口退出后遗留孤儿进程或短期能力端口。

Runtime 启动前由 Host 在同一把状态锁内完成 `Stopped/Crashed → Starting` 预约，多个并发启动请求只有一个能够继续创建 executor 与 Pi 子进程。Host 对出站 JSONL 也执行 1 MiB 上限；Pi 的 stdout JSONL 与 stderr 诊断均由有界逐段读取器处理，超长单行会在固定内存内被丢弃和报告，不会先无限扩张缓冲区再做长度检查。

每次 Runtime 启动都会分配单调递增的 generation，并在读取配置或创建任何运行资源前进入 `Starting`。停止或退出发生在启动窗口时会为该 generation 留下取消标记；启动流程在准备资源、创建 executor 和安装子进程前分别复查，已创建的局部资源会被回收。writer、stdout、stderr、watcher 与 QVeris 审计也绑定 generation，旧进程的迟到退出或 I/O 错误不能清空新 Runtime 的 pending 请求、代理或状态。

“同步模型”只将 Host 从 `/models` 获取并验证过的“网关 + 目录”候选暂存在当前进程内，不写磁盘、不重启 Runtime。网关地址变化时禁止直接复用旧目录；保存时只接受与表单网关完全匹配的可信候选。刷新后若原默认模型已下线，Host 会回退到首个可用模型，并在生成 Pi 配置前再次校验所选模型确实属于当前目录。Host 会丢弃非聊天、空 ID、超长或含控制字符的模型项，去除重复 ID，并限制目录条目数与配置文件体积，避免异常上游目录污染 UI 或 Pi 配置。

“保存并应用”由单个 Host command 完成：先组合磁盘当前值与匹配的内存候选并校验，再等待旧 Runtime 完全停止、原子写入并启动新 Runtime。只有完整应用成功才清除本次候选；并发到达的更新候选不会被旧保存操作清除。新配置无法启动时，Host 会恢复旧配置并尝试恢复旧 Runtime，避免前端跨多个 command 编排造成磁盘配置与运行状态分裂。

集成设置与 Pi 的模型、Shell 配置不直接截断覆盖：Host 在同目录写完并同步唯一临时文件，将旧文件保留为短期备份后再替换。若进程在替换窗口退出且主文件缺失，下次读取会恢复最后一份备份。

## 进程与信任边界

```text
WebView (untrusted presentation)
  └─ Tauri command allowlist
       └─ Rust Host (trusted product boundary)
            ├─ Credential store
            ├─ Runtime manager
            ├─ Per-conversation audit stream
            └─ Pi child process (restricted environment)
                 └─ qveris-bridge extension
                      └─ loopback executor (run-scoped capability)
```

Rust Host 清理继承环境，不向 Pi 传递任何 `QVERIS_*`、OAuth 或控制面 token。未知工具结果不会在崩溃恢复后自动重放。

桌面构建从 `scripts/pi-version.json` 读取固定版本和 SHA-256，下载后放入应用资源目录。Host 优先启动随包 Pi，并用 `--extension .../qveris-bridge.mjs --mode rpc --no-session` 显式加载受管桥；开发时可用 `FOLIOMIND_PI_BINARY` 与 `FOLIOMIND_BRIDGE_EXTENSION` 覆盖路径。

## Windows 与 macOS

Tauri 配置包含 Windows NSIS/MSI 与 macOS App/DMG 目标。生产发布仍需在对应平台补齐代码签名、公证、自动更新签名和干净安装烟测。
