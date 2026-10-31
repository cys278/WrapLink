import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { CreateLinkInput } from "../src/domain/link.js";
import { Metrics } from "../src/metrics.js";
import { MemoryLinkStore } from "../src/store/memory-link-store.js";

const config = {
  baseUrl: "http://sho.rt",
  logLevel: "silent",
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function create(url = "https://example.com/page", customCode?: string) {
  return app!.inject({
    method: "POST",
    url: "/api/v1/links",
    payload: customCode ? { url, customCode } : { url },
  });
}

describe("application options", () => {
  it("uses the injected code generator and tags the code source", async () => {
    const store = new MemoryLinkStore(100);
    const createSpy = vi.spyOn(store, "create");

    app = buildApp(config, store, undefined, undefined, undefined, new Metrics(), {
      codeGenerator: async () => "Gen3rated",
    });

    const response = await create();

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      code: "Gen3rated",
      shortUrl: "http://sho.rt/Gen3rated",
    });
    expect(
      (createSpy.mock.calls[0]![0] as CreateLinkInput).codeSource,
    ).toBe("generated");

    await create("https://example.com/custom", "custom-alias");

    expect(
      (createSpy.mock.calls[1]![0] as CreateLinkInput).codeSource,
    ).toBe("custom");
  });

  it("retries with a fresh code when a generated code is taken", async () => {
    const codes = ["dupe1234", "dupe1234", "fresh123"];

    app = buildApp(config, new MemoryLinkStore(100), undefined, undefined, undefined, new Metrics(), {
      codeGenerator: async () => codes.shift()!,
    });

    expect((await create()).json().code).toBe("dupe1234");
    expect((await create()).json().code).toBe("fresh123");
  });

  it("returns 503 when no code can be generated", async () => {
    app = buildApp(config, new MemoryLinkStore(100), undefined, undefined, undefined, new Metrics(), {
      codeGenerator: async () => {
        throw new Error("sequence unavailable");
      },
    });

    const response = await create();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "link creation is temporarily unavailable",
    });
  });

  it("echoes safe request IDs and replaces unsafe ones", async () => {
    app = buildApp(config, new MemoryLinkStore(100));

    const supplied = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "lb-7f3a.42" },
    });

    expect(supplied.headers["x-request-id"]).toBe("lb-7f3a.42");

    const unsafe = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "bad id\nwith newline" },
    });

    expect(unsafe.headers["x-request-id"]).toMatch(
      /^[0-9a-f-]{36}$/,
    );

    const missing = await app.inject({ method: "GET", url: "/health" });

    expect(missing.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("appends extra gauges to /metrics and tolerates their failure", async () => {
    app = buildApp(config, new MemoryLinkStore(100), undefined, undefined, undefined, new Metrics(), {
      extraMetrics: async () =>
        "# TYPE shortener_link_sync_backlog gauge\nshortener_link_sync_backlog 7\n",
    });

    const ok = await app.inject({ method: "GET", url: "/metrics" });

    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain("shortener_link_sync_backlog 7");
    expect(ok.body).toContain("shortener_links_created_total 0");

    await app.close();

    app = buildApp(config, new MemoryLinkStore(100), undefined, undefined, undefined, new Metrics(), {
      extraMetrics: async () => {
        throw new Error("redis down");
      },
    });

    const degraded = await app.inject({ method: "GET", url: "/metrics" });

    expect(degraded.statusCode).toBe(200);
    expect(degraded.body).toContain("shortener_links_created_total 0");
  });

  it("uses X-Forwarded-For for rate limiting only when trusted", async () => {
    const seen: string[] = [];
    const rateLimiter = {
      consume: async (identity: string) => {
        seen.push(identity);

        return {
          allowed: true,
          limit: 10,
          remaining: 9,
          retryAfterSeconds: 60,
        };
      },
    };

    for (const trustProxy of [false, true]) {
      app = buildApp(
        { ...config, trustProxy },
        new MemoryLinkStore(100),
        rateLimiter,
      );

      await app.inject({
        method: "POST",
        url: "/api/v1/links",
        remoteAddress: "10.0.0.5",
        headers: { "x-forwarded-for": "203.0.113.9" },
        payload: { url: "https://example.com/x" },
      });

      await app.close();
      app = undefined;
    }

    expect(seen).toEqual(["10.0.0.5", "203.0.113.9"]);
  });
});
