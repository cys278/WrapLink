import { describe, expect, it, vi } from "vitest";
import type { PendingLink } from "../src/domain/link.js";
import {
  LinkSyncWorker,
  syncBacklog,
  type PendingLinkSink,
  type SyncCompletion,
  type SyncQueue,
} from "../src/store/link-sync-worker.js";
import type { PendingLinkBatchResult } from "../src/store/postgres-link-store.js";
import { serializePendingLink } from "../src/store/write-behind-link-store.js";

/** Mirrors the Redis implementation's semantics in memory. */
class MemorySyncQueue implements SyncQueue {
  readonly queues = new Map<number, string[]>();
  readonly locks = new Map<number, string>();
  readonly deadLetters: string[] = [];
  readonly completions: SyncCompletion[] = [];
  stealLockOnComplete = false;

  push(shard: number, ...entries: string[]): void {
    this.queues.set(shard, [
      ...(this.queues.get(shard) ?? []),
      ...entries,
    ]);
  }

  async length(shard: number): Promise<number> {
    return this.queues.get(shard)?.length ?? 0;
  }

  async acquire(shard: number, token: string): Promise<boolean> {
    if (this.locks.has(shard)) {
      return false;
    }

    this.locks.set(shard, token);

    return true;
  }

  async peek(shard: number, count: number): Promise<string[]> {
    return (this.queues.get(shard) ?? []).slice(0, count);
  }

  async complete(
    shard: number,
    token: string,
    completion: SyncCompletion,
  ): Promise<boolean> {
    if (this.stealLockOnComplete) {
      this.locks.set(shard, "someone-else");
    }

    if (this.locks.get(shard) !== token) {
      return false;
    }

    this.completions.push(completion);
    this.deadLetters.push(...completion.deadLetters);
    this.queues.set(
      shard,
      (this.queues.get(shard) ?? []).slice(completion.consumed),
    );
    this.locks.delete(shard);

    return true;
  }

  async release(shard: number, token: string): Promise<void> {
    if (this.locks.get(shard) === token) {
      this.locks.delete(shard);
    }
  }
}

class MemorySink implements PendingLinkSink {
  readonly rows = new Map<string, PendingLink>();
  failNext = false;

  insertPendingBatch = vi.fn(
    async (
      links: readonly PendingLink[],
    ): Promise<PendingLinkBatchResult> => {
      if (this.failNext) {
        this.failNext = false;
        throw new Error("PostgreSQL unavailable");
      }

      const persisted: string[] = [];
      const conflicts: PendingLink[] = [];

      for (const link of links) {
        const existing = this.rows.get(link.code);

        if (!existing) {
          this.rows.set(link.code, link);
          persisted.push(link.code);
        } else if (
          existing.targetUrl === link.targetUrl &&
          existing.createdAt.getTime() === link.createdAt.getTime()
        ) {
          persisted.push(link.code);
        } else {
          conflicts.push(link);
        }
      }

      return { persisted, conflicts };
    },
  );
}

function pending(code: string, url = `https://example.com/${code}`) {
  return {
    code,
    targetUrl: url,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    expiresAt: null,
  };
}

function worker(
  queue: SyncQueue,
  sink: PendingLinkSink,
  overrides: Partial<{
    shards: number[];
    batchSize: number;
    isAvailable: () => boolean;
  }> = {},
) {
  return new LinkSyncWorker(queue, sink, {
    shards: overrides.shards ?? [0, 1, 2],
    intervalMs: 1_000,
    batchSize: overrides.batchSize ?? 100,
    cacheTtlSeconds: 300,
    ...(overrides.isAvailable
      ? { isAvailable: overrides.isAvailable }
      : {}),
  });
}

