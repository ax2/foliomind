# FolioMind Design QA

## Visual truth and capture

- Selected source: `design/foliomind-concept.png` (1487 × 1058 pixels), retained from the pre-rename design pass.
- Final implementation: `.qa/implementation-primary-final.png`.
- Combined comparison: `.qa/comparison-primary-final.png`.
- Capture method: Playwright Python API with local Chromium 1223 at 1487 × 1058 CSS pixels, device scale factor 1.
- State: 自选 / 贵州茅台 / 分时 / initial FolioMind Agent response.
- Intentional deviations: the browser render excludes the 60 px operating-system title bar shown in the concept because Tauri supplies native window decoration; the former QVeris Lab product branding in the source was deliberately replaced by FolioMind while QVeris remains the underlying data provider.

## Core interaction evidence

- 行情 navigation and market table: passed.
- 盯盘 navigation and creation of `成交量异常监控`: passed.
- Skill marketplace navigation and `公告与舆情` install state: passed.
- Settings navigation, QVeris credential state, and built-in model gateway defaults: passed.
- Conversation navigation and message submit: passed.
- Watchlist switch 贵州茅台 → 宁德时代 → 贵州茅台: passed.
- Viewport overflow: none (`scrollWidth/clientWidth = 1487/1487`, `scrollHeight/clientHeight = 1058/1058`).
- Browser console errors: 0. Page errors: 0.

## Source/render comparison

The selected source and final Playwright render were inspected together in a single side-by-side image at the same pixel dimensions.

1. Layout: activity rail, 260 px watchlist, central stock workspace, and 32vw Copilot preserve the source's four-column proportions. Final measured columns are `74px 260px 677.172px 475.828px`.
2. Typography: Chinese/Latin font hierarchy, numeric emphasis, muted metadata, red gains, and green losses match the source hierarchy without clipping.
3. Market visualization: blue intraday area, orange average-price line, red/green volume, range tabs, and key figures reproduce the source anatomy.
4. Copilot: analysis summary, composer, and disclaimer preserve the source hierarchy. Prototype-only financial claims and invented tool IDs were intentionally removed; the audit card now renders only real Host-emitted Search / Inspect / Call records.
5. Assets and tokens: the FolioMind raster logo, Phosphor icon set, cool-white surfaces, pale-blue selection, hairline borders, compact radii, and restrained shadows are crisp at DSF 1.
6. Copy: visible labels and primary financial copy match the approved Chinese concept. Browser-only interaction adds realistic follow-up copy after the user submits a new prompt.

## Comparison history and fixes

- Initial comparison found a P1 chart anatomy mismatch (missing average line/volume), a P1 Copilot density mismatch, and P2 vertical whitespace/content omissions.
- Fixes added the average line and volume series, restored company introduction, widened the Copilot column, and increased the chart height. The integration pass then replaced prototype-only Agent evidence with truthful empty/audited states and added the real QVeris/Pi settings view.
- Final comparison found no remaining P0, P1, or P2 fidelity issue. The native title-bar difference is intentional and documented above.

final result: passed
