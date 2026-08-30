import { readFile } from "node:fs/promises";
const root = new URL("..", import.meta.url);
const load = (file) => readFile(new URL(file, root), "utf8");
const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass, detail });

const [packageJson, cargoToml, tauriConfig, app, marketViews, userState, workflow, prd, readme, watchlist, portfolioReview] = await Promise.all([
  load("package.json").then(JSON.parse), load("src-tauri/Cargo.toml"), load("src-tauri/tauri.conf.json").then(JSON.parse),
  load("src/App.jsx"), load("src/components/SecondaryViews.jsx"), load("src/lib/userStateSchema.js"), load(".github/workflows/release.yml"), load("docs/prd.md"), load("README.md"), load("src/lib/watchlist.js"), load("src/lib/portfolioReview.js"),
]);
const version = packageJson.version;
check("版本号一致", cargoToml.includes(`version = "${version}"`) && tauriConfig.version === version, `当前 ${version}`);
check("真实数据边界", marketViews.includes("DATA_STATES") && marketViews.includes("realDataMode"), "页面必须显式区分未配置、加载、失败和空数据");
check("状态脱敏", userState.includes("normalizeUserState") && userState.includes("return { watchlist") && !userState.includes("integration-settings.json"), "用户状态 schema 只处理脱敏用户事实");
check("发布资产", workflow.includes("SHA256SUMS") && workflow.includes("gh release upload"), "Release workflow 需校验并上传安装包");
check("安装升级路径", tauriConfig.bundle?.windows?.allowDowngrades === false && tauriConfig.bundle?.windows?.nsis?.installMode === "currentUser" && Boolean(tauriConfig.bundle?.windows?.wix?.upgradeCode) && readme.includes("不要求用户先手动卸载"), "Windows 同一产品必须覆盖升级、阻止降级并保留用户配置");
check("阶段设计", prd.includes("Stage 1E") && prd.includes("异动雷达"), "新功能必须先有可验收的 PRD 阶段设计");
check("自选迁移边界", watchlist.includes("parseWatchlistImport") && watchlist.includes("watchlistCsv"), "批量自选导入需先解析校验，导出不得包含实时数据或凭证");
check("复盘证据边界", portfolioReview.includes("createPortfolioReviewSnapshot") && portfolioReview.includes("if (!metrics.pricedCount)") && userState.includes("sanitizePortfolioReviews"), "盘后复盘只能由真实已计价持仓生成，并使用有界脱敏 schema");

const failed = checks.filter((item) => !item.pass);
console.log(JSON.stringify({ version, reviewedAt: new Date().toISOString(), checks, result: failed.length ? "needs-attention" : "pass" }, null, 2));
if (failed.length) process.exitCode = 1;
