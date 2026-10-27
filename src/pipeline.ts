import Anthropic from "@anthropic-ai/sdk";
import topicsConfig from "../topics.json";
import { createClient, responseText } from "./claude";
import type { Env } from "./types";
import { webSearch, type WebResult } from "./websearch";

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
  score_reason: string | null;
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
const ARXIV_API_URL = "https://export.arxiv.org/api/query";
const ARXIV_MAX_RESULTS = 150;
const ARXIV_ABSTRACT_CHARS = 500;

// Shown to Claude and mirrored in the dashboard's "How scores work" panel.
export const SCORE_RUBRIC = `9-10: Major and directly actionable for on-device AI work: a new NPU, MCU or edge SoC launch; a major runtime or compiler release; a paper that sets a clear new state of the art for an on-device audio task. Primary source.
7-8: Clearly relevant and substantive: a notable product or feature launch, a solid paper with efficiency or real-time results, an important SDK or toolchain update.
5-6: Relevant but incremental: a minor update, early-stage or narrow research, secondary coverage of known news.
3-4: Tangential: general AI news with a weak on-device angle, or cloud-only work.
1-2: Barely related to the topic.
For research, weigh efficiency (model size, latency, power, streaming) and reproducibility (code, benchmarks) above novelty alone.`;

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
         articles_inserted = ?2, articles_skipped = ?3, total_returned = ?4, details = ?5 WHERE id = ?1`,
    )
      .bind(
        run!.id,
        result.articles_inserted,
        result.articles_skipped,
        result.total_returned_by_claude,
        JSON.stringify(result.topics),
      )
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
  const client = createClient(env);

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
      `INSERT INTO articles (topic, headline, source, published_at, url, summary, relevance_score, score_reason)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(url) DO NOTHING`,
    );
    const results = await env.DB.batch(
      articles.map((a) =>
        insert.bind(
          topic.id,
          a.headline,
          a.source,
          a.published_at,
          a.url,
          a.summary,
          a.relevance_score,
          a.score_reason,
        ),
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

async function searchTopic(env: Env, topic: Topic): Promise<Candidate[]> {
  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const searches: Promise<WebResult[]>[] = topic.queries.map((query) =>
    webSearch(env, query, { count: RESULTS_PER_QUERY, freshness: "week" }),
  );
  if (topic.arxiv_query) searches.push(searchArxiv(topic.arxiv_query));
  const responses = await Promise.allSettled(searches);

  const failures = responses.filter((r) => r.status === "rejected");
  if (failures.length === responses.length) {
    throw new Error(`All searches failed: ${(failures[0] as PromiseRejectedResult).reason}`);
  }

  const byUrl = new Map<string, Candidate>();
  for (const r of responses) {
    if (r.status !== "fulfilled") continue;
    for (const item of r.value) {
      if (!item.url || !item.title || !/^https?:\/\//i.test(item.url)) continue;
      const url = normalizeUrl(item.url);
      if (byUrl.has(url)) continue;
      const date = item.page_age?.slice(0, 10);
      const published_at = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
      if (published_at && published_at < cutoff) continue;
      if (urlPredatesCutoff(url, cutoff)) continue;
      byUrl.set(url, {
        id: byUrl.size + 1,
        url,
        title: item.title,
        domain: new URL(url).hostname.replace(/^www\./, ""),
        published_at,
        description: item.description ?? "",
        snippets: (item.snippets ?? []).slice(0, 3),
      });
    }
  }
  return [...byUrl.values()];
}

// Newest arXiv submissions matching the query (arXiv search syntax), shaped like search results.
// Web search rarely surfaces new papers, so research topics read arXiv directly.
async function searchArxiv(query: string): Promise<WebResult[]> {
  const params = new URLSearchParams({
    search_query: query,
    sortBy: "submittedDate",
    sortOrder: "descending",
    max_results: String(ARXIV_MAX_RESULTS),
  });
  const res = await fetch(`${ARXIV_API_URL}?${params}`, {
    headers: { "User-Agent": "news-app-backend (https://github.com/gorkemulkar/news-app-backend)" },
  });
  if (!res.ok) throw new Error(`arXiv ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const xml = await res.text();

  const field = (entry: string, tag: string) =>
    decodeXml(entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? "")
      .replace(/\s+/g, " ")
      .trim();

  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]) => {
    const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => decodeXml(m[1]).trim());
    const abstract = field(entry, "summary");
    return {
      url: field(entry, "id"),
      title: field(entry, "title"),
      description: abstract.length > ARXIV_ABSTRACT_CHARS ? `${abstract.slice(0, ARXIV_ABSTRACT_CHARS)}…` : abstract,
      snippets: authors.length ? [`Authors: ${authors.slice(0, 4).join(", ")}${authors.length > 4 ? " et al." : ""}`] : [],
      page_age: field(entry, "published"),
    };
  });
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// One canonical URL per paper: arXiv versions (v1, v2), /pdf/ links and http all map to https /abs/<id>.
function normalizeUrl(url: string): string {
  const arxiv = url.match(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:v\d+)?(?:\.pdf)?(?:[?#].*)?$/i);
  return arxiv ? `https://arxiv.org/abs/${arxiv[1]}` : url;
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
  // One JSON parameter instead of one per URL: D1 caps a statement at 100 bound parameters.
  const { results } = await env.DB.prepare(
    "SELECT url FROM articles WHERE url IN (SELECT value FROM json_each(?1))",
  )
    .bind(JSON.stringify(urls))
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

  const prompt = `Today is ${today}. Below are web search results and arXiv papers from the past ${MAX_AGE_DAYS} days for a news topic. Pick the ${ARTICLES_PER_TOPIC} most recent and significant items for someone building on-device AI products.

Topic: ${topic.name}
Scope: ${topic.description}

Skip items that are off-topic, generic explainers, listicles, SEO pages, job posts or duplicates of the same story (keep the most authoritative source). The "published" field is when the page was last crawled, so also skip anything whose title, snippets or URL show it first came out before the past ${MAX_AGE_DAYS} days. Prefer primary sources such as papers, vendor announcements and established trade press.

Score each pick with this relevance rubric:
${SCORE_RUBRIC}

Search results:
${JSON.stringify(listing, null, 1)}

Reply with only a JSON array and no other text. Each element:
{"id": number (from the results), "headline": string (clear, factual), "source": string (publication or organization name; "arXiv" for arXiv papers), "summary": string (2-3 sentences, using only facts in the result), "relevance_score": integer 1-10, "score_reason": string (one short sentence on why it earned that score under the rubric)}
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

  return parseSelection(responseText(response), candidates);
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
      score_reason: text(r.score_reason),
    });
  }
  return articles.slice(0, ARTICLES_PER_TOPIC);
}
