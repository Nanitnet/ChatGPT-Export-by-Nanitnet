// A deliberately separate, count-only probe: never reads message text, page
// title, conversation/message IDs, URLs, scripts, storage or session material.
(() => {
  "use strict";
  if (location.origin !== "https://chatgpt.com") return { error: "Диагностика доступна только на https://chatgpt.com." };
  const selectors = {
    main: 'main, [role="main"]',
    thread: '#thread',
    transcripts: '[data-conversation-transcript]',
    legacyUser: '[data-message-author-role="user"]',
    legacyAssistant: '[data-message-author-role="assistant"]',
    messageUser: '[data-message-role="user"]',
    messageAssistant: '[data-message-role="assistant"]',
    contentSearchUser: '[data-content-search-unit-key$=":user"]',
    contentSearchAssistant: '[data-content-search-unit-key$=":assistant"]',
    chatgptSearchUser: '[data-chatgpt-search-unit-key$=":user"]',
    chatgptSearchAssistant: '[data-chatgpt-search-unit-key$=":assistant"]',
    turnUser: '[data-turn="user"]',
    turnAssistant: '[data-turn="assistant"]',
    keyedTurns: '[data-turn-key]',
    turnContainers: '[data-turn-id-container]',
    legacyTurns: '[data-testid^="conversation-turn-"]',
    userBubbles: '[data-user-message-bubble]:not([data-user-message-bubble="false"])',
    userCopy: '[data-user-message-copy]',
    assistantBodies: '.markdown, [data-markdown-text-style="assistant-message"], [data-assistant-markdown-root], [data-assistant-markdown]',
    frames: 'iframe',
  };
  const counts = {};
  for (const [name, selector] of Object.entries(selectors)) {
    const nodes = [...document.querySelectorAll(selector)];
    counts[name] = { total: nodes.length, visible: nodes.filter((node) => {
      for (let current = node; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (current.hidden || current.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden") return false;
      }
      return true;
    }).length };
  }
  return { diagnosticVersion: 1, readyState: document.readyState, counts };
})();
