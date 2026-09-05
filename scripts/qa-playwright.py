import asyncio
import json
import os
import re
from pathlib import Path

from playwright.async_api import expect, async_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / ".qa"
TARGET_URL = os.environ.get("FOLIOMIND_QA_URL", "http://127.0.0.1:4173")
CHROMIUM_CANDIDATES = (
    "/home/alex/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome",
    "/home/alex/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell",
    "/home/alex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
    "/home/alex/.local/chrome-linux64/chrome",
)


def chromium_executable() -> str:
    candidates = (os.environ.get("FOLIOMIND_CHROMIUM"), *CHROMIUM_CANDIDATES)
    if executable := next((path for path in candidates if path and Path(path).is_file()), None):
        return executable
    raise FileNotFoundError("找不到 Chromium；请通过 FOLIOMIND_CHROMIUM 指定可执行文件")


async def main() -> None:
    OUTPUT.mkdir(exist_ok=True)
    console_errors: list[str] = []
    expected_console_errors: list[str] = []
    page_errors: list[str] = []
    checks: list[dict[str, object]] = []

    viewport = {"width": 1487, "height": 1058}
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, executable_path=chromium_executable())
        context = await browser.new_context(viewport=viewport, device_scale_factor=1)
        page = await context.new_page()
        page.set_default_timeout(6_000)
        def capture_console(message) -> None:
            if message.type != "error":
                return
            # A no-credential QA run intentionally exercises the real-data
            # empty/error states. Chromium reports the Host's honest upstream
            # 502 as a console resource error; keep it visible in the report
            # without treating it as a frontend crash.
            if "Failed to load resource" in message.text and "502" in message.text:
                expected_console_errors.append(message.text)
            else:
                console_errors.append(message.text)

        page.on("console", capture_console)
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        await page.goto(TARGET_URL, wait_until="networkidle")
        await expect(page.locator('.app-shell[data-user-state-loaded="true"]')).to_be_visible(timeout=15_000)
        await page.screenshot(path=OUTPUT / "implementation-primary-final.png")

        async def click_and_capture(label: str, filename: str, expected: str) -> None:
            await page.get_by_role("button", name=label, exact=True).click()
            await page.get_by_text(expected, exact=True).first.wait_for()
            await page.screenshot(path=OUTPUT / filename)
            checks.append({"flow": label, "passed": True})

        await click_and_capture("行情", "implementation-market.png", "市场行情")
        await click_and_capture("筛选", "implementation-research.png", "研究筛选")
        research_state = page.locator(".research-page .data-state").first
        research_result = page.locator(".research-page .research-table").first
        if await research_state.count():
            await expect(research_state).to_contain_text(re.compile("连接真实数据后开始|正在获取真实行情|尚无可用行情|暂时无法获取行情|部分行情暂未更新"))
        if await research_result.count():
            await expect(research_result).to_be_visible()
        checks.append({"flow": "真实数据筛选状态", "passed": True})
        await click_and_capture("组合", "implementation-portfolio.png", "风险洞察")
        await expect(page.get_by_role("button", name="添加持仓", exact=True)).to_be_visible()
        checks.append({"flow": "组合工作区可用", "passed": True})
        await click_and_capture("盯盘", "implementation-monitor.png", "个股盯盘")
        new_monitor = page.get_by_role("button", name="新建盯盘")
        if await new_monitor.is_disabled():
            await expect(page.get_by_text("请先配置数据凭据、同步模型并保存，盯盘只接受真实数据。", exact=True)).to_be_visible()
            checks.append({"flow": "未配置时安全禁用盯盘", "passed": True})
        else:
            await new_monitor.click()
            await page.get_by_text("触发条件", exact=True).wait_for()
            await expect(page.get_by_label("触发方式")).to_be_visible()
            await expect(page.get_by_label("盯盘有效期")).to_be_visible()
            # Close the modal before navigating to another workspace so its
            # backdrop cannot intercept the next interaction.
            await page.locator(".condition-modal button[aria-label='关闭']").click()
            checks.append({"flow": "未配置时可安全保存盯盘条件", "passed": True})
        await expect(page.get_by_label("搜索盯盘规则")).to_be_visible()
        await expect(page.get_by_label("盯盘规则状态")).to_be_visible()
        await expect(page.get_by_label("盯盘规则排序")).to_be_visible()
        checks.append({"flow": "盯盘规则管理控件可用", "passed": True})

        await click_and_capture("技能", "implementation-skills.png", "Skill 市场")
        skill_card = page.locator(".skill-grid article").filter(has_text="公告与舆情").first
        # The Host state is canonical, but a cold page can briefly render the
        # built-in Skill list while hydration completes. Retry the idempotent
        # install action once if that initial render wins the race.
        for attempt in range(2):
            installed_button = skill_card.get_by_role("button", name="已安装")
            if await installed_button.count():
                break
            install_button = skill_card.get_by_role("button", name="安装")
            if not await install_button.count():
                break
            await install_button.click()
            try:
                await expect(installed_button).to_be_visible(timeout=8_000)
                break
            except AssertionError:
                if attempt == 1:
                    raise
                await page.wait_for_timeout(500)
        await expect(skill_card.get_by_role("button", name="已安装")).to_be_visible(timeout=15_000)
        checks.append({"flow": "安装 Skill", "passed": True})

        await click_and_capture("设置", "implementation-settings.png", "数据与模型凭证")
        await expect(page.get_by_label("Gateway Base URL")).to_have_value("https://aigateway.qveris.ai/v1")
        credential_card = page.locator(".settings-card").filter(has_text="数据与模型凭证").first
        await expect(credential_card).to_contain_text(re.compile("未配置|已配置"))
        checks.append({"flow": "真实数据与模型设置", "passed": True})

        await click_and_capture("对话", "implementation-chat.png", "分析摘要")
        # The placeholder intentionally changes while live data or Pi is busy;
        # use the stable accessible label so the QA flow does not race a
        # transient status message.
        composer = page.get_by_label("分析问题")
        await expect(composer).to_be_visible()
        if await composer.is_enabled():
            await composer.fill("分析贵州茅台近期风险")
            send_button = page.locator(".send-button").first
            if await send_button.is_enabled():
                await composer.press("Enter")
                await page.get_by_text("分析贵州茅台近期风险", exact=True).wait_for()
                checks.append({"flow": "发送对话", "passed": True})
            else:
                checks.append({"flow": "模型未就绪时安全阻止对话", "passed": True})
        else:
            await expect(composer).to_be_visible()
            checks.append({"flow": "模型未就绪时安全阻止对话", "passed": True})

        await page.get_by_role("button", name="自选", exact=True).click()
        rows = page.locator(".watch-row-main")
        await expect(rows.first).to_be_visible()
        first_name = await rows.nth(0).locator("strong").first.inner_text()
        await rows.nth(0).click()
        stock_heading = page.locator(".stock-header h1").first
        await expect(stock_heading).to_contain_text(first_name)
        if await rows.count() > 1:
            second_name = await rows.nth(1).locator("strong").first.inner_text()
            await rows.nth(1).click()
            await expect(stock_heading).to_contain_text(second_name)
            checks.append({"flow": "切换自选股", "passed": True})
            await rows.nth(0).click()
            await expect(stock_heading).to_contain_text(first_name)
        else:
            checks.append({"flow": "单一自选股工作区可用", "passed": True})
        await page.reload(wait_until="networkidle")
        await page.screenshot(path=OUTPUT / "implementation-primary-final.png")
        layout = await page.evaluate("""() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          scrollHeight: document.documentElement.scrollHeight,
          clientHeight: document.documentElement.clientHeight,
          columns: getComputedStyle(document.querySelector('.app-shell')).gridTemplateColumns,
        })""")
        checks.append({"flow": "视口无溢出", "passed": layout["scrollWidth"] == layout["clientWidth"] and layout["scrollHeight"] == layout["clientHeight"], "detail": layout})
        await page.set_viewport_size({"width": 390, "height": 844})
        await page.reload(wait_until="networkidle")
        mobile_layout = await page.evaluate("""() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        })""")
        checks.append({"flow": "移动端视口无横向溢出", "passed": mobile_layout["scrollWidth"] == mobile_layout["clientWidth"], "detail": mobile_layout})
        mobile_controls = await page.evaluate("""() => {
          const selectors = [
            '.stock-header-actions .live-data-button',
            '.stock-header-actions .agent-data-button',
            '.stock-header-actions .stock-bookmark',
            '.stock-header-actions .stock-more-button',
          ];
          const viewport = document.documentElement.clientWidth;
          const controls = selectors.map((selector) => {
            const element = document.querySelector(selector);
            if (!element) return { selector, present: false, visible: false };
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const visible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
            return { selector, present: true, visible, left: Math.round(rect.left), right: Math.round(rect.right) };
          });
          return { controls, allVisibleWithinViewport: controls.filter((item) => item.visible).every((item) => item.left >= 0 && item.right <= viewport) };
        }""")
        checks.append({"flow": "移动端标的操作完整可见", "passed": mobile_controls["allVisibleWithinViewport"], "detail": mobile_controls})
        mobile_portfolio_controls = await page.evaluate("""() => {
          const controls = [...document.querySelectorAll('.portfolio-actions .icon-button')].map((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const visible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
            return { label: element.getAttribute('aria-label') || element.textContent.trim(), visible, left: Math.round(rect.left), right: Math.round(rect.right) };
          });
          const viewport = document.documentElement.clientWidth;
          return { controls, allVisibleWithinViewport: controls.filter((item) => item.visible).every((item) => item.left >= 0 && item.right <= viewport) };
        }""")
        checks.append({"flow": "移动端组合操作完整可见", "passed": mobile_portfolio_controls["allVisibleWithinViewport"], "detail": mobile_portfolio_controls})
        await page.screenshot(path=OUTPUT / "implementation-mobile-final.png")
        await browser.close()

    report = {
        "url": TARGET_URL,
        "viewport": {**viewport, "deviceScaleFactor": 1},
        "checks": checks,
        "consoleErrors": console_errors,
        "expectedConsoleErrors": expected_console_errors,
        "pageErrors": page_errors,
    }
    (OUTPUT / "playwright-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    failed_checks = [check["flow"] for check in checks if not check["passed"]]
    if failed_checks or console_errors or page_errors:
        raise SystemExit(
            f"Playwright QA failed: checks={failed_checks}, "
            f"consoleErrors={len(console_errors)}, expectedConsoleErrors={len(expected_console_errors)}, pageErrors={len(page_errors)}"
        )


if __name__ == "__main__":
    asyncio.run(main())
