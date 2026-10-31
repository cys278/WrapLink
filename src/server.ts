import { buildApp, type AppOptions } from "./app.js";
import { shardsForWorker } from "./cache/keys.js";
import { createRedisClient } from "./cache/redis-client.js";
import { ClusterMetrics } from "./cluster-metrics.js";
import { loadConfig } from "./config.js";
import { createDatabasePool } from "./database/pool.js";
import {
  BlockCodeAllocator,
  CodeScrambler,
} from "./domain/code-allocator.js";
import type { LinkStore } from "./domain/link.js";
import { Metrics, type MetricsCollector } from "./metrics.js";
import { HashedApiKeyAuthenticator } from "./security/api-key-authenticator.js";
import { RedisRateLimiter } from "./security/rate-limiter.js";
import { SafeUrlPolicy } from "./security/url-policy.js";
import { CachedLinkStore } from "./store/cached-link-store.js";
import { ClickBuffer } from "./store/click-buffer.js";
import {
  LinkSyncWorker,
  RedisSyncQueue,
  syncBacklog,
} from "./store/link-sync-worker.js";
import { PostgresIdBlockSource } from "./store/postgres-id-block-source.js";
import { PostgresLinkStore } from "./store/postgres-link-store.js";
import { WriteBehindLinkStore } from "./store/write-behind-link-store.js";

function workerIdentity(): { index: number; count: number } {
  const index = Number(process.env.WRAPLINK_WORKER_INDEX ?? 0);
  const count = Number(process.env.WRAPLINK_WORKER_COUNT ?? 1);

  if (
    Number.isSafeInteger(index) &&
    Number.isSafeInteger(count) &&
    count >= 1 &&
    index >= 0 &&
    index < count
  ) {
    return { index, count };
  }

  return { index: 0, count: 1 };
}

const config = loadConfig();

const pool = createDatabasePool(config);
const redis = createRedisClient(config);

// Workers forked by cluster.ts aggregate metrics in the primary over IPC.
// A standalone process (npm run dev / start:single) has no primary, so it
// keeps its own in-process collector.
const metrics: MetricsCollector & { close?: () => void } =
  typeof process.send === "function"
    ? new ClusterMetrics()
    : new Metrics();

const postgresStore =
  new PostgresLinkStore(pool);

const clickBuffer = new ClickBuffer(
  postgresStore,
  config.clickFlushIntervalMs,
  config.clickBufferMax,
);

clickBuffer.start();

const cachedStore = new CachedLinkStore(
  postgresStore,
  redis,
  config.redisCacheTtlSeconds,
  clickBuffer,
);

let store: LinkStore = cachedStore;
const appOptions: AppOptions = {};

if (config.linkWriteMode === "write-behind") {
  store = new WriteBehindLinkStore(
    cachedStore,
    redis,
    { maxPendingLinks: config.writeBehindMaxPending },
    metrics,
  );

  const allocator = new BlockCodeAllocator(
    new PostgresIdBlockSource(pool),
    // loadConfig() guarantees the secret in write-behind mode.
    new CodeScrambler(config.codeScrambleSecret!),
  );

  appOptions.codeGenerator = () => allocator.nextCode();
}

const syncQueue = new RedisSyncQueue(redis);
const identity = workerIdentity();

const syncWorker = config.linkSyncEnabled
  ? new LinkSyncWorker(
      syncQueue,
      postgresStore,
      {
        shards: shardsForWorker(identity.index, identity.count),
        intervalMs: config.linkSyncIntervalMs,
        batchSize: config.linkSyncBatchSize,
        cacheTtlSeconds: config.redisCacheTtlSeconds,
        isAvailable: () => redis.isReady,
      },
      metrics,
    )
  : undefined;

appOptions.extraMetrics = async () => {
  const lines: string[] = [
    "# TYPE shortener_click_buffer_pending gauge",
    `shortener_click_buffer_pending{pid="${process.pid}"} ${clickBuffer.pendingClicks()}`,
    "# TYPE shortener_click_buffer_dropped gauge",
    `shortener_click_buffer_dropped{pid="${process.pid}"} ${clickBuffer.droppedClicks()}`,
  ];

  // O(1): planner statistics instead of COUNT(*).
  const estimate = await postgresStore
    .estimatedSize()
    .catch(() => undefined);

  if (estimate !== undefined) {
    lines.push(
      "# TYPE shortener_links_estimated gauge",
      `shortener_links_estimated ${estimate}`,
    );
  }

  if (redis.isReady) {
    const backlog = await syncBacklog(syncQueue).catch(
      () => undefined,
    );

    if (backlog !== undefined) {
      lines.push(
        "# TYPE shortener_link_sync_backlog gauge",
        `shortener_link_sync_backlog ${backlog}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
};

const rateLimiter =
  new RedisRateLimiter(
    redis,
    config.createRateLimitMax,
    config.createRateLimitWindowSeconds,
  );

const apiKeyAuthenticator =
  new HashedApiKeyAuthenticator(
    config.createApiKeys,
  );

const urlPolicy = new SafeUrlPolicy();

const app = buildApp(
  config,
  store,
  rateLimiter,
  apiKeyAuthenticator,
  urlPolicy,
  metrics,
  appOptions,
);

let shuttingDown = false;

function disconnectFromPrimary(): void {
  if (
    process.connected &&
    typeof process.disconnect ===
      "function"
  ) {
    process.disconnect();
  }
}

async function closeResources(): Promise<void> {
  // Order matters: push queued links to PostgreSQL first, then flush
  // clicks (which may target those links), then metrics, then close the
  // connections everything above depends on.
  if (syncWorker && redis.isReady) {
    await syncWorker.close();
  }

  await clickBuffer.close();

  metrics.close?.();

  await Promise.all([
    pool.end(),
    redis.isOpen
      ? redis.close()
      : Promise.resolve(),
  ]);
}

async function shutdown(
  signal: string,
): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  app.log.info(
    { signal },
    "shutting down",
  );

  try {
    // Stop accepting new requests before
    // draining buffered work.
    await app.close();
    await closeResources();
    process.exitCode = 0;
  } catch (error) {
    app.log.error(
      error,
      "graceful shutdown failed",
    );

    process.exitCode = 1;
  } finally {
    disconnectFromPrimary();
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  // PostgreSQL is the durable source
  // of truth.
  await pool.query("SELECT 1");

  // Redis is optional for redirect reads.
  // Link creation still fails closed when
  // rate limiting cannot be enforced, and
  // write-behind creation falls back to
  // PostgreSQL.
  try {
    await redis.connect();
  } catch (error) {
    app.log.warn(
      { error },
      "Redis unavailable; redirects will use PostgreSQL",
    );
  }

  if (syncWorker) {
    syncWorker.start();
  }

  await app.listen({
    host: config.host,
    port: config.port,
  });

  app.log.info(
    {
      linkWriteMode: config.linkWriteMode,
      linkSync: config.linkSyncEnabled,
      worker: identity,
      redisCluster: config.redisClusterUrls.length > 0,
    },
    "WrapLink ready",
  );
} catch (error) {
  app.log.error(
    error,
    "server startup failed",
  );

  await closeResources().catch(
    () => undefined,
  );

  process.exitCode = 1;
  disconnectFromPrimary();
}
