// Pure conversion of a server response. No DOM, storage, credentials or network.
(() => {
  "use strict";
  function fail(code, message) {
    const error = new Error(message);
    error.apiCode = code;
    throw error;
  }
  function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
  // Diagnostics contain only allowlisted schema labels, never arbitrary strings
  // from the response (even an unknown content_type could contain private data).
  const knownTypes = new Set(["text", "code", "multimodal_text", "execution_output", "tether_quote", "tether_browsing_display",
    "tether_browsing_code", "user_editable_context", "model_editable_context", "thoughts", "reasoning_recap",
    "image_asset_pointer", "image", "image_url", "audio_asset_pointer", "audio", "input_audio", "audio_perception", "audio_uncond",
    "audio_transcription", "text_audio", "audio_sentinel", "text_sentinel", "end_of_task", "audio_future3",
    "real_time_user_audio_video_asset_pointer", "file", "file_asset_pointer", "video", "video_asset_pointer"]);
  const knownFields = ["content_type", "type", "parts", "text", "content", "thoughts", "summary", "result", "language",
    "user_profile", "user_instructions", "model_set_context", "asset_pointer", "audio_asset_pointer", "frames_asset_pointers", "chunks"];
  const valueType = (value) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const typeLabel = (value) => knownTypes.has(value) ? value : typeof value === "string" ? "unrecognized" : valueType(value);
  function convert(payload, url) {
    if (!object(payload) || !object(payload.mapping) || typeof payload.current_node !== "string") {
      fail("API_SCHEMA", "Сервер вернул неизвестную структуру переписки. Экспорт остановлен.");
    }
    if (payload.is_partial === true || payload.has_more === true || payload.has_more_messages === true || payload.truncated === true || payload.pagination?.has_more === true || payload.next_cursor) {
      fail("API_PARTIAL", "Ответ API помечен как неполный. Файл не сохранён.");
    }
    const path = [];
    const seen = new Set();
    let key = payload.current_node;
    while (key !== null) {
      if (typeof key !== "string" || !key || seen.has(key)) fail("API_TREE_CYCLE", "Нарушены связи дерева сообщений. Файл не сохранён.");
      seen.add(key);
      if (!Object.hasOwn(payload.mapping, key) || !object(payload.mapping[key])) fail("API_TREE_GAP", "В ответе API отсутствует часть сообщений текущей ветки. Файл не сохранён.");
      const node = payload.mapping[key];
      if (!Object.hasOwn(node, "parent") || (node.parent !== null && typeof node.parent !== "string")) fail("API_TREE_GAP", "Не удалось подтвердить начало переписки. Файл не сохранён.");
      path.push(node);
      key = node.parent;
    }
    path.reverse();
    let hidden = 0;
    let attachments = 0;
    const messages = [];
    const contentTypes = new Map();
    for (const node of path) {
      if (!object(node.message)) continue;
      const type = typeLabel(node.message.content?.content_type);
      contentTypes.set(type, (contentTypes.get(type) ?? 0) + 1);
    }
    const contentSummary = () => ({ version: 1, branchNodes: path.length, parsedMessages: messages.length, hiddenNodes: hidden,
      contentTypes: [...contentTypes].map(([type, count]) => ({ type, count })) });
    function unsupported(value, location) {
      const error = new Error("Неподдерживаемая структура содержимого.");
      error.apiCode = "API_CONTENT";
      error.apiDiagnostic = { ...contentSummary(), unsupported: {
        location, valueType: valueType(value), type: typeLabel(value?.content_type ?? value?.type),
        fields: object(value) ? knownFields.filter((name) => Object.hasOwn(value, name)).map((name) => ({ name, valueType: valueType(value[name]) })) : [],
        otherFieldCount: object(value) ? Object.keys(value).filter((name) => !knownFields.includes(name)).length : 0,
      }};
      throw error;
    }
    function partText(part) {
      if (typeof part === "string") return part;
      if (object(part)) {
        if (typeof part.text === "string") return part.text;
        const kind = part.content_type ?? part.type;
        if (["image_asset_pointer", "image", "image_url"].includes(kind)) { attachments++; return "[Изображение — файл не скачивался]"; }
        if (["audio_asset_pointer", "audio", "input_audio", "audio_perception", "audio_uncond"].includes(kind)) { attachments++; return "[Аудио — файл не скачивался]"; }
        if (["file", "file_asset_pointer", "video", "video_asset_pointer", "real_time_user_audio_video_asset_pointer"].includes(kind)) { attachments++; return "[Вложение — файл не скачивался]"; }
        // Audio stream delimiters carry no text or asset of their own.
        if (["audio_sentinel", "text_sentinel", "end_of_task", "audio_future3"].includes(kind)) return "";
        if (kind === "text_audio" && object(part.text)) return partText(part.text);
      }
      unsupported(part, "part");
    }
    for (const node of path) {
      const message = node.message;
      if (message === null || message === undefined) continue;
      if (!object(message)) fail("API_SCHEMA", "Неизвестная структура сообщения API.");
      const role = message.author?.role;
      const channel = message.channel ?? message.metadata?.channel;
      const content = message.content;
      const type = content?.content_type;
      if (!["user", "assistant"].includes(role) || message.metadata?.is_visually_hidden_from_conversation === true ||
          ["user_editable_context", "model_editable_context"].includes(type) ||
          (role === "assistant" && (["thoughts", "reasoning_recap"].includes(type) || message.metadata?.is_thinking_preamble_message === true)) ||
          (role === "assistant" && channel && channel !== "final") ||
          (role === "assistant" && message.recipient && message.recipient !== "all")) { hidden++; continue; }
      if (["in_progress", "streaming", "pending"].includes(message.status)) fail("API_GENERATING", "Ответ ещё создаётся. Дождитесь окончания и повторите экспорт.");
      if (!object(content)) unsupported(content, "content");
      let text;
      if (Array.isArray(content.parts)) text = content.parts.map(partText).join("\n");
      else if (typeof content.text === "string") text = content.text;
      else if (type === "tether_browsing_display" && typeof content.result === "string") text = content.result;
      else text = partText(content);
      let markdown = text;
      if (content.content_type === "code") {
        const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
        const fence = "`".repeat(Math.max(3, longest + 1));
        const language = typeof content.language === "string" && /^[\w.+-]{1,40}$/.test(content.language) ? content.language : "";
        markdown = `${fence}${language}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
      }
      if (!text) { hidden++; continue; }
      const entry = { role, text, markdown };
      if (typeof message.create_time === "number" && Number.isFinite(message.create_time)) {
        const date = new Date(message.create_time * 1000);
        if (!Number.isNaN(date.valueOf())) entry.createdAt = date.toISOString();
      }
      messages.push(entry);
    }
    if (!messages.length) fail("API_EMPTY", "API не вернул сообщения пользователя и ChatGPT. Файл не сохранён.");
    const warnings = ["Экспорт текущей ветки по ответу сервера. Другие ветки и файлы вложений не включены. Markdown сохранён из API."];
    if (attachments) warnings.push(`Вложения обозначены текстом; файлов не скачивалось: ${attachments}.`);
    return { schemaVersion: 1, title: typeof payload.title === "string" && payload.title.trim() ? payload.title : "ChatGPT",
      url, exportedAt: new Date().toISOString(), messages, warnings,
      capture: { method: "server-api", completeness: "complete", branch: "current_node", graphNodes: Object.keys(payload.mapping).length,
        branchNodes: path.length, messageCount: messages.length, hiddenNodes: hidden, attachmentPlaceholders: attachments,
        parentChainVerified: true, contentSummary: contentSummary() } };
  }
  globalThis.__chatgptLocalExportApiFormatV1 = convert;
  return true;
})();
