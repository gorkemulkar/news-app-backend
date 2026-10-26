import Anthropic from "@anthropic-ai/sdk";
import topicsConfig from "../topics.json";
import type { Env } from "./types";

type Topic = (typeof topicsConfig.topics)[number];

interface Candidate {
  id: number;
  url: string;
  title: string;
  domain: string;
  published_at: string | null;
  description: string;
  snippets: string[];
}

interface Article {
  headline: string;
  source: string | null;
  published_at: string | null;
  url: string;
  summary: string | null;
  relevance_score: number | null;
}

interface TopicResult {
  topic: string;
  candidates: number;
  known_excluded: number;
  returned: number;
  inserted: number;
  skipped: number;
  removed: number;
  error?: string;
}

const ARTICLES_PER_TOPIC = 5;
const MAX_ARTICLES_PER_TOPIC = 20;
const RESULTS_PER_QUERY = 10;
const MAX_AGE_DAYS = 7;
const YDC_SEARCH_URL = "https://ydc-index.io/v1/search";

export async function runPipeline(env: Env, trigger: "manual" | "scheduled") {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY secret is not set");
  if (!env.YDC_API_KEY) throw new Error("YDC_API_KEY secret is not set");

  const run = await env.DB.prepare("INSERT INTO pipeline_runs (trigger) VALUES (?1) RETURNING id")
    .bind(trigger)
    .first<{ id: number }>();
  try {
    const result = await executePipeline(env);
    await env.DB.prepare(
      `UPDATE pipeline_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
         articles_inserted = ?2, articles_skipped = ?3, total_returned = ?4 WHERE id = ?1`,
    )
      .bind(run!.id, result.articles_inserted, result.articles_skipped, result.total_returned_by_claude)
      .run();
    return result;
  } catch (err) {
    await env.DB.prepare(
      `UPDATE pipeline_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), error = ?2 WHERE id = ?1`,
    )
      .bind(run!.id, err instanceof Error ? err.message : String(err))
      .run();
    throw err;
  }
}

async function executePipeline(env: Env) {
  const started = Date.now();
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.ANTHROPIC_BASE_URL || undefined,
    // Portkey authenticates with its own header; the gateway ignores x-api-key.
    defaultHeaders: env.ANTHROPIC_BASE_URL?.includes("portkey")
      ? { "x-portkey-api-key": env.ANTHROPIC_API_KEY }
      : undefined,
  });

  const settled = await Promise.allSettled(
    topicsConfig.topics.map((topic) => processTopic(client, env, topic)),
  );
  const topics: TopicResult[] = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : {
          topic: topicsConfig.topics[i].id,
          candidates: 0,
          known_excluded: 0,
          returned: 0,
          inserted: 0,
          skipped: 0,
          removed: 0,
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        },
  );

  const sum = (key: "returned" | "inserted" | "skipped" | "removed") =>
    topics.reduce((n, t) => n + t[key], 0);

  return {
    articles_inserted: sum("inserted"),
    articles_skipped: sum("skipped"),
    total_returned_by_claude: sum("returned"),
    removed_by_cap: sum("removed"),
    topics,
    duration_ms: Date.now() - started,
  };
}

async function processTopic(client: Anthropic, env: Env, topic: Topic): Promise<TopicResult> {
  const found = await searchTopic(env, topic);

  // Drop URLs already stored so Claude picks from new stories instead of re-selecting old ones.
  const known = await knownUrls(env, found.map((c) => c.url));
  const candidates = found.filter((c) => !known.has(c.url));

  const articles = candidates.length > 0 ? await selectArticles(client, env.ANTHROPIC_MODEL, topic, candidates) : [];

  let inserted = 0;
  if (articles.length > 0) {
    const insert = env.DB.prepare(
      `INSERT INTO articles (topic, headline, source, published_at, url, summary, relevance_score)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(url) DO NOTHING`,
    );
    const results = await env.DB.batch(
      articles.map((a) =>
        insert.bind(topic.id, a.headline, a.source, a.published_at, a.url, a.summary, a.relevance_score),
      ),
    );
    inserted = results.filter((r) => r.meta.changes > 0).length;
  }

  // Keep the newest MAX_ARTICLES_PER_TOPIC per topic; undated articles fall back to fetch time.
  const trimmed = await env.DB.prepare(
    `DELETE FROM articles
     WHERE topic = ?1 AND id NOT IN (
       SELECT id FROM articles WHERE topic = ?1
       ORDER BY COALESCE(published_at, fetched_at) DESC, id DESC
       LIMIT ?2
     )`,
  )
    .bind(topic.id, MAX_ARTICLES_PER_TOPIC)
    .run();

  return {
    topic: topic.id,
    candidates: candidates.length,
    known_excluded: found.length - candidates.length,
    returned: articles.length,
    inserted,
    skipped: articles.length - inserted,
    removed: trimmed.meta.changes,
  };
}

interface YdcResult {
  url?: string;
  title?: string;
  description?: string;
  snippets?: string[];
  page_age?: string;
}

