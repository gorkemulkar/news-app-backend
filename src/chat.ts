import type Anthropic from "@anthropic-ai/sdk";
import { createClient, responseText } from "./claude";
import { BadRequestError, type Env } from "./types";
import { webSearch } from "./websearch";

const MAX_WEB_SEARCHES = 3;
const MAX_TOOL_ROUNDS = 3;
const WEB_RESULTS_PER_SEARCH = 6;

const WEB_SEARCH_TOOL: Anthropic.Tool = {
  name: "web_search",
  description:
    "Search the web for information the provided articles don't cover. Returns numbered results (title, URL, date, " +
    "snippet) that you can cite by number. Use specific queries, and include a year or month when recency matters.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "The search query" } },
    required: ["query"],
    additionalProperties: false,
  },
};

interface Source {
  n: number;
  kind: "article" | "web";
  id?: number;
  topic: string | null;
  headline: string;
  source: string | null;
  published_at: string | null;
  url: string;
}

// Rough token estimate (about 4 characters per token for English); labeled as approximate in the UI.
function estimateTokens(text: string): number {
  return Math.round(text.length / 4);
}

// Model preference -> model ID on the configured gateway. An allowlist, so callers can't pick arbitrary models.
const CHAT_MODELS = {
  opus: "@bedrock-global/us.anthropic.claude-opus-5-5",
  sonnet: "@bedrock-global/us.anthropic.claude-sonnet-5-5",
  haiku: "@bedrock-global/us.anthropic.claude-haiku-5-5",
} as const;
type ChatModel = keyof typeof CHAT_MODELS;
const DEFAULT_MODEL: ChatModel = "opus";

const MAX_QUESTION_CHARS = 2000;
const CONTEXT_ARTICLES = 10;
const LOOKBACK_DAYS = 30;

const STOPWORDS = new Set(
  ("a an and are as at be but by can did do does for from has have how i in is it its me my new news of on or " +
    "the their there these this to was what when where which who why will with any about latest recent week " +
    "tell give show summarize summary articles article anything happening happened").split(" "),
);

interface ArticleRow {
  id: number;
  topic: string;
  headline: string;
  source: string | null;
  published_at: string | null;
  url: string;
  summary: string | null;
  relevance_score: number | null;
  fetched_at: string;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9+.-]*[a-z0-9+]|[a-z0-9]/g) ?? []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t),
  );
}

// Keyword overlap, weighting headline matches above summary matches, nudged by relevance score and recency.
function rank(articles: ArticleRow[], question: string): ArticleRow[] {
  const terms = [...new Set(tokenize(question))];
  const now = Date.now();
  const scored = articles.map((a) => {
    const headline = new Set(tokenize(a.headline));
    const body = new Set(tokenize(`${a.summary ?? ""} ${a.source ?? ""} ${a.topic.replace(/-/g, " ")}`));
    // Prefix match so "quantize" finds "quantization" and "npu" finds "npus".
    const hits = (set: Set<string>, t: string) => [...set].some((w) => w === t || (t.length >= 4 && w.startsWith(t)));
    const keyword = terms.reduce((s, t) => s + (hits(headline, t) ? 3 : 0) + (hits(body, t) ? 1 : 0), 0);
    const ageDays = (now - Date.parse(a.published_at ?? a.fetched_at)) / 86_400_000;
    const boost = (a.relevance_score ?? 5) / 10 + Math.max(0, 1 - ageDays / LOOKBACK_DAYS);
    return { a, keyword, total: keyword + boost * 0.5 };
  });

  // With no keyword hits at all (e.g. "what's new?"), fall back to the most relevant recent articles.
  const anyHit = scored.some((s) => s.keyword > 0);
  return scored
    .filter((s) => !anyHit || s.keyword > 0)
    .sort((x, y) => y.total - x.total)
    .slice(0, CONTEXT_ARTICLES)
    .map((s) => s.a);
}

const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_CHARS = 6000;

