/**
 * Loads links from PostgreSQL into Redis in batches.
 *
 * When a table is hot enough that every redirect would otherwise reach
 * PostgreSQL, keeping all of it in RAM turns ~millisecond disk-backed
 * reads into ~microsecond memory reads. Check memory first: each link
 * costs roughly its URL length plus ~150 bytes of Redis overhead.
 *
 *   npm run cache:warm                       # cache TTL from the env
 *   npm run cache:warm -- --ttl 0            # keep entries until evicted
 *   npm run cache:warm -- --batch 5000 --limit 1000000
 *
 * Pagination is keyset-based (WHERE code > last ORDER BY code), so every
 * batch is an index range scan. OFFSET pagination would re-scan all skipped
 * rows on each batch and make the whole job O(n^2).
 */
import { linkKey } from "../cache/keys.js";
import { createRedisClient } from "../cache/redis-client.js";
import { createDatabasePool } from "../database/pool.js";
import {
  loadJobEnv,
  parseArgs,
  positiveIntegerArg,
} from "./job-env.js";

interface LinkRow {
  code: string;
  target_url: string;
  created_at: Date;
  expires_at: Date | null;
  clicks: string;
}

const env = loadJobEnv();
const args = parseArgs(process.argv.slice(2));

const batchSize = positiveIntegerArg(args, "batch", 2_000);
const ttlSeconds = positiveIntegerArg(
  args,
  "ttl",
  env.redisCacheTtlSeconds,
  true,
);
const limit = positiveIntegerArg(
  args,
  "limit",
  Number.MAX_SAFE_INTEGER,
);

const pool = createDatabasePool({
  databaseUrl: env.databaseUrl,
  databasePoolMax: 4,
});

const redis = createRedisClient(env);

async function cacheLink(link: LinkRow): Promise<void> {
  const key = linkKey(link.code);
  const now = Date.now();

  let ttlMs = ttlSeconds === 0 ? 0 : ttlSeconds * 1_000;

  if (link.expires_at) {
    const remaining = link.expires_at.getTime() - now;

    if (remaining <= 0) {
      return;
    }

    ttlMs = ttlMs === 0 ? remaining : Math.min(ttlMs, remaining);
  }

  const transaction = redis.multi().hSet(key, {
    code: link.code,
    targetUrl: link.target_url,
    createdAt: link.created_at.toISOString(),
    expiresAt: link.expires_at?.toISOString() ?? "",
    clicks: String(link.clicks),
  });

  if (ttlMs === 0) {
    transaction.persist(key);
  } else {
    transaction.pExpire(key, ttlMs);
  }

  await transaction.exec();
}

try {
  await redis.connect();

  let lastCode = "";
  let loaded = 0;
  const started = performance.now();

  while (loaded < limit) {
    const result = await pool.query<LinkRow>(
      `
        SELECT code, target_url, created_at, expires_at, clicks
        FROM links
        WHERE code > $1
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY code
        LIMIT $2
      `,
      [lastCode, Math.min(batchSize, limit - loaded)],
    );

    if (result.rows.length === 0) {
      break;
    }

    // node-redis pipelines concurrent commands automatically, so one batch
    // costs a handful of network round trips rather than one per link.
    await Promise.all(result.rows.map(cacheLink));

    loaded += result.rows.length;
    lastCode = result.rows.at(-1)!.code;

    const seconds = (performance.now() - started) / 1_000;

    console.log(
      `Loaded ${loaded} links (${Math.round(loaded / Math.max(seconds, 0.001))}/s)`,
    );
  }

  console.log(`Cache warm complete: ${loaded} links`);
} catch (error) {
  console.error("Cache warm failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);

  if (redis.isOpen) {
    await redis.close().catch(() => undefined);
  }
}
