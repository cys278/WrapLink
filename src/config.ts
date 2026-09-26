export interface AppConfig {
  host: string;
  port: number;
  baseUrl: string;
  logLevel: string;
  maxLinks: number;
  databaseUrl: string;
  databasePoolMax: number;
  redisUrl: string;
  redisClusterUrls: readonly string[];
  redisCacheTtlSeconds: number;
  createRateLimitMax: number;
  createRateLimitWindowSeconds: number;
  createApiKeys: readonly string[];
}

function integer(
  name: string,
  fallback: number,
): number {
  const raw = process.env[name];

  if (raw === undefined) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);

  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new Error(
      `${name} must be a positive integer`,
    );
  }

  return value;
}

function requiredList(name: string): string[] {
  const raw = process.env[name];

  if (!raw) {
    throw new Error(
      `${name} must contain at least one value`,
    );
  }

  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (values.length === 0) {
    throw new Error(
      `${name} must contain at least one value`,
    );
  }

  return values;
}

export function loadConfig(): AppConfig {
  return {
    host: process.env.HOST ?? "0.0.0.0",

    port: integer("PORT", 3000),

    baseUrl: (
      process.env.BASE_URL ??
      "http://localhost:3000"
    ).replace(/\/$/, ""),

    logLevel:
      process.env.LOG_LEVEL ?? "info",

    maxLinks: integer(
      "MAX_LINKS",
      100_000,
    ),

    databaseUrl:
      process.env.DATABASE_URL ??
      "postgresql://shortener:shortener@127.0.0.1:55432/shortener",

    databasePoolMax: integer(
      "DATABASE_POOL_MAX",
      20,
    ),

    redisUrl:
      process.env.REDIS_URL ??
      "redis://127.0.0.1:6379",

    redisClusterUrls:
      process.env.REDIS_CLUSTER_URLS
        ?.split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0) ??
      [],

    redisCacheTtlSeconds: integer(
      "REDIS_CACHE_TTL_SECONDS",
      300,
    ),

    createRateLimitMax: integer(
      "CREATE_RATE_LIMIT_MAX",
      20,
    ),

    createRateLimitWindowSeconds: integer(
      "CREATE_RATE_LIMIT_WINDOW_SECONDS",
      60,
    ),

    createApiKeys: requiredList(
      "CREATE_API_KEYS",
    ),
  };
}