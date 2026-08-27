# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Durable product decisions

- The selected visual source is `design/foliomind-concept.png` (the first generated Research Cockpit direction).
- The product is FolioMind, a Windows/macOS Tauri 2 desktop client powered by Pi RPC and QVeris data capabilities.
- Do not reuse or derive architecture from `qveris-qlab`; the approved architecture is React → Tauri Rust Host → Pi JSONL RPC, with a run-scoped QVeris executor bridge.
- The primary experience is a watchlist + stock workspace + FolioMind Agent. Market, monitoring, conversations, Skills, and settings are first-class navigation destinations.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
