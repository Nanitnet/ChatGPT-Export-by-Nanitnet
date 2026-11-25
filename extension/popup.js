import { createFilename, toMarkdown } from "./format.js";

const api = globalThis.browser ?? globalThis.chrome;
const status = document.querySelector("#status");
const exportButtons = [...document.querySelectorAll("button[data-format]")];
const modeControl = document.querySelector("#mode");
const panel = document.querySelector("#panel");
const themeControl = document.querySelector("#theme");
const settingsToggle = document.querySelector("#settings-toggle");
const systemTheme = matchMedia("(prefers-color-scheme: dark)");
const loadedModes = new Map();
let viewVersion = 0;
let tabId;
let pendingFormat = null;
let preferredFormat = "json";
let timer;

function showStatus(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
}

function applyTheme() {
  document.documentElement.dataset.theme = themeControl.value === "system" ? (systemTheme.matches ? "dark" : "light") : themeControl.value;
}
try {
  const theme = localStorage.getItem("nanitnet-export-theme");
  if (["system", "light", "dark"].includes(theme)) themeControl.value = theme;
} catch { /* Theme remains usable when extension storage is unavailable. */ }
applyTheme();
themeControl.addEventListener("change", () => {
  applyTheme();
  try { localStorage.setItem("nanitnet-export-theme", themeControl.value); } catch { /* Optional preference only. */ }
});
systemTheme.addEventListener("change", applyTheme);

function settings(open) {
  document.querySelector("#settings-view").hidden = !open;
  document.querySelector("#export-view").hidden = open;
  document.querySelector("#settings-icon").toggleAttribute("hidden", open);
  document.querySelector("#back-icon").toggleAttribute("hidden", !open);
  panel.dataset.view = open ? "settings" : "export";
  document.querySelector("#view-title").textContent = open ? "Настройки" : "Экспорт чата";
  settingsToggle.setAttribute("aria-expanded", String(open));
  settingsToggle.setAttribute("aria-label", open ? "Назад" : "Настройки");
  settingsToggle.title = open ? "Назад" : "Настройки";
}
settingsToggle.addEventListener("click", () => settings(document.querySelector("#settings-view").hidden));
addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !document.querySelector("#settings-view").hidden) {
    event.preventDefault();
    event.stopPropagation();
    settings(false);
    settingsToggle.focus();
  }
});

function messageCount(count) {
  const last = count % 10, two = count % 100;
  const noun = two >= 11 && two <= 14 ? "сообщений" : last === 1 ? "сообщение" : last >= 2 && last <= 4 ? "сообщения" : "сообщений";
  return `${new Intl.NumberFormat("ru-RU").format(count)} ${noun}`;
}

async function execute(details) {
  const results = await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, ...details });
  const frame = results.find((item) => item.frameId === 0);
  if (frame?.error) throw new Error(frame.error.message || String(frame.error));
  if (!frame?.result) throw new Error("Не удалось прочитать страницу. Откройте расширение заново.");
  if (frame.result.error && !frame.result.state) throw new Error(frame.result.error);
  return frame.result;
}

async function loadMode(mode) {
  await connected;
  if (!loadedModes.has(mode)) {
    const loading = mode === "api"
      ? execute({ files: ["api-format.js", "api-job.js"], world: "MAIN" })
      : execute({ files: ["collector.js", "job.js"] });
    loadedModes.set(mode, loading);
    loading.catch(() => loadedModes.delete(mode));
  }
  return loadedModes.get(mode);
}

async function command(action, options = {}, mode = modeControl.value) {
  await loadMode(mode);
  const key = mode === "api" ? "__chatgptLocalExportApiJobV1" : "__chatgptLocalExportJobV1";
  return execute({
    ...(mode === "api" ? { world: "MAIN" } : {}),
    func: (action, options, key) => globalThis[key]?.command(action, options) ?? { error: "Откройте расширение заново." },
    args: [action, options, key],
  });
}

