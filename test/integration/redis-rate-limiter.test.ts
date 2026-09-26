import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { randomUUID } from "node:crypto";
import { createRedisClient } from "../../src/cache/redis-client.js";
import { RedisRateLimiter } from "../../src/security/rate-limiter.js";

const redisUrl =
  process.env.REDIS_URL ??
  "redis://127.0.0.1:6379";

const redis = createRedisClient({
  redisUrl,
  redisClusterUrls: [],
});

beforeAll(async () => {
  await redis.connect();
});

afterAll(async () => {
  if (redis.isOpen) {
    await redis.close();
  }
});

describe("RedisRateLimiter", () => {
  it("atomically rejects requests above the limit", async () => {
    const limiter = new RedisRateLimiter(
      redis,
      2,
      30,
      `wraplink:test:rate:${randomUUID()}`,
    );

    const identity = "192.0.2.1";

    const first = await limiter.consume(identity);
    const second = await limiter.consume(identity);
    const third = await limiter.consume(identity);

    expect(first).toMatchObject({
      allowed: true,
      limit: 2,
      remaining: 1,
    });

    expect(second).toMatchObject({
      allowed: true,
      limit: 2,
      remaining: 0,
    });

    expect(third).toMatchObject({
      allowed: false,
      limit: 2,
      remaining: 0,
    });

    expect(third.retryAfterSeconds).toBeGreaterThan(0);
    expect(third.retryAfterSeconds).toBeLessThanOrEqual(30);
  });
});