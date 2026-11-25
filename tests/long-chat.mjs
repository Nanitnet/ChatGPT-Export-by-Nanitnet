import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, firefox } = require(process.env.PLAYWRIGHT_MODULE);
const fixture = await readFile(new URL("fixture-large.html", import.meta.url), "utf8");
const collector = await readFile(new URL("../extension/collector.js", import.meta.url), "utf8");
const runner = await readFile(new URL("../extension/job.js", import.meta.url), "utf8");
const reports = [];

for (const type of [chromium, firefox].filter((type) => !process.env.LONG_CHAT_BROWSER || type.name() === process.env.LONG_CHAT_BROWSER)) {
  const browser = await type.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: fixture }));
    for (const mode of ["recycle", "shells"].filter((mode) => !process.env.LONG_CHAT_MODE || mode === process.env.LONG_CHAT_MODE)) {
      await page.goto(`https://chatgpt.com/c/large?count=1000&mode=${mode}`);
      await page.evaluate(collector);
      await page.evaluate(runner);
      const started = Date.now();
      await page.evaluate(() => globalThis.__chatgptLocalExportJobV1.command("start"));
      await page.waitForFunction(() => globalThis.__chatgptLocalExportJobV1.command("status").state !== "running", null, { timeout: 240_000 });
      const state = await page.evaluate(() => globalThis.__chatgptLocalExportJobV1.command("status"));
      const result = await page.evaluate(() => globalThis.__chatgptLocalExportJobV1.command("result"));
      assert.equal(state.state, "done", JSON.stringify(state));
      assert.equal(result.capture.completeness, "complete");
      assert.equal(result.messages.length, 1000);
      assert.equal(result.capture.missingBlocks, 0);
      for (let index = 0; index < 1000; index++) {
        const message = result.messages[index];
        assert.equal(message.role, index % 2 ? "assistant" : "user");
        let expected = index % 20 === 0 ? "Повторяющийся вопрос" : (`Сообщение ${String(index).padStart(4, '0')}: ` + 'длинная проверочная переписка '.repeat(12)).trim();
        let markdown = expected;
        if (index % 10 === 1) {
          const code = `const messageIndex = ${index};\n\nconsole.log(messageIndex);`;
          expected += `\n\n${code}`; markdown += `\n\n\`\`\`js\n${code}\n\`\`\``;
        }
        assert.equal(message.text, expected, `Wrong or truncated body at ${index}`);
        assert.equal(message.markdown, markdown, `Wrong Markdown body at ${index}`);
      }
      const stats = await page.evaluate(() => ({ ...window.__fixtureStats, bottomGap: document.querySelector('#scroll').scrollHeight - document.querySelector('#scroll').clientHeight - document.querySelector('#scroll').scrollTop }));
      assert.ok(stats.maxHydrated <= 11);
      assert.ok(stats.bottomGap < 2);
      if (mode === "recycle") assert.equal(stats.paginationLoads, 8);
      const report = { browser: type.name(), mode, messages: result.messages.length, seconds: (Date.now() - started) / 1000, stats };
      reports.push(report);
      console.log("PASS", JSON.stringify(report));
    }
    // A real hole must never be reported as a complete export.
    await page.goto("https://chatgpt.com/c/large?count=80&mode=shells&missing=35");
    await page.evaluate(collector); await page.evaluate(runner);
    await page.evaluate(() => globalThis.__chatgptLocalExportJobV1.command("start"));
    await page.waitForFunction(() => globalThis.__chatgptLocalExportJobV1.command("status").state !== "running", null, { timeout: 40_000 });
    const partial = await page.evaluate(() => globalThis.__chatgptLocalExportJobV1.command("result"));
    assert.equal(partial.capture.completeness, "incomplete");
    assert.equal(partial.messages.length, 79);
    assert.equal(partial.capture.missingBlocks, 1);
    assert.match(partial.warnings[0], /Неполный экспорт/);
    // Cancellation and route changes stop work and must not claim completeness.
    await page.goto("https://chatgpt.com/c/large?count=1000&mode=recycle");
    await page.evaluate(collector); await page.evaluate(runner);
    await page.evaluate(() => { globalThis.__chatgptLocalExportJobV1.command("start"); globalThis.__chatgptLocalExportJobV1.command("cancel"); });
    await page.waitForFunction(() => globalThis.__chatgptLocalExportJobV1.command("status").state !== "running");
    assert.equal((await page.evaluate(() => globalThis.__chatgptLocalExportJobV1.command("result"))).capture.completeness, "incomplete");
    await page.evaluate(() => { globalThis.__chatgptLocalExportJobV1.command("start", {force:true}); history.pushState({}, '', '/c/different'); });
    await page.waitForTimeout(300);
    assert.ok((await page.evaluate(() => globalThis.__chatgptLocalExportJobV1.command("result"))).error);
    console.log(`${type.name()}: missing message detection, cancellation, SPA navigation — passed`);
  } finally { await browser.close(); }
}
await mkdir(new URL("../test-results/long-chat/", import.meta.url), { recursive: true });
await writeFile(new URL("../test-results/long-chat/report.json", import.meta.url), JSON.stringify({ passed: true, reports }, null, 2));
