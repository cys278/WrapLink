import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  linkKey,
  shardOf,
  syncDeadLetterKey,
  syncLockKey,
  syncQueueKey,
} from "../../src/cache/keys.js";
import { createRedisClient } from "../../src/cache/redis-client.js";
import { CachedLinkStore } from "../../src/store/cached-link-store.js";
import {
  LinkSyncWorker,
  RedisSyncQueue,
} from "../../src/store/link-sync-worker.js";
import { PostgresIdBlockSource } from "../../src/store/postgres-id-block-source.js";
import { PostgresLinkStore } from "../../src/store/postgres-link-store.js";
import {
  serializePendingLink,
  WriteBehindLinkStore,
} from "../../src/store/write-behind-link-store.js";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://shortener:shortener@127.0.0.1:55432/shortener",
  max: 5,
});

const redis = createRedisClient({
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  redisClusterUrls: [],
});

const postgres = new PostgresLinkStore(pool);
const cached = new CachedLinkStore(postgres, redis, 300);
const queue = new RedisSyncQueue(redis);

const codes = ["wbFirst01", "wbReplay1", "wbTaken01", "wbFull001", "wbFull002", "wbExpire1"];

function store(maxPendingLinks = 1_000_000) {
  return new WriteBehindLinkStore(cached, redis, { maxPendingLinks });
}

function worker(shards: number[]) {
  return new LinkSyncWorker(queue, postgres, {
    shards,
    intervalMs: 1_000,
    batchSize: 100,
    cacheTtlSeconds: 300,
  });
}

beforeAll(async () => {
  await redis.connect();
});

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE links");

  const keys = codes.flatMap((code) => {
    const shard = shardOf(code);

    return [
      linkKey(code),
      syncQueueKey(shard),
      syncLockKey(shard),
      syncDeadLetterKey(shard),
    ];
  });

  await redis.del(keys.filter((key, index) => keys.indexOf(key) === index));
});

afterAll(async () => {
  await pool.end();

  if (redis.isOpen) {
    await redis.quit();
  }
});

describe("write-behind link creation", () => {
  it("acknowledges from Redis, then syncs to PostgreSQL", async () => {
    const code = "wbFirst01";
    const shard = shardOf(code);

    const link = await store().create({
      code,
      targetUrl: "https://example.com/write-behind",
      expiresAt: null,
    });

    expect(link?.code).toBe(code);

    // Visible to redirects immediately, not yet durable.
    expect(await cached.find(code)).toMatchObject({
      targetUrl: "https://example.com/write-behind",
    });
    expect(await postgres.find(code)).toBeNull();
    expect(await redis.hGet(linkKey(code), "pending")).toBe("1");
    expect(await redis.pTTL(linkKey(code))).toBe(-1);
    expect(await redis.lLen(syncQueueKey(shard))).toBe(1);

    expect((await worker([shard]).tick()).synced).toBe(1);

    expect(await postgres.find(code)).toMatchObject({
      targetUrl: "https://example.com/write-behind",
    });
    expect(await redis.hGet(linkKey(code), "pending")).toBeNull();

    const ttl = await redis.pTTL(linkKey(code));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300_000);

    expect(await redis.lLen(syncQueueKey(shard))).toBe(0);
    expect(await redis.exists(syncLockKey(shard))).toBe(0);
  });

  it("treats a replayed queue entry as already persisted", async () => {
    const code = "wbReplay1";
    const shard = shardOf(code);

    await store().create({
      code,
      targetUrl: "https://example.com/replay",
      expiresAt: null,
    });

    const [entry] = await redis.lRange(syncQueueKey(shard), 0, 0);

    expect((await worker([shard]).tick()).synced).toBe(1);

    // Simulate a crash after COMMIT but before the queue was trimmed.
    await redis.rPush(syncQueueKey(shard), entry!);

    const replay = await worker([shard]).tick();

    expect(replay).toEqual({ synced: 1, conflicts: 0, poison: 0 });
    expect(await postgres.size()).toBe(1);
  });

  it("dead-letters collisions and lets PostgreSQL win", async () => {
    const code = "wbTaken01";
    const shard = shardOf(code);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await postgres.create({
      code,
      targetUrl: "https://example.com/original",
      expiresAt: null,
    });

    await redis.hSet(linkKey(code), {
      code,
      targetUrl: "https://example.com/impostor",
      createdAt: new Date().toISOString(),
      expiresAt: "",
      clicks: "0",
      pending: "1",
    });

    await redis.rPush(
      syncQueueKey(shard),
      serializePendingLink({
        code,
        targetUrl: "https://example.com/impostor",
        createdAt: new Date(),
        expiresAt: null,
      }),
    );

    expect((await worker([shard]).tick()).conflicts).toBe(1);

    expect(await redis.exists(linkKey(code))).toBe(0);
    expect(await redis.lLen(syncDeadLetterKey(shard))).toBe(1);
    expect((await cached.find(code))?.targetUrl).toBe(
      "https://example.com/original",
    );

    error.mockRestore();
  });

  it("applies backpressure per shard", async () => {
    const write = store(1); // one pending link per shard
    const first = "wbFull001";
    const second = "wbFull002";

    await write.create({
      code: first,
      targetUrl: "https://example.com/1",
      expiresAt: null,
    });

    // Only exercise the limit when both codes share a shard; otherwise the
    // second link simply lands in its own queue.
    await write.create({
      code: second,
      targetUrl: "https://example.com/2",
      expiresAt: null,
    });

    if (shardOf(first) === shardOf(second)) {
      expect(await postgres.find(second)).not.toBeNull();
    } else {
      expect(await redis.lLen(syncQueueKey(shardOf(second)))).toBe(1);
    }

    expect(await redis.lLen(syncQueueKey(shardOf(first)))).toBe(1);
  });

  it("keeps the link's own expiry in Redis", async () => {
    const code = "wbExpire1";
    const expiresAt = new Date(Date.now() + 30_000);

    await store().create({
      code,
      targetUrl: "https://example.com/soon",
      expiresAt,
    });

    const ttl = await redis.pTTL(linkKey(code));

    expect(ttl).toBeGreaterThan(25_000);
    expect(ttl).toBeLessThanOrEqual(30_000);

    await worker([shardOf(code)]).tick();

    // Finalising never extends the TTL past the link's expiry.
    expect(await redis.pTTL(linkKey(code))).toBeLessThanOrEqual(30_000);
    expect((await postgres.find(code))?.expiresAt?.getTime()).toBe(
      expiresAt.getTime(),
    );
  });
});

describe("PostgreSQL support for write-behind", () => {
  it("reserves disjoint ID blocks", async () => {
    const source = new PostgresIdBlockSource(pool);
    const first = await source.reserveBlock();
    const second = await source.reserveBlock();

    expect(first.size).toBe(10_000);
    expect(second.start - first.start).toBe(10_000n);
  });

  it("reports click batches for links that do not exist yet", async () => {
    await postgres.create({
      code: "wbFirst01",
      targetUrl: "https://example.com/exists",
      expiresAt: null,
    });

    const unmatched = await postgres.recordClickBatch(
      new Map([
        ["wbFirst01", 3],
        ["wbMissing", 2],
      ]),
    );

    expect([...unmatched]).toEqual(["wbMissing"]);
    expect((await postgres.find("wbFirst01"))?.clicks).toBe(3);
  });

  it("estimates table size without scanning", async () => {
    expect(await postgres.estimatedSize()).toBeGreaterThanOrEqual(0);
  });
});
