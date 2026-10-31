import { describe, expect, it, vi } from "vitest";
import {
  linkKey,
  shardOf,
  syncQueueKey,
} from "../src/cache/keys.js";
import type { RedisClient } from "../src/cache/redis-client.js";
import { MemoryLinkStore } from "../src/store/memory-link-store.js";
import {
  parsePendingLink,
  serializePendingLink,
  WriteBehindLinkStore,
} from "../src/store/write-behind-link-store.js";

interface FakeRedisOptions {
  ready?: boolean;
  evalResult?: number | Error;
  pendingFlag?: string | null;
}

function fakeRedis(options: FakeRedisOptions = {}) {
  const evalMock = vi.fn(async () => {
    if (options.evalResult instanceof Error) {
      throw options.evalResult;
    }

    return options.evalResult ?? 1;
  });

  const hGet = vi.fn(async () => options.pendingFlag ?? null);

  const client = {
    isReady: options.ready ?? true,
    eval: evalMock,
    hGet,
  };

  return {
    client: client as unknown as RedisClient,
    evalMock,
    hGet,
  };
}

function counters() {
  const values = new Map<string, number>();

  return {
    values,
    increment(name: string, value = 1) {
      values.set(name, (values.get(name) ?? 0) + value);
    },
  };
}

const input = {
  code: "Ab3dE5gH9",
  targetUrl: "https://example.com/fast",
  expiresAt: null,
} as const;

describe("WriteBehindLinkStore", () => {
  it("acknowledges generated links from Redis without touching PostgreSQL", async () => {
    const synchronous = new MemoryLinkStore(10);
    const create = vi.spyOn(synchronous, "create");
    const redis = fakeRedis();
    const metrics = counters();

    const store = new WriteBehindLinkStore(
      synchronous,
      redis.client,
      { maxPendingLinks: 2_048 },
      metrics,
    );

    const link = await store.create(input);

    expect(link).toMatchObject({
      code: input.code,
      targetUrl: input.targetUrl,
      clicks: 0,
      expiresAt: null,
    });
    expect(create).not.toHaveBeenCalled();
    expect(metrics.values.get("links_queued")).toBe(1);

    const [, evalOptions] = redis.evalMock.mock.calls[0] as unknown as [
      string,
      { keys: string[]; arguments: string[] },
    ];

    expect(evalOptions.keys).toEqual([
      linkKey(input.code),
      syncQueueKey(shardOf(input.code)),
    ]);

    // 2,048 pending links across 1,024 shards = 2 per shard.
    expect(evalOptions.arguments[0]).toBe("2");

    const queued = parsePendingLink(evalOptions.arguments[1]!);

    expect(queued?.code).toBe(input.code);
    expect(queued?.targetUrl).toBe(input.targetUrl);
    expect(evalOptions.arguments[6]).toBe("0");
  });

  it("passes the remaining lifetime to Redis as a relative TTL", async () => {
    const redis = fakeRedis();
    const store = new WriteBehindLinkStore(
      new MemoryLinkStore(10),
      redis.client,
      { maxPendingLinks: 1_000 },
    );

    const expiresAt = new Date(Date.now() + 60_000);

    await store.create({ ...input, expiresAt });

    const [, evalOptions] = redis.evalMock.mock.calls[0] as unknown as [
      string,
      { arguments: string[] },
    ];

    expect(evalOptions.arguments[5]).toBe(expiresAt.toISOString());

    const ttlMs = Number(evalOptions.arguments[6]);

    expect(ttlMs).toBeGreaterThan(59_000);
    expect(ttlMs).toBeLessThanOrEqual(60_000);
  });

  it("reports an existing code so the caller can retry", async () => {
    const store = new WriteBehindLinkStore(
      new MemoryLinkStore(10),
      fakeRedis({ evalResult: 0 }).client,
      { maxPendingLinks: 1_000 },
    );

    expect(await store.create(input)).toBeNull();
  });

  it("falls back to PostgreSQL when the queue is full", async () => {
    const synchronous = new MemoryLinkStore(10);
    const metrics = counters();
    const store = new WriteBehindLinkStore(
      synchronous,
      fakeRedis({ evalResult: -1 }).client,
      { maxPendingLinks: 1_000 },
      metrics,
    );

    expect(await store.create(input)).toMatchObject({
      code: input.code,
    });
    expect(await synchronous.find(input.code)).not.toBeNull();
    expect(metrics.values.get("write_behind_backpressure")).toBe(1);
  });

  it("falls back to PostgreSQL when Redis is down or failing", async () => {
    for (const redis of [
      fakeRedis({ ready: false }),
      fakeRedis({ evalResult: new Error("connection reset") }),
    ]) {
      const synchronous = new MemoryLinkStore(10);
      const metrics = counters();
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      const store = new WriteBehindLinkStore(
        synchronous,
        redis.client,
        { maxPendingLinks: 1_000 },
        metrics,
      );

      expect(await store.create(input)).not.toBeNull();
      expect(await synchronous.find(input.code)).not.toBeNull();
      expect(metrics.values.get("write_behind_fallbacks")).toBe(1);

      warn.mockRestore();
    }
  });

  it("sends custom aliases through the synchronous path", async () => {
    const synchronous = new MemoryLinkStore(10);
    const redis = fakeRedis();
    const store = new WriteBehindLinkStore(
      synchronous,
      redis.client,
      { maxPendingLinks: 1_000 },
    );

    const link = await store.create({
      ...input,
      code: "my-alias",
      codeSource: "custom",
    });

    expect(link?.code).toBe("my-alias");
    expect(redis.evalMock).not.toHaveBeenCalled();
    expect(await synchronous.find("my-alias")).not.toBeNull();
  });

  it("refuses a custom alias that is still waiting to be synced", async () => {
    const synchronous = new MemoryLinkStore(10);
    const store = new WriteBehindLinkStore(
      synchronous,
      fakeRedis({ pendingFlag: "1" }).client,
      { maxPendingLinks: 1_000 },
    );

    expect(
      await store.create({
        ...input,
        codeSource: "custom",
      }),
    ).toBeNull();
    expect(await synchronous.find(input.code)).toBeNull();
  });

  it("rejects an invalid backlog limit", () => {
    expect(
      () =>
        new WriteBehindLinkStore(
          new MemoryLinkStore(10),
          fakeRedis().client,
          { maxPendingLinks: 0 },
        ),
    ).toThrow();
  });
});

describe("pending link serialization", () => {
  it("round-trips links", () => {
    const link = {
      code: "abcd1234",
      targetUrl: "https://example.com/a?b=c",
      createdAt: new Date("2026-01-02T03:04:05.678Z"),
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    };

    expect(parsePendingLink(serializePendingLink(link))).toEqual(link);
    expect(
      parsePendingLink(
        serializePendingLink({ ...link, expiresAt: null }),
      ),
    ).toEqual({ ...link, expiresAt: null });
  });

  it("rejects malformed records", () => {
    for (const value of [
      "not json",
      "null",
      "{}",
      JSON.stringify({
        code: "bad code!",
        targetUrl: "https://x.y",
        createdAt: new Date().toISOString(),
        expiresAt: null,
      }),
      JSON.stringify({
        code: "good",
        targetUrl: "https://x.y",
        createdAt: "yesterday",
        expiresAt: null,
      }),
      JSON.stringify({
        code: "good",
        targetUrl: "https://x.y",
        createdAt: new Date().toISOString(),
        expiresAt: 5,
      }),
    ]) {
      expect(parsePendingLink(value)).toBeNull();
    }
  });
});