function download(conversation, format) {
  const json = format === "json";
  const contents = json ? `${JSON.stringify(conversation, null, 2)}\n` : toMarkdown(conversation);
  const blob = new Blob([contents], { type: json ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = createFilename(conversation, json ? "json" : "md");
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function poll() {
  clearTimeout(timer);
  const version = viewVersion;
  const mode = modeControl.value;
  try {
    const state = await command("status", {}, mode);
    if (version !== viewVersion) return;
    const running = state.state === "running";
    panel.dataset.state = state.state;
    panel.dataset.mode = mode;
    document.querySelector("#spinner").hidden = !running;
    document.querySelector("#done-icon").toggleAttribute("hidden", state.state !== "done");
    modeControl.disabled = running;
    exportButtons.forEach((button) => { button.disabled = running; });
    document.querySelector("#cancel").hidden = !running;
    document.querySelector("#restart").hidden = !["done", "incomplete", "error"].includes(state.state);
    const restartLabel = mode === "api" ? "Запросить заново" : "Собрать заново";
    document.querySelector("#restart").setAttribute("aria-label", restartLabel);
    document.querySelector("#restart").title = restartLabel;
    document.querySelector("#partial").hidden = mode !== "scroll" || state.state !== "incomplete" || !state.count;
    document.querySelector("#diagnose").disabled = running;
    if (running) {
      showStatus(mode === "api" ? "Получаю переписку…" : `Собираю: ${messageCount(state.count)}`);
      timer = setTimeout(poll, 450);
    } else if (state.state === "done") {
      if (pendingFormat) {
        const format = pendingFormat;
        pendingFormat = null;
        download(await command("result", {}, mode), format);
        showStatus(messageCount(state.count));
      } else showStatus(messageCount(state.count));
    } else if (["incomplete", "error"].includes(state.state)) {
      pendingFormat = null;
      showStatus(state.error || "Собраны не все сообщения.", true);
    } else showStatus("");
  } catch (error) {
    if (version !== viewVersion) return;
    modeControl.disabled = false;
    exportButtons.forEach((button) => { button.disabled = false; });
    document.querySelector("#cancel").hidden = true;
    document.querySelector("#spinner").hidden = true;
    document.querySelector("#done-icon").toggleAttribute("hidden", true);
    panel.dataset.state = "error";
    showStatus(error.message || "Ошибка экспорта.", true);
  }
}

async function start(format, force = false) {
  try {
    await connected;
    preferredFormat = format;
    pendingFormat = format;
    exportButtons.forEach((button) => { button.disabled = true; });
    modeControl.disabled = true;
    await command("start", { force });
    await poll();
  } catch (error) {
    pendingFormat = null;
    modeControl.disabled = false;
    exportButtons.forEach((button) => { button.disabled = false; });
    showStatus(error.message || "Не удалось начать экспорт.", true);
  }
}

const connected = (async () => {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || new URL(tab.url).origin !== "https://chatgpt.com") {
    throw new Error("Откройте переписку на https://chatgpt.com и нажмите значок расширения снова.");
  }
  tabId = tab.id;
  const remembered = await execute({ func: () => globalThis.__chatgptLocalExportLastModeV1 ?? "api" });
  modeControl.value = remembered === "scroll" ? "scroll" : "api";
})();
connected.then(poll).catch((error) => { panel.dataset.state = "error"; showStatus(error.message, true); });

modeControl.addEventListener("change", async () => {
  clearTimeout(timer);
  viewVersion++;
  pendingFormat = null;
  document.querySelector("#diagnostic-panel").hidden = true;
  try {
    await connected;
    await execute({ func: (mode) => { globalThis.__chatgptLocalExportLastModeV1 = mode; return true; }, args: [modeControl.value] });
    await poll();
  } catch (error) { showStatus(error.message, true); }
});

exportButtons.forEach((button) => button.addEventListener("click", () => start(button.dataset.format)));
document.querySelector("#restart").addEventListener("click", () => start(preferredFormat, true));
document.querySelector("#cancel").addEventListener("click", async () => {
  try { await command("cancel"); showStatus("Отменяю…"); }
  catch (error) { showStatus(error.message, true); }
});
document.querySelector("#partial").addEventListener("click", async () => {
  try { download(await command("result"), preferredFormat); }
  catch (error) { showStatus(error.message, true); }
});
document.querySelector("#diagnose").addEventListener("click", async () => {
  try {
    await connected;
    const state = await command("status");
    const report = { extensionVersion: api.runtime.getManifest().version, mode: modeControl.value,
      ...await execute({ files: ["diagnostics.js"] }),
      ...(modeControl.value === "api" ? { api: { state: state.state, errorCode: state.errorCode ?? null, messageCount: state.count ?? 0,
        requests: state.diagnostics ?? [], content: state.contentDiagnostic ?? null } } : {}) };
    document.querySelector("#diagnostic-output").value = JSON.stringify(report, null, 2);
    document.querySelector("#diagnostic-panel").hidden = false;
    showStatus("Диагностика готова");
  } catch (error) { showStatus(error.message, true); }
});
addEventListener("pagehide", () => clearTimeout(timer));
