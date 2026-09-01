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

组合盘后复盘由 `src/lib/portfolioReview.js` 从客户端已经收到的真实持仓行情、风险指标和公司事件生成不可变快照。快照最多保留 90 份，每份只保存归一化后的价格、盈亏、来源、数据截至时间、风险摘要和未来 7 天持仓事件，不保存 API Key、提示词、模型响应或运行日志。缺少真实现价时禁止生成，未计价持仓只进入覆盖率分母，不会估算市值或盈亏；Web、备份和桌面 Rust Host 使用同一有界 schema。

设置页的用户数据备份只导出经过白名单筛选的自选、盯盘规则、站内消息和持仓字段，并带有显式格式版本；API Key、模型网关、模型目录、工具缓存、开发者变量和运行日志不会进入备份。导入会重新校验字段、限制集合规模，要求至少一个自选标的，并在原子持久化前清理行情缓存，避免把旧渠道数据带到新环境。运行中的 Pi、盯盘或设置应用任务会拒绝导入。

本地 Web 调试时，`npm run web:dev` 同时启动 Vite 和独立 Dev Host，默认监听 `127.0.0.1:43123`（端口冲突时自动递增）。Dev Host 复用同一 HTTP 路由和 Search → Inspect → Call 策略，直接代理模型网关和 QVeris 工具；因此修改 Web/Host 代码后无需安装新桌面版本。Web UI 先通过允许的 localhost Origin 获取一次性会话令牌，再以 `X-FolioMind-Host` 请求头访问配置、凭据、用户状态和运行时 API。该 HTTP 入口仅允许回环请求和本地开发 Origin，不作为公网服务。

默认测试套件会以动态回环端口启动真实 Dev Host 子进程，并把状态目录隔离到系统临时目录；本机 mock 网关覆盖会话鉴权、凭据前缀、跨重启状态恢复、并发 prompt 拒绝、owner 取消和 Runtime 状态释放。测试不连接真实 QVeris，也不读取用户配置。Host 对端口 `0` 报告操作系统实际分配的端口，使 CI 不依赖固定端口且避免并行任务冲突。

金融查询默认使用 QVeris CAP 的 `qveris_finance` provider。Web Host 将稳定的 capability/tool schema（tool_id、参数、返回字段、能力 ID、provider）保存到本地 `tool-selection-cache.json`，行情、公司资料、估值、历史日线、公司事件、资金流和标注新闻直接调用 CAP；CAP 不可用时再回退到 Search → Inspect → Call。对外仍提供稳定的 `foliomind_data(kind, symbol, range)` schema，`kind` 包括 `quote`、`details`、`series`、`core_event`、`capital_flow`、`sentiment`，未来可替换为其它渠道而不影响页面。条件检查对这些能力使用三值逻辑：CAP 明确失败或无可用字段时返回 `unknown`，不把空数组当成未触发。QVeris 和模型网关的瞬时 408/425/429/5xx 失败以及可恢复的网络错误会经过有界指数退避重试，并尊重上游 `Retry-After`；已取消的请求不会重试，取消信号会打断退避等待。桌面端 Rust 桥接器对 Search/Inspect/Call 采用相同的重试分类、退避上限和停止取消语义。自选行情刷新使用受限并发（默认 2，localhost 开发面板可调至 1–4），避免多个标的串行等待。localhost 与桌面端均显示本机开发者面板，分别展示 Host 或 Pi/QVeris 事件日志；密钥和原始提示词不会写入日志。凭据、模型或渠道变更会使相关缓存失效。

事件日历在已返回的真实公司事件之上提供客户端关联范围筛选：默认展示自选标的，用户选择“只看持仓”时按规范化证券代码（A 股交易所后缀 `.SH/.SS/.SZ` 可省略）与 `user-state.json` 中的持仓匹配；也可以按自选项已有的 `category` 做行业筛选。该筛选不改变 CAP 请求范围、不持久化事件结果，也不会把没有持仓的空结果误报为“暂无事件”；列表和月视图共享同一筛选结果。

