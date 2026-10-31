export type LinkWriteMode = "sync" | "write-behind";

export interface AppConfig {
  host: string;
  port: number;
  baseUrl: string;
  logLevel: string;
  /** Honour X-Forwarded-For when running behind a load balancer. */
  trustProxy: boolean;
  maxLinks: number;
  databaseUrl: string;
  databasePoolMax: number;
  redisUrl: string;
  redisClusterUrls: readonly string[];
  /** Serve cluster reads from replicas (may briefly lag behind masters). */
  redisClusterUseReplicas: boolean;
  redisCacheTtlSeconds: number;
  createRateLimitMax: number;
  createRateLimitWindowSeconds: number;
  createApiKeys: readonly string[];
  clickFlushIntervalMs: number;
  clickBufferMax: number;
  /**
   * "sync": every link is inserted into PostgreSQL before the response.
   * "write-behind": generated links are acknowledged from Redis and synced
   * to PostgreSQL in batches by a background worker.
   */
  linkWriteMode: LinkWriteMode;
  writeBehindMaxPending: number;
  linkSyncEnabled: boolean;
  linkSyncIntervalMs: number;
  linkSyncBatchSize: number;
  /** Key for the short-code permutation. Required in write-behind mode. */
  codeScrambleSecret: string | undefined;
}

function integer(
  name: string,
  fallback: number,
): number {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw.trim());

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

function boolean(
  name: string,
  fallback: boolean,
): boolean {
  const raw = process.env[name]?.trim().toLowerCase();

  if (raw === undefined || raw === "") {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }

  throw new Error(`${name} must be true or false`);
}

function list(name: string): string[] {
  return (
    process.env[name]
      ?.split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0) ?? []
  );
}

function requiredList(name: string): string[] {
  const values = list(name);

  if (values.length === 0) {
    throw new Error(
      `${name} must contain at least one value`,
    );
  }

  return values;
}

function linkWriteMode(): LinkWriteMode {
  const raw = (
    process.env.LINK_WRITE_MODE ?? "sync"
  ).trim();

  if (raw === "sync" || raw === "write-behind") {
    return raw;
  }

  throw new Error(
    'LINK_WRITE_MODE must be "sync" or "write-behind"',
  );
}

export function loadConfig(): AppConfig {
  const mode = linkWriteMode();

  const codeScrambleSecret =
    process.env.CODE_SCRAMBLE_SECRET?.trim() || undefined;

  if (mode === "write-behind") {
    if (
      codeScrambleSecret === undefined ||
      codeScrambleSecret.length < 32
    ) {
      throw new Error(
        "CODE_SCRAMBLE_SECRET must contain at least 32 characters " +
          "when LINK_WRITE_MODE=write-behind",
      );
    }
  }

  return {
    host: process.env.HOST ?? "0.0.0.0",

    port: integer("PORT", 3000),

    baseUrl: (
      process.env.BASE_URL ??
      "http://localhost:3000"
    ).replace(/\/$/, ""),

    logLevel:
      process.env.LOG_LEVEL ?? "info",

    trustProxy: boolean("TRUST_PROXY", false),

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

    redisClusterUrls: list("REDIS_CLUSTER_URLS"),

    redisClusterUseReplicas: boolean(
      "REDIS_CLUSTER_USE_REPLICAS",
      false,
    ),

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

    clickFlushIntervalMs: integer(
      "CLICK_FLUSH_INTERVAL_MS",
      1_000,
    ),

    clickBufferMax: integer(
      "CLICK_BUFFER_MAX",
      10_000,
    ),

    linkWriteMode: mode,

    writeBehindMaxPending: integer(
      "WRITE_BEHIND_MAX_PENDING",
      1_000_000,
    ),

    linkSyncEnabled: boolean(
      "LINK_SYNC_ENABLED",
      mode === "write-behind",
    ),

    linkSyncIntervalMs: integer(
      "LINK_SYNC_INTERVAL_MS",
      250,
    ),

    linkSyncBatchSize: integer(
      "LINK_SYNC_BATCH_SIZE",
      1_000,
    ),

    codeScrambleSecret,
  };
}
