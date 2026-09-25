import type { FastifyInstance } from "fastify";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import { buildApp } from "../src/app.js";
import { HashedApiKeyAuthenticator } from "../src/security/api-key-authenticator.js";
import type { RateLimiter } from "../src/security/rate-limiter.js";
import { SafeUrlPolicy } from "../src/security/url-policy.js";
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
  redisUrl: "redis://127.0.0.1:6379",
  redisCacheTtlSeconds: 300,
  createRateLimitMax: 20,
  createRateLimitWindowSeconds: 60,
  createApiKeys: [
    "wraplink-test-key-0000000000000001",
  ],
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("short links", () => {
  it(
    "creates, redirects and reports a link",
    async () => {
      app = buildApp(
        config,
        new MemoryLinkStore(100),
      );

      const created = await app.inject({
        method: "POST",
        url: "/api/v1/links",
        payload: {
          url: "https://example.com/docs",
          customCode: "docs",
        },
      });

      expect(created.statusCode).toBe(201);

      expect(created.json().shortUrl).toBe(
        "http://sho.rt/docs",
      );

      const redirect = await app.inject({
        method: "GET",
        url: "/docs",
      });

      expect(redirect.statusCode).toBe(302);

      expect(
        redirect.headers.location,
      ).toBe("https://example.com/docs");

      const stats = await app.inject({
        method: "GET",
        url: "/api/v1/links/docs",
      });

      expect(stats.json().clicks).toBe(1);
    },
  );

  it(
    "rejects unsafe URLs and duplicate custom codes",
    async () => {
      app = buildApp(
        config,
        new MemoryLinkStore(100),
      );

      const unsafe = await app.inject({
        method: "POST",
        url: "/api/v1/links",
        payload: {
          url: "javascript:alert(1)",
        },
      });

      expect(unsafe.statusCode).toBe(400);

      await app.inject({
        method: "POST",
        url: "/api/v1/links",
        payload: {
          url: "https://example.com",
          customCode: "same",
        },
      });

      const duplicate = await app.inject({
        method: "POST",
        url: "/api/v1/links",
        payload: {
          url: "https://openai.com",
          customCode: "same",
        },
      });

      expect(duplicate.statusCode).toBe(409);
    },
  );

  it("expires links", async () => {
    app = buildApp(
      config,
      new MemoryLinkStore(100),
    );

    await app.inject({
      method: "POST",
      url: "/api/v1/links",
      payload: {
        url: "https://example.com",
        customCode: "gone",
        expiresInSeconds: 1,
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 1_050);
    });

    const response = await app.inject({
      method: "GET",
      url: "/gone",
    });

    expect(response.statusCode).toBe(404);
  });

  it(
    "adds baseline security headers",
    async () => {
      app = buildApp(
        config,
        new MemoryLinkStore(100),
      );

      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(response.headers).toMatchObject({
        "content-security-policy":
          "default-src 'none'",
        "permissions-policy":
          "camera=(), microphone=(), geolocation=()",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      });
    },
  );

  it(
    "rejects oversized request bodies",
    async () => {
      app = buildApp(
        config,
        new MemoryLinkStore(100),
      );

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/links",
        payload: {
          url: "https://example.com",
          padding: "x".repeat(
            20 * 1_024,
          ),
        },
      });

      expect(response.statusCode).toBe(413);
    },
  );

  it("rate limits link creation", async () => {
    const rateLimiter: RateLimiter = {
      async consume() {
        return {
          allowed: false,
          limit: 2,
          remaining: 0,
          retryAfterSeconds: 30,
        };
      },
    };

    app = buildApp(
      config,
      new MemoryLinkStore(100),
      rateLimiter,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/links",
      payload: {
        url: "https://example.com",
      },
    });

    expect(response.statusCode).toBe(429);

    expect(response.json()).toEqual({
      error:
        "link creation rate limit exceeded",
    });

    expect(response.headers).toMatchObject({
      "rate-limit-limit": "2",
      "rate-limit-remaining": "0",
      "rate-limit-reset": "30",
      "retry-after": "30",
    });
  });

  it(
    "fails closed when rate limiting is unavailable",
    async () => {
      const rateLimiter: RateLimiter = {
        async consume() {
          throw new Error(
            "Redis unavailable",
          );
        },
      };

      app = buildApp(
        config,
        new MemoryLinkStore(100),
        rateLimiter,
      );

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/links",
        payload: {
          url: "https://example.com",
        },
      });

      expect(response.statusCode).toBe(503);

      expect(response.json()).toEqual({
        error:
          "link creation is temporarily unavailable",
      });
    },
  );

  it(
    "requires a valid API key for link creation",
    async () => {
      const authenticator =
        new HashedApiKeyAuthenticator(
          config.createApiKeys,
        );

      app = buildApp(
        config,
        new MemoryLinkStore(100),
        undefined,
        authenticator,
      );

      const unauthorized = await app.inject({
        method: "POST",
        url: "/api/v1/links",
        payload: {
          url: "https://example.com/private",
          customCode: "private",
        },
      });

      expect(
        unauthorized.statusCode,
      ).toBe(401);

      expect(
        unauthorized.headers,
      ).toMatchObject({
        "www-authenticate":
          'ApiKey realm="link-creation"',
      });

      expect(unauthorized.json()).toEqual({
        error: "valid API key required",
      });

      const authorized = await app.inject({
        method: "POST",
        url: "/api/v1/links",
        headers: {
          "x-api-key":
            config.createApiKeys[0]!,
        },
        payload: {
          url: "https://example.com/private",
          customCode: "private",
        },
      });

      expect(
        authorized.statusCode,
      ).toBe(201);
    },
  );

  it(
    "rejects private-network destination URLs",
    async () => {
      app = buildApp(
        config,
        new MemoryLinkStore(100),
        undefined,
        undefined,
        new SafeUrlPolicy(),
      );

      const loopback = await app.inject({
        method: "POST",
        url: "/api/v1/links",
        payload: {
          url: "http://127.0.0.1:8080/admin",
          customCode: "loopback",
        },
      });

      expect(loopback.statusCode).toBe(400);

      expect(loopback.json()).toEqual({
        error:
          "url must be a valid and publicly reachable http or https URL",
      });

      const metadataService =
        await app.inject({
          method: "POST",
          url: "/api/v1/links",
          payload: {
            url: "http://169.254.169.254/latest/meta-data",
            customCode: "metadata",
          },
        });

      expect(
        metadataService.statusCode,
      ).toBe(400);
    },
  );
});