describe("LinkSyncWorker", () => {
  it("moves queued links into the sink and trims the queue", async () => {
    const queue = new MemorySyncQueue();
    const sink = new MemorySink();

    queue.push(0, serializePendingLink(pending("aaaa1")));
    queue.push(
      2,
      serializePendingLink(pending("bbbb1")),
      serializePendingLink(pending("bbbb2")),
    );

    const result = await worker(queue, sink).tick();

    expect(result).toEqual({ synced: 3, conflicts: 0, poison: 0 });
    expect([...sink.rows.keys()].sort()).toEqual([
      "aaaa1",
      "bbbb1",
      "bbbb2",
    ]);
    expect(await syncBacklog(queue, [0, 1, 2])).toBe(0);
    expect(queue.locks.size).toBe(0);
    expect(queue.completions[0]?.cacheTtlSeconds).toBe(300);
  });

  it("skips empty shards without taking locks", async () => {
    const queue = new MemorySyncQueue();
    const acquire = vi.spyOn(queue, "acquire");

    await worker(queue, new MemorySink()).tick();

    expect(acquire).not.toHaveBeenCalled();
  });

  it("processes large queues in batches", async () => {
    const queue = new MemorySyncQueue();
    const sink = new MemorySink();

    for (let index = 0; index < 25; index += 1) {
      queue.push(0, serializePendingLink(pending(`code${index}`)));
    }

    const result = await worker(queue, sink, {
      shards: [0],
      batchSize: 10,
    }).tick();

    expect(result.synced).toBe(25);
    expect(sink.insertPendingBatch).toHaveBeenCalledTimes(3);
    expect(await queue.length(0)).toBe(0);
  });

  it("dead-letters collisions and drops their cache entries", async () => {
    const queue = new MemorySyncQueue();
    const sink = new MemorySink();
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    sink.rows.set("taken", pending("taken", "https://example.com/original"));
    queue.push(
      0,
      serializePendingLink(pending("taken", "https://example.com/new")),
    );

    const result = await worker(queue, sink, { shards: [0] }).tick();

    expect(result.conflicts).toBe(1);
    expect(queue.completions[0]?.conflicts).toEqual(["taken"]);
    expect(queue.completions[0]?.persisted).toEqual([]);
    expect(queue.deadLetters).toHaveLength(1);
    expect(JSON.parse(queue.deadLetters[0]!).reason).toBe("conflict");
    expect(sink.rows.get("taken")?.targetUrl).toBe(
      "https://example.com/original",
    );

    error.mockRestore();
  });

  it("dead-letters unparseable records without blocking the queue", async () => {
    const queue = new MemorySyncQueue();
    const sink = new MemorySink();

    queue.push(
      0,
      "{corrupt",
      serializePendingLink(pending("valid1")),
    );

    const result = await worker(queue, sink, { shards: [0] }).tick();

    expect(result).toEqual({ synced: 1, conflicts: 0, poison: 1 });
    expect(JSON.parse(queue.deadLetters[0]!).reason).toBe("invalid");
    expect(await queue.length(0)).toBe(0);
  });

  it("keeps entries queued and releases the lock when PostgreSQL fails", async () => {
    const queue = new MemorySyncQueue();
    const sink = new MemorySink();
    const warn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    queue.push(0, serializePendingLink(pending("retry1")));
    sink.failNext = true;

    const sync = worker(queue, sink, { shards: [0] });

    expect((await sync.tick()).synced).toBe(0);
    expect(await queue.length(0)).toBe(1);
    expect(queue.locks.size).toBe(0);

    expect((await sync.tick()).synced).toBe(1);
    expect(await queue.length(0)).toBe(0);

    warn.mockRestore();
  });

  it("does not trim when the lock was lost, and replays idempotently", async () => {
    const queue = new MemorySyncQueue();
    const sink = new MemorySink();

    queue.push(0, serializePendingLink(pending("replay1")));
    queue.stealLockOnComplete = true;

    const sync = worker(queue, sink, { shards: [0] });

    expect((await sync.tick()).synced).toBe(0);
    expect(await queue.length(0)).toBe(1);
    expect(sink.rows.has("replay1")).toBe(true);

    // The other holder's lock expires; the replay is recognised.
    queue.stealLockOnComplete = false;
    queue.locks.clear();

    expect(await sync.tick()).toEqual({
      synced: 1,
      conflicts: 0,
      poison: 0,
    });
    expect(await queue.length(0)).toBe(0);
  });

  it("skips shards another worker is processing", async () => {
    const queue = new MemorySyncQueue();
    const sink = new MemorySink();

    queue.push(0, serializePendingLink(pending("locked1")));
    queue.locks.set(0, "other-worker");

    expect((await worker(queue, sink, { shards: [0] }).tick()).synced).toBe(0);
    expect(sink.insertPendingBatch).not.toHaveBeenCalled();
  });

  it("does nothing while its dependencies are unavailable", async () => {
    const queue = new MemorySyncQueue();
    const length = vi.spyOn(queue, "length");

    queue.push(0, serializePendingLink(pending("later1")));

    await worker(queue, new MemorySink(), {
      isAvailable: () => false,
    }).tick();

    expect(length).not.toHaveBeenCalled();
  });

  it("drains until empty and flushes on close", async () => {
    const queue = new MemorySyncQueue();
    const sink = new MemorySink();

    for (let index = 0; index < 30; index += 1) {
      queue.push(index % 3, serializePendingLink(pending(`drain${index}`)));
    }

    const sync = worker(queue, sink, { batchSize: 4 });

    expect((await sync.drain()).synced).toBe(30);

    queue.push(1, serializePendingLink(pending("closing1")));
    await sync.close();

    expect(sink.rows.has("closing1")).toBe(true);
    expect(() => sync.start()).toThrow("closed");
  });

  it("reports the backlog for its shards", async () => {
    const queue = new MemorySyncQueue();

    queue.push(0, "a", "b");
    queue.push(2, "c");
    queue.push(5, "not mine");

    expect(await worker(queue, new MemorySink()).backlog()).toBe(3);
  });

  it("validates its options", () => {
    expect(
      () =>
        new LinkSyncWorker(new MemorySyncQueue(), new MemorySink(), {
          shards: [0],
          intervalMs: 0,
          batchSize: 1,
          cacheTtlSeconds: 1,
        }),
    ).toThrow("intervalMs");
  });
});
