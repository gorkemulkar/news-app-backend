import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./types";

export function createClient(env: Env): Anthropic {
  return new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.ANTHROPIC_BASE_URL || undefined,
    // Portkey authenticates with its own header; the gateway ignores x-api-key.
    defaultHeaders: env.ANTHROPIC_BASE_URL?.includes("portkey")
      ? { "x-portkey-api-key": env.ANTHROPIC_API_KEY }
      : undefined,
  });
}

// Concatenate every text block; tool and thinking blocks carry no answer text.
export function responseText(response: Anthropic.Message): string {
  return response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}
