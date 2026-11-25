export function toMarkdown(conversation) {
  const title = conversation.title.replace(/\s+/g, " ").replace(/[\\`*_[\]<>#]/g, "\\$&");
  const blocks = [
    `# ${title}`,
    `Источник: ${conversation.url}`,
    `Экспорт: ${conversation.exportedAt}`,
    ...conversation.warnings.map((warning) => `> ${warning}`),
    ...conversation.messages.map((message) =>
      `## ${message.role === "user" ? "Вы" : "ChatGPT"}\n\n${message.markdown}`),
  ];
  return `${blocks.join("\n\n")}\n`;
}

export function createFilename(conversation, extension) {
  // Leave room for the date and suffix on Windows/macOS/Linux.
  const title = Array.from(conversation.title.normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, " ").replace(/^[. ]+|[. ]+$/g, ""))
    .slice(0, 48).join("") || "ChatGPT";
  return `chatgpt-${title}-${conversation.exportedAt.slice(0, 10)}.${extension}`;
}
