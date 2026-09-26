import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import {
  createRedisClient,
  type RedisClient,
} from "../../src/cache/redis-client.js";

const redisClusterUrls =
  process.env.REDIS_CLUSTER_URLS
    ?.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0) ??
  [];

if (redisClusterUrls.length === 0) {
  throw new Error(
    "REDIS_CLUSTER_URLS is required for Redis Cluster integration tests",
  );
}

let client: RedisClient;

beforeAll(async () => {
  client = createRedisClient({
    redisUrl: "redis://127.0.0.1:6379",
    redisClusterUrls,
  });

  await client.connect();
});

afterAll(async () => {
  if (client.isOpen) {
    await client.quit();
  }
});

describe("Redis Cluster client", () => {
  it(
    "reads and writes through the cluster",
    async () => {
      const key =
        "wraplink:test:redis-cluster";

      await client.set(key, "working");

      expect(
        await client.get(key),
      ).toBe("working");

      await client.del(key);
    },
  );
});
