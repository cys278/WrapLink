import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildApp } from "../../src/app.js";
import { PostgresLinkStore } from "../../src/store/postgres-link-store.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://shortener:shortener@127.0.0.1:55432/shortener";

const config = {
  host: "127.0.0.1",
  port: 3000,
  baseUrl: "http://sho.rt",
  logLevel: "silent",
  maxLinks: 100,
  databaseUrl,
  databasePoolMax: 5,
};

const pool = new Pool({
  connectionString: databaseUrl,
  max: config.databasePoolMax,
});

const store = new PostgresLinkStore(pool);
const app = buildApp(config, store);

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE links");
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("PostgreSQL-backed API", () => {
  it("creates, redirects and persists click statistics", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/links",
      payload: {
        url: "https://example.com/database",
        customCode: "database",
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      code: "database",
      shortUrl: "http://sho.rt/database",
      targetUrl: "https://example.com/database",
    });

    const redirect = await app.inject({
      method: "GET",
      url: "/database",
    });

    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe(
      "https://example.com/database",
    );

    const statistics = await app.inject({
      method: "GET",
      url: "/api/v1/links/database",
    });

    expect(statistics.statusCode).toBe(200);
    expect(statistics.json()).toMatchObject({
      code: "database",
      clicks: 1,
    });

    const persisted = await pool.query<{
      code: string;
      clicks: string;
    }>(
      "SELECT code, clicks FROM links WHERE code = $1",
      ["database"],
    );

    expect(persisted.rows[0]).toEqual({
      code: "database",
      clicks: "1",
    });
  });
});