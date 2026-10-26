const API_BASE =
  new URLSearchParams(location.search).get("api") || "https://news-app-backend.toki-arsa-analizi.workers.dev";

const el = {
  topic: document.getElementById("topic"),
  minScore: document.getElementById("min-score"),
  limit: document.getElementById("limit"),
  filters: document.getElementById("filters"),
  groups: document.getElementById("groups"),
  status: document.getElementById("status"),
  resultCount: document.getElementById("result-count"),
  lastRefreshed: document.getElementById("last-refreshed"),
  refresh: document.getElementById("refresh"),
  refreshLabel: document.querySelector("#refresh .btn-label"),
  cardTemplate: document.getElementById("card-template"),
};

let topics = [];

async function api(path, options) {
  const res = await fetch(API_BASE + path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (HTTP ${res.status})`);
  return body;
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

function formatRefreshed(iso) {
  if (!iso) return "Not refreshed yet";
  const when = new Date(iso);
  const minutes = Math.round((Date.now() - when.getTime()) / 60000);
  const ago =
    minutes < 1 ? "just now" :
    minutes < 60 ? `${minutes} min ago` :
    minutes < 1440 ? `${Math.round(minutes / 60)} h ago` :
    `${Math.round(minutes / 1440)} d ago`;
  const stamp = when.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `Last refreshed ${stamp} (${ago})`;
}

function renderCard(article) {
  const card = el.cardTemplate.content.firstElementChild.cloneNode(true);
  const link = card.querySelector(".headline a");
  link.textContent = article.headline;
  if (/^https?:\/\//i.test(article.url)) link.href = article.url;

  const score = card.querySelector(".score");
  if (article.relevance_score) {
    score.textContent = `${article.relevance_score}/10`;
    score.classList.add(scoreTier(article.relevance_score));
    score.title = `Relevance ${article.relevance_score} out of 10`;
    score.setAttribute("aria-label", score.title);
  } else {
    score.remove();
  }

  card.querySelector(".source").textContent = article.source || "Unknown source";
  const date = card.querySelector(".date");
  date.textContent = formatDate(article.published_at);
  if (article.published_at) date.dateTime = article.published_at;
  card.querySelector(".summary").textContent = article.summary || "";
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
    count.textContent = `${articles.length}`;
    heading.append(count);

    const cards = document.createElement("div");
    cards.className = "cards";
    cards.append(...articles.map(renderCard));

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

  el.groups.setAttribute("aria-busy", "true");
  try {
    render(await api(`/articles?${params}`));
  } catch (err) {
    showStatus(`Could not load articles: ${err.message}`, "error");
  } finally {
    el.groups.setAttribute("aria-busy", "false");
  }
}

async function refresh() {
  el.refresh.disabled = true;
  el.refresh.classList.add("loading");
  el.refreshLabel.textContent = "Running agent…";
  showStatus("Searching the web and asking Claude to pick and summarize articles. This usually takes 15-60 seconds.", "info");
  try {
    const result = await api("/agent", { method: "POST" });
    const failed = result.topics.filter((t) => t.error);
    showStatus(
      `Refresh complete: ${result.articles_inserted} new article${result.articles_inserted === 1 ? "" : "s"} added` +
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

async function init() {
  el.filters.addEventListener("change", loadArticles);
  el.filters.addEventListener("submit", (e) => e.preventDefault());
  el.refresh.addEventListener("click", refresh);

  try {
    topics = (await api("/topics")).topics;
    for (const t of topics) el.topic.append(new Option(t.name, t.id));
  } catch (err) {
    showStatus(`Could not load topics: ${err.message}`, "error");
  }
  await loadArticles();
}

init();
