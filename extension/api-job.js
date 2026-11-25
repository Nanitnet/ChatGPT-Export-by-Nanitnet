// Runs in MAIN on chatgpt.com so requests use the page's own same-origin session.
// Secrets are local variables only; neither status nor result contains session
// JSON, tokens, request headers, account IDs, cookies or raw error responses.
(() => {
  "use strict";
  if (location.origin !== "https://chatgpt.com") return { error: "Откройте чат на https://chatgpt.com." };
  if (globalThis.__chatgptLocalExportApiJobV1) return globalThis.__chatgptLocalExportApiJobV1.command("status");
  let job = null;
  const route = () => `${location.origin}${location.pathname}`;
  const messages = {
    API_LOGIN: "Не удалось получить авторизацию ChatGPT. Войдите в аккаунт, обновите чат и повторите экспорт.",
    API_NETWORK: "Запрос API не прошёл: сеть, CSP или запрещённый переход на другой адрес. Обновите страницу и повторите.",
    API_TIMEOUT: "API не ответил за 20 секунд. Повторите экспорт позже.",
    API_CANCELLED: "Экспорт через API отменён.",
    API_CHANGED: "Открытая переписка изменилась. Начните экспорт нужного чата заново.",
  };
  class ApiFailure extends Error {
    constructor(code, message) { super(message); this.apiCode = code; }
  }
  const parserErrors = {
    API_SCHEMA: "Сервер вернул неизвестную структуру переписки. Файл не сохранён.",
    API_PARTIAL: "Ответ API помечен как неполный. Файл не сохранён.",
    API_TREE_CYCLE: "Нарушены связи дерева сообщений. Файл не сохранён.",
    API_TREE_GAP: "В ответе API отсутствует часть текущей ветки. Файл не сохранён.",
    API_CONTENT: "Неподдерживаемое содержимое сообщения. Экспорт остановлен, чтобы не пропустить текст.",
    API_GENERATING: "Ответ ещё создаётся. Дождитесь окончания и повторите экспорт.",
    API_EMPTY: "API не вернул сообщения пользователя и ChatGPT. Файл не сохранён.",
  };
  function fail(code, message) { throw new ApiFailure(code, message ?? messages[code]); }
  function check(current) {
    if (current.url !== route()) fail("API_CHANGED");
    if (current.cancelled) fail("API_CANCELLED");
  }
  function status() {
    if (!job || (job.url !== route() && job.state !== "running")) return { state: "idle", mode: "api", diagnostics: [] };
    return { state: job.state, mode: "api", phase: job.phase, count: job.count, expected: job.count,
      error: job.error, errorCode: job.errorCode, elapsedSeconds: Math.floor((Date.now() - job.started) / 1000),
      diagnostics: job.diagnostics.map((item) => ({ ...item })), contentDiagnostic: job.contentDiagnostic ?? null };
  }
  async function getJson(current, path, stage, headers = {}) {
    check(current);
    const target = new URL(path, "https://chatgpt.com");
    if (target.origin !== "https://chatgpt.com" || target.username || target.password || target.hash) fail("API_PATH", "Недопустимый адрес API.");
    const request = new AbortController();
    let timedOut = false;
    const cancel = () => request.abort();
    current.abort.signal.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(() => { timedOut = true; request.abort(); }, 20_000);
    try {
      const response = await fetch(target.href, { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
        headers: { Accept: "application/json", ...headers }, signal: request.signal });
      check(current);
      const contentType = response.headers.get("content-type") ?? "";
      const kind = /(?:application\/json|\+json)/i.test(contentType) ? "json" : /text\/html/i.test(contentType) ? "html" : "other";
      current.diagnostics.push({ stage, status: Number.isInteger(response.status) && response.status <= 599 ? response.status : 0, kind });
      if (response.status === 429) fail("API_RATE_LIMIT", "API ограничил частоту запросов (HTTP 429). Подождите и повторите.");
      if (!response.ok) return { status: response.status, data: null };
      if (kind !== "json") return { status: response.status, data: null };
      let data;
      try { data = await response.json(); }
      catch {
        check(current);
        if (timedOut) fail("API_TIMEOUT");
        fail("API_JSON", "API вернул некорректный JSON. Файл не сохранён.");
      }
      check(current);
      return { status: response.status, data };
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      check(current);
      fail(timedOut ? "API_TIMEOUT" : "API_NETWORK");
    } finally {
      clearTimeout(timeout);
      current.abort.signal.removeEventListener("abort", cancel);
    }
  }
  async function session(current, refresh = false) {
    const paths = refresh ? ["/api/auth/session?refresh=true", "/unauth-mweb/auth/session/read-only"]
      : ["/api/auth/session", "/unauth-mweb/auth/session/read-only"];
    for (let index = 0; index < paths.length; index++) {
      const headers = index === 1 ? { "X-OAI-Client-Session-Identity-Version": "2" } : {};
      const response = await getJson(current, paths[index], index === 0 ? "session" : "session-fallback", headers);
      const data = response.data;
      const token = typeof data?.accessToken === "string" ? data.accessToken : data?.access_token;
      if (typeof token === "string" && token.length <= 16384 && /^[A-Za-z0-9._~+\/-]+={0,2}$/.test(token)) {
        const account = data?.account?.id;
        return { token, account: typeof account === "string" && account.length <= 128 ? account : null };
      }
    }
    fail("API_LOGIN");
  }
  async function collect(current) {
    let credentials = null;
    try {
      const match = location.pathname.match(/\/(?:c|uc)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/i);
      if (!match) fail("API_CHAT_ID", "Откройте сохранённую переписку: в адресе должен быть /c/ и ID чата.");
      current.phase = "Получаю авторизацию";
      credentials = await session(current);
      let response;
      for (let attempt = 0; attempt < 2; attempt++) {
        current.phase = "Получаю переписку с сервера";
        const headers = { Authorization: `Bearer ${credentials.token}` };
        if (credentials.account) headers["ChatGPT-Account-ID"] = encodeURIComponent(credentials.account);
        response = await getJson(current, `/backend-api/conversation/${encodeURIComponent(match[1])}`, "conversation", headers);
        if (response.status !== 401 || attempt === 1) break;
        credentials = null;
        current.phase = "Обновляю авторизацию";
        credentials = await session(current, true);
      }
      credentials = null;
      if (response.status === 401) fail("API_UNAUTHORIZED", "API не принял авторизацию (HTTP 401). Войдите в ChatGPT заново.");
      if (response.status === 403) fail("API_FORBIDDEN", "API отказал в доступе (HTTP 403). Проверьте вход и доступ к чату.");
      if (response.status === 404) fail("API_NOT_FOUND", "API не нашёл чат (HTTP 404). Проверьте выбранный аккаунт и рабочее пространство.");
      if (response.status < 200 || response.status >= 300) fail("API_HTTP", `API вернул HTTP ${response.status}. Файл не сохранён.`);
      if (!response.data) fail("API_JSON", "API вернул страницу вместо JSON. Обновите ChatGPT и повторите.");
      check(current);
      current.phase = "Проверяю целостность переписки";
      const convert = globalThis.__chatgptLocalExportApiFormatV1;
      if (typeof convert !== "function") fail("API_PARSER", "Перезапустите окно расширения: преобразователь API не загружен.");
      current.result = convert(response.data, current.url);
      current.contentDiagnostic = current.result.capture.contentSummary;
      check(current);
      current.count = current.result.messages.length;
      current.phase = "Готово";
      current.state = "done";
    } catch (error) {
      current.result = null;
      current.state = "error";
      const parserMessage = typeof error?.apiCode === "string" && Object.hasOwn(parserErrors, error.apiCode) ? parserErrors[error.apiCode] : null;
      current.contentDiagnostic = parserMessage ? error.apiDiagnostic ?? null : null;
      current.errorCode = error instanceof ApiFailure || parserMessage ? error.apiCode : "API_INTERNAL";
      const message = error instanceof ApiFailure ? error.message : parserMessage ?? "Не удалось обработать ответ. Файл не сохранён.";
      current.error = `${current.errorCode}: ${message}`;
      current.phase = "Отменено";
    } finally { credentials = null; }
  }
  const controller = { command(action, options = {}) {
    if (action === "status") return status();
    if (action === "cancel") { if (job?.state === "running") { job.cancelled = true; job.abort.abort(); } return status(); }
    if (action === "result") {
      if (job?.url !== route()) return { error: messages.API_CHANGED };
      return job?.result ?? { error: "Результат API ещё не готов." };
    }
    if (action === "start") {
      if (job?.state === "running") return status();
      if (job?.state === "done" && job.url === route() && !options.force) return status();
      job = { url: route(), state: "running", phase: "Начинаю запрос API", count: 0, started: Date.now(), cancelled: false,
        result: null, abort: new AbortController(), diagnostics: [] };
      job.promise = collect(job);
      return status();
    }
    return { error: "Неизвестная команда API." };
  }};
  globalThis.__chatgptLocalExportApiJobV1 = controller;
  return status();
})();