事件日历刷新成功后由 `src/lib/eventReminders.js` 按北京时间自然日计算提醒窗口：未来 1–7 天产生一次提前提醒，事件当天再产生一次当天提醒。提醒使用 `eventKey + reminderPhase` 幂等键写入脱敏站内消息，随后尽力发送已获授权的系统通知；重复刷新、无日期或过期事件不会刷屏或生成通知。事件提醒不阻塞事件列表，也不把模型推断或未知日期当作事实。

当多个本地 Web 请求同时遇到同一类工具缓存未命中时，Host 使用按数据类型和渠道隔离的 warm-up gate 合并 Discover 流程：首个请求负责 Search → Inspect → Call 并固化参数模板，等待者在完成后继续使用 `foliomind_data` 直接调用；若首个请求失败，等待者会接管预热，避免死锁或永久等待。

盯盘服务由 WebView 调度（桌面端每 30 秒检查到期规则），同一时间只允许一条 Pi 检查任务，避免与用户对话并发占用 Runtime。只有在 API Key 和模型均已配置时才能新建或执行盯盘；本地 Web Host 的价格异动策略优先直接调用已固化的行情工具并在前端按阈值计算，缓存未命中才回退到真实 Pi 查询；其他策略仍要求 Pi 使用内置 `qveris-finance-research` Skill 执行 `Search → Inspect → Call`。所有结果都要求带 `triggered`、来源和数据截至时间的结构化结果；告警按触发边沿发送，同一条件持续成立时不会每次轮询重复刷屏，条件恢复后再次触发才生成新消息；触发结果和失败都会写入站内消息，用户可在消息中心标记已读。持仓可选配置止盈价/止损价，真实行情刷新后在本地纯计算并沿用触发边沿去重；缺少现价时不触发，消息包含计划价、真实现价、数据时间、来源和非投资建议声明。无效的历史检查时间会被视为到期，避免规则静默停止。

系统通知是显式可选能力：通知页默认关闭，只有用户主动开启并通过当前桌面或 localhost 环境的权限请求后，触发边沿才会发送系统通知；权限拒绝或插件不可用时仅保留站内消息，不影响盯盘任务。

QVeris 的 `session_id`、响应视图、返回模式和最大响应大小属于 Host 策略字段，不向模型暴露，也不接受 Skill 覆盖。Host 会对查询、标识符、候选工具数量和调用参数体设置独立上限，再写入本轮 `product_run_id`。

回环 executor 同时最多处理 16 个连接；槽位在连接处理线程退出时由 RAII 自动归还。达到上限的新连接会在读取请求体或创建线程前立即收到 `503`，避免异常本地连接利用读取或上游超时无限堆积线程。

开发面板的费用字段由 `src/components/DeveloperPanel.jsx` 统一归一化：兼容 Local Host 的 `{amount, unit}`、桌面审计的 `cost + costUnit` 以及网关数值费用；CAP 与模型费用按调用类型和计费单位隔离，未知费用不估算。原生后台复盘的行情新鲜度判断优先解析 RFC3339 偏移并转换为北京时间自然日，避免 UTC 跨日时间戳被错误地判为前一交易日或下一交易日。

每个 executor 维护 run-scoped 取消信号和活动下游 socket 注册表。停止 Runtime 时，Host 会拒绝新连接、关闭所有已接收连接，并取消仍在等待响应头或响应体的 QVeris 工具/模型请求；上游返回后会再次检查取消状态，避免已观察到停止信号的旧 run 写入成功审计或响应。`stop()` 最多等待 1 秒让连接 guard 退出后再返回；若同步 socket 写入未及时响应关闭信号，线程仍可能在系统写超时前短暂收尾，但不会继续等待上游网络响应。

