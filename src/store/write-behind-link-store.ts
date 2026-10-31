import {
  LINK_KEY_SHARDS,
  linkKey,
  shardOf,
  syncQueueKey,
} from "../cache/keys.js";
import type { RedisClient } from "../cache/redis-client.js";
import type {
  CreateLinkInput,
  Link,
  LinkStore,
  PendingLink,
} from "../domain/link.js";

/**
 * Creates the link hash and appends it to its shard's sync queue in one
 * atomic step. Both keys share a hash tag, so this works in Redis Cluster.
 *
 * Returns  1 when the link was accepted,
 *          0 when the code already exists in Redis,
 *         -1 when the shard's queue is full (backpressure).
 */
const ENQUEUE_LINK = `
  if redis.call("EXISTS", KEYS[1]) == 1 then
    return 0
  end

  if redis.call("LLEN", KEYS[2]) >= tonumber(ARGV[1]) then
    return -1
  end

  redis.call(
    "HSET", KEYS[1],
    "code", ARGV[3],
    "targetUrl", ARGV[4],
    "createdAt", ARGV[5],
    "expiresAt", ARGV[6],
    "clicks", "0",
    "pending", "1"
  )

  if ARGV[7] ~= "0" then
    redis.call("PEXPIRE", KEYS[1], ARGV[7])
  end

  redis.call("RPUSH", KEYS[2], ARGV[2])

  return 1
`;

export interface CounterSink {
  increment(name: string, value?: number): void;
}

export interface WriteBehindOptions {
  /**
   * Upper bound on links waiting in Redis for PostgreSQL. Bounding the
   * backlog bounds Redis memory: when PostgreSQL falls behind, new links
   * fall back to synchronous inserts instead of filling RAM.
   */
  maxPendingLinks: number;
}

export function serializePendingLink(
  link: PendingLink,
): string {
  return JSON.stringify({
    code: link.code,
    targetUrl: link.targetUrl,
    createdAt: link.createdAt.toISOString(),
    expiresAt: link.expiresAt?.toISOString() ?? null,
  });
}

export function parsePendingLink(
  value: string,
): PendingLink | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;

  if (
    typeof record.code !== "string" ||
    !/^[A-Za-z0-9_-]{4,32}$/.test(record.code) ||
    typeof record.targetUrl !== "string" ||
    record.targetUrl.length === 0 ||
    record.targetUrl.length > 2_048 ||
    typeof record.createdAt !== "string"
  ) {
    return null;
  }

  const createdAt = new Date(record.createdAt);

  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }

  let expiresAt: Date | null = null;

  if (record.expiresAt !== null) {
    if (typeof record.expiresAt !== "string") {
      return null;
    }

    expiresAt = new Date(record.expiresAt);

    if (Number.isNaN(expiresAt.getTime())) {
      return null;
    }
  }

  return {
    code: record.code,
    targetUrl: record.targetUrl,
    createdAt,
    expiresAt,
  };
}

/**
 * Write-behind link creation.
 *
 * Generated codes are written to Redis and acknowledged immediately; the
 * LinkSyncWorker later inserts them into PostgreSQL in batches. Reads,
 * clicks, custom aliases and every failure mode delegate to the
 * synchronous store, so PostgreSQL remains the source of truth.
 *
 * Durability trade-off: a link lives only in Redis until it is synced
 * (normally well under a second). Run Redis with AOF and replicas when
 * using this mode; see docs/ARCHITECTURE.md.
 */
export class WriteBehindLinkStore
  implements LinkStore
{
  private readonly maxPendingPerShard: number;

  constructor(
    private readonly synchronous: LinkStore,
    private readonly redis: RedisClient,
    options: WriteBehindOptions,
    private readonly counters?: CounterSink,
  ) {
    if (
      !Number.isSafeInteger(options.maxPendingLinks) ||
      options.maxPendingLinks < 1
    ) {
      throw new Error(
        "maxPendingLinks must be a positive integer",
      );
    }

    this.maxPendingPerShard = Math.max(
      1,
      Math.ceil(
        options.maxPendingLinks / LINK_KEY_SHARDS,
      ),
    );
  }

  async create(
    input: CreateLinkInput,
  ): Promise<Link | null> {
    if (input.codeSource === "custom") {
      return this.createCustom(input);
    }

    if (!this.redis.isReady) {
      this.counters?.increment(
        "write_behind_fallbacks",
      );

      return this.synchronous.create(input);
    }

    const createdAt = new Date();

    const pending: PendingLink = {
      code: input.code,
      targetUrl: input.targetUrl,
      createdAt,
      expiresAt: input.expiresAt,
    };

    let outcome: number;

    try {
      const result = await this.redis.eval(
        ENQUEUE_LINK,
        {
          keys: [
            linkKey(input.code),
            syncQueueKey(shardOf(input.code)),
          ],
          arguments: [
            String(this.maxPendingPerShard),
            serializePendingLink(pending),
            input.code,
            input.targetUrl,
            createdAt.toISOString(),
            input.expiresAt?.toISOString() ?? "",
            // Relative, not absolute (PEXPIREAT): the app's and Redis's
            // clocks may differ, and a relative TTL is immune to that skew.
            input.expiresAt
              ? String(
                  Math.max(
                    1,
                    input.expiresAt.getTime() - createdAt.getTime(),
                  ),
                )
              : "0",
          ],
        },
      );

      outcome = Number(result);
    } catch (error) {
      console.warn(
        "Write-behind enqueue failed; using PostgreSQL:",
        error,
      );

      this.counters?.increment(
        "write_behind_fallbacks",
      );

      return this.synchronous.create(input);
    }

    if (outcome === 1) {
      this.counters?.increment("links_queued");

      return {
        code: input.code,
        targetUrl: input.targetUrl,
        createdAt,
        expiresAt: input.expiresAt,
        clicks: 0,
      };
    }

    if (outcome === 0) {
      return null;
    }

    // Queue full: PostgreSQL is behind. Shed load onto the durable path
    // rather than growing Redis memory without bound.
    this.counters?.increment("write_behind_backpressure");

    return this.synchronous.create(input);
  }

  find(code: string): Promise<Link | null> {
    return this.synchronous.find(code);
  }

  recordClick(code: string): Promise<void> {
    return this.synchronous.recordClick(code);
  }

  size(): Promise<number> {
    return this.synchronous.size();
  }

  isHealthy(): Promise<boolean> {
    return this.synchronous.isHealthy();
  }

  private async createCustom(
    input: CreateLinkInput,
  ): Promise<Link | null> {
    // A generated code may be waiting in Redis but not yet in PostgreSQL.
    // Refuse the alias rather than let the later sync collide with it.
    if (this.redis.isReady) {
      try {
        const pendingFlag = await this.redis.hGet(
          linkKey(input.code),
          "pending",
        );

        if (pendingFlag === "1") {
          return null;
        }
      } catch {
        // Fall through: PostgreSQL still enforces uniqueness, and the
        // sync worker detects the rare remaining race.
      }
    }

    return this.synchronous.create(input);
  }
}
