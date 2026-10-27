import { createClient, responseText } from "./claude";
import { BadRequestError, type Env } from "./types";

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
  const { question: rawQuestion, model: rawModel, topic, history: rawHistory } = body as Record<string, unknown>;
  const history = parseHistory(rawHistory);

  const question = typeof rawQuestion === "string" ? rawQuestion.trim() : "";
  if (!question) throw new BadRequestError("question is required");
  if (question.length > MAX_QUESTION_CHARS) throw new BadRequestError(`question must be at most ${MAX_QUESTION_CHARS} characters`);

  const model = (rawModel ?? DEFAULT_MODEL) as string;
  if (!(model in CHAT_MODELS)) throw new BadRequestError(`model must be one of: ${Object.keys(CHAT_MODELS).join(", ")}`);
  if (topic !== undefined && typeof topic !== "string") throw new BadRequestError("topic must be a string");

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
  const sources = context.map((a, i) => ({
    n: i + 1,
    id: a.id,
    topic: a.topic,
    headline: a.headline,
    source: a.source,
    published_at: a.published_at,
    url: a.url,
  }));

  if (context.length === 0) {
    return {
      answer: "There are no stored articles from the past 30 days to answer from yet. Run the agent first.",
      model,
      sources,
    };
  }

  const articleBlock = context
    .map(
      (a, i) =>
        `[${i + 1}] ${a.headline}\nSource: ${a.source ?? "unknown"} | Published: ${a.published_at ?? "unknown"} | Topic: ${a.topic} | Relevance: ${a.relevance_score ?? "?"}/10\n${a.summary ?? ""}`,
    )
    .join("\n\n");

  const response = await createClient(env).messages.create({
    model: CHAT_MODELS[model as ChatModel],
    max_tokens: 4000,
    output_config: { effort: "medium" },
    system:
      "You answer questions for an engineer who builds on-device audio ML and edge AI products, using a news digest. " +
      "Answer only from the numbered articles the user provides, and cite them inline as [1], [2]. " +
      "If the articles don't cover the question, say so plainly instead of drawing on outside knowledge. " +
      "Be concise and concrete: lead with the answer, then the supporting details. " +
      "Earlier turns cited earlier article lists; in your answer, cite only the numbers in the current list.",
    messages: [
      ...history,
      {
        role: "user",
        content: `Today is ${new Date().toISOString().slice(0, 10)}.\n\nArticles:\n\n${articleBlock}\n\nQuestion: ${question}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined the question (${response.stop_details?.category ?? "no category"})`);
  }

  return {
    answer: responseText(response).trim(),
    model,
    sources,
    usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
  };
}
