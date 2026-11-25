import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module.");
const { chromium, firefox } = require(process.env.PLAYWRIGHT_MODULE);
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "extension/manifest.json"), "utf8"));
const fixture = await readFile(join(root, "tests/fixture.html"), "utf8");
const modernFixture = await readFile(join(root, "tests/fixture-modern.html"), "utf8");
const octaneFixture = await readFile(join(root, "tests/fixture-octane.html"), "utf8");
const collector = await readFile(join(root, "extension/collector.js"), "utf8");
const diagnosticScript = await readFile(join(root, "extension/diagnostics.js"), "utf8");

async function testCollector(browserType) {
  const browser = await browserType.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const requests = [];
    await page.route("**/*", (route) => {
      requests.push(route.request().url());
      return route.fulfill({ contentType: "text/html", body: fixture });
    });
    await page.goto("https://chatgpt.com/c/test?secret=DO_NOT_EXPORT#private");
    // Reading session material or making any request during collection fails this test.
    await page.evaluate(() => {
      for (const name of ["localStorage", "sessionStorage"]) {
        Object.defineProperty(window, name, { get() { throw new Error(`Forbidden read: ${name}`); } });
      }
      Object.defineProperty(document, "cookie", { get() { throw new Error("Forbidden cookie read"); } });
      window.fetch = () => { throw new Error("Forbidden fetch"); };
      window.XMLHttpRequest = class { constructor() { throw new Error("Forbidden XHR"); } };
    });
    const before = requests.length;
    const originalDOM = await page.content();
    const result = await page.evaluate(collector);
    assert.equal(await page.content(), originalDOM, "Collector must not change page HTML");
    assert.equal(result.error, undefined);
    assert.equal(result.title, "Тестовый разговор");
    assert.equal(result.url, "https://chatgpt.com/c/test");
    assert.equal(result.messages.length, 2);
    assert.equal(result.capture.completeness, "not-guaranteed");
    assert.equal(result.messages[0].text, "Привет!\nВторая строка <script>alert(1)</script>");
    assert.ok(result.messages[0].markdown.includes("\\<script\\>"));
    const markdown = result.messages[1].markdown;
    assert.ok(markdown.includes('````js\nconst fence = "```";\n\n\nconsole.log(fence);\n````'));
    assert.ok(markdown.includes("``a`b``"));
    assert.ok(markdown.includes("3. Три\n6. Шесть"));
    assert.ok(markdown.includes("- Вложенный пункт"));
    assert.ok(markdown.includes("> Цитата"));
    assert.ok(markdown.includes("| Имя | Значение |\n| --- | --- |\n| a \\| b | `x\\|y` |"));
    assert.ok(markdown.includes("$x^2$"));
    assert.ok(markdown.includes("https://example.invalid/a%28b%29?x=1&y=2"));
    assert.ok(!markdown.includes("javascript:"));
    assert.ok(!markdown.includes("!["));
    assert.ok(!JSON.stringify(result).includes("NOT_A_MESSAGE"));
    assert.ok(!JSON.stringify(result).includes("DUPLICATE_FORMULA"));
    assert.equal(requests.length, before);

    await page.setContent(modernFixture);
    const modernDOM = await page.content();
    const modern = await page.evaluate(collector);
    assert.equal(await page.content(), modernDOM);
    assert.equal(modern.messages.length, 6);
    assert.deepEqual(modern.messages.map((message) => message.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);
    assert.equal(modern.messages[0].text, "Повторный вопрос\nВторая строка");
    assert.equal(modern.messages[0].text, modern.messages[2].text, "Identical turns must not be deduplicated by text");
    assert.ok(modern.messages[1].markdown.includes("Первый **ответ**."));
    assert.ok(modern.messages[1].markdown.includes("Вторая часть."));
    assert.ok(modern.messages[1].markdown.includes("```js\nconst value = 42;\n```"));
    assert.equal(modern.messages[5].text, "Ответ без роли.");
    assert.ok(!JSON.stringify(modern).includes("NOT_A_MESSAGE"));
    assert.ok(!JSON.stringify(modern).includes("private-"));
    // Diagnostics must work even when reading text, titles, or message IDs throws.
    await page.evaluate(() => {
      Object.defineProperty(Node.prototype, "textContent", { configurable: true, get() { throw new Error("Diagnostic read message text"); } });
      Object.defineProperty(document, "title", { configurable: true, get() { throw new Error("Diagnostic read title"); } });
      const original = Element.prototype.getAttribute;
      Element.prototype.getAttribute = function (name) {
        if (name !== "aria-hidden") throw new Error(`Diagnostic read attribute: ${name}`);
        return original.call(this, name);
      };
    });
    const diagnostic = await page.evaluate(diagnosticScript);
    assert.equal(diagnostic.counts.contentSearchUser.visible, 2); // Includes sidebar marker; scope is count-only.
    assert.equal(diagnostic.counts.contentSearchAssistant.total, 2);
    assert.equal(diagnostic.counts.contentSearchAssistant.visible, 1);
    assert.ok(!JSON.stringify(diagnostic).includes("private-"));
    assert.ok(!JSON.stringify(diagnostic).includes("Повторный вопрос"));
    // Restore a fresh document after installing privacy traps.
    await page.goto("https://chatgpt.com/c/test");

    await page.setContent(octaneFixture);
    const octane = await page.evaluate(collector);
    assert.equal(octane.messages.length, 2);
    assert.deepEqual(octane.messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(octane.messages[0].text, "Reply with exactly this text: EXPORT_NATIVE_FIREFOX_TEST_OK");
    assert.ok(octane.messages[1].markdown.includes("```javascript\nconst exportCheck = 42;\n```"));
    assert.ok(!JSON.stringify(octane).includes("NOT_A_MESSAGE"));
    await page.evaluate(() => { document.querySelector('[aria-busy]').setAttribute('aria-busy', 'true'); });
    assert.match((await page.evaluate(collector)).error, /ещё создаётся/);
    await page.goto("https://chatgpt.com/c/test");

    await page.evaluate(() => {
      const button = document.createElement("button");
      button.dataset.testid = "stop-button";
      document.querySelector("main").append(button);
    });
    assert.match((await page.evaluate(collector)).error, /ещё создаётся/);

    await page.goto("https://example.invalid/c/test");
    assert.match((await page.evaluate(collector)).error, /только на/);
    await page.goto("https://chatgpt.com/");
    await page.evaluate(() => { document.querySelector("main").replaceChildren(); });
    assert.match((await page.evaluate(collector)).error, /Сообщения не найдены/);
    console.log(`${browserType.name()}: all three DOM layouts, no duplicates or page mutations, formatting, diagnostics privacy, errors — passed`);
  } finally { await browser.close(); }
}

async function testChromeExtension() {
  const profile = await mkdtemp(join(tmpdir(), "chatgpt-export-test-"));
  const extensionPath = join(root, "dist/chrome");
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    acceptDownloads: true,
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto("chrome://extensions/");
    const extensionId = await page.waitForFunction((extensionName) => {
      const manager = document.querySelector("extensions-manager")?.shadowRoot;
      const list = manager?.querySelector("extensions-item-list")?.shadowRoot;
      return [...(list?.querySelectorAll("extensions-item") ?? [])]
        .find((item) => item.data?.name === extensionName)?.id;
    }, manifest.name).then((handle) => handle.jsonValue());
    const popup = await context.newPage();
    // UI-only API bridge; native Firefox integration tests exercise the real APIs.
    await popup.addInitScript(() => {
      const unsupported = location.search.includes('unsupported');
      let state = { state: 'idle' };
      const data = { title: 'Тест', url: 'https://chatgpt.com/c/test', exportedAt: '2026-11-24T10:00:00.000Z', warnings: [], messages: [{ role:'user', text:'Вопрос', markdown:'Вопрос' }] };
      chrome.tabs.query = async () => [{ id:1, url: unsupported ? 'https://chatgpt.com.evil.invalid/' : 'https://chatgpt.com/c/test' }];
      chrome.scripting.executeScript = async (details) => {
        if (unsupported) throw new Error('Must not inject into an unsupported origin');
        if (details.target.frameIds?.[0] !== 0 || (details.world && details.world !== 'MAIN')) throw new Error('Unexpected injection');
        if (details.files?.[0] === 'diagnostics.js') return [{ frameId:0, result:{ diagnosticVersion:1, counts:{} } }];
        if (details.files) return [{ frameId:0, result:state }];
        if (!details.args) return [{ frameId:0, result:'api' }];
        if (['api','scroll'].includes(details.args[0])) return [{ frameId:0, result:true }];
        const action = details.args[0];
        if (action === 'start') state = { state:'done', count:1, expected:1 };
        return [{ frameId:0, result: action === 'result' ? data : state }];
      };
    });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    assert.equal(await popup.locator('.brand').textContent(), 'Nanitnet');
    assert.equal(await popup.locator('#settings-view').isVisible(), false);
    const uiImages = join(root, 'test-results/popup');
    await mkdir(uiImages, { recursive: true });
    for (const theme of ['dark', 'light']) {
      await popup.locator('#settings-toggle').click();
      await popup.locator('#theme').selectOption(theme);
      await popup.locator('#settings-toggle').click();
      assert.equal(await popup.locator('html').getAttribute('data-theme'), theme);
      await popup.reload();
      assert.equal(await popup.locator('html').getAttribute('data-theme'), theme, 'Only the theme preference persists');
      await popup.evaluate(() => Promise.all([document.fonts.load('13px Inter', 'Markdown'), document.fonts.load('13px Inter', 'Экспорт')]));
      const ui = await popup.locator('#panel').evaluate(panel => ({
        width: panel.getBoundingClientRect().width,
        overflow: document.body.scrollWidth > document.body.clientWidth,
        fontLoaded: document.fonts.check('13px Inter'),
        foreground: getComputedStyle(document.querySelector('[data-format=markdown]')).color,
      }));
      assert.equal(ui.width, 360);
      assert.equal(ui.overflow, false);
      assert.equal(ui.fontLoaded, true);
      assert.equal(ui.foreground, theme === 'dark' ? 'rgb(224, 224, 224)' : 'rgb(26, 29, 30)');
      await popup.locator('#panel').screenshot({ path: join(uiImages, `nanitnet-${theme}.png`), scale: 'css' });
    }
    for (const format of ["markdown", "json"]) {
      const downloaded = popup.waitForEvent("download");
      await popup.locator(`[data-format="${format}"]`).click();
      const download = await downloaded;
      assert.equal(await download.failure(), null);
      const content = await readFile(await download.path(), "utf8");
      if (format === "json") assert.equal(JSON.parse(content).messages[0].text, "Вопрос");
      else assert.ok(content.includes("## Вы\n\nВопрос"));
      assert.match(download.suggestedFilename(), format === "json" ? /\.json$/ : /\.md$/);
      await popup.locator("button:disabled").waitFor({ state: "detached" });
    }
    await popup.locator("#settings-toggle").click();
    await popup.locator("#diagnose").click();
    await popup.locator("#diagnostic-panel").waitFor({ state: "visible" });
    const report = JSON.parse(await popup.locator("#diagnostic-output").inputValue());
    assert.equal(report.extensionVersion, manifest.version);
    assert.equal(report.diagnosticVersion, 1);
    assert.ok(!JSON.stringify(report).includes("Вопрос"));
    await popup.goto(`chrome-extension://${extensionId}/popup.html?unsupported`);
    await popup.locator('[data-format="json"]').click();
    await popup.locator('#status[data-error="true"]').waitFor();
    assert.match(await popup.locator("#status").textContent(), /Откройте переписку/);
    const networkBlocked = await popup.evaluate(async () => {
      try { await fetch("https://example.invalid/"); return false; } catch { return true; }
    });
    assert.equal(networkBlocked, true);
    console.log("Chromium extension: manifest load, popup, both actual downloads, diagnostic UI, exact origin check, CSP — passed");
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}

await testCollector(chromium);
await testCollector(firefox);
await testChromeExtension();
