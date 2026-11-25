import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const formatter = await readFile(new URL("../extension/api-format.js", import.meta.url), "utf8");
const jobSource = await readFile(new URL("../extension/api-job.js", import.meta.url), "utf8");
const id = "11111111-1111-4111-8111-111111111111";
const token = "TEST_SESSION_SECRET_DO_NOT_EXPORT";
const account = "TEST_ACCOUNT_ID_DO_NOT_EXPORT";

function fixture(count = 1000) {
  const mapping = { root: { parent: null, message: null } };
  for (let index = 0; index < count; index++) {
    mapping[`n${index}`] = { parent: index ? `n${index - 1}` : "root", message: {
      author: { role: index % 2 ? "assistant" : "user" }, status: "finished_successfully",
      content: { content_type: "text", parts: [index % 20 === 0 ? "Повторный вопрос" : `Сообщение ${index}\n\n\`\`\`js\nconst index = ${index};\n\`\`\``] },
      create_time: 1795540000 + index,
    }};
  }
  mapping.alternate = { parent: "root", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["ALTERNATIVE_BRANCH_MUST_NOT_EXPORT"] } } };
  return { title: "API test", current_node: `n${count - 1}`, mapping, internal_auth: "SERVER_INTERNAL_MUST_NOT_EXPORT" };
}

