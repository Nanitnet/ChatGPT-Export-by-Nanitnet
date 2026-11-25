import test from "node:test";
import assert from "node:assert/strict";
import { createFilename, toMarkdown } from "../extension/format.js";

const conversation = {
  title: "Тест / история",
  url: "https://chatgpt.com/c/test",
  exportedAt: "2026-11-24T10:00:00.000Z",
  warnings: ["Только загруженные сообщения."],
  messages: [
    { role: "user", markdown: "Вопрос" },
    { role: "assistant", markdown: "```js\nconst x = 1;\n\n\nconsole.log(x);\n```" },
  ],
};

test("Markdown keeps message order, role boundaries, warnings, and blank lines in code", () => {
  const output = toMarkdown(conversation);
  assert.ok(output.indexOf("## Вы") < output.indexOf("## ChatGPT"));
  assert.ok(output.includes("> Только загруженные сообщения."));
  assert.ok(output.includes(conversation.messages[1].markdown));
  assert.ok(output.endsWith("\n"));
});

test("title cannot inject Markdown image markup or another heading", () => {
  const output = toMarkdown({ ...conversation, title: "![x](https://example.invalid)\n# test" });
  assert.ok(output.startsWith("# !\\[x\\](https://example.invalid) \\# test\n"));
});

test("filenames remove path separators, controls and bidi marks; fit filesystem limits", () => {
  const filename = createFilename({ ...conversation, title: "../bad\\name:*?\u0000\u202e" }, "md");
  assert.ok(!/[<>:"/\\|?*\u0000\u202e]/.test(filename));
  assert.ok(!filename.includes(".."));
  assert.equal(createFilename({ ...conversation, title: "... " }, "json"), "chatgpt-ChatGPT-2026-11-24.json");
  const long = createFilename({ ...conversation, title: "🌍".repeat(100) }, "json");
  assert.ok(Buffer.byteLength(long) < 255);
});
