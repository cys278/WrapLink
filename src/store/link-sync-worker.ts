import { randomUUID } from "node:crypto";
import {
  allShards,
  linkKey,
  syncDeadLetterKey,
  syncLockKey,
  syncQueueKey,
} from "../cache/keys.js";
import type { RedisClient } from "../cache/redis-client.js";
import type { PendingLink } from "../domain/link.js";
import type { PendingLinkBatchResult } from "./postgres-link-store.js";
import {
  parsePendingLink,
  serializePendingLink,
  type CounterSink,
} from "./write-behind-link-store.js";

export interface PendingLinkSink {
  insertPendingBatch(
    links: readonly PendingLink[],
  ): Promise<PendingLinkBatchResult>;
}

export interface SyncCompletion {
  /** Number of entries to remove from the head of the queue. */
  consumed: number;
  /** Codes now durable in PostgreSQL; their cache entries get a TTL. */
  persisted: readonly string[];
  /** Codes owned by another link in PostgreSQL; cache entries are dropped. */
  conflicts: readonly string[];
  /** Serialized records to keep for operators to inspect. */
  deadLetters: readonly string[];
  cacheTtlSeconds: number;
}

/**
 * Queue operations for one shard. The Redis implementation performs each
 * step atomically; tests use an in-memory implementation.
 */
export interface SyncQueue {
  length(shard: number): Promise<number>;
  acquire(
    shard: number,
    token: string,
    ttlMs: number,
  ): Promise<boolean>;
  peek(shard: number, count: number): Promise<string[]>;
  /**
   * Finalizes cache entries, records dead letters, trims the consumed
   * entries and releases the lock, but only if `token` still owns it.
   * Returns false when the lock was lost (another worker will replay the
   * batch, which the idempotent insert tolerates).
   */
  complete(
    shard: number,
    token: string,
    completion: SyncCompletion,
  ): Promise<boolean>;
  release(shard: number, token: string): Promise<void>;
}

const COMPLETE_SYNC = `
  if redis.call("GET", KEYS[2]) ~= ARGV[1] then
    return 0
  end

  local persisted = tonumber(ARGV[3])
  local conflicts = tonumber(ARGV[4])
  local dead = tonumber(ARGV[5])
  local ttlMs = tonumber(ARGV[6]) * 1000

  for index = 1, persisted do
    local key = KEYS[3 + index]

    if redis.call("HGET", key, "pending") == "1" then
      redis.call("HDEL", key, "pending")

      local current = redis.call("PTTL", key)

      if current == -1 or current > ttlMs then
        redis.call("PEXPIRE", key, ttlMs)
      end
    end
  end

  for index = 1, conflicts do
    local key = KEYS[3 + persisted + index]

    if redis.call("HGET", key, "pending") == "1" then
      redis.call("DEL", key)
    end
  end

  for index = 1, dead do
    redis.call("RPUSH", KEYS[3], ARGV[6 + index])
  end

  if dead > 0 then
    redis.call("LTRIM", KEYS[3], -10000, -1)
  end

  redis.call("LTRIM", KEYS[1], ARGV[2], -1)
  redis.call("DEL", KEYS[2])

  return 1
`;

const RELEASE_LOCK = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end

  return 0
