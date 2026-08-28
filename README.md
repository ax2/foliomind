# FolioMind

[![Build](https://github.com/ax2/foliomind/actions/workflows/desktop.yml/badge.svg)](https://github.com/ax2/foliomind/actions/workflows/desktop.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

FolioMind 是一个面向 Windows 和 macOS 的开源金融研究 Agent。产品以自选股为入口，把行情、个股盯盘、QVeris 数据工具、金融 Skills 与可审计对话放在同一工作台中。

## 当前能力

- 自选股分组、标的切换、分时行情与关键指标。
- 个股盯盘规则、事件时间线和开关状态。
- 市场行情总览与跨市场自选列表。
- Skill 市场及安装状态管理。
- FolioMind Agent 对话支持逐步显示 Pi 流式回答，可在应用内停止正在运行的分析，并以安全的 Markdown 展示标题、列表、表格、代码和来源链接，同时保留工具调用记录、数据截至时间与免责声明。
- Tauri 2 Rust Host 管理 `pi --mode rpc` JSONL 子进程。
- 固定并校验 Pi 0.84.2，桌面构建自动下载对应 Windows/macOS Runtime 并随安装包分发。
- Run-scoped QVeris executor bridge，仅向 Pi 暴露 `qveris_search`、`qveris_inspect`、`qveris_call`。
- 内置并在启动时加载 `qveris-finance-research` Skill，强制真实外部数据遵循 Search → Inspect → Call。
- 设置页可将 QVeris API Key 保存到系统凭据库、同步动态模型目录并选择 Pi 默认模型。
- 内置 QVeris OpenAI-compatible 模型网关配置；Pi 只访问带短期令牌的本机回环代理，不接触长期 API Key。
- 内置 Pi Bash 工具；Windows 安装包捆绑经过 SHA-256 校验的 PortableGit/Bash，所有桌面子进程均以无控制台窗口方式启动。
- WebView 对话在桌面环境通过 Tauri command 调用真实 Pi RPC；普通浏览器预览使用明确的演示回退。
- 本地 Web 调试可连接桌面端随附的 `127.0.0.1` Local Host；浏览器通过受保护的短期会话调用同一套 Pi、QVeris、凭据和用户状态能力。

## 架构

```text
React desktop UI
    │ Tauri commands / runtime events
    ▼
Rust Host
    ├─ window + lifecycle
    ├─ Pi JSONL RPC manager
    ├─ credential boundary
    └─ run-scoped QVeris executor capability
              │
              ▼
       Pi runtime + reviewed Skills
              │ qveris_search → inspect → call
              ▼
          QVeris tools
```

此项目不使用 `qveris-qlab` 架构。技术基线参考 ZiCode Studio Desktop 的 Tauri/Host/Pi 分层，但前端统一使用 React，且只保留金融客户端需要的边界。

## 配置真实数据与模型

在桌面端打开“设置”：

1. 保存 QVeris API Key。该密钥只进入操作系统凭据库。
2. 保持默认工具地址 `https://qveris.ai/api/v1`，模型地址 `https://aigateway.qveris.ai/v1`，或按部署环境修改。
3. 点击“同步模型”，从网关的 `/models` 原子读取并保存当前可用模型，再选择 Pi 默认模型并应用。更换网关地址后必须重新同步，已下线的默认模型会安全回退到目录中的首个可用模型。
4. 在自选股页面点击“实时数据”，Agent 会使用内置 Skill 查询并返回 provider、工具 ID、来源和截至时间。

行情页面中的预置数字仅用于界面布局演示，并有明确标注；Agent 查询结果才是实时外部数据。

### 本地 Web 调试

Web 端只用于本机调试时，先启动桌面端 Host，再启动 Vite：

```bash
npm run desktop:dev
npm run dev -- --host 127.0.0.1 --port 5173
```

浏览器打开 `http://127.0.0.1:5173` 后，设置页会显示“本地调试 Host”。此模式的 API Key 仍保存到操作系统凭据库，浏览器只持有当前标签页的短期 Host 会话令牌；关闭桌面端后 Web 端会退回到明确标注的预览模式。普通浏览器部署不启用本地 Host，也不会把长期 API Key 写入 `localStorage`。

为避免长期凭据通过明文链路泄露，远程 QVeris 地址必须使用 HTTPS；只有 `localhost`、`127.0.0.0/8` 和 `::1` 回环地址允许使用 HTTP。基础地址不能包含 query 或 fragment。

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

GitHub Actions 的 `release` workflow 只允许从当前 `main` 提交运行，并接收与仓库配置一致的 SemVer（当前为 `0.1.3`）。它会先完成格式、严格 Clippy、测试以及 Windows NSIS/MSI 和 macOS Apple Silicon DMG 构建；确认三类安装包齐全并通过 SHA-256 校验后，才创建或复用 `v<version>` draft release、上传安装包与 `SHA256SUMS.txt` 并正式发布。构建失败不会预先留下新的 tag 或 draft release。

```bash
gh workflow run release.yml --repo ax2/foliomind -f version=0.1.3 -f prerelease=false
```

视觉源文件位于 `design/foliomind-concept.png`，最终视觉验收记录见 `design-qa.md`。

## License

FolioMind 使用 [MIT License](LICENSE) 开源。
