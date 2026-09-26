import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { Pool } from "pg";
import { PostgresLinkStore } from "../../src/store/postgres-link-store.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://shortener:shortener@127.0.0.1:55432/shortener";

const pool = new Pool({
  connectionString: databaseUrl,
  max: 5,
});

const store = new PostgresLinkStore(pool);

beforeEach(async () => {
  await pool.query(
    "TRUNCATE TABLE links",
  );
});

afterAll(async () => {
  await pool.end();
});

describe("PostgresLinkStore", () => {
  it(
    "reports healthy when PostgreSQL is reachable",
    async () => {
      expect(
        await store.isHealthy(),
      ).toBe(true);
    },
  );

  it(
    "creates and retrieves a link",
    async () => {
      const created = await store.create({
        code: "docs",
        targetUrl:
          "https://example.com/docs",
        expiresAt: null,
      });

      expect(created).toMatchObject({
        code: "docs",
        targetUrl:
          "https://example.com/docs",
        clicks: 0,
        expiresAt: null,
      });

      expect(
        created?.createdAt,
      ).toBeInstanceOf(Date);

      const found = await store.find(
        "docs",
      );

      expect(found).toEqual(created);
      expect(await store.size()).toBe(1);
    },
  );

  it(
    "returns null when a code already exists",
    async () => {
      const input = {
        code: "same",
        targetUrl:
          "https://example.com",
        expiresAt: null,
      };

      expect(
        await store.create(input),
      ).not.toBeNull();

      expect(
        await store.create(input),
      ).toBeNull();

      expect(await store.size()).toBe(1);
    },
  );

  it(
    "does not return expired links",
    async () => {
      await store.create({
        code: "gone",
        targetUrl:
          "https://example.com",
        expiresAt: new Date(
          Date.now() - 1_000,
        ),
      });

      expect(
        await store.find("gone"),
      ).toBeNull();
    },
  );

  it(
    "increments click counts atomically",
    async () => {
      await store.create({
        code: "clicks",
        targetUrl:
          "https://example.com",
        expiresAt: null,
      });

      await Promise.all(
        Array.from(
          { length: 25 },
          () =>
            store.recordClick("clicks"),
        ),
      );

      const found = await store.find(
        "clicks",
      );

      expect(found?.clicks).toBe(25);
    },
  );

  it(
    "increments multiple clicks in one database operation",
    async () => {
      await store.create({
        code: "batched",
        targetUrl:
          "https://example.com/batched",
        expiresAt: null,
      });

      await store.recordClicks(
        "batched",
        25,
      );

      const found = await store.find(
        "batched",
      );

      expect(found?.clicks).toBe(25);
    },
  );

  it(
    "increments multiple links in one batch",
    async () => {
      await store.create({
        code: "alpha",
        targetUrl:
          "https://example.com/alpha",
        expiresAt: null,
      });

      await store.create({
        code: "bravo",
        targetUrl:
          "https://example.com/bravo",
        expiresAt: null,
      });

      await store.create({
        code: "charlie",
        targetUrl:
          "https://example.com/charlie",
        expiresAt: null,
      });

      await store.recordClickBatch(
        new Map([
          ["alpha", 3],
          ["bravo", 7],
          ["charlie", 11],
        ]),
      );

      expect(
        (await store.find("alpha"))?.clicks,
      ).toBe(3);

      expect(
        (await store.find("bravo"))?.clicks,
      ).toBe(7);

      expect(
        (await store.find("charlie"))?.clicks,
      ).toBe(11);
    },
  );

  it(
    "rejects invalid click batches",
    async () => {
      await expect(
        store.recordClickBatch(
          new Map([
            ["docs", 0],
          ]),
        ),
      ).rejects.toThrow(
        "click count must be a positive integer",
      );

      await expect(
        store.recordClickBatch(
          new Map([
            ["docs", 1.5],
          ]),
        ),
      ).rejects.toThrow(
        "click count must be a positive integer",
      );
    },
  );

  it(
    "rejects invalid batched click counts",
    async () => {
      await expect(
        store.recordClicks("docs", 0),
      ).rejects.toThrow(
        "click count must be a positive integer",
      );

      await expect(
        store.recordClicks("docs", 1.5),
      ).rejects.toThrow(
        "click count must be a positive integer",
      );
    },
  );
});