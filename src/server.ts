import { buildApp } from "./app.js";
import { createRedisClient } from "./cache/redis-client.js";
import { loadConfig } from "./config.js";
import { createDatabasePool } from "./database/pool.js";
import { HashedApiKeyAuthenticator } from "./security/api-key-authenticator.js";
import { RedisRateLimiter } from "./security/rate-limiter.js";
import { SafeUrlPolicy } from "./security/url-policy.js";
import { CachedLinkStore } from "./store/cached-link-store.js";
import { PostgresLinkStore } from "./store/postgres-link-store.js";

const config = loadConfig();

const pool = createDatabasePool(config);
const redis = createRedisClient(config);

const postgresStore = new PostgresLinkStore(
  pool,
);

const store = new CachedLinkStore(
  postgresStore,
  redis,
  config.redisCacheTtlSeconds,
);

const rateLimiter = new RedisRateLimiter(
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
);

let shuttingDown = false;

async function closeResources(): Promise<void> {
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
    await app.close();
    await closeResources();
    process.exitCode = 0;
  } catch (error) {
    app.log.error(
      error,
      "graceful shutdown failed",
    );

    process.exitCode = 1;
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  // PostgreSQL is required because it is the
  // durable source of truth.
  await pool.query("SELECT 1");

  // Redis is optional for redirects because
  // they can fall back to PostgreSQL.
  //
  // Link creation fails closed if Redis is
  // unavailable because rate limiting cannot
  // be enforced safely.
  try {
    await redis.connect();
  } catch (error) {
    app.log.warn(
      { error },
      "Redis unavailable; redirects will use PostgreSQL",
    );
  }

  await app.listen({
    host: config.host,
    port: config.port,
  });
} catch (error) {
  app.log.error(
    error,
    "server startup failed",
  );

  await closeResources().catch(
    () => undefined,
  );

  process.exitCode = 1;
}