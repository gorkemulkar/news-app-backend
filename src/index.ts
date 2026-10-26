import { listArticles } from "./articles";
import { runPipeline } from "./pipeline";
import { BadRequestError, type Env } from "./types";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const ENDPOINTS = {
  "/health": "Service status and current timestamp",
  "/articles": "Stored articles; filters: topic, from, to (YYYY-MM-DD), source, min_score (1-10), limit",
  "/agent": "Runs the news pipeline now (also runs daily at 7 AM America/New_York)",
};

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
        case "/agent":
          return json(await runPipeline(env));
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
      runPipeline(env).then((result) => console.log("scheduled pipeline", JSON.stringify(result))),
    );
  },
} satisfies ExportedHandler<Env>;
