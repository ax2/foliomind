# FolioMind 架构边界

## 设计原则

1. 桌面层负责产品体验、权限、凭证、生命周期和审计，不重新实现 Pi Agent。
2. Pi 只通过 stdin/stdout JSONL RPC 与 Rust Host 通信，不自行监听公网端口。
3. 长期 `QVERIS_API_KEY` 不进入浏览器或 Pi 环境。桌面 Host 为每次运行签发短期 capability；Web 调试使用独立的 Node Dev Host，同样只监听 loopback。
4. 数据调用遵循 `Search → Inspect → Call`；调用结果必须保留 source、as-of、execution ID 和费用字段。
5. 第一版不连接真实券商，不提供自动交易，不承诺收益。

自选标的、分组、盯盘规则和站内通知统一保存在 Host 管理的 `user-state.json` 中。桌面端写入 Tauri 应用配置目录并使用临时文件原子替换；浏览器本地 Host 使用同样的文件协议。自选项的 `group` 是脱敏的本地组织字段，旧状态按市场迁移到 A 股、美股、港股或自选；排序缺失的真实行情始终排在末尾。自选批量导入/导出只处理代码、名称、市场、分类和分组，导入先完整解析并在一次状态写入中提交，重复/非法行不会产生半成功状态。未配置真实凭证时 UI 可显示明确标注的预览布局；配置完成后行情、指标、图表和盯盘结果只接受 QVeris 返回的数据，空字段保持为空。行情展示统一解析 provider 的 `asOf`：缺失或异常时间显示“数据时间未知”，超过 15 分钟显示“可能已延迟”，避免把旧行情误认为实时数据。

Tauri 与 Web 共用同一份脱敏状态契约，除自选 `group` 和条件 `conditions/logic` 外，还包含消息标的上下文、事件提醒元数据、持仓计划字段、`monitorHistory` 检查时间线及其审计摘要；桌面 schema 对新字段提供安全默认值，旧版状态升级时不会静默丢弃已纳入契约的字段。保存前两端都执行集合规模、文本、价格、逻辑和计划字段校验，历史记录保留上限也保持一致。

状态归一化位于无运行时依赖的 `src/lib/userStateSchema.js`，因此浏览器回退、localhost Dev Host 和前端备份入口共享同一套白名单、长度上限、枚举和旧字段迁移逻辑；Tauri Rust Host 在落盘前再次执行类型与业务校验。读取时先归一化再注入 store，保存时先归一化再发往 Host，避免不同传输层对 malformed state 的处理不一致。localhost Host 拒绝保存空自选并只返回归一化后的状态。

设置页的用户数据备份只导出经过白名单筛选的自选、盯盘规则、站内消息和持仓字段，并带有显式格式版本；API Key、模型网关、模型目录、工具缓存、开发者变量和运行日志不会进入备份。导入会重新校验字段、限制集合规模，要求至少一个自选标的，并在原子持久化前清理行情缓存，避免把旧渠道数据带到新环境。运行中的 Pi、盯盘或设置应用任务会拒绝导入。

本地 Web 调试时，`npm run web:dev` 同时启动 Vite 和独立 Dev Host，默认监听 `127.0.0.1:43123`（端口冲突时自动递增）。Dev Host 复用同一 HTTP 路由和 Search → Inspect → Call 策略，直接代理模型网关和 QVeris 工具；因此修改 Web/Host 代码后无需安装新桌面版本。Web UI 先通过允许的 localhost Origin 获取一次性会话令牌，再以 `X-FolioMind-Host` 请求头访问配置、凭据、用户状态和运行时 API。该 HTTP 入口仅允许回环请求和本地开发 Origin，不作为公网服务。

