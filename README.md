# FolioMind

[![Build](https://github.com/ax2/foliomind/actions/workflows/desktop.yml/badge.svg)](https://github.com/ax2/foliomind/actions/workflows/desktop.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

FolioMind 是一个面向 Windows 和 macOS 的开源金融研究 Agent。产品以自选股为入口，把行情、投资组合、个股盯盘、金融 Skills 与可审计对话放在同一工作台中。它是独立的社区项目，不代表任何数据服务商；QVeris 只是内置的可选数据能力适配器。

## 当前能力

- 自选股分组、分组筛选与按名称/最新价/涨跌幅排序；缺失行情始终保持为空；支持 FolioMind CSV/TradingView 风格 TXT 的批量导入导出。
- 投资组合持仓、成本、市值、未实现盈亏与行情覆盖率。
- 组合盘后复盘快照：保存真实行情覆盖、组合盈亏、风险信号和未来 7 天已返回事件，可展开回顾并随本地备份迁移。
- 持仓可选配置止盈/止损价；真实行情到价后按边沿去重生成站内/系统提醒，不执行自动交易。
- 持仓可建立交易计划档案（买入逻辑、计划周期、目标/止损价），支持执行/重新跟踪、操作留痕和真实价格距离提示。
- 个股盯盘规则、事件时间线和开关状态。
- 公司事件日历：按自选标的展示未来 90 天真实分红、拆股、股东会和财报日期，支持列表/月视图、月份导航、范围筛选、关键词搜索和来源追溯；无数据时保持明确空态。
- 盯盘告警按触发边沿去重：条件持续成立时不重复刷屏，恢复后再次触发才生成新消息。
- 盯盘消息支持可选的系统通知；用户主动授权后，桌面端和 localhost 调试页可在站内消息之外收到提醒。
- 桌面端与本地 Web Host 均支持按间隔执行真实盯盘检查；普通浏览器预览不会伪造检查结果。
- 市场行情总览与跨市场自选列表，缺失数据保持为空；支持核心估值、交易盘面、完整字段和自定义命名行情视图。
- 异动雷达支持按需发起真实证据解读：聚合新闻、公司事件和资金流 CAP，诱因必须关联来源；证据不足时保持空态，不猜测原因。
- 研究筛选工作台：按名称、代码、市场、涨跌方向及行情覆盖筛选自选标的，估值字段缺失时保持为空。
- 行情卡提供统一“来源与证据”抽屉，展示渠道、Provider、能力、新鲜度、截至时间和字段覆盖；缺失字段保持为空，并可独立重试当前标的。
- 组合风险洞察：基于真实现价提示集中度、行情覆盖和未计价成本；没有足够历史序列时不会虚构波动率或相关性。
- Skill 市场及安装状态管理。
- FolioMind Agent 对话支持逐步显示 Pi 流式回答，可在应用内停止正在运行的分析，并以安全的 Markdown 展示标题、列表、表格、代码和来源链接，同时保留工具调用记录、数据截至时间与免责声明。
- Tauri 2 Rust Host 管理 `pi --mode rpc` JSONL 子进程。
- 固定并校验 Pi 0.84.2，桌面构建自动下载对应 Windows/macOS Runtime 并随安装包分发。
- Run-scoped 数据执行桥，只向 Pi 暴露 Search、Inspect、Call 三阶段能力。
- 内置金融研究 Skill；行情页面默认直连 QVeris CAP 的 `qveris_finance` 能力（`MKT.L1.RT`、`REF.COMPANY_PROFILE`、`FUNDAMENTALS.DERIVED_RATIOS`、`MKT.BARS.EOD`），本地保存稳定的 tool schema，缓存失效时才回退 Search → Inspect → Call。QVeris 适配器可替换为兼容的自托管服务。
- 设置页可将数据服务 API Key 保存到系统凭据库、同步动态模型目录并选择 Pi 默认模型。
- 设置页可检查 GitHub 最新公开版本并直达发布页；安装包仍提供 SHA-256 校验，自动更新待平台签名密钥接入后启用。
- 设置页支持导出/导入本地 JSON 备份，迁移自选、盯盘、消息与持仓；API Key、模型配置、缓存和运行日志不会进入备份。
- 内置兼容 OpenAI API 的模型网关配置；Pi 只访问带短期令牌的本机回环代理，不接触长期 API Key。
- 内置 Pi Bash 工具；Windows 安装包捆绑经过 SHA-256 校验的 PortableGit/Bash，所有桌面子进程均以无控制台窗口方式启动。
- WebView 对话在桌面环境通过 Tauri command 调用真实 Pi RPC；普通浏览器预览使用明确的演示回退。
- 本地 Web 调试可连接独立的 `127.0.0.1` Local Host；浏览器通过受保护的短期会话调用同一套 Pi、数据适配器、凭据和用户状态能力。

## 架构

```text
React desktop UI
    │ Tauri commands / runtime events
    ▼
Rust Host
    ├─ window + lifecycle
    ├─ Pi JSONL RPC manager
    ├─ credential boundary
    └─ run-scoped data executor capability
              │
              ▼
       Pi runtime + reviewed Skills
              │ search → inspect → call
              ▼
       Configured data tools
```

此项目不使用 `qveris-qlab` 架构。技术基线参考 ZiCode Studio Desktop 的 Tauri/Host/Pi 分层，但前端统一使用 React，且只保留金融客户端需要的边界。

## 配置真实数据与模型

在桌面端打开“设置”：

1. 保存数据服务 API Key。该密钥优先进入操作系统凭据库；Linux 本地调试若未运行 Secret Service，则使用权限为 `0600` 的用户配置文件回退，避免设置页保存失败。
2. 可使用内置的 QVeris 兼容配置（工具地址 `https://qveris.ai/api/v1`、模型地址 `https://aigateway.qveris.ai/v1`），也可以按部署环境替换为兼容服务。
3. 点击“同步模型”，从网关的 `/models` 原子读取并保存当前可用模型，再选择 Pi 默认模型并应用。更换网关地址后必须重新同步，已下线的默认模型会安全回退到目录中的首个可用模型。
4. 在自选股页面点击“获取实时数据”可直接刷新当前标的；需要解释时再点击“交给 Agent”。行情卡会根据 provider 时间标记“数据时间未知”或“可能已延迟”，不会把缺少时间戳的数据冒充实时数据；没有可识别真实价格的数据不会进入行情、组合或盯盘结果。

盯盘消息页的“系统通知”开关默认关闭。开启时仅在当前桌面/localhost 环境请求系统通知权限；拒绝权限不会影响站内消息保存和盯盘任务执行。

桌面版关闭主窗口后会隐藏到系统托盘并保持本地 Host 与自动复盘协调器运行。托盘菜单提供“显示 FolioMind”“立即检查盘后复盘”和“退出 FolioMind”；需要完全停止后台进程时请使用托盘退出。Web 本地调试页关闭后不会继续运行。

研究筛选目前以“我的自选”为明确数据范围；添加更多标的或安装额外数据 Skill 后，仍需等真实行情返回才会进入筛选结果。组合风险洞察只展示可解释的已计价暴露，不输出没有数据依据的综合风险分数。

自选侧栏“更多”支持批量导入和导出。导入文件只包含代码、名称、市场、分类和分组，解析会先完整校验，重复或非法行不会污染已有自选；实时行情、凭证和运行日志不会进入文件。

设置页的“本地数据备份”适合换机或在 Web 调试与桌面端之间迁移用户数据。导入会覆盖当前自选、盯盘、消息和持仓，并清空旧行情缓存，随后重新获取真实数据；正在分析或盯盘检查时会暂时禁止导入，避免覆盖进行中的任务。

未配置凭证和模型时，界面可能显示带有“预览模式”标识的静态布局样例；一旦配置完成，行情、指标、图表、组合和盯盘信号只使用数据服务已返回的真实数据，缺失字段显示为空并提示查询，不会用样例补齐。

### 本地 Web 调试

Web 端本机调试不需要安装或启动桌面端。推荐用一个命令同时启动 Vite 和独立 Dev Host：

```bash
npm run web:dev
```

浏览器打开终端打印的 Web 地址（默认 `http://127.0.0.1:5173`；端口被占用时会自动递增并打印新的地址）后，设置页会显示“本地开发 Host”。Dev Host 与桌面端共享同一套 Host HTTP 协议，并直接代理模型、Search → Inspect → Call 和对话，因此修改前端或 Host 逻辑后刷新页面即可验证，不需要重新安装桌面包。API Key 保存在用户配置目录下权限为 `0600` 的文件中，浏览器只持有当前标签页的短期会话令牌。

本地 Web Host 会把 `qveris_finance` CAP 的 tool schema（tool_id、参数、返回字段、能力 ID、provider）保存到用户配置目录的 `tool-selection-cache.json`。行情、基本面和历史序列优先直连 CAP；能力不可用时再回退到一次 Search → Inspect → Call。QVeris 数据调用和模型网关遇到 408/425/429/5xx 或可恢复网络错误时使用有界指数退避，并尊重上游 `Retry-After`；已取消的请求不会重试，取消请求会立即打断等待。固化工具只有收到明确的工具失效/不存在响应才会清除，瞬时限流、服务端错误和网络抖动会保留缓存。运行时同一时间只接受一轮对话请求，重复提交返回可识别的忙碌状态，不会互相覆盖取消控制器。价格异动盯盘也复用 CAP 行情工具，避免每次检查重新调用模型编排；自选行情默认以 2 路受限并发请求。行情轮询会感知浏览器可见性。localhost 页面和桌面端右下角的“开发者面板”均可查看运行时、API Key 前缀、模型/CAP 调用日志、耗时和能力目录；密钥与原始提示词不会记录。

如需验证真实 Tauri 窗口，再使用 `npm run desktop:dev`；这不是 Web 调试的前置条件。

当多个自选标的首次同时刷新且工具缓存尚未命中时，Host 会合并同类请求，只执行一次 Search → Inspect → Call 预热，其余请求等待缓存固化后直接复用，减少首屏重复发现工具。

为避免长期凭据通过明文链路泄露，远程数据服务地址必须使用 HTTPS；只有 `localhost`、`127.0.0.0/8` 和 `::1` 回环地址允许使用 HTTP。基础地址不能包含 query 或 fragment。

## 本地开发

```bash
npm install
npm run dev
```

安装 Rust toolchain 与平台依赖后运行桌面端：

```bash
npm run desktop:dev
npm run desktop:build
```

验证：

```bash
npm test
npm run audit:security
npm run fetch:pi
npm run fetch:bash
npm run smoke:pi
npm run build
npm run test:sites
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

## 发布安装包

GitHub Actions 的 `release` workflow 只允许从当前 `main` 提交运行，并接收与仓库配置一致的 SemVer（当前为 `0.1.65`）。它会先完成格式、严格 Clippy、测试以及 Windows NSIS/MSI 和 macOS Apple Silicon DMG 构建；确认三类安装包齐全并通过 SHA-256 校验后，才创建或复用 `v<version>` draft release、上传安装包与 `SHA256SUMS.txt` 并正式发布。Windows 安装包使用稳定的 WiX UpgradeCode、禁止降级并采用 current-user 安装模式；可识别的同一产品新版本会直接覆盖升级，不要求用户先手动卸载或重复确认，只有无法识别为同一产品时才保留系统安全确认。配置、API Key 和用户数据位于安装目录之外，会保留在升级后。

```bash
gh workflow run release.yml --repo ax2/foliomind -f version=0.1.65 -f prerelease=false
```

发布前可运行 `npm run review:architecture`，检查版本、真实数据边界、状态脱敏、安装升级路径、Release 资产和 PRD 阶段设计。

视觉源文件位于 `design/foliomind-concept.png`，最终视觉验收记录见 `design-qa.md`。

## License

FolioMind 使用 [MIT License](LICENSE) 开源。