function context(fetch) {
  return vm.createContext({ location: { origin: "https://chatgpt.com", pathname: `/c/${id}` }, URL, AbortController,
    setTimeout, clearTimeout, fetch });
}
function parse(payload) {
  const env = context();
  vm.runInContext(formatter, env);
  return env.__chatgptLocalExportApiFormatV1(payload, `https://chatgpt.com/c/${id}`);
}
function json(data, status = 200, type = "application/json") {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => type }, json: async () => data };
}
async function run(fetch, afterStart) {
  const env = context(fetch);
  vm.runInContext(formatter, env);
  vm.runInContext(jobSource, env);
  const api = env.__chatgptLocalExportApiJobV1;
  api.command("start");
  afterStart?.(env, api);
  for (let count = 0; count < 100 && api.command("status").state === "running"; count++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.notEqual(api.command("status").state, "running");
  return { status: api.command("status"), result: api.command("result"), env, api };
}

test("1,000-message API tree: exact active branch, order, repeats, original Markdown; no DOM", () => {
  const data = fixture();
  const result = parse(data);
  assert.equal(result.messages.length, 1000);
  assert.equal(result.capture.completeness, "complete");
  assert.equal(result.capture.parentChainVerified, true);
  for (let index = 0; index < 1000; index++) {
    assert.equal(result.messages[index].role, index % 2 ? "assistant" : "user");
    assert.equal(result.messages[index].text, data.mapping[`n${index}`].message.content.parts[0]);
    assert.equal(result.messages[index].markdown, data.mapping[`n${index}`].message.content.parts[0]);
  }
  assert.ok(!JSON.stringify(result).includes("ALTERNATIVE_BRANCH"));
  assert.ok(!JSON.stringify(result).includes("SERVER_INTERNAL"));
});

test("broken ancestry, missing leaf, cycle and server pagination fail closed", () => {
  for (const mutate of [
    (data) => { delete data.mapping.n400; },
    (data) => { data.current_node = "not-present"; },
    (data) => { data.mapping.n3.parent = "n900"; },
    (data) => { delete data.mapping.root.parent; },
    (data) => { data.has_more = true; },
  ]) {
    const data = fixture(); mutate(data);
    assert.throws(() => parse(data), (error) => ["API_TREE_GAP", "API_TREE_CYCLE", "API_PARTIAL"].includes(error.apiCode));
  }
});

test("hidden analysis and tool messages excluded; images use placeholders", () => {
  const data = fixture(4);
  data.mapping.n1.message.channel = "analysis";
  data.mapping.n2.message.content.parts = ["Текст", { content_type: "image_asset_pointer", asset_pointer: "PRIVATE_ASSET_LINK" }];
  data.mapping.n3.message.content = { content_type: "code", text: 'const x = "```";', language: "js" };
  const result = parse(data);
  assert.equal(result.messages.length, 3);
  assert.equal(result.capture.attachmentPlaceholders, 1);
  assert.match(result.messages[1].text, /Изображение/);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_ASSET_LINK"));
  assert.ok(result.messages[2].markdown.startsWith("````js\n"));
});

test("1,000 visible messages survive context and channel-less thinking records", () => {
  const data = fixture();
  data.mapping.profile = { parent: "root", message: { author: { role: "user" }, content: {
    content_type: "user_editable_context", user_profile: token, user_instructions: account,
  }} };
  data.mapping.memory = { parent: "profile", message: { author: { role: "assistant" }, content: {
    content_type: "model_editable_context", model_set_context: token,
  }} };
  data.mapping.n0.parent = "memory";
  for (let index = 1; index < 1000; index += 2) {
    data.mapping[`thought${index}`] = { parent: `n${index - 1}`, message: { author: { role: "assistant" }, recipient: "all", channel: null,
      content: { content_type: "thoughts", thoughts: [{ summary: "PRIVATE_THINKING", content: "PRIVATE_THINKING" }] } } };
    data.mapping[`recap${index}`] = { parent: `thought${index}`, message: { author: { role: "assistant" }, recipient: "all", channel: null,
      content: { content_type: "reasoning_recap", content: "Thought for 16s" } } };
    data.mapping[`n${index}`].parent = `recap${index}`;
  }
  const result = parse(data);
  assert.equal(result.messages.length, 1000);
  assert.equal(result.capture.branchNodes, 2003);
  assert.equal(result.capture.hiddenNodes, 1002);
  assert.equal(result.capture.contentSummary.contentTypes.find((item) => item.type === "thoughts").count, 500);
  for (let index = 0; index < 1000; index++) assert.equal(result.messages[index].text, data.mapping[`n${index}`].message.content.parts[0]);
  for (const secret of [token, account, "PRIVATE_THINKING", "Thought for 16s"]) assert.ok(!JSON.stringify(result).includes(secret));
});

test("voice transcripts and media pointers preserve readable text and mark omitted assets", () => {
  const data = fixture(6);
  data.mapping.n0.message.content = { content_type: "multimodal_text", parts: [
    { content_type: "audio_transcription", text: "Распознанный вопрос" },
    { content_type: "real_time_user_audio_video_asset_pointer", audio_asset_pointer: { asset_pointer: token } },
  ] };
  data.mapping.n1.message.content = { content_type: "audio_asset_pointer", asset_pointer: token };
  data.mapping.n2.message.content = { content_type: "text_audio", text: { content_type: "text", text: "Голосовой ответ" } };
  data.mapping.n3.message.content = { content_type: "tether_browsing_display", result: "Доступный текст результата" };
  data.mapping.n4.message.content = { content_type: "text", parts: [{ type: "text", text: "Структурированный текст" }] };
  data.mapping.n5.message.metadata = { is_thinking_preamble_message: true };
  const result = parse(data);
  assert.equal(result.messages.length, 5);
  assert.match(result.messages[0].text, /^Распознанный вопрос\n\[Вложение/);
  assert.match(result.messages[1].text, /Аудио/);
  assert.equal(result.messages[2].text, "Голосовой ответ");
  assert.equal(result.messages[3].text, "Доступный текст результата");
  assert.equal(result.messages[4].text, "Структурированный текст");
  assert.equal(result.capture.attachmentPlaceholders, 2);
  assert.ok(!JSON.stringify(result).includes(token));
});

test("HTTP 200 unsupported parts fail closed with structural diagnostics, never raw values or keys", async () => {
  const data = fixture();
  data.mapping.n500.message.content = { content_type: "multimodal_text", parts: [
    { content_type: token, text: { private: account }, asset_pointer: token, [account]: token },
  ] };
  const { status, result } = await run(async (url) => new URL(url).pathname === "/api/auth/session" ? json({ accessToken: token }) : json(data));
  assert.equal(status.state, "error");
  assert.equal(status.errorCode, "API_CONTENT");
  assert.deepEqual(Array.from(status.diagnostics, (item) => item.status), [200, 200]);
  assert.equal(status.contentDiagnostic.parsedMessages, 500);
  assert.equal(status.contentDiagnostic.unsupported.location, "part");
  assert.equal(status.contentDiagnostic.unsupported.type, "unrecognized");
  assert.equal(status.contentDiagnostic.unsupported.otherFieldCount, 1);
  assert.equal(status.contentDiagnostic.unsupported.fields.find((item) => item.name === "text").valueType, "object");
  assert.ok(result.error);
  assert.equal(result.messages, undefined);
  for (const secret of [token, account, "Сообщение"]) assert.ok(!JSON.stringify(status).includes(secret));
  for (const content of [null, { content_type: token, [account]: token }, { content_type: "text", parts: [null] }]) {
    const broken = fixture(1); broken.mapping.n0.message.content = content;
    assert.throws(() => parse(broken), (error) => error.apiCode === "API_CONTENT" && !JSON.stringify(error.apiDiagnostic).includes(token) && !JSON.stringify(error.apiDiagnostic).includes(account));
  }
});

test("only fixed same-origin GETs; auth token/account never in output or globals", async () => {
  const calls = [];
  const result = await run(async (url, options) => {
    calls.push({ url, options });
    assert.equal(new URL(url).origin, "https://chatgpt.com");
    assert.equal(options.method, "GET");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.redirect, "error");
    if (new URL(url).pathname === "/api/auth/session") return json({ accessToken: token, account: { id: account }, user: { email: "PRIVATE_EMAIL" } });
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.headers["ChatGPT-Account-ID"], account);
    return json(fixture());
  });
  assert.equal(calls.length, 2);
  assert.equal(result.status.state, "done");
  assert.equal(result.result.messages.length, 1000);
  for (const value of [token, account, "PRIVATE_EMAIL"]) {
    assert.ok(!JSON.stringify(result.status).includes(value));
    assert.ok(!JSON.stringify(result.result).includes(value));
    assert.ok(!Object.values(result.env).includes(value));
  }
  result.api.command("start");
  assert.equal(calls.length, 2, "Cached snapshot does not send another request");
});