市场页的自选市场宽度由前端纯函数从当前 `liveQuotes` 计算，只接受具有有效价格的真实报价；缺失价格或涨跌幅不参与上涨/下跌/极值统计。它只改变展示，不新增 CAP 请求、缓存键或持久化字段，因而不会把预览值或旧值误报为市场宽度。

模型网关的成功 SSE 响应由 Host 以 close-delimited HTTP 流逐块转发并及时 flush，避免 Pi 等待整轮网关响应结束后才开始处理；流式与非流式响应均受 16 MiB 总大小限制。JSON 和非成功响应继续完整缓冲，以便保留确定的状态码与错误正文。

WebView 按 Pi RPC 的 `message_update.assistantMessageEvent` 与 `contentIndex` 累积文本增量，并以 `message_end.message` 覆盖为最终权威内容。整个过程只维护一条助手消息；超时、拒绝或 Runtime 异常会原位替换临时内容，避免残留半截回答或重复错误消息。

流式增量以纯文本呈现，避免每个 token 重建 Markdown 语法树；收到最终消息后再通过按需加载的 React AST 渲染器展示 CommonMark/GFM。渲染器忽略原始 HTML 和远程图片，只允许无凭据的 HTTPS 来源链接，模型输出不会进入 `dangerouslySetInnerHTML`。桌面端通过受 capability scope 约束的 Tauri Opener 将链接交给系统浏览器，普通 Web 预览使用隔离的新窗口。

用户停止分析时，前端通过同一条受管 RPC 通道发送 Pi `abort` 命令，并在收到 `message_end(stopReason=aborted)` 与 `agent_settled` 后结束本轮生命周期。取消中的状态禁止重复提交或重复取消；若取消命令被拒绝，则仅在原分析仍未结束时恢复运行状态，避免覆盖并发到达的正常结果。

取消命令本身也有独立的 pending 锁：即使 Pi 先报告本轮已经完成，前端仍会暂时禁止下一轮提交，直到 abort RPC 返回，避免迟到的取消请求误作用于下一轮分析。

桌面端使用 Tauri 内建 tray 生命周期：主窗口普通关闭会被拦截并隐藏到系统托盘，托盘菜单可恢复窗口、触发一次盘后复盘 reconcile 或显式退出。Rust `BackgroundScheduler` 每 60 秒独立核对到期状态、真实交易日历与持仓行情，不依赖 WebView 执行业务；桌面前端只在任务完成后重新 hydrate 状态，本地 Web 调试则保留浏览器调度。应用收到显式 `ExitRequested` 或 `Exit` 时先幂等停止调度循环，再关闭本轮回环代理、拒绝尚未完成的 RPC，并显式终止和回收 Pi 子进程，避免留下孤儿进程或短期能力端口。

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

开发面板读取本地 Host 的能力目录与脱敏调用审计，可在 Web 通过 Host 直连测试，在桌面通过内置 Tool Runtime 测试；只有观察到目标 tool ID 的成功审计才判定测试成功。能力目录支持通过免费 Search 动态加载 provider 返回的完整工具元数据，动态项测试必须携带同一 `search_id`、`tool_id` 与参数 schema，结果不会自动进入产品默认工具链；只有已验证的稳定 tool schema 暴露给 Skill。Windows 更新依靠稳定 UpgradeCode、禁止降级和 current-user 模式覆盖安装，不能在发布脚本中先删除旧安装目录或用户配置。

用户状态根对象带单调递增的 `revision`。Web Host 与桌面 Host 保存时在同一 I/O 临界区比较 `expectedRevision`，不匹配返回 409/`USER_STATE_CONFLICT`；客户端收到冲突后重新读取最新状态，只自动合并不同记录或不同日程字段的修改，同一记录的相互冲突修改停止保存并提示刷新。旧状态文件迁移为 revision 0，便携备份不携带 revision，避免把另一台设备的并发令牌带入本机。该契约使托盘后台调度写入的新提醒、复盘和检查历史不会被仍持有旧快照的 WebView 静默覆盖。

