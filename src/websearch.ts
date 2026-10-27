import type { Env } from "./types";

const YDC_SEARCH_URL = "https://ydc-index.io/v1/search";

export interface WebResult {
  url?: string;
  title?: string;
  description?: string;
  snippets?: string[];
  page_age?: string;
}

// You.com search: news results first, then web results.
export async function webSearch(
  env: Env,
  query: string,
  options: { count?: number; freshness?: "day" | "week" | "month" | "year" } = {},
): Promise<WebResult[]> {
  const res = await fetch(YDC_SEARCH_URL, {
    method: "POST",
    headers: { "X-API-Key": env.YDC_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ query, count: options.count ?? 10, country: "US", ...(options.freshness && { freshness: options.freshness }) }),
  });
  if (!res.ok) throw new Error(`You.com search ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { results?: { web?: WebResult[]; news?: WebResult[] } };
  return [...(body.results?.news ?? []), ...(body.results?.web ?? [])];
}
