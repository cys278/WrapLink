export interface AppConfig {
  host: string;
  port: number;
  baseUrl: string;
  logLevel: string;
  maxLinks: number;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  return {
    host: process.env.HOST ?? "0.0.0.0",
    port: integer("PORT", 3000),
    baseUrl: (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    logLevel: process.env.LOG_LEVEL ?? "info",
    maxLinks: integer("MAX_LINKS", 100_000),
  };
}
