export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_MODEL: string;
  YDC_API_KEY: string;
  SCHEDULE_TIMEZONE: string;
  SCHEDULE_HOUR: string;
}

export class BadRequestError extends Error {}