// Prior turns as alternating user/assistant messages, oldest first, ending with an assistant reply.
function parseHistory(raw: unknown): { role: "user" | "assistant"; content: string }[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new BadRequestError("history must be an array of {role, content}");
  const messages = raw.slice(-MAX_HISTORY_MESSAGES).map((m, i) => {
    const { role, content } = (m ?? {}) as Record<string, unknown>;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || !content.trim()) {
      throw new BadRequestError(`history[${i}] must be {role: "user" | "assistant", content: string}`);
    }
    return { role, content: content.slice(0, MAX_HISTORY_CHARS) } as { role: "user" | "assistant"; content: string };
  });
  // Trimming to the last N can leave a leading assistant turn; the conversation must open with the user.
  while (messages[0]?.role === "assistant") messages.shift();
  messages.forEach((m, i) => {
    if (m.role !== (i % 2 === 0 ? "user" : "assistant")) throw new BadRequestError("history must alternate user and assistant");
  });
  if (messages.length % 2 !== 0) throw new BadRequestError("history must end with an assistant message");
  return messages;
}

export async function chat(env: Env, body: unknown) {
  if (typeof body !== "object" || body === null) throw new BadRequestError("Send a JSON body: {\"question\": \"...\"}");
  const {
    question: rawQuestion,
    model: rawModel,
    topic,
    history: rawHistory,
    web_search: rawWeb,
  } = body as Record<string, unknown>;
  const history = parseHistory(rawHistory);

  const question = typeof rawQuestion === "string" ? rawQuestion.trim() : "";
  if (!question) throw new BadRequestError("question is required");
  if (question.length > MAX_QUESTION_CHARS) throw new BadRequestError(`question must be at most ${MAX_QUESTION_CHARS} characters`);

  const model = (rawModel ?? DEFAULT_MODEL) as string;
  if (!(model in CHAT_MODELS)) throw new BadRequestError(`model must be one of: ${Object.keys(CHAT_MODELS).join(", ")}`);
  if (topic !== undefined && typeof topic !== "string") throw new BadRequestError("topic must be a string");
  if (rawWeb !== undefined && typeof rawWeb !== "boolean") throw new BadRequestError("web_search must be true or false");
  const webEnabled = rawWeb === true;

  const { results } = await env.DB.prepare(
    `SELECT id, topic, headline, source, published_at, url, summary, relevance_score, fetched_at
     FROM articles
     WHERE COALESCE(published_at, fetched_at) >= date('now', ?1) ${topic ? "AND topic = ?2" : ""}`,
  )
    .bind(`-${LOOKBACK_DAYS} days`, ...(topic ? [topic] : []))
    .all<ArticleRow>();

  // Follow-ups like "tell me more about the first one" carry few keywords, so also match on the previous question.
  const previousQuestion = history.at(-2)?.content ?? "";
  const context = rank(results, `${question} ${previousQuestion}`);
  const sources: Source[] = context.map((a, i) => ({
    n: i + 1,
    kind: "article",
    id: a.id,
    topic: a.topic,
    headline: a.headline,
    source: a.source,
    published_at: a.published_at,
    url: a.url,
  }));

  if (context.length === 0 && !webEnabled) {
    return {
      answer: "There are no stored articles from the past 30 days to answer from yet. Run the agent first, or turn on web search.",
      model,
      sources,
      context: { articles: 0, article_tokens_est: 0 },
      web: { enabled: false, searches: [], result_tokens_est: 0 },
      usage: { input_tokens: 0, output_tokens: 0, model_calls: 0 },
    };
  }

  const articleBlock = context
    .map(
      (a, i) =>
        `[${i + 1}] ${a.headline}\nSource: ${a.source ?? "unknown"} | Published: ${a.published_at ?? "unknown"} | Topic: ${a.topic} | Relevance: ${a.relevance_score ?? "?"}/10\n${a.summary ?? ""}`,
    )
    .join("\n\n");

  const system =
    "You answer questions for an engineer who builds on-device audio ML and edge AI products, using a news digest. " +
    (webEnabled
      ? "Answer from the numbered articles first. When they don't cover what's asked, use the web_search tool, then " +
        "cite web results by the numbers the tool gives them. Say which parts come from the web. "
      : "Answer only from the numbered articles the user provides. If they don't cover the question, say so plainly " +
        "instead of drawing on outside knowledge. ") +
    "Cite sources inline as [1], [2]. Be concise and concrete: lead with the answer, then the supporting details. " +
    "Earlier turns cited earlier lists; in your answer, cite only the numbers given in this turn.";

  const messages: Anthropic.MessageParam[] = [
    ...history,
    {
      role: "user",
      content: `Today is ${new Date().toISOString().slice(0, 10)}.\n\nArticles:\n\n${articleBlock}\n\nQuestion: ${question}`,
    },
  ];

  const client = createClient(env);
  const usage = { input_tokens: 0, output_tokens: 0, model_calls: 0 };
  const web = { enabled: webEnabled, searches: [] as { query: string; results: number; error?: string }[], result_tokens_est: 0 };
  let response: Anthropic.Message;

  // Tool loop: Claude may call web_search (run by the Worker against You.com) before answering.
  // The last round withholds tools (tool_choice none) so the loop always ends with an answer.
  for (let round = 0; ; round++) {
    const toolsAllowed = webEnabled && web.searches.length < MAX_WEB_SEARCHES && round < MAX_TOOL_ROUNDS;
    response = await client.messages.create({
      model: CHAT_MODELS[model as ChatModel],
      max_tokens: 4000,
      output_config: { effort: "medium" },
      system,
      messages,
      ...(webEnabled && { tools: [WEB_SEARCH_TOOL], tool_choice: { type: toolsAllowed ? "auto" : "none" } as const }),
    });
    usage.input_tokens += response.usage.input_tokens;
    usage.output_tokens += response.usage.output_tokens;
    usage.model_calls++;

    if (response.stop_reason === "refusal") {
      throw new Error(`Claude declined the question (${response.stop_details?.category ?? "no category"})`);
    }
    if (response.stop_reason !== "tool_use") break;

    // Answer every tool call in this turn (Claude can issue several at once), in one user message.
    const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      calls.map(async (call) => {
        const query = typeof (call.input as { query?: unknown })?.query === "string" ? (call.input as { query: string }).query.trim() : "";
        if (!query || web.searches.length >= MAX_WEB_SEARCHES) {
          const reason = query ? "Search limit reached; answer with what you have." : "Missing query.";
          return { type: "tool_result", tool_use_id: call.id, content: reason, is_error: true };
        }
        const entry: { query: string; results: number; error?: string } = { query, results: 0 };
        web.searches.push(entry);
        try {
          const results = (await webSearch(env, query, { count: WEB_RESULTS_PER_SEARCH }))
            .filter((r) => r.url && r.title && /^https?:\/\//i.test(r.url))
            .slice(0, WEB_RESULTS_PER_SEARCH);
          entry.results = results.length;
          const lines = results.map((r) => {
            const n = sources.length + 1;
            sources.push({
              n,
              kind: "web",
              topic: null,
              headline: r.title!,
              source: new URL(r.url!).hostname.replace(/^www\./, ""),
              published_at: r.page_age?.slice(0, 10) ?? null,
              url: r.url!,
            });
            const snippet = [r.description, ...(r.snippets ?? []).slice(0, 2)].filter(Boolean).join(" ").slice(0, 600);
            return `[${n}] ${r.title}\nURL: ${r.url} | Date: ${r.page_age?.slice(0, 10) ?? "unknown"}\n${snippet}`;
          });
          const text = lines.length ? lines.join("\n\n") : "No results.";
          web.result_tokens_est += estimateTokens(text);
          return { type: "tool_result", tool_use_id: call.id, content: text };
        } catch (err) {
          entry.error = err instanceof Error ? err.message : String(err);
          return { type: "tool_result", tool_use_id: call.id, content: `Search failed: ${entry.error}`, is_error: true };
        }
      }),
    );
    // Pass the assistant turn back unchanged (it may hold thinking blocks), then the results.
    messages.push({ role: "assistant", content: response.content }, { role: "user", content: toolResults });
  }

  return {
    answer: responseText(response).trim(),
    model,
    sources,
    context: { articles: context.length, article_tokens_est: estimateTokens(articleBlock) },
    web,
    usage,
  };
}
