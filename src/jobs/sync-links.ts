/**
 * Drains every write-behind queue into PostgreSQL and exits.
 *
 * The application already runs this continuously in each worker. Use the
 * job to flush the backlog during maintenance, after running with
 * LINK_SYNC_ENABLED=false, or to inspect dead letters.
 *
 *   npm run sync                         # drain all shards
 *   npm run sync -- --batch 5000         # larger PostgreSQL batches
 *   npm run sync -- --dead-letters       # print collisions and bad records
 */
import { allShards, syncDeadLetterKey } from "../cache/keys.js";
import { createRedisClient } from "../cache/redis-client.js";
import { createDatabasePool } from "../database/pool.js";
import {
  LinkSyncWorker,
  RedisSyncQueue,
  syncBacklog,
} from "../store/link-sync-worker.js";
import { PostgresLinkStore } from "../store/postgres-link-store.js";
import {
  loadJobEnv,
  parseArgs,
  positiveIntegerArg,
} from "./job-env.js";

const env = loadJobEnv();
const args = parseArgs(process.argv.slice(2));

const pool = createDatabasePool({
  databaseUrl: env.databaseUrl,
  databasePoolMax: 10,
});

const redis = createRedisClient(env);

try {
  await redis.connect();
  await pool.query("SELECT 1");

  if (args.has("dead-letters")) {
    let total = 0;

    for (const shard of allShards()) {
      const key = syncDeadLetterKey(shard);
      const length = await redis.lLen(key);

      if (length === 0) {
        continue;
      }

      total += length;
      console.log(`${key}: ${length}`);

      for (const entry of await redis.lRange(key, 0, 4)) {
        console.log(`  ${entry}`);
      }
    }

    console.log(`Dead letters: ${total}`);
  } else {
    const queue = new RedisSyncQueue(redis);
    const before = await syncBacklog(queue);

    console.log(`Pending links before sync: ${before}`);

    const started = performance.now();

    const worker = new LinkSyncWorker(
      queue,
      new PostgresLinkStore(pool),
      {
        shards: allShards(),
        intervalMs: 1_000,
        batchSize: positiveIntegerArg(args, "batch", 2_000),
        cacheTtlSeconds: env.redisCacheTtlSeconds,
        maxBatchesPerShard: 1_000,
      },
    );

    const result = await worker.drain();
    const seconds = (performance.now() - started) / 1_000;

    console.log(
      `Synced ${result.synced} links in ${seconds.toFixed(1)}s ` +
        `(${Math.round(result.synced / Math.max(seconds, 0.001))}/s); ` +
        `conflicts: ${result.conflicts}; invalid: ${result.poison}`,
    );

    console.log(
      `Pending links after sync: ${await syncBacklog(queue)}`,
    );

    if (result.conflicts > 0) {
      console.warn(
        "Some codes collided with existing links. Inspect them with " +
          "npm run sync -- --dead-letters",
      );
    }
  }
} catch (error) {
  console.error("Link sync failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);

  if (redis.isOpen) {
    await redis.close().catch(() => undefined);
  }
}