test("session fallback and exactly one refresh after HTTP 401", async () => {
  let conversationCalls = 0;
  let refreshCalls = 0;
  const result = await run(async (url) => {
    const address = new URL(url);
    if (address.pathname === "/api/auth/session" && !address.search) return json({});
    if (address.pathname === "/unauth-mweb/auth/session/read-only") return json({ accessToken: token });
    if (address.pathname === "/api/auth/session" && address.search === "?refresh=true") { refreshCalls++; return json({ accessToken: `${token}_REFRESHED` }); }
    conversationCalls++;
    return conversationCalls === 1 ? json(null, 401) : json(fixture(2));
  });
  assert.equal(result.status.state, "done");
  assert.equal(conversationCalls, 2);
  assert.equal(refreshCalls, 1);
});

test("signed out, HTTP failures, unknown schema and reflected errors never export credentials", async () => {
  const cases = [
    [() => json({}), "API_LOGIN"],
    [(url) => new URL(url).pathname === "/api/auth/session" ? json({ accessToken: token }) : json({ error: token }, 403), "API_FORBIDDEN"],
    [(url) => new URL(url).pathname === "/api/auth/session" ? json({ accessToken: token }) : json({ error: token }, 429), "API_RATE_LIMIT"],
    [(url) => new URL(url).pathname === "/api/auth/session" ? json({ accessToken: token }) : json({ accessToken: token }), "API_SCHEMA"],
    [() => { const error = new Error(token); error.apiCode = "LEAK"; throw error; }, "API_NETWORK"],
  ];
  for (const [fetch, code] of cases) {
    const result = await run(fetch);
    assert.equal(result.status.state, "error");
    assert.equal(result.status.errorCode, code);
    assert.ok(result.result.error);
    assert.ok(!JSON.stringify(result.status).includes(token));
    assert.ok(!JSON.stringify(result.result).includes(token));
  }
});

test("cancellation and SPA route changes discard the result", async () => {
  const pendingFetch = (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error(token)), { once: true }));
  const cancelled = await run(pendingFetch, (_env, api) => api.command("cancel"));
  assert.equal(cancelled.status.errorCode, "API_CANCELLED");
  const moved = await run(async () => json({ accessToken: token }), (env) => { env.location.pathname = "/c/different"; });
  assert.ok(moved.result.error);
  assert.ok(!JSON.stringify(moved.result).includes(token));
});
