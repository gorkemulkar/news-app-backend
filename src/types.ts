export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_MODEL: string;
  SCHEDULE_TIMEZONE: string;
  SCHEDULE_HOUR: string;
}

export class BadRequestError extends Error {}
