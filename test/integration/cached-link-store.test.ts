import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { Pool } from "pg";
import { createRedisClient } from "../../src/cache/redis-client.js";
import { CachedLinkStore } from "../../src/store/cached-link-store.js";
import { PostgresLinkStore } from "../../src/store/postgres-link-store.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://shortener:shortener@127.0.0.1:55432/shortener";

const redisUrl =
  process.env.REDIS_URL ??
  "redis://127.0.0.1:6379";

const pool = new Pool({
  connectionString: databaseUrl,
  max: 5,
});

const redis = createRedisClient({ redisUrl });
const postgres = new PostgresLinkStore(pool);
const store = new CachedLinkStore(
  postgres,
  redis,
  300,
);

const codes = [
  "cached",
  "fallback",
  "atomic",
  "expires",
];

function cacheKey(code: string): string {
  return `wraplink:link:${code}`;
}

beforeAll(async () => {
  await redis.connect();
});

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE links");

  await Promise.all(
    codes.map((code) => redis.del(cacheKey(code))),
  );
});

afterEach(async () => {
  await Promise.all(
    codes.map((code) => redis.del(cacheKey(code))),
  );
});

afterAll(async () => {
  if (redis.isOpen) {
    await redis.close();
  }

  await pool.end();
});

describe("CachedLinkStore", () => {
  it("populates Redis after creating a link", async () => {
    await store.create({
      code: "cached",
      targetUrl: "https://example.com/cached",
      expiresAt: null,
    });

    const cached = await redis.hGetAll(
      cacheKey("cached"),
    );

    expect(cached).toMatchObject({
      code: "cached",
      targetUrl: "https://example.com/cached",
      clicks: "0",
    });
  });

  it("serves a cached link without reading PostgreSQL", async () => {
    const created = await store.create({
      code: "cached",
      targetUrl: "https://example.com/cached",
      expiresAt: null,
    });

    await pool.query(
      "DELETE FROM links WHERE code = $1",
      ["cached"],
    );

    expect(await store.find("cached")).toEqual(created);
  });

  it("falls back to PostgreSQL and populates Redis", async () => {
    await postgres.create({
      code: "fallback",
      targetUrl: "https://example.com/fallback",
      expiresAt: null,
    });

    expect(
      await redis.exists(cacheKey("fallback")),
    ).toBe(0);

    const found = await store.find("fallback");

    expect(found?.targetUrl).toBe(
      "https://example.com/fallback",
    );

    expect(
      await redis.exists(cacheKey("fallback")),
    ).toBe(1);
  });

  it("keeps concurrent click counts synchronized", async () => {
    await store.create({
      code: "atomic",
      targetUrl: "https://example.com/atomic",
      expiresAt: null,
    });

    await Promise.all(
      Array.from(
        { length: 25 },
        () => store.recordClick("atomic"),
      ),
    );

    expect((await store.find("atomic"))?.clicks).toBe(25);

    const persisted = await pool.query<{
      clicks: string;
    }>(
      "SELECT clicks FROM links WHERE code = $1",
      ["atomic"],
    );

    expect(persisted.rows[0]?.clicks).toBe("25");
  });

  it("does not cache beyond the link expiration", async () => {
    await store.create({
      code: "expires",
      targetUrl: "https://example.com/expires",
      expiresAt: new Date(Date.now() + 5_000),
    });

    const ttl = await redis.ttl(
      cacheKey("expires"),
    );

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5);
  });
});