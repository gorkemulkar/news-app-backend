const API_BASE =
  new URLSearchParams(location.search).get("api") || "https://news-app-backend.toki-arsa-analizi.workers.dev";

const el = {
  topic: document.getElementById("topic"),
  minScore: document.getElementById("min-score"),
  limit: document.getElementById("limit"),
  sort: document.getElementById("sort"),
  filters: document.getElementById("filters"),
  rubricList: document.getElementById("rubric-list"),
  groups: document.getElementById("groups"),
  status: document.getElementById("status"),
  resultCount: document.getElementById("result-count"),
  lastRefreshed: document.getElementById("last-refreshed"),
  refresh: document.getElementById("refresh"),
  refreshLabel: document.querySelector("#refresh .btn-label"),
  cardTemplate: document.getElementById("card-template"),
  passwordDialog: document.getElementById("password-dialog"),
  passwordForm: document.getElementById("password-form"),
  passwordInput: document.getElementById("password-input"),
  passwordError: document.getElementById("password-error"),
  passwordCancel: document.getElementById("password-cancel"),
  forgetPassword: document.getElementById("forget-password"),
};

// The agent password lives only in this browser (never in the page source); storage may be unavailable.
const PASSWORD_KEY = "news-agent-password";
const savedPassword = {
  get() { try { return localStorage.getItem(PASSWORD_KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(PASSWORD_KEY, v); } catch {} },
  clear() { try { localStorage.removeItem(PASSWORD_KEY); } catch {} },
};
let sessionPassword = null;

function currentPassword() {
  return sessionPassword ?? savedPassword.get();
}

function syncForgetButton() {
  el.forgetPassword.hidden = !savedPassword.get();
}

// Resolves with the entered password, or null if the user cancels.
function askForPassword(errorMessage) {
  el.passwordError.textContent = errorMessage || "";
  el.passwordError.hidden = !errorMessage;
  el.passwordInput.value = "";
  el.passwordDialog.showModal();
  el.passwordInput.focus();
  return new Promise((resolve) => {
    const finish = (value) => {
      el.passwordForm.removeEventListener("submit", onSubmit);
      el.passwordCancel.removeEventListener("click", onCancel);
      el.passwordDialog.removeEventListener("cancel", onCancel);
      el.passwordDialog.close();
      resolve(value);
    };
    const onSubmit = (e) => {
      e.preventDefault();
      finish(el.passwordInput.value.trim() || null);
    };
    const onCancel = (e) => {
      e.preventDefault();
      finish(null);
    };
    el.passwordForm.addEventListener("submit", onSubmit);
    el.passwordCancel.addEventListener("click", onCancel);
    el.passwordDialog.addEventListener("cancel", onCancel);
  });
}

let topics = [];
// Filter changes can overlap; only the latest request may render, so a slow older response can't overwrite it.
let latestLoad = 0;

async function api(path, options) {
  const res = await fetch(API_BASE + path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (HTTP ${res.status})`), { status: res.status });
  return body;
}

// Runs the agent with the stored password, asking for it on first use or when it's rejected.
async function runAgent() {
  let password = currentPassword();
  let error = null;
  for (;;) {
    if (!password) {
      password = await askForPassword(error);
      if (!password) return null;
    }
    try {
      const result = await api("/agent", { method: "POST", headers: { Authorization: `Bearer ${password}` } });
      sessionPassword = password;
      savedPassword.set(password);
      syncForgetButton();
      return result;
    } catch (err) {
      if (err.status !== 401) throw err;
      sessionPassword = null;
      savedPassword.clear();
      syncForgetButton();
      password = null;
      error = "That password was not accepted. Try again.";
    }
  }
}

function showStatus(message, kind = "ok") {
  el.status.textContent = message;
  el.status.className = `status ${kind}`;
  el.status.hidden = false;
}

function scoreTier(score) {
  if (score >= 9) return "high";
  if (score >= 7) return "good";
  if (score >= 5) return "mid";
  return "low";
}

function formatDate(isoDate) {
  if (!isoDate) return "Date unknown";
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function timeAgo(when) {
  const minutes = Math.round((Date.now() - when.getTime()) / 60000);
  return minutes < 1 ? "just now" :
    minutes < 60 ? `${minutes} min ago` :
    minutes < 1440 ? `${Math.round(minutes / 60)} h ago` :
    `${Math.round(minutes / 1440)} d ago`;
}

function formatRefreshed(iso) {
  if (!iso) return "Not refreshed yet";
  const when = new Date(iso);
  const stamp = when.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `Last refreshed ${stamp} (${timeAgo(when)})`;
}

function renderCard(article, isNew) {
  const card = el.cardTemplate.content.firstElementChild.cloneNode(true);
  const link = card.querySelector(".headline a");
  link.textContent = article.headline;
  if (/^https?:\/\//i.test(article.url)) link.href = article.url;

  const score = card.querySelector(".score");
  if (article.relevance_score) {
    score.textContent = `${article.relevance_score}/10`;
    score.classList.add(scoreTier(article.relevance_score));
    score.title = `Relevance ${article.relevance_score} out of 10` + (article.score_reason ? `: ${article.score_reason}` : "");
    score.setAttribute("aria-label", score.title);
  } else {
    score.remove();
  }

  if (isNew) {
    card.classList.add("is-new");
    card.querySelector(".new-badge").hidden = false;
  }
  card.querySelector(".source").textContent = article.source || "Unknown source";
  const date = card.querySelector(".date");
  date.textContent = formatDate(article.published_at);
  if (article.published_at) date.dateTime = article.published_at;
  if (article.fetched_at) card.querySelector(".added").textContent = `Added ${timeAgo(new Date(article.fetched_at))}`;
  card.querySelector(".summary").textContent = article.summary || "";

  const reason = card.querySelector(".reason");
  if (article.score_reason && article.relevance_score) {
    reason.querySelector("strong").textContent = `Why ${article.relevance_score}/10: `;
    reason.append(article.score_reason);
  } else {
    reason.remove();
  }
  return card;
}

function render(data) {
  el.groups.replaceChildren();
  el.resultCount.textContent = `${data.count} article${data.count === 1 ? "" : "s"}`;
  el.lastRefreshed.textContent = formatRefreshed(data.last_refreshed);

  if (data.count === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No articles match these filters.";
    el.groups.append(empty);
    return;
  }

  // "New" = added by the most recent run that added anything, so a Refresh's additions stand out.
  const newSince = data.latest_additions_at;
  const isNew = (a) => Boolean(newSince && a.fetched_at && a.fetched_at >= newSince);

  const byTopic = new Map();
  for (const article of data.articles) {
    if (!byTopic.has(article.topic)) byTopic.set(article.topic, []);
    byTopic.get(article.topic).push(article);
  }

  // Configured topic order first, then any topic the config no longer lists.
  const order = [...topics.map((t) => t.id), ...[...byTopic.keys()].filter((id) => !topics.some((t) => t.id === id))];
  for (const id of order) {
    const articles = byTopic.get(id);
    if (!articles) continue;
    const meta = topics.find((t) => t.id === id);

    const section = document.createElement("section");
    section.className = "topic-group";
    section.setAttribute("aria-labelledby", `topic-${id}`);

    const heading = document.createElement("h2");
    heading.id = `topic-${id}`;
    heading.textContent = meta ? meta.name : id;
    const count = document.createElement("span");
    count.className = "count";
    const newCount = articles.filter(isNew).length;
    count.textContent = `${articles.length}` + (newCount ? ` · ${newCount} new` : "");
    heading.append(count);

    const cards = document.createElement("div");
    cards.className = "cards";
    cards.append(...articles.map((a) => renderCard(a, isNew(a))));

    section.append(heading);
    if (meta?.description) {
      const desc = document.createElement("p");
      desc.className = "topic-desc";
      desc.textContent = meta.description;
      section.append(desc);
    }
    section.append(cards);
    el.groups.append(section);
  }
}

async function loadArticles() {
  const params = new URLSearchParams();
  if (el.topic.value) params.set("topic", el.topic.value);
  if (el.minScore.value) params.set("min_score", el.minScore.value);
  params.set("limit", el.limit.value);
  params.set("sort", el.sort.value);

  const load = ++latestLoad;
  el.groups.setAttribute("aria-busy", "true");
  try {
    const data = await api(`/articles?${params}`);
    if (load === latestLoad) render(data);
  } catch (err) {
    if (load === latestLoad) showStatus(`Could not load articles: ${err.message}`, "error");
  } finally {
    if (load === latestLoad) el.groups.setAttribute("aria-busy", "false");
  }
}

async function refresh() {
  if (!currentPassword()) {
    const password = await askForPassword();
    if (!password) return;
    sessionPassword = password;
  }
  el.refresh.disabled = true;
  el.refresh.classList.add("loading");
  el.refreshLabel.textContent = "Running agent…";
  showStatus("Searching the web and asking Claude to pick and summarize articles. This usually takes 15-60 seconds.", "info");
  try {
    const result = await runAgent();
    if (!result) {
      el.status.hidden = true;
      return;
    }
    const failed = result.topics.filter((t) => t.error);
    const added = result.articles_inserted;
    showStatus(
      (added
        ? `Refresh complete: ${added} new article${added === 1 ? "" : "s"} added, marked New below`
        : "Refresh complete: no new articles since the last run") +
        (result.articles_skipped ? `, ${result.articles_skipped} already known` : "") +
        (failed.length ? `. ${failed.length} topic(s) failed: ${failed.map((t) => t.topic).join(", ")}` : "."),
      failed.length ? "error" : "ok",
    );
    await loadArticles();
  } catch (err) {
    showStatus(`Refresh failed: ${err.message}`, "error");
  } finally {
    el.refresh.disabled = false;
    el.refresh.classList.remove("loading");
    el.refreshLabel.textContent = "Refresh";
  }
}

// The rubric comes from the API, so the panel always matches what Claude is told.
function renderRubric(rubric) {
  if (!rubric) return;
  for (const line of rubric.split("\n")) {
    const li = document.createElement("li");
    const m = line.match(/^(\d+-\d+):\s*(.*)$/);
    if (m) {
      const range = document.createElement("strong");
      range.textContent = m[1];
      range.className = `score ${scoreTier(Number(m[1].split("-")[0]))}`;
      li.append(range, " ", m[2]);
    } else {
      li.className = "rubric-note";
      li.textContent = line;
    }
    el.rubricList.append(li);
  }
}

async function init() {
  el.filters.addEventListener("change", loadArticles);
  el.filters.addEventListener("submit", (e) => e.preventDefault());
  el.refresh.addEventListener("click", refresh);
  el.forgetPassword.addEventListener("click", () => {
    sessionPassword = null;
    savedPassword.clear();
    syncForgetButton();
    showStatus("Saved password removed from this browser.", "info");
  });
  syncForgetButton();

  try {
    const config = await api("/topics");
    topics = config.topics;
    for (const t of topics) el.topic.append(new Option(t.name, t.id));
    renderRubric(config.score_rubric);
  } catch (err) {
    showStatus(`Could not load topics: ${err.message}`, "error");
  }
  await loadArticles();
}

init();