async function searchTopic(env: Env, topic: Topic): Promise<Candidate[]> {
  const responses = await Promise.allSettled(
    topic.queries.map(async (query) => {
      const res = await fetch(YDC_SEARCH_URL, {
        method: "POST",
        headers: { "X-API-Key": env.YDC_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ query, count: RESULTS_PER_QUERY, freshness: "week", country: "US" }),
      });
      if (!res.ok) throw new Error(`You.com search ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { results?: { web?: YdcResult[]; news?: YdcResult[] } };
      return [...(body.results?.news ?? []), ...(body.results?.web ?? [])];
    }),
  );

  const failures = responses.filter((r) => r.status === "rejected");
  if (failures.length === responses.length) {
    throw new Error(`All searches failed: ${(failures[0] as PromiseRejectedResult).reason}`);
  }

  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const byUrl = new Map<string, Candidate>();
  for (const r of responses) {
    if (r.status !== "fulfilled") continue;
    for (const item of r.value) {
      if (!item.url || !item.title || !/^https?:\/\//i.test(item.url) || byUrl.has(item.url)) continue;
      const date = item.page_age?.slice(0, 10);
      const published_at = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
      if (published_at && published_at < cutoff) continue;
      if (urlPredatesCutoff(item.url, cutoff)) continue;
      byUrl.set(item.url, {
        id: byUrl.size + 1,
        url: item.url,
        title: item.title,
        domain: new URL(item.url).hostname.replace(/^www\./, ""),
        published_at,
        description: item.description ?? "",
        snippets: (item.snippets ?? []).slice(0, 3),
      });
    }
  }
  return [...byUrl.values()];
}

// page_age reflects the last crawl, so a re-crawled old article can look new; a dated URL path
// such as /2023/12/ is the more reliable signal. Compared at month granularity.
function urlPredatesCutoff(url: string, cutoff: string): boolean {
  const m = new URL(url).pathname.match(/\/(20\d{2})[/-](0?[1-9]|1[0-2])(?=[/-])/);
  if (!m) return false;
  return `${m[1]}-${m[2].padStart(2, "0")}` < cutoff.slice(0, 7);
}

async function knownUrls(env: Env, urls: string[]): Promise<Set<string>> {
  if (urls.length === 0) return new Set();
  const placeholders = urls.map((_, i) => `?${i + 1}`).join(", ");
  const { results } = await env.DB.prepare(`SELECT url FROM articles WHERE url IN (${placeholders})`)
    .bind(...urls)
    .all<{ url: string }>();
  return new Set(results.map((r) => r.url));
}

async function selectArticles(
  client: Anthropic,
  model: string,
  topic: Topic,
  candidates: Candidate[],
): Promise<Article[]> {
  const today = new Date().toISOString().slice(0, 10);
  const listing = candidates.map(({ id, title, domain, published_at, description, snippets }) => ({
    id,
    title,
    domain,
    published: published_at ?? "unknown",
    description,
    snippets,
  }));

  const prompt = `Today is ${today}. Below are web search results from the past ${MAX_AGE_DAYS} days for a news topic. Pick the ${ARTICLES_PER_TOPIC} most recent and significant items for someone building on-device AI products.

Topic: ${topic.name}
Scope: ${topic.description}

Skip items that are off-topic, generic explainers, listicles, SEO pages, job posts or duplicates of the same story (keep the most authoritative source). The "published" field is when the page was last crawled, so also skip anything whose title, snippets or URL show it first came out before the past ${MAX_AGE_DAYS} days. Prefer primary sources such as papers, vendor announcements and established trade press.

Search results:
${JSON.stringify(listing, null, 1)}

Reply with only a JSON array and no other text. Each element:
{"id": number (from the results), "headline": string (clear, factual), "source": string (publication or organization name), "summary": string (2-3 sentences, using only facts in the result), "relevance_score": integer 1-10}
If fewer than ${ARTICLES_PER_TOPIC} items qualify, return fewer; if none, return [].`;

  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    output_config: { effort: "medium" },
    messages: [{ role: "user", content: prompt }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined the request (${response.stop_details?.category ?? "no category"})`);
  }

  // Concatenate every text block before extracting the JSON array.
  const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return parseSelection(text, candidates);
}

function parseSelection(text: string, candidates: Candidate[]): Article[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) {
    throw new Error(`No JSON array in Claude's response: ${text.slice(0, 200)}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error(`Invalid JSON array in Claude's response: ${text.slice(start, start + 200)}`);
  }
  if (!Array.isArray(raw)) return [];

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const used = new Set<number>();
  const articles: Article[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    // URLs and dates come from the search result, never from the model.
    const candidate = byId.get(Number(r.id));
    if (!candidate || used.has(candidate.id)) continue;
    used.add(candidate.id);

    const score = Math.round(Number(r.relevance_score));
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    articles.push({
      headline: text(r.headline) ?? candidate.title,
      source: text(r.source) ?? candidate.domain,
      published_at: candidate.published_at,
      url: candidate.url,
      summary: text(r.summary),
      relevance_score: Number.isFinite(score) ? Math.min(10, Math.max(1, score)) : null,
    });
  }
  return articles.slice(0, ARTICLES_PER_TOPIC);
}
