/**
 * Minimal environment for maintenance jobs. Jobs do not serve HTTP, so they
 * must not require HTTP-only settings such as CREATE_API_KEYS.
 */
export interface JobEnv {
  databaseUrl: string;
  redisUrl: string;
  redisClusterUrls: string[];
  redisCacheTtlSeconds: number;
}

export function loadJobEnv(): JobEnv {
  const ttl = Number(process.env.REDIS_CACHE_TTL_SECONDS ?? 300);

  return {
    databaseUrl:
      process.env.DATABASE_URL ??
      "postgresql://shortener:shortener@127.0.0.1:55432/shortener",
    redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    redisClusterUrls:
      process.env.REDIS_CLUSTER_URLS?.split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0) ?? [],
    redisCacheTtlSeconds:
      Number.isSafeInteger(ttl) && ttl > 0 ? ttl : 300,
  };
}

/** Parses `--name value` and `--flag` style arguments. */
export function parseArgs(
  argv: readonly string[],
): Map<string, string> {
  const args = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]!;

    if (!current.startsWith("--")) {
      continue;
    }

    const next = argv[index + 1];

    if (next !== undefined && !next.startsWith("--")) {
      args.set(current.slice(2), next);
      index += 1;
    } else {
      args.set(current.slice(2), "true");
    }
  }

  return args;
}

export function positiveIntegerArg(
  args: Map<string, string>,
  name: string,
  fallback: number,
  allowZero = false,
): number {
  const raw = args.get(name);

  if (raw === undefined) {
    return fallback;
  }

  const value = Number(raw);

  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1)
  ) {
    throw new Error(`--${name} must be a ${allowZero ? "non-negative" : "positive"} integer`);
  }

  return value;
}