金融查询默认使用 QVeris CAP 的 `qveris_finance` provider。Web Host 将稳定的 capability/tool schema（tool_id、参数、返回字段、能力 ID、provider）保存到本地 `tool-selection-cache.json`，行情、公司资料、估值、历史日线、公司事件、资金流和标注新闻直接调用 CAP；CAP 不可用时再回退到 Search → Inspect → Call。对外仍提供稳定的 `foliomind_data(kind, symbol, range)` schema，`kind` 包括 `quote`、`details`、`series`、`core_event`、`capital_flow`、`sentiment`，未来可替换为其它渠道而不影响页面。条件检查对这些能力使用三值逻辑：CAP 明确失败或无可用字段时返回 `unknown`，不把空数组当成未触发。QVeris 和模型网关的瞬时 408/425/429/5xx 失败以及可恢复的网络错误会经过有界指数退避重试，并尊重上游 `Retry-After`；已取消的请求不会重试，取消信号会打断退避等待。桌面端 Rust 桥接器对 Search/Inspect/Call 采用相同的重试分类、退避上限和停止取消语义。自选行情刷新使用受限并发（默认 2，localhost 开发面板可调至 1–4），避免多个标的串行等待。localhost 与桌面端均显示本机开发者面板，分别展示 Host 或 Pi/QVeris 事件日志；密钥和原始提示词不会写入日志。凭据、模型或渠道变更会使相关缓存失效。

事件日历在已返回的真实公司事件之上提供客户端关联范围筛选：默认展示自选标的，用户选择“只看持仓”时按规范化证券代码（A 股交易所后缀 `.SH/.SS/.SZ` 可省略）与 `user-state.json` 中的持仓匹配；也可以按自选项已有的 `category` 做行业筛选。该筛选不改变 CAP 请求范围、不持久化事件结果，也不会把没有持仓的空结果误报为“暂无事件”；列表和月视图共享同一筛选结果。

当多个本地 Web 请求同时遇到同一类工具缓存未命中时，Host 使用按数据类型和渠道隔离的 warm-up gate 合并 Discover 流程：首个请求负责 Search → Inspect → Call 并固化参数模板，等待者在完成后继续使用 `foliomind_data` 直接调用；若首个请求失败，等待者会接管预热，避免死锁或永久等待。

盯盘服务由 WebView 调度（桌面端每 30 秒检查到期规则），同一时间只允许一条 Pi 检查任务，避免与用户对话并发占用 Runtime。只有在 API Key 和模型均已配置时才能新建或执行盯盘；本地 Web Host 的价格异动策略优先直接调用已固化的行情工具并在前端按阈值计算，缓存未命中才回退到真实 Pi 查询；其他策略仍要求 Pi 使用内置 `qveris-finance-research` Skill 执行 `Search → Inspect → Call`。所有结果都要求带 `triggered`、来源和数据截至时间的结构化结果；告警按触发边沿发送，同一条件持续成立时不会每次轮询重复刷屏，条件恢复后再次触发才生成新消息；触发结果和失败都会写入站内消息，用户可在消息中心标记已读。持仓可选配置止盈价/止损价，真实行情刷新后在本地纯计算并沿用触发边沿去重；缺少现价时不触发，消息包含计划价、真实现价、数据时间、来源和非投资建议声明。无效的历史检查时间会被视为到期，避免规则静默停止。

系统通知是显式可选能力：通知页默认关闭，只有用户主动开启并通过当前桌面或 localhost 环境的权限请求后，触发边沿才会发送系统通知；权限拒绝或插件不可用时仅保留站内消息，不影响盯盘任务。

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

真实 CAP 结果在 Web Host 内仅做进程内短时复用：行情 15 秒、序列/资金流/新闻 60 秒、公司资料/事件 5 分钟。缓存键包含数据类型、完整参数、provider 和渠道地址，凭证或设置变化时清空；不写入用户状态或工具选择文件，也不跨渠道复用。明确失败的 CAP envelope（`success=false` 或 `status_code >= 400`）在归一化阶段即被拒绝，前端只能看到空态或友好重试。能力目录元数据仅在实际变化时写盘，开发面板记录 `cap-cache-hit` 与上游调用耗时，便于定位慢请求而不泄露原始响应。

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

Tauri 配置包含 Windows NSIS/MSI 与 macOS App/DMG 目标。Windows 使用稳定 WiX UpgradeCode 和 current-user NSIS 模式，升级覆盖应用文件且不触碰安装目录之外的用户配置。生产发布仍需在对应平台补齐代码签名、公证、自动更新签名和干净安装烟测。

开发面板读取本地 Host 的能力目录与脱敏调用审计，可对内置 CAP 做真实测试；能力目录仅把已验证的稳定 tool schema 暴露给 Skill，Provider 尚未验证的能力只显示总量，不伪装为可调用工具。Windows 更新依靠稳定 UpgradeCode/current-user 模式覆盖安装，不能在发布脚本中先删除旧安装目录或用户配置。
