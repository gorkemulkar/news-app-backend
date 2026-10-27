import { BadRequestError, type Env } from "./types";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ORDER_BY = {
  published: "published_at IS NULL, published_at DESC, relevance_score DESC, id DESC",
  added: "fetched_at DESC, relevance_score DESC, id DESC",
  score: "relevance_score IS NULL, relevance_score DESC, published_at DESC, id DESC",
} as const;

// GET /articles?topic=&from=YYYY-MM-DD&to=YYYY-MM-DD&source=&min_score=&limit=&sort=published|added|score
export async function listArticles(env: Env, params: URLSearchParams) {
  const where: string[] = [];
  const binds: (string | number)[] = [];
  const add = (clause: string, value: string | number) => {
    binds.push(value);
    where.push(clause.replace("?", `?${binds.length}`));
  };

  const topic = params.get("topic");
  if (topic) add("topic = ?", topic);

  for (const [key, op] of [["from", ">="], ["to", "<="]] as const) {
    const value = params.get(key);
    if (!value) continue;
    if (!DATE_RE.test(value)) throw new BadRequestError(`${key} must be YYYY-MM-DD`);
    add(`published_at ${op} ?`, value);
  }

  const source = params.get("source");
  if (source) add("source LIKE ? COLLATE NOCASE", `%${source}%`);

  const minScore = params.get("min_score");
  if (minScore) {
    const n = Number(minScore);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw new BadRequestError("min_score must be an integer 1-10");
    add("relevance_score >= ?", n);
  }

  const limitParam = params.get("limit");
  const limit = limitParam ? Number(limitParam) : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new BadRequestError("limit must be a positive integer");
  binds.push(Math.min(limit, MAX_LIMIT));

  const sort = params.get("sort") ?? "published";
  if (!(sort in ORDER_BY)) throw new BadRequestError(`sort must be one of: ${Object.keys(ORDER_BY).join(", ")}`);

  const sql = `SELECT id, topic, headline, source, published_at, url, summary, relevance_score, score_reason, fetched_at
    FROM articles
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${ORDER_BY[sort as keyof typeof ORDER_BY]}
    LIMIT ?${binds.length}`;

  const [{ results }, runs] = await Promise.all([env.DB.prepare(sql).bind(...binds).all(), runTimes(env)]);
  return { count: results.length, ...runs, articles: results };
}

// last_refreshed: last successful run (falls back to the newest fetch for data that predates run tracking).
// latest_additions_at: start of the most recent run that added articles; anything fetched since is "new".
async function runTimes(env: Env): Promise<{ last_refreshed: string | null; latest_additions_at: string | null }> {
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(
         (SELECT MAX(finished_at) FROM pipeline_runs WHERE error IS NULL AND finished_at IS NOT NULL),
         (SELECT MAX(fetched_at) FROM articles)
       ) AS last_refreshed,
       (SELECT MAX(started_at) FROM pipeline_runs WHERE articles_inserted > 0) AS latest_additions_at`,
  ).first<{ last_refreshed: string | null; latest_additions_at: string | null }>();
  return { last_refreshed: row?.last_refreshed ?? null, latest_additions_at: row?.latest_additions_at ?? null };
}
