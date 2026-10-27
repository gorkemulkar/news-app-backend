import topicsConfig from "../topics.json";
import { listArticles } from "./articles";
import { chat } from "./chat";
import { runPipeline, SCORE_RUBRIC } from "./pipeline";
import { BadRequestError, type Env } from "./types";

// Manual runs spend real API credit, so a public Refresh button can start at most one run per window.
const MANUAL_RUN_COOLDOWN_SECONDS = 300;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const ENDPOINTS = {
  "/health": "Service status and current timestamp",
  "/topics": "Configured news topics and the relevance-score rubric",
  "/articles":
    "Stored articles; filters: topic, from, to (YYYY-MM-DD), source, min_score (1-10), limit; sort: published (default), added, score",
  "/agent":
    "Runs the news pipeline now; requires Authorization: Bearer <password>. Also runs daily at 7 AM America/New_York; one manual run per 5 minutes",
  "/chat":
    'POST {"question": "...", "model": "opus" (default) | "sonnet" | "haiku", "topic": optional, "web_search": false (default) | true, "history": optional}; answers from stored articles, plus web search (You.com) when enabled; requires Authorization: Bearer <password>',
};

// Paid endpoints (/agent, /chat) share one password. Fails closed when the secret is unset.
async function requirePassword(request: Request, env: Env): Promise<Response | null> {
  if (!env.AGENT_PASSWORD) return json({ error: "The agent password is not configured" }, 503);
  if (await isAuthorized(request, env)) return null;
  return Response.json(
    { error: "Unauthorized: send the agent password as 'Authorization: Bearer <password>'" },
    { status: 401, headers: { ...CORS_HEADERS, "WWW-Authenticate": 'Bearer realm="news-agent"' } },
  );
}

const encoder = new TextEncoder();

// Compares SHA-256 digests in constant time, so neither the password's length nor its content leaks through timing.
async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const match = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const [given, expected] = await Promise.all(
    [match[1].trim(), env.AGENT_PASSWORD].map((s) => crypto.subtle.digest("SHA-256", encoder.encode(s))),
  );
  return crypto.subtle.timingSafeEqual(given, expected);
}

async function secondsUntilNextManualRun(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT CAST(strftime('%s', 'now') - strftime('%s', MAX(started_at)) AS INTEGER) AS elapsed
     FROM pipeline_runs WHERE trigger = 'manual'`,
  ).first<{ elapsed: number | null }>();
  return row?.elapsed == null ? 0 : Math.max(0, MANUAL_RUN_COOLDOWN_SECONDS - row.elapsed);
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

// Cron runs in UTC, so two triggers bracket 7 AM local across DST and this picks the right one.
function isScheduledLocalHour(time: number, env: Env): boolean {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: env.SCHEDULE_TIMEZONE,
    hour: "numeric",
    hourCycle: "h23",
  }).format(new Date(time));
  return Number(hour) === Number(env.SCHEDULE_HOUR);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const { pathname, searchParams } = new URL(request.url);

    try {
      switch (pathname) {
        case "/":
          return json({ service: "news-app-backend", endpoints: ENDPOINTS });
        case "/health":
          return json({ status: "ok", service: "news-app-backend", timestamp: new Date().toISOString() });
        case "/topics":
          return json({
            topics: topicsConfig.topics.map(({ id, name, description }) => ({ id, name, description })),
            score_rubric: SCORE_RUBRIC,
          });
        case "/agent": {
          const denied = await requirePassword(request, env);
          if (denied) return denied;
          const wait = await secondsUntilNextManualRun(env);
          if (wait > 0) {
            return json({ error: `The agent ran recently; try again in ${wait} seconds`, retry_after_seconds: wait }, 429);
          }
          return json(await runPipeline(env, "manual"));
        }
        case "/chat": {
          if (request.method !== "POST") return json({ error: "Use POST with a JSON body" }, 405);
          const denied = await requirePassword(request, env);
          if (denied) return denied;
          const body = await request.json().catch(() => {
            throw new BadRequestError("Body must be valid JSON");
          });
          return json(await chat(env, body));
        }
        case "/articles":
          return json(await listArticles(env, searchParams));
        default:
          return json({ error: "Not found", endpoints: ENDPOINTS }, 404);
      }
    } catch (err) {
      const status = err instanceof BadRequestError ? 400 : 500;
      return json({ error: err instanceof Error ? err.message : String(err) }, status);
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!isScheduledLocalHour(controller.scheduledTime, env)) return;
    ctx.waitUntil(
      runPipeline(env, "scheduled").then((result) => console.log("scheduled pipeline", JSON.stringify(result))),
    );
  },
} satisfies ExportedHandler<Env>;
