import { BadRequestError, type Env } from "./types";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /articles?topic=&from=YYYY-MM-DD&to=YYYY-MM-DD&source=&min_score=&limit=
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

  const sql = `SELECT id, topic, headline, source, published_at, url, summary, relevance_score, fetched_at
    FROM articles
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY published_at IS NULL, published_at DESC, relevance_score DESC, id DESC
    LIMIT ?${binds.length}`;

  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return { count: results.length, articles: results };
}
