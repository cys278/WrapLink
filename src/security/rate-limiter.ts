import { createHash } from "node:crypto";
import type { RedisClient } from "../cache/redis-client.js";

const CONSUME_RATE_LIMIT = `
  local current = redis.call("INCR", KEYS[1])

  if current == 1 then
    redis.call("EXPIRE", KEYS[1], ARGV[1])
  end

  local ttl = redis.call("TTL", KEYS[1])

  if ttl < 0 then
    redis.call("EXPIRE", KEYS[1], ARGV[1])
    ttl = tonumber(ARGV[1])
  end

  return { current, ttl }
`;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(identity: string): Promise<RateLimitResult>;
}

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: RedisClient,
    private readonly maximum: number,
    private readonly windowSeconds: number,
    private readonly prefix = "wraplink:rate:create",
  ) {
    if (
      !Number.isSafeInteger(maximum) ||
      maximum < 1
    ) {
      throw new Error(
        "Rate-limit maximum must be a positive integer",
      );
    }

    if (
      !Number.isSafeInteger(windowSeconds) ||
      windowSeconds < 1
    ) {
      throw new Error(
        "Rate-limit window must be a positive integer",
      );
    }
  }

  async consume(
    identity: string,
  ): Promise<RateLimitResult> {
    if (!this.redis.isReady) {
      throw new Error("Redis is unavailable");
    }

    const result = await this.redis.eval(
      CONSUME_RATE_LIMIT,
      {
        keys: [this.key(identity)],
        arguments: [String(this.windowSeconds)],
      },
    );

    if (
      !Array.isArray(result) ||
      result.length !== 2
    ) {
      throw new Error(
        "Redis returned an invalid rate-limit result",
      );
    }

    const count = Number(result[0]);
    const ttl = Number(result[1]);

    if (
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(ttl)
    ) {
      throw new Error(
        "Redis returned invalid rate-limit values",
      );
    }

    return {
      allowed: count <= this.maximum,
      limit: this.maximum,
      remaining: Math.max(
        0,
        this.maximum - count,
      ),
      retryAfterSeconds: Math.max(1, ttl),
    };
  }

  private key(identity: string): string {
    const digest = createHash("sha256")
      .update(identity)
      .digest("hex");

    return `${this.prefix}:${digest}`;
  }
}