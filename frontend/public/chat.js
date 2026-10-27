// Chat panel: questions go to /chat with the saved password; answers cite the stored articles.
// Depends on app.js for authorizedPost().

const chatEl = {
  log: document.getElementById("chat-log"),
  empty: document.getElementById("chat-empty"),
  form: document.getElementById("chat-form"),
  input: document.getElementById("chat-input"),
  send: document.getElementById("chat-send"),
  sendLabel: document.querySelector("#chat-send .btn-label"),
  clear: document.getElementById("chat-clear"),
  webToggle: document.getElementById("web-toggle"),
  hoodRows: document.getElementById("hood-rows"),
  hoodEmpty: document.getElementById("hood-empty"),
  hoodTableWrap: document.getElementById("hood-table-wrap"),
};
const WEB_KEY = "news-chat-web-search";
let responseCount = 0;

const MODEL_NAMES = { haiku: "Haiku 5.5", opus: "Opus 5.5" };
const HISTORY_TURNS = 3;
const MODEL_KEY = "news-chat-model";

// Completed exchanges only, sent back so follow-up questions keep their context.
const chatHistory = [];
let sending = false;

function selectedModel() {
  return document.querySelector('input[name="chat-model"]:checked').value;
}

function restoreModel() {
  let saved = null;
  try { saved = localStorage.getItem(MODEL_KEY); } catch {}
  const input = saved && document.querySelector(`input[name="chat-model"][value="${CSS.escape(saved)}"]`);
  if (input) input.checked = true;
}

function scrollToBottom() {
  chatEl.log.scrollTop = chatEl.log.scrollHeight;
}

// Inline formatting: **bold**, `code` and [n] citations linked to their source. Built as DOM nodes, never innerHTML.
function appendInline(parent, text, sources) {
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[\d+\](?:\[\d+\])*)/g)) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = part.slice(2, -2);
      parent.append(strong);
    } else if (part.startsWith("`") && part.endsWith("`")) {
      const code = document.createElement("code");
      code.textContent = part.slice(1, -1);
      parent.append(code);
    } else if (/^\[\d+\]/.test(part)) {
      for (const [, n] of part.matchAll(/\[(\d+)\]/g)) {
        const source = sources.find((s) => s.n === Number(n));
        if (source && /^https?:\/\//i.test(source.url)) {
          const a = document.createElement("a");
          a.href = source.url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.className = "cite";
          a.textContent = `[${n}]`;
          a.title = source.headline;
          parent.append(a);
        } else {
          parent.append(`[${n}]`);
        }
      }
    } else {
      parent.append(part);
    }
  }
}

// Block formatting: paragraphs, "- " / "* " / "1. " lists, and "#" headings rendered as bold lines.
function renderAnswer(text, sources) {
  const frag = document.createDocumentFragment();
  let list = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      if (!list) {
        list = document.createElement(/^\d/.test(line) ? "ol" : "ul");
        frag.append(list);
      }
      const li = document.createElement("li");
      appendInline(li, bullet[1], sources);
      list.append(li);
      continue;
    }
    list = null;
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    const p = document.createElement("p");
    if (heading) {
      const strong = document.createElement("strong");
      strong.textContent = heading[1];
      p.append(strong);
    } else {
      appendInline(p, line, sources);
    }
    frag.append(p);
  }
  return frag;
}

function addMessage(role, className = "") {
  chatEl.empty.hidden = true;
  chatEl.clear.hidden = false;
  const msg = document.createElement("div");
  msg.className = `msg msg-${role} ${className}`.trim();
  chatEl.log.append(msg);
  scrollToBottom();
  return msg;
}

function renderSources(sources) {
  const details = document.createElement("details");
  details.className = "msg-sources";
  const summary = document.createElement("summary");
  const webCount = sources.filter((s) => s.kind === "web").length;
  const articleCount = sources.length - webCount;
  summary.textContent =
    `${articleCount} article${articleCount === 1 ? "" : "s"}` +
    (webCount ? ` + ${webCount} web result${webCount === 1 ? "" : "s"}` : "");
  const ol = document.createElement("ol");
  for (const s of sources) {
    const li = document.createElement("li");
    li.value = s.n;
    const a = document.createElement("a");
    a.textContent = s.headline;
    if (/^https?:\/\//i.test(s.url)) {
      a.href = s.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
    if (s.kind === "web") {
      const tag = document.createElement("span");
      tag.className = "web-tag";
      tag.textContent = "web";
      li.append(tag, " ");
    }
    li.append(a, ` · ${s.source ?? "Unknown source"}`);
    ol.append(li);
  }
  details.append(summary, ol);
  return details;
}

const fmt = (n) => (typeof n === "number" ? n.toLocaleString() : "–");

function webSummary(web) {
  if (!web?.enabled) return "off";
  if (!web.searches.length) return "on, not used";
  const results = web.searches.reduce((n, s) => n + s.results, 0);
  return `${web.searches.length} search${web.searches.length === 1 ? "" : "es"}, ${results} results`;
}

// Always-visible per-answer stats: exact token counts, plus what the answer drew on.
function usageBlock(result, seconds) {
  const box = document.createElement("div");
  box.className = "msg-usage";
  const u = result.usage ?? {};
  const chip = (label, value, cls = "") => {
    const span = document.createElement("span");
    span.className = `usage-chip ${cls}`.trim();
    const b = document.createElement("b");
    b.textContent = value;
    span.append(`${label} `, b);
    return span;
  };
  const tokens = document.createElement("div");
  tokens.className = "usage-tokens";
  tokens.append(
    chip("Input", fmt(u.input_tokens)),
    chip("Output", fmt(u.output_tokens)),
    chip("Total", fmt((u.input_tokens ?? 0) + (u.output_tokens ?? 0)), "total"),
  );
  const meta = document.createElement("p");
  meta.className = "usage-meta";
  meta.textContent =
    `${MODEL_NAMES[result.model] ?? result.model} · ${seconds.toFixed(1)} s · ` +
    `${result.context?.articles ?? 0} DB articles (≈${fmt(result.context?.article_tokens_est)} tokens) · ` +
    `web search ${webSummary(result.web)}` +
    (u.model_calls > 1 ? ` · ${u.model_calls} model calls` : "");
  box.append(tokens, meta);
  if (result.web?.searches.length) {
    const q = document.createElement("p");
    q.className = "usage-meta";
    q.textContent = `Searched: ${result.web.searches.map((s) => `“${s.query}”${s.error ? " (failed)" : ""}`).join(", ")}`;
    box.append(q);
  }
  return box;
}

function addHoodRow(result) {
  responseCount++;
  const u = result.usage ?? {};
  const row = document.createElement("tr");
  const web = result.web;
  const webCell = !web?.enabled
    ? "off"
    : web.searches.length
      ? `${web.searches.length} (≈${fmt(web.result_tokens_est)} tokens)`
      : "on, not used";
  const cells = [
    responseCount,
    MODEL_NAMES[result.model] ?? result.model,
    result.context?.articles ?? 0,
    `≈${fmt(result.context?.article_tokens_est)}`,
    webCell,
    fmt(u.input_tokens),
    fmt(u.output_tokens),
    fmt((u.input_tokens ?? 0) + (u.output_tokens ?? 0)),
  ];
  for (const [i, value] of cells.entries()) {
    const td = document.createElement("td");
    td.textContent = value;
    if (i === 4 && web?.searches.length) td.title = web.searches.map((s) => s.query).join("\n");
    row.append(td);
  }
  chatEl.hoodRows.append(row);
  chatEl.hoodEmpty.hidden = true;
  chatEl.hoodTableWrap.hidden = false;
}

function setSending(on) {
  sending = on;
  chatEl.send.disabled = on;
  chatEl.send.classList.toggle("loading", on);
  chatEl.sendLabel.textContent = on ? "Thinking…" : "Send";
}

async function sendQuestion(question) {
  if (sending || !question) return;
  const model = selectedModel();
  const userMsg = addMessage("user");
  userMsg.textContent = question;
  chatEl.input.value = "";

  const webSearch = chatEl.webToggle.checked;
  const pending = addMessage("assistant", "pending");
  pending.textContent = webSearch
    ? `${MODEL_NAMES[model]} is reading the articles and may search the web…`
    : `${MODEL_NAMES[model]} is reading the articles…`;
  setSending(true);
  const started = performance.now();
  try {
    const result = await authorizedPost("/chat", {
      question,
      model,
      web_search: webSearch,
      history: chatHistory.slice(-HISTORY_TURNS * 2),
    });
    if (!result) {
      // Password prompt cancelled: put the question back so nothing is lost.
      pending.remove();
      userMsg.remove();
      chatEl.input.value = question;
      if (!chatEl.log.querySelector(".msg")) {
        chatEl.empty.hidden = false;
        chatEl.clear.hidden = true;
      }
      return;
    }
    pending.classList.remove("pending");
    pending.replaceChildren(renderAnswer(result.answer, result.sources));
    if (result.sources.length) pending.append(renderSources(result.sources));
    pending.append(usageBlock(result, (performance.now() - started) / 1000));
    addHoodRow(result);
    chatHistory.push({ role: "user", content: question }, { role: "assistant", content: result.answer });
  } catch (err) {
    pending.classList.remove("pending");
    pending.classList.add("msg-error");
    pending.textContent = `Couldn't get an answer: ${err.message}`;
  } finally {
    setSending(false);
    scrollToBottom();
    chatEl.input.focus();
  }
}

function initChat() {
  restoreModel();
  try { chatEl.webToggle.checked = localStorage.getItem(WEB_KEY) === "on"; } catch {}
  chatEl.webToggle.addEventListener("change", () => {
    try { localStorage.setItem(WEB_KEY, chatEl.webToggle.checked ? "on" : "off"); } catch {}
  });
  document.querySelectorAll('input[name="chat-model"]').forEach((input) =>
    input.addEventListener("change", () => {
      try { localStorage.setItem(MODEL_KEY, input.value); } catch {}
    }),
  );
  chatEl.form.addEventListener("submit", (e) => {
    e.preventDefault();
    sendQuestion(chatEl.input.value.trim());
  });
  // Enter sends; Shift+Enter adds a new line.
  chatEl.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      chatEl.form.requestSubmit();
    }
  });
  document.querySelectorAll(".suggestion").forEach((b) =>
    b.addEventListener("click", () => sendQuestion(b.textContent.trim())),
  );
  chatEl.clear.addEventListener("click", () => {
    chatHistory.length = 0;
    chatEl.log.querySelectorAll(".msg").forEach((m) => m.remove());
    responseCount = 0;
    chatEl.hoodRows.replaceChildren();
    chatEl.hoodEmpty.hidden = false;
    chatEl.hoodTableWrap.hidden = true;
    chatEl.empty.hidden = false;
    chatEl.clear.hidden = true;
    chatEl.input.focus();
  });
}

initChat();
