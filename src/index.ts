import topicsConfig from "../topics.json";
import { listArticles } from "./articles";
import { runPipeline, SCORE_RUBRIC } from "./pipeline";
import { BadRequestError, type Env } from "./types";

// Manual runs spend real API credit, so a public Refresh button can start at most one run per window.
const MANUAL_RUN_COOLDOWN_SECONDS = 300;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const ENDPOINTS = {
  "/health": "Service status and current timestamp",
  "/topics": "Configured news topics and the relevance-score rubric",
  "/articles":
    "Stored articles; filters: topic, from, to (YYYY-MM-DD), source, min_score (1-10), limit; sort: published (default), added, score",
  "/agent": "Runs the news pipeline now (also runs daily at 7 AM America/New_York); one manual run per 5 minutes",
};

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
          const wait = await secondsUntilNextManualRun(env);
          if (wait > 0) {
            return json({ error: `The agent ran recently; try again in ${wait} seconds`, retry_after_seconds: wait }, 429);
          }
          return json(await runPipeline(env, "manual"));
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
