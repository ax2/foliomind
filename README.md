# FolioMind

[![Build](https://github.com/ax2/foliomind/actions/workflows/desktop.yml/badge.svg)](https://github.com/ax2/foliomind/actions/workflows/desktop.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

FolioMind 是一个面向 Windows 和 macOS 的开源金融研究 Agent。产品以自选股为入口，把行情、个股盯盘、QVeris 数据工具、金融 Skills 与可审计对话放在同一工作台中。

## 当前能力

- 自选股分组、标的切换、分时行情与关键指标。
- 个股盯盘规则、事件时间线和开关状态。
- 市场行情总览与跨市场自选列表。
- Skill 市场及安装状态管理。
- FolioMind Agent 对话、工具调用记录、数据截至时间与免责声明。
- Tauri 2 Rust Host 管理 `pi --mode rpc` JSONL 子进程。
- 固定并校验 Pi 0.84.2，桌面构建自动下载对应 Windows/macOS Runtime 并随安装包分发。
- Run-scoped QVeris executor bridge，仅向 Pi 暴露 `qveris_search`、`qveris_inspect`、`qveris_call`。
- WebView 对话在桌面环境通过 Tauri command 调用真实 Pi RPC；普通浏览器预览使用明确的演示回退。

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
npm run fetch:pi
npm run smoke:pi
npm run build
npm run test:sites
```

视觉源文件位于 `design/foliomind-concept.png`，最终视觉验收记录见 `design-qa.md`。

## License

FolioMind 使用 [MIT License](LICENSE) 开源。
