import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { MemoryLinkStore } from "../src/store/memory-link-store.js";

const config = {
  host: "127.0.0.1",
  port: 3000,
  baseUrl: "http://sho.rt",
  logLevel: "silent",
  maxLinks: 100,
  databaseUrl:
    "postgresql://shortener:shortener@127.0.0.1:55432/shortener",
  databasePoolMax: 5,
};
let app: FastifyInstance | undefined;

afterEach(async () => { await app?.close(); app = undefined; });

describe("short links", () => {
  it("creates, redirects and reports a link", async () => {
    app = buildApp(config, new MemoryLinkStore(100));
    const created = await app.inject({ method: "POST", url: "/api/v1/links", payload: { url: "https://example.com/docs", customCode: "docs" } });
    expect(created.statusCode).toBe(201);
    expect(created.json().shortUrl).toBe("http://sho.rt/docs");

    const redirect = await app.inject({ method: "GET", url: "/docs" });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe("https://example.com/docs");

    const stats = await app.inject({ method: "GET", url: "/api/v1/links/docs" });
    expect(stats.json().clicks).toBe(1);
  });

  it("rejects unsafe URLs and duplicate custom codes", async () => {
    app = buildApp(config, new MemoryLinkStore(100));
    const unsafe = await app.inject({ method: "POST", url: "/api/v1/links", payload: { url: "javascript:alert(1)" } });
    expect(unsafe.statusCode).toBe(400);
    await app.inject({ method: "POST", url: "/api/v1/links", payload: { url: "https://example.com", customCode: "same" } });
    const duplicate = await app.inject({ method: "POST", url: "/api/v1/links", payload: { url: "https://openai.com", customCode: "same" } });
    expect(duplicate.statusCode).toBe(409);
  });

  it("expires links", async () => {
    app = buildApp(config, new MemoryLinkStore(100));
    await app.inject({ method: "POST", url: "/api/v1/links", payload: { url: "https://example.com", customCode: "gone", expiresInSeconds: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const response = await app.inject({ method: "GET", url: "/gone" });
    expect(response.statusCode).toBe(404);
  });
});