`;

export class RedisSyncQueue implements SyncQueue {
  constructor(private readonly redis: RedisClient) {}

  async length(shard: number): Promise<number> {
    return this.redis.lLen(syncQueueKey(shard));
  }

  async acquire(
    shard: number,
    token: string,
    ttlMs: number,
  ): Promise<boolean> {
    const result = await this.redis.set(
      syncLockKey(shard),
      token,
      {
        condition: "NX",
        expiration: { type: "PX", value: ttlMs },
      },
    );

    return result === "OK";
  }

  async peek(
    shard: number,
    count: number,
  ): Promise<string[]> {
    return this.redis.lRange(
      syncQueueKey(shard),
      0,
      count - 1,
    );
  }

  async complete(
    shard: number,
    token: string,
    completion: SyncCompletion,
  ): Promise<boolean> {
    const result = await this.redis.eval(
      COMPLETE_SYNC,
      {
        keys: [
          syncQueueKey(shard),
          syncLockKey(shard),
          syncDeadLetterKey(shard),
          ...completion.persisted.map(linkKey),
          ...completion.conflicts.map(linkKey),
        ],
        arguments: [
          token,
          String(completion.consumed),
          String(completion.persisted.length),
          String(completion.conflicts.length),
          String(completion.deadLetters.length),
          String(completion.cacheTtlSeconds),
          ...completion.deadLetters,
        ],
      },
    );

    return Number(result) === 1;
  }

  async release(
    shard: number,
    token: string,
  ): Promise<void> {
    await this.redis.eval(RELEASE_LOCK, {
      keys: [syncLockKey(shard)],
      arguments: [token],
    });
  }
}

export interface LinkSyncOptions {
  shards: readonly number[];
  intervalMs: number;
  batchSize: number;
  cacheTtlSeconds: number;
  lockTtlMs?: number;
  maxBatchesPerShard?: number;
  concurrency?: number;
  /** Skip ticks while this returns false (for example Redis is down). */
  isAvailable?: () => boolean;
}

export interface SyncResult {
  synced: number;
  conflicts: number;
  poison: number;
}

function emptyResult(): SyncResult {
  return { synced: 0, conflicts: 0, poison: 0 };
}

function addResult(
  target: SyncResult,
  source: SyncResult,
): void {
  target.synced += source.synced;
  target.conflicts += source.conflicts;
  target.poison += source.poison;
}

function deadLetter(
  reason: string,
  payload: string,
): string {
  return JSON.stringify({
    reason,
    payload,
    at: new Date().toISOString(),
  });
}

/**
 * Drains the write-behind queues into PostgreSQL.
 *
 * Guarantees:
 * - At-least-once: entries leave the queue only after PostgreSQL commits.
 * - Idempotent: replays after a crash are recognised, not duplicated.
 * - Exclusive per shard: a short-lived lock prevents two workers from
 *   processing the same shard; an expired lock lets another worker resume.
 * - Ordered per shard: entries are consumed from the head in batches.
 */
export class LinkSyncWorker {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<SyncResult> | undefined;
  private closed = false;

  private readonly lockTtlMs: number;
  private readonly maxBatchesPerShard: number;
  private readonly concurrency: number;

  constructor(
    private readonly queue: SyncQueue,
    private readonly sink: PendingLinkSink,
    private readonly options: LinkSyncOptions,
    private readonly counters?: CounterSink,
  ) {
    for (const [name, value] of [
      ["intervalMs", options.intervalMs],
      ["batchSize", options.batchSize],
      ["cacheTtlSeconds", options.cacheTtlSeconds],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer`);
      }
    }

    this.lockTtlMs = options.lockTtlMs ?? 30_000;
    this.maxBatchesPerShard =
      options.maxBatchesPerShard ?? 10;
    this.concurrency = options.concurrency ?? 64;
  }

  start(): void {
    if (this.closed) {
      throw new Error("link sync worker is closed");
    }

    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      if (this.running) {
        return;
      }

      void this.tick().catch((error) => {
        console.warn("Link sync tick failed:", error);
      });
    }, this.options.intervalMs);

    this.timer.unref();
  }

  /** Processes every owned shard once. */
  tick(): Promise<SyncResult> {
    if (this.running) {
      return this.running;
    }

    const operation = this.processShards().finally(() => {
      this.running = undefined;
    });

    this.running = operation;

    return operation;
  }

  /** Repeats ticks until a tick finds nothing left to do. */
  async drain(maxTicks = 1_000_000): Promise<SyncResult> {
    const total = emptyResult();

    for (let tick = 0; tick < maxTicks; tick += 1) {
      const result = await this.tick();
      addResult(total, result);

      if (
        result.synced + result.conflicts + result.poison ===
        0
      ) {
        break;
      }
    }

    return total;
  }

  async backlog(): Promise<number> {
    const lengths = await this.mapShards((shard) =>
      this.queue.length(shard),
    );

    return lengths.reduce((sum, length) => sum + length, 0);
  }

  /** Stops the timer and flushes what is already queued. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    if (this.running) {
      await this.running.catch(() => undefined);
    }

    await this.tick().catch((error) => {
      console.warn("Final link sync failed:", error);
    });
  }

  private async processShards(): Promise<SyncResult> {
    const total = emptyResult();

    if (this.options.isAvailable && !this.options.isAvailable()) {
      return total;
    }

    let failedShards = 0;
    let firstError: unknown;

    const results = await this.mapShards(async (shard) => {
      try {
        return await this.syncShard(shard);
      } catch (error) {
        failedShards += 1;
        firstError ??= error;

        return emptyResult();
      }
    });

    if (failedShards > 0) {
      // One line per tick, not one per shard: an outage would otherwise
      // produce thousands of log lines per second.
      this.counters?.increment("link_sync_errors", failedShards);
      console.warn(
        `Link sync failed for ${failedShards} shard(s):`,
        firstError,
      );
    }

    for (const result of results) {
      addResult(total, result);
    }

    return total;
  }

  private async syncShard(shard: number): Promise<SyncResult> {
    const result = emptyResult();

    if ((await this.queue.length(shard)) === 0) {
      return result;
    }

    const token = randomUUID();

    if (!(await this.queue.acquire(shard, token, this.lockTtlMs))) {
      return result;
    }

    let held = true;

    try {
      for (
        let batchIndex = 0;
        batchIndex < this.maxBatchesPerShard;
        batchIndex += 1
      ) {
        if (batchIndex > 0) {
          held = await this.queue.acquire(
            shard,
            token,
            this.lockTtlMs,
          );

          if (!held) {
            break;
          }
        }

        const raw = await this.queue.peek(
          shard,
          this.options.batchSize,
        );

        if (raw.length === 0) {
          break;
        }

        const valid: PendingLink[] = [];
        const deadLetters: string[] = [];

        for (const entry of raw) {
          const link = parsePendingLink(entry);

          if (link) {
            valid.push(link);
          } else {
            deadLetters.push(deadLetter("invalid", entry));
          }
        }

        const poison = deadLetters.length;

        const inserted =
          valid.length > 0
            ? await this.sink.insertPendingBatch(valid)
            : { persisted: [], conflicts: [] };

        for (const conflict of inserted.conflicts) {
          deadLetters.push(
            deadLetter(
              "conflict",
              serializePendingLink(conflict),
            ),
          );

          console.error(
            `Write-behind code collision for "${conflict.code}"; ` +
              "PostgreSQL keeps the existing link",
          );
        }

        const completed = await this.queue.complete(
          shard,
          token,
          {
            consumed: raw.length,
            persisted: inserted.persisted,
            conflicts: inserted.conflicts.map(
              (link) => link.code,
            ),
            deadLetters,
            cacheTtlSeconds: this.options.cacheTtlSeconds,
          },
        );

        held = false;

        if (!completed) {
          // The lock expired while PostgreSQL was working. The rows are
          // committed; whoever holds the lock now will replay them
          // idempotently and trim the queue.
          this.counters?.increment("link_sync_lock_lost");
          break;
        }

        result.synced += inserted.persisted.length;
        result.conflicts += inserted.conflicts.length;
        result.poison += poison;

        this.counters?.increment(
          "links_synced",
          inserted.persisted.length,
        );
        this.counters?.increment(
          "link_sync_conflicts",
          inserted.conflicts.length,
        );
        this.counters?.increment(
          "link_sync_poison",
          poison,
        );

        if (raw.length < this.options.batchSize) {
          break;
        }
      }
    } finally {
      if (held) {
        await this.queue
          .release(shard, token)
          .catch(() => undefined);
      }
    }

    return result;
  }

  private async mapShards<T>(
    task: (shard: number) => Promise<T>,
  ): Promise<T[]> {
    const shards = this.options.shards;
    const results = new Array<T>(shards.length);
    let next = 0;

    const lanes = Array.from(
      { length: Math.min(this.concurrency, shards.length) },
      async () => {
        while (next < shards.length) {
          const index = next;
          next += 1;
          results[index] = await task(shards[index]!);
        }
      },
    );

    await Promise.all(lanes);

    return results;
  }
}

/** Total links waiting for PostgreSQL across the given shards. */
export async function syncBacklog(
  queue: SyncQueue,
  shards: readonly number[] = allShards(),
): Promise<number> {
  const lengths = await Promise.all(
    shards.map((shard) => queue.length(shard)),
  );

  return lengths.reduce((sum, length) => sum + length, 0);
}
