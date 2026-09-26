import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import {
  createRedisClient,
  type RedisClient,
} from "../../src/cache/redis-client.js";

const key = "wraplink:test:connection";

let client: RedisClient;

beforeAll(async () => {
  client = createRedisClient({
    redisUrl:
      process.env.REDIS_URL ??
      "redis://127.0.0.1:6379",
    redisClusterUrls: [],
  });

  await client.connect();
});

afterEach(async () => {
  await client.del(key);
});

afterAll(async () => {
  if (client.isOpen) {
    await client.close();
  }
});

describe("Redis client", () => {
  it("stores and retrieves an expiring value", async () => {
    await client.set(key, "connected", {
      expiration: {
        type: "EX",
        value: 30,
      },
    });

    expect(await client.get(key)).toBe("connected");

    const ttl = await client.ttl(key);

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });
});