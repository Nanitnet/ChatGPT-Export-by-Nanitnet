// Executed in the default ISOLATED world only after the user presses Export.
// The final expression is returned directly to scripting.executeScript().
(() => {
  "use strict";
  if (location.origin !== "https://chatgpt.com") {
    return { error: "Экспорт доступен только на https://chatgpt.com." };
  }

  const skippedTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "BUTTON", "SVG", "INPUT", "TEXTAREA", "SELECT", "NAV"]);
  const blockTags = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "TABLE"]);

  let visibilityCache = new WeakMap();
  function isHidden(element) {
    if (visibilityCache.has(element)) return visibilityCache.get(element);
    if (element.hidden || element.getAttribute("aria-hidden") === "true" || element.classList.contains("sr-only")) return true;
    const style = getComputedStyle(element);
    const hidden = style.display === "none" || style.visibility === "hidden";
    visibilityCache.set(element, hidden);
    return hidden;
  }

  function skip(element) {
    return skippedTags.has(element.tagName) || isHidden(element);
  }

  function escapeMarkdown(text) {
    return text.replace(/[\\`*_[\]<>!|#]/g, "\\$&");
  }

  function join(parts) {
    return parts.reduce((text, part) => {
      const left = text.match(/\n+$/)?.[0].length ?? 0;
      const right = part.match(/^\n+/)?.[0].length ?? 0;
      return text + part.slice(Math.min(left, right));
    }, "");
  }

  function plain(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const pre = /^(pre|break-spaces)/.test(getComputedStyle(node.parentElement).whiteSpace);
      return pre ? node.textContent : node.textContent.replace(/\s+/g, " ");
    }
    if (node.nodeType !== Node.ELEMENT_NODE || skip(node)) return "";
    if (node.tagName === "BR") return "\n";
    if (node.tagName === "IMG") return `[Изображение${node.alt ? `: ${node.alt}` : ""}]`;
    if (node.tagName === "PRE") return `\n\n${(node.querySelector("code") ?? node).textContent}\n\n`;
    if (node.tagName === "MATH" || node.classList.contains("katex")) {
      const latex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      if (latex) return latex;
    }
    const text = join([...node.childNodes].map(plain));
    return blockTags.has(node.tagName) ? `\n\n${text.trim()}\n\n` : text;
  }

  function safeLink(value) {
    if (!value) return null;
    try {
      const url = new URL(value, location.href);
      if (!["https:", "http:", "mailto:"].includes(url.protocol)) return null;
      // Percent-encode Markdown delimiters and whitespace, including angle brackets.
      return url.href.replace(/[\s<>\\()]/g, (character) =>
        character === "(" ? "%28" : character === ")" ? "%29" : encodeURIComponent(character));
    } catch { return null; }
  }

  function render(node) {
    if (node.nodeType === Node.TEXT_NODE) return escapeMarkdown(plain(node));
    if (node.nodeType !== Node.ELEMENT_NODE || skip(node)) return "";
    const tag = node.tagName;
    if (tag === "BR") return "\n";
    if (tag === "IMG") return escapeMarkdown(plain(node));
    if (tag === "PRE") {
      const code = node.querySelector("code") ?? node;
      const text = code.textContent;
      const longest = (text.match(/`+/g) ?? []).reduce((max, match) => Math.max(max, match.length), 0);
      const fence = "`".repeat(Math.max(3, longest + 1));
      const candidate = code.className.match?.(/(?:^|\s)language-([\w.+-]+)/)?.[1] ?? node.dataset.language ?? "";
      const language = /^[\w.+-]{1,40}$/.test(candidate) ? candidate : "";
      return `\n\n${fence}${language}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}\n\n`;
    }
    if (tag === "CODE") {
      const text = node.textContent.replace(/\r?\n/g, " ");
      const longest = (text.match(/`+/g) ?? []).reduce((max, match) => Math.max(max, match.length), 0);
      const fence = "`".repeat(longest + 1);
      const pad = /^[` ]|[` ]$/.test(text) ? " " : "";
      return `${fence}${pad}${text}${pad}${fence}`;
    }
    if (tag === "MATH" || node.classList.contains("katex")) {
      const latex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      if (latex) return node.parentElement?.classList.contains("katex-display") ? `\n\n$$\n${latex}\n$$\n\n` : `$${latex}$`;
    }
    if (tag === "TABLE") {
      const rows = [...node.querySelectorAll("tr")].filter((row) => row.closest("table") === node && !skip(row));
      const cells = rows.map((row) => [...row.children]
        .filter((cell) => ["TH", "TD"].includes(cell.tagName))
        .map((cell) => join([...cell.childNodes].map(render)).trim().replace(/\n+/g, " ").replace(/(?<!\\)\|/g, "\\|")));
      if (!cells.length) return "";
      const width = Math.max(...cells.map((row) => row.length));
      const lines = cells.map((row) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`);
      lines.splice(1, 0, `| ${Array(width).fill("---").join(" | ")} |`);
      return `\n\n${lines.join("\n")}\n\n`;
    }
    if (tag === "UL" || tag === "OL") {
      let index = Number(node.getAttribute("start") || 1);
      const items = [...node.children].filter((child) => child.tagName === "LI" && !skip(child)).map((item) => {
        if (tag === "OL" && item.hasAttribute("value")) index = Number(item.getAttribute("value"));
        const marker = tag === "OL" ? `${index++}. ` : "- ";
        const text = join([...item.childNodes].map(render)).trim();
        return marker + text.replace(/\n/g, `\n${" ".repeat(marker.length)}`);
      });
      return `\n\n${items.join("\n")}\n\n`;
    }
    const text = join([...node.childNodes].map(render));
    if (tag === "A") {
      const href = safeLink(node.getAttribute("href"));
      return href ? `[${text.trim() || escapeMarkdown(href)}](<${href}>)` : text;
    }
    if (tag === "STRONG" || tag === "B") return text.trim() ? `**${text}**` : text;
    if (tag === "EM" || tag === "I") return text.trim() ? `*${text}*` : text;
    if (tag === "DEL" || tag === "S") return text.trim() ? `~~${text}~~` : text;
    if (/^H[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${text.trim()}\n\n`;
    if (tag === "BLOCKQUOTE") return `\n\n${text.trim().replace(/^/gm, "> ")}\n\n`;
    if (tag === "HR") return "\n\n---\n\n";
    return blockTags.has(tag) ? `\n\n${text.trim()}\n\n` : text;
  }

  function hasHiddenAncestor(node) {
    for (let current = node; current; current = current.parentElement) {
      if (isHidden(current)) return true;
    }
    return false;
  }
  function scan() {
    visibilityCache = new WeakMap();
    const roots = [...document.querySelectorAll('#thread, main, [role="main"], [data-conversation-transcript]')].filter((node) => !hasHiddenAncestor(node));
    const selected = [];
    function eligible(node) {
      if (hasHiddenAncestor(node)) return false;
      if (node.closest('nav, [role="navigation"], form, [contenteditable="true"]')) return false;
      return !roots.length || roots.some((root) => root.contains(node)) || Boolean(node.closest('[data-turn-key], [data-turn-id-container], [data-testid^="conversation-turn-"]'));
    }
    function add(node, role) {
      if (!eligible(node)) return;
      if (!node.firstElementChild && !node.textContent.trim()) return;
      // A turn shell, a search unit and a legacy message may describe the same
      // message. Prefer the most specific semantic marker, without text-based dedup.
      if (selected.some((entry) => entry.node.contains(node) || node.contains(entry.node))) return;
      selected.push({ node, role });
    }
    for (const attribute of ["data-message-author-role", "data-message-role", "data-content-search-unit-key", "data-chatgpt-search-unit-key", "data-turn"]) {
      const suffix = attribute.endsWith("unit-key");
      const operator = suffix ? "$=" : "=";
      const user = suffix ? ":user" : "user";
      const assistant = suffix ? ":assistant" : "assistant";
      for (const node of document.querySelectorAll(`[${attribute}${operator}"${user}"], [${attribute}${operator}"${assistant}"]`)) {
        add(node, node.getAttribute(attribute).endsWith(user) ? "user" : "assistant");
      }
    }
    for (const node of document.querySelectorAll('[data-user-message-bubble]:not([data-user-message-bubble="false"])')) add(node, "user");

    // Some variants retain a keyed turn plus an answer body but no role marker.
    // Only use this fallback inside a turn; never export arbitrary page Markdown.
    for (const node of document.querySelectorAll('[data-turn-key], [data-turn-id-container], [data-testid^="conversation-turn-"]')) {
      if (selected.some((entry) => node.contains(entry.node) || entry.node.contains(node))) continue;
      if (node.querySelector('.markdown, [data-markdown-text-style="assistant-message"], [data-assistant-markdown-root], [data-assistant-markdown]')) add(node, "assistant");
    }
    selected.sort((a, b) => a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

  function contentNodes(node, role) {
    const selector = role === "user"
      ? '[data-user-message-bubble]:not([data-user-message-bubble="false"]), [data-user-message-copy], [data-testid="collapsible-user-message-content"], .whitespace-pre-wrap'
      : '.markdown, [data-markdown-text-style="assistant-message"], [data-assistant-markdown-root], [data-assistant-markdown]';
    if (node.matches(selector)) return [node];
    const matches = [...node.querySelectorAll(selector)].filter((element) => !hasHiddenAncestor(element));
    // Keep all disjoint body parts, omitting nested duplicate matches.
    const bodies = matches.filter((element) => !matches.some((other) => other !== element && other.contains(element)));
    return bodies.length ? bodies : [node];
  }
  const extracted = selected.map(({ node, role }) => {
    const bodies = contentNodes(node, role);
    return { node, message: {
      role,
      text: bodies.map((body) => plain(body).trim()).filter(Boolean).join("\n\n"),
      markdown: bodies.map((body) => render(body).trim()).filter(Boolean).join("\n\n"),
    }};
  }).filter(({ message }) => message.text || message.markdown);
  const messages = extracted.map(({ message }) => message);
  const emptyError = !messages.length ? "Сообщения не найдены. Дождитесь загрузки чата. Если переписка видна, нажмите «Диагностика» и пришлите её сводку." : null;
  const busy = '[data-testid="stop-button"], [data-testid="stop-generation-button"], [data-message-role="assistant"] [aria-busy="true"], [data-assistant-markdown-root] [aria-busy="true"], [data-assistant-markdown][aria-busy="true"]';
  const generating = [...document.querySelectorAll(busy)].some((node) => !hasHiddenAncestor(node));
  const conversation = {
    schemaVersion: 1,
    title: document.title.replace(/\s*[-–—|]\s*ChatGPT\s*$/i, "").trim() || "ChatGPT",
    url: `${location.origin}${location.pathname}`,
    exportedAt: new Date().toISOString(),
    capture: { method: "loaded-dom", completeness: "not-guaranteed", branch: "currently-rendered" },
    warnings: [
      "Экспорт содержит только сообщения, загруженные на страницу. Полнота переписки не гарантируется.",
      "Другие ветки, содержимое Canvas, изображения и файлы вложений не включены. Оформление восстановлено из страницы, исходный Markdown недоступен.",
    ],
    messages,
  };
    const shellSelector = '[data-conversation-transcript] > [data-message-role="user"], [data-conversation-transcript] > [data-message-role="assistant"], [data-turn="user"], [data-turn="assistant"], [data-turn-key], [data-turn-id-container], [data-testid^="conversation-turn-"]';
    function stableKey(node) {
      if (!node) return null;
      for (const attr of ['data-turn-id-container', 'data-turn-id', 'data-turn-key', 'data-message-id', 'data-content-search-unit-key', 'data-chatgpt-search-unit-key', 'id']) {
        const value = node.getAttribute(attr);
        if (value) return `${attr}:${value}`;
      }
      const testid = node.getAttribute('data-testid');
      return /^conversation-turn-\d+$/.test(testid || '') ? `testid:${testid}` : null;
    }
    const units = [];
    for (const node of document.querySelectorAll(shellSelector)) {
      if (!eligible(node)) continue;
      const ancestor = node.parentElement?.closest(shellSelector);
      if (ancestor && eligible(ancestor) && stableKey(ancestor)) continue;
      const key = stableKey(node);
      if (key) units.push({ node, key });
    }
    const records = [];
    const parts = new Map();
    for (const { node, message } of extracted) {
      let unit = units.find((item) => item.node.contains(node));
      if (!unit) {
        const key = stableKey(node);
        if (key) { unit = { node, key }; units.push(unit); }
      }
      const unitKey = unit?.key ?? null;
      const index = parts.get(unitKey) ?? 0;
      parts.set(unitKey, index + 1);
      records.push({ unitKey, key: stableKey(node) ?? (unitKey ? `${unitKey}:part:${index}` : null), message, node });
    }
    units.sort((a, b) => a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    const root = extracted[0]?.node.closest('[data-conversation-transcript], #thread, main, [role="main"]')
      ?? units[0]?.node.closest('[data-conversation-transcript], #thread, main, [role="main"]') ?? document.body;
    const expectedTotal = Math.max(0, ...units.map(({ node }) => Number(node.getAttribute('aria-setsize')) || 0));
    const loading = root.matches('[role="progressbar"], [aria-busy="true"]') || [...root.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some((node) => !hasHiddenAncestor(node));
    return { conversation, records, units, root, expectedTotal, generating, loading, emptyError };
  }
  const reader = { scan };
  globalThis.__chatgptLocalExportReaderV1 = reader;
  const snapshot = scan();
  if (snapshot.generating) return { error: "Ответ ещё создаётся. Дождитесь окончания генерации и повторите экспорт." };
  return snapshot.emptyError ? { error: snapshot.emptyError } : snapshot.conversation;
})();