组合自动复盘使用可持久化的本地调度状态：北京时间到点后先按 `close:<YYYY-MM-DD>` 做幂等检查，再通过固定 `cn_financial_pro.trade_dates.v1` / `REF.EXCHANGE_CALENDAR` 查询上交所目标日期；明确为交易日后由原生 worker 直接调用固定 `qveris_finance.mkt_l1_rt`，只有至少一个持仓存在当日真实报价时才生成快照和站内通知。网络 I/O 不持有状态锁，最终写入会重验 revision、持仓快照和同日幂等键；只有实际插入的一方发送系统通知。日历失败时 fail closed 并按配置间隔节流重试，休市日不生成。当前 worker 依赖桌面进程存活，显式退出后不会执行；上交所之外的分市场时区、交易日历和收盘时刻仍待拆分。

原生 `BackgroundScheduler` 同时向桌面开发面板发送脱敏 `foliomind://background-scheduler-log` 事件。事件统一记录稳定 tool/capability 标识、受限参数、HTTP 状态、耗时、返回摘要、失败原因和可验证费用；`cost_from_value` 只提取已知费用字段，不保存原始响应或凭证。开发面板按 CAP 与模型网关分组汇总调用次数和费用，未返回费用时标记未知；清理日志只影响当前运行期调试视图，不改变用户状态。

能力工作台从 Host 能力目录读取版本化的已验证 CAP 契约，并为每项能力提供独立的真实调用测试。能力条目的参数 schema、返回字段、覆盖边界和 tool ID 都是对外稳定元数据；测试操作与 `<details>` 展开标题分离，结果以状态消息与脱敏调用日志呈现。成本账本在数据结构中分别维护 `qverisUnits` 与 `modelUnits`，避免 CAP credits、模型 USD 等不同计费单位被混用；部分调用缺费时只显示已知笔数，不估算未知费用。

能力工作台同时将每项 CAP 的稳定参数契约转换为 OpenAI-compatible function tool JSON，复制结果通过 `x-foliomind` 保留 provider、tool_id 和 capability 元数据，必填字段由参数类型后的 `?` 判定，可选字段不进入 `required`，并拒绝额外属性。该导出仅走剪贴板，不进入用户状态、审计日志或凭据存储，未来 Skill 可直接复用而无需重新 Discover。

能力工作台的固化 CAP 列表支持纯前端即时筛选，匹配 capability/tool ID、用途、kind 和 provider；筛选只改变可见条目，不触发网络请求、不改变调用契约，也不把动态发现目录中的未验证能力并入固化列表。无匹配时显示可恢复空态，保证能力数量增长后仍可快速定位目标工具。

市场页的自选行情表使用版本化的本机非敏感偏好保存列视图。列定义是前端展示白名单，动态网格只根据用户选择调整布局；它不会改变 CAP 查询参数、缓存键或数据归一化。名称/代码和市场列不可隐藏，数据列缺失时保持空值；窄屏只在表格容器内横向滚动，避免页面级溢出。Web 与桌面共用同一实现，恢复默认列和存储失败均有安全回退。

市场页同时提供版本化的命名行情视图：内置“核心估值”“交易盘面”“完整字段”仅是列 ID 预设，用户自定义视图最多保存 10 个，按名称更新或删除。视图偏好与行情数据、凭证、模型配置和运行日志严格隔离；手动修改列进入临时视图，不会隐式改写已保存视图。读取时执行列白名单、名称长度和数量上限校验，存储损坏时只回退内置视图。选择视图只更新前端展示列，不改变 CAP 参数、缓存键、数据时间或真实数据边界。

