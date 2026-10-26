export interface Env {
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      const row = await env.DB.prepare("SELECT COUNT(*) AS articles FROM articles").first<{ articles: number }>();
      return Response.json({ ok: true, articles: row?.articles ?? 0 });
    }

    return new Response("news-app-backend", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
