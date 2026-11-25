// A job lives in the extension's isolated world in this tab, independently of
// the action popup. No background worker, storage, network or session access.
(() => {
  "use strict";
  if (location.origin !== "https://chatgpt.com") return { error: "Откройте чат на https://chatgpt.com." };
  if (globalThis.__chatgptLocalExportJobV1) return globalThis.__chatgptLocalExportJobV1.command("status");
  let job = null;
  const route = () => `${location.origin}${location.pathname}`;
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function status() {
    if (!job || (job.url !== route() && job.state !== "running")) return { state: "idle" };
    return { state: job.state, phase: job.phase, count: job.count, expected: job.expected,
      error: job.error, elapsedSeconds: Math.floor((Date.now() - job.started) / 1000) };
  }

  function scrollRoot(snapshot) {
    for (let node = snapshot.records[0]?.node ?? snapshot.units[0]?.node ?? snapshot.root; node; node = node.parentElement) {
      if (node.clientHeight > 0 && /auto|scroll|overlay/.test(getComputedStyle(node).overflowY)) return node;
    }
    return document.scrollingElement ?? document.documentElement;
  }

  async function collect(current) {
    const reader = globalThis.__chatgptLocalExportReaderV1;
    let scroller;
    let initialBottomGap = 0;
    let originalHeight = 0;
    let originalTop = 0;
    let observer;
    let scheduled = false;
    const groups = new Map();
    const edges = new Map();
    const records = new Map();
    let metadata;
    let expectedTotal = 0;
    let lastSnapshot;
    let changedAt = Date.now();
    let signature = "";
    let observationError;
    let startReached = false;
    let endReached = false;

    function check() {
      if (current.url !== route()) throw new Error("Чат изменился во время экспорта. Откройте нужную переписку и начните заново.");
      if (current.cancelled) throw new Error("Экспорт отменён.");
      if (Date.now() - current.started > 15 * 60_000) throw new Error("Превышено время ожидания загрузки. Собранные сообщения можно сохранить как неполный экспорт.");
      if (observationError) throw observationError;
    }

    function capture() {
      check();
      const snapshot = reader.scan();
      lastSnapshot = snapshot;
      if (scroller && !scroller.isConnected) scroller = scrollRoot(snapshot);
      if (snapshot.generating) throw new Error("Ответ ещё создаётся. Дождитесь окончания генерации и начните экспорт заново.");
      metadata = snapshot.conversation;
      expectedTotal = Math.max(expectedTotal, snapshot.expectedTotal);
      for (const unit of snapshot.units) {
        if (!groups.has(unit.key)) groups.set(unit.key, { node: unit.node, records: new Map(), discovery: groups.size });
        groups.get(unit.key).node = unit.node;
      }
      for (let index = 1; index < snapshot.units.length; index++) {
        const from = snapshot.units[index - 1].key;
        const to = snapshot.units[index].key;
        if (!edges.has(from)) edges.set(from, new Set());
        if (from !== to) edges.get(from).add(to);
      }
      for (const record of snapshot.records) {
        if (!record.key || !record.unitKey) throw new Error("У сообщений нет устойчивых идентификаторов. Без них нельзя надёжно собрать длинную переписку без повторов.");
        const group = groups.get(record.unitKey);
        if (!group) throw new Error("Не удалось определить порядок сообщений.");
        records.set(record.key, record.message);
        group.records.set(record.key, record.message);
      }
      current.count = records.size;
      current.expected = Math.max(expectedTotal, groups.size);
      const next = `${snapshot.units.map((unit) => unit.key).join("|")};${snapshot.records.map((record) => `${record.key}:${record.message.markdown.length}`).join("|")};${scroller?.scrollHeight ?? 0}`;
      if (next !== signature) { signature = next; changedAt = Date.now(); }
      return snapshot;
    }

    async function settle(minimum = 180, targetKey = null, maximum = 6000) {
      const started = Date.now();
      while (true) {
        const snapshot = capture();
        const elapsed = Date.now() - started;
        const targetReady = !targetKey || groups.get(targetKey)?.records.size > 0;
        if (elapsed >= minimum && Date.now() - changedAt >= 120 && !snapshot.loading && targetReady) return;
        if (elapsed >= maximum) return;
        await delay(90);
      }
    }

    function move(top) {
      capture();
      scroller.scrollTo({ top, behavior: "instant" });
    }

    function orderedMessages() {
      const incoming = new Map([...groups.keys()].map((key) => [key, 0]));
      for (const targets of edges.values()) for (const target of targets) incoming.set(target, incoming.get(target) + 1);
      const ready = [...incoming].filter(([, count]) => count === 0).map(([key]) => key);
      const ordered = [];
      let ambiguous = false;
      while (ready.length) {
        if (ready.length > 1) ambiguous = true;
        ready.sort((a, b) => groups.get(a).discovery - groups.get(b).discovery);
        const key = ready.shift();
        ordered.push(key);
        for (const next of edges.get(key) ?? []) {
          incoming.set(next, incoming.get(next) - 1);
          if (incoming.get(next) === 0) ready.push(next);
        }
      }
      if (ordered.length !== groups.size) throw new Error("Порядок сообщений изменился во время экспорта. Начните сбор заново.");
      const missing = [...groups.values()].filter((group) => !group.records.size).length;
      return { messages: ordered.flatMap((key) => [...groups.get(key).records.values()]), missing, ambiguous };
    }

    function result(reason = null) {
      const ordered = orderedMessages();
      const total = Math.max(expectedTotal, groups.size);
      const missing = Math.max(ordered.missing, total - [...groups.values()].filter((group) => group.records.size).length);
      const complete = !reason && !missing && !ordered.ambiguous && startReached && endReached && ordered.messages.length > 0;
      const warnings = ["Экспорт текущей отображаемой ветки. Другие ветки, Canvas, изображения и файлы вложений не включены; оформление восстановлено из страницы."];
      if (!complete) warnings.unshift(`Неполный экспорт. ${reason || (missing ? `Не прочитано блоков: ${missing}.` : "Не удалось подтвердить непрерывный порядок всех сообщений.")}`);
      return { ...metadata, exportedAt: new Date().toISOString(), warnings,
        capture: { method: "scroll-and-collect", completeness: complete ? "complete" : "incomplete", branch: "currently-rendered",
          expectedBlocks: total, capturedBlocks: groups.size - ordered.missing, missingBlocks: missing,
          startReached, endReached, orderVerified: !ordered.ambiguous,
          messageCount: ordered.messages.length }, messages: ordered.messages };
    }

    try {
      if (!reader) throw new Error("Скрипт чтения чата не загружен.");
      let snapshot = capture();
      if (!snapshot.records.length && !snapshot.units.length) throw new Error(snapshot.emptyError);
      scroller = scrollRoot(snapshot);
      originalTop = scroller.scrollTop;
      originalHeight = scroller.scrollHeight;
      initialBottomGap = Math.max(0, originalHeight - scroller.clientHeight - originalTop);
      observer = new MutationObserver(() => {
        if (scheduled || current.state !== "running") return;
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          if (current.state !== "running") return;
          try { capture(); } catch (error) { observationError = error; }
        });
      });
      observer.observe(snapshot.root, { childList: true, subtree: true, characterData: true });

      async function seekStart() {
        current.phase = "Подгружаю начало чата";
        let boundarySince = Date.now();
        let previousBoundary = "";
        while (true) {
          move(0);
          await settle(300);
          snapshot = capture();
          const boundary = `${scroller.scrollHeight}:${snapshot.units[0]?.key}:${groups.size}`;
          if (boundary !== previousBoundary || scroller.scrollTop > 2 || snapshot.loading) {
            previousBoundary = boundary;
            boundarySince = Date.now();
          }
          if (Date.now() - boundarySince >= 1800 && scroller.scrollTop <= 2 && !snapshot.loading) break;
          await delay(150);
        }
        return capture().units[0]?.key ?? null;
      }
      for (let pass = 0; pass < 3; pass++) {
        const firstKey = await seekStart();
        startReached = true;
        current.phase = "Собираю сообщения";
        let endIdle = null;
        let lastEnd = "";
        for (let step = 0; step < 20_000; step++) {
          check();
          snapshot = capture();
          const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          if (maximum - scroller.scrollTop <= 2) {
            const end = `${scroller.scrollHeight}:${snapshot.units.at(-1)?.key}:${groups.size}:${records.size}`;
            if (end !== lastEnd || snapshot.loading) { lastEnd = end; endIdle = Date.now(); }
            if (Date.now() - endIdle >= 1800 && !snapshot.loading) { endReached = true; break; }
            move(scroller.scrollHeight);
            await settle(250);
          } else {
            endIdle = null;
            move(Math.min(maximum, scroller.scrollTop + Math.max(100, scroller.clientHeight * .65)));
            await settle();
          }
        }
        // A delayed prepend may finish after the first top boundary went idle.
        // Recheck the actual first message; automatically sweep again if the
        // server revealed an older prefix while we were collecting the middle.
        const verifiedFirst = await seekStart();
        if (verifiedFirst === firstKey) break;
        endReached = false;
      }
      // Persistent virtualized shells can occasionally miss hydration on the
      // first pass. Revisit missing blocks, waiting for their actual contents.
      current.phase = "Проверяю пропуски";
      for (const [key, group] of groups) {
        if (group.records.size || !group.node?.isConnected) continue;
        check();
        group.node.scrollIntoView({ block: "center", behavior: "instant" });
        await settle(250, key);
      }
      current.result = result();
      current.state = current.result.capture.completeness === "complete" ? "done" : "incomplete";
      current.phase = current.state === "done" ? "Готово" : "Собрано не всё";
      if (current.state === "incomplete") current.error = current.result.warnings[0];
    } catch (error) {
      current.error = error.message || String(error);
      current.state = "incomplete";
      current.phase = current.cancelled ? "Отменено" : "Сбор остановлен";
      try { if (metadata && records.size && current.url === route()) current.result = result(current.error); } catch { current.result = null; }
    } finally {
      observer?.disconnect();
      if (scroller && current.url === route()) {
        const restored = originalTop + Math.max(0, scroller.scrollHeight - originalHeight);
        scroller.scrollTo({ top: Math.min(restored, Math.max(0, scroller.scrollHeight - scroller.clientHeight - initialBottomGap)), behavior: "instant" });
      }
    }
  }

  const api = { command(action, options = {}) {
    if (action === "status") return status();
    if (action === "cancel") { if (job?.state === "running") job.cancelled = true; return status(); }
    if (action === "result") {
      if (job?.url !== route()) return { error: "Переписка изменилась. Начните экспорт заново." };
      return job?.result ?? { error: "Результат ещё не готов." };
    }
    if (action === "start") {
      if (job?.state === "running") return status();
      if (job?.state === "done" && job.url === route() && !options.force) return status();
      job = { url: route(), state: "running", phase: "Начинаю сбор", count: 0, expected: 0, started: Date.now(), result: null, cancelled: false };
      job.promise = collect(job);
      return status();
    }
    return { error: "Неизвестная команда экспорта." };
  }};
  globalThis.__chatgptLocalExportJobV1 = api;
  return status();
})();