异动雷达在客户端从已返回的真实 quote 计算阈值命中；用户点击“AI 解读”后才执行证据聚合。Local Host 并行调用已固化的 `sentiment`、`core_event` 和 `capital_flow` CAP，桌面端由 Pi 通过同一 `foliomind_data` 能力补充，随后使用严格 JSON 提示生成异动事实、持仓关系、后续核验项和来源。归一化阶段只接受带有效证据索引或工具返回来源的诱因，模型无来源的因果表述会被丢弃；无真实证据时保留明确空态，不调用模型猜测。结果只存在当前运行内存，审计沿用现有脱敏调用日志，来源链接仅允许 HTTP(S)，不把持仓上下文、原始响应或 API Key 写入用户状态。

动态自选组盯盘在规则中保存 `scope=watchlist` 和 `symbol=*`，不复制创建时的标的快照。每次检查根据当前自选重新展开标的，使用受限并发执行相同的 CAP/Host 链路；单标的结果各自写入 `monitorHistory`，失败只进入有界汇总消息。规则通过 `lastSignalBySymbol` 保存每个标的的触发边沿，避免整组共享一个布尔状态导致漏报或刷屏。状态层仅允许最多 200 个规范化代码和布尔值，旧规则缺省 scope 时仍按单标的兼容，备份不携带凭据或原始调用内容。

股票详情页的快捷操作复用 `useLabStore` 自选持久化和现有行情/证据入口：收藏切换不创建第二套状态，更多菜单只编排已有能力，操作反馈留在运行态，不写入用户状态或日志。菜单使用显式 ARIA menu 契约，避免图标控件成为无行为死端。

行情图表设置保持在 `StockWorkspace` 的运行态，由 `MarketChart` 接收显式的网格线和 MA5 开关。MA5 只从当前真实序列的滑动窗口计算，序列不足五点时返回空，不向数据层回填；设置面板是纯显示偏好，不影响 CAP 请求、缓存、审计或用户状态。

对话快捷指令由 `CopilotPanel` 维护为编辑态模板，选择后只更新 draft 并聚焦输入框，不绕过既有 `sendMessage`、运行时互斥或取消协议。模板不包含行情值和供应商错误码，菜单状态仅存在当前组件，避免把用户尚未确认的提示写入日志或用户状态。

`AppErrorBoundary` 包裹应用渲染树。故障界面只提供安全的重试和完整重载动作，诊断只记录固定事件名与异常类型，不渲染异常正文，也不清理已持久化的用户状态。

CAP 数据访问与模型推理访问在状态层明确解耦：有效 API Key 即可执行真实行情、详情、序列、事件、资金流、新闻和盯盘数据链路；模型 ID 只作为对话与 AI 解读的门禁。这样数据页面不会因模型目录未同步而误回到预览态，模型缺失也不会被误报为 CAP 失败。

桌面端通过原生 `qveris_data_query` 白名单命令执行固定 CAP，参数、tool ID 和能力 ID 由应用内契约生成；Local Host 与桌面返回统一的 `data/mode/cacheHit/audits` 结构。该命令只读取系统凭据、限制网关地址和请求超时，并将脱敏审计事件发送到开发面板，不把原始响应或凭据持久化。

设置页的“测试数据连接”是一个显式的真实 CAP 探针：只使用已保存的数据能力配置和当前自选中的第一个标的（无自选时使用受控默认标的），通过 `queryCapabilityData({ kind: "quote", symbol })` 调用固定行情契约。探针不要求模型、不写入 `liveQuotes` 或用户状态；只有响应中存在有效正数价格时才报告成功，并向用户展示脱敏来源、数据时间和耗时。地址被编辑但尚未保存时禁止探针，避免测试结果与实际页面链路不一致。失败沿用友好数据错误映射，完整请求/响应仍只进入已有的脱敏开发日志。

对话面板同时订阅 `liveDataLoading`。行情批量刷新期间，store 原本会拒绝并发对话请求；UI 现在同步禁用输入、快捷指令和发送按钮，并保留已输入草稿。刷新完成后自动恢复，避免用户把资源互斥误认为对话故障。该状态只影响交互门禁，不改变 Runtime、CAP 或模型生命周期。
