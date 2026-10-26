import Anthropic from "@anthropic-ai/sdk";
import topicsConfig from "../topics.json";
import type { Env } from "./types";

type Topic = (typeof topicsConfig.topics)[number];

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
  returned: number;
  inserted: number;
  skipped: number;
  removed: number;
  error?: string;
}

const ARTICLES_PER_TOPIC = 5;
const MAX_ARTICLES_PER_TOPIC = 20;
const MAX_PAUSE_CONTINUATIONS = 4;

export async function runPipeline(env: Env) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY secret is not set");

  const started = Date.now();
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const settled = await Promise.allSettled(
    topicsConfig.topics.map((topic) => processTopic(client, env, topic)),
  );
  const topics: TopicResult[] = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : {
          topic: topicsConfig.topics[i].id,
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
  const articles = await findArticles(client, env.ANTHROPIC_MODEL, topic);

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
    returned: articles.length,
    inserted,
    skipped: articles.length - inserted,
    removed: trimmed.meta.changes,
  };
}

async function findArticles(client: Anthropic, model: string, topic: Topic): Promise<Article[]> {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Today is ${today}. Use web search to find the ${ARTICLES_PER_TOPIC} most recent and significant news articles or papers published in the past 7 days on this topic.

Topic: ${topic.name}
Scope: ${topic.description}
Useful keywords: ${topic.keywords.join(", ")}
Typical sources: ${topic.sources.join(", ")}

Only include items published in the past 7 days, each with a direct URL to the article or paper itself (not a search, tag or listing page). Rank by significance to someone building on-device AI products.

Reply with only a JSON array and no other text. Each element:
{"headline": string, "source": string (publication or site name), "published_date": "YYYY-MM-DD", "url": string, "summary": string (2-3 sentences), "relevance_score": integer from 1 to 10}
If fewer than ${ARTICLES_PER_TOPIC} items qualify, return fewer; if none, return [].`;

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
  // The web search tool splits the answer across many content blocks (and possibly across
  // pause_turn continuations), so collect every text block before extracting the JSON.
  let text = "";

  for (let attempt = 0; attempt <= MAX_PAUSE_CONTINUATIONS; attempt++) {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
      messages,
    });

    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }

    if (response.stop_reason === "refusal") {
      throw new Error(`Claude declined the request (${response.stop_details?.category ?? "no category"})`);
    }
    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content });
  }

  return parseArticles(text);
}

function parseArticles(text: string): Article[] {
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

  const seen = new Set<string>();
  const articles: Article[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const url = typeof r.url === "string" ? r.url.trim() : "";
    const headline = typeof r.headline === "string" ? r.headline.trim() : "";
    if (!/^https?:\/\//i.test(url) || !headline || seen.has(url)) continue;
    seen.add(url);

    const date = typeof r.published_date === "string" ? r.published_date.slice(0, 10) : "";
    const score = Math.round(Number(r.relevance_score));
    articles.push({
      headline,
      source: typeof r.source === "string" && r.source.trim() ? r.source.trim() : null,
      published_at: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      url,
      summary: typeof r.summary === "string" && r.summary.trim() ? r.summary.trim() : null,
      relevance_score: Number.isFinite(score) ? Math.min(10, Math.max(1, score)) : null,
    });
  }
  return articles.slice(0, ARTICLES_PER_TOPIC);
}
