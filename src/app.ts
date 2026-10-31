import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import Fastify, {
  LogController,
  type FastifyInstance,
} from "fastify";

import type { AppConfig } from "./config.js";
import { generateCode } from "./domain/code.js";
import type { LinkStore } from "./domain/link.js";
import {
  Metrics,
  type MetricsCollector,
} from "./metrics.js";
import type { ApiKeyAuthenticator } from "./security/api-key-authenticator.js";
import type { RateLimiter } from "./security/rate-limiter.js";
import type { UrlPolicy } from "./security/url-policy.js";

interface CreateBody {
  url?: unknown;
  customCode?: unknown;
  expiresInSeconds?: unknown;
}

const CODE_PATTERN = /^[A-Za-z0-9_-]{4,32}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** The HTTP-facing subset of AppConfig that buildApp actually reads. */
export type AppHttpConfig = Pick<
  AppConfig,
  "baseUrl" | "logLevel"
> & {
  trustProxy?: boolean;
};

export interface AppOptions {
  /**
   * Produces codes for links without a customCode. Defaults to 8 random
   * Base62 characters; write-behind mode injects the collision-free
   * block allocator instead.
   */
  codeGenerator?: () => Promise<string>;
  /** Extra Prometheus exposition text (gauges) appended to /metrics. */
  extraMetrics?: () => Promise<string>;
}

function requestId(request: IncomingMessage): string {
  // Reuse a caller-supplied ID (for example from a load balancer) so one
  // request can be followed across services; otherwise mint one.
  const supplied = request.headers["x-request-id"];

  if (
    typeof supplied === "string" &&
    REQUEST_ID_PATTERN.test(supplied)
  ) {
    return supplied;
  }

  return randomUUID();
}

function validHttpUrl(
  value: unknown,
): string | null {
  if (
    typeof value !== "string" ||
    value.length > 2_048
  ) {
    return null;
  }

  try {
    const url = new URL(value);

    const validProtocol =
      url.protocol === "http:" ||
      url.protocol === "https:";

    return validProtocol ? url.href : null;
  } catch {
    return null;
  }
}

export function buildApp(
  config: AppHttpConfig,
  store: LinkStore,
  rateLimiter?: RateLimiter,
  apiKeyAuthenticator?: ApiKeyAuthenticator,
  urlPolicy?: UrlPolicy,
  metrics: MetricsCollector = new Metrics(),
  options: AppOptions = {},
): FastifyInstance {
  const codeGenerator =
    options.codeGenerator ??
    (async () => generateCode());

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy ?? false,
    requestIdHeader: false,
    genReqId: requestId,
    logController: new LogController({
      disableRequestLogging: true,
    }),
    bodyLimit: 16 * 1_024,
    requestTimeout: 10_000,
    connectionTimeout: 10_000,
  });

  const requestStartTimes =
    new WeakMap<object, bigint>();

  app.addHook(
    "onSend",
    async (request, reply, payload) => {
      reply.headers({
        "x-request-id": request.id,
        "content-security-policy":
          "default-src 'none'",
        "permissions-policy":
          "camera=(), microphone=(), geolocation=()",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      });

      return payload;
    },
  );

  app.addHook(
    "onRequest",
    async (request) => {
      requestStartTimes.set(
        request,
        process.hrtime.bigint(),
      );
    },
  );

  app.addHook(
    "onResponse",
    async (request, reply) => {
      const startTime =
        requestStartTimes.get(request);

      if (startTime === undefined) {
        return;
      }

      requestStartTimes.delete(request);

      const elapsedNanoseconds =
        process.hrtime.bigint() - startTime;

      const route =
        request.routeOptions.url ??
        "unknown";

      metrics.request(
        request.method,
        route,
        reply.statusCode,
        Number(elapsedNanoseconds) /
          1_000_000_000,
      );
    },
  );

  app.get("/health", async () => ({
    status: "ok",
  }));

  app.get(
    "/ready",
    async (_request, reply) => {
      const healthy =
        await store.isHealthy();

      if (!healthy) {
        return reply.code(503).send({
          status: "not_ready",
        });
      }

      return {
        status: "ready",
      };
    },
  );

  app.get(
    "/metrics",
    async (request, reply) => {
      let body = await metrics.render();

      if (options.extraMetrics) {
        try {
          body += await options.extraMetrics();
        } catch (error) {
          request.log.warn(
            { error },
            "could not collect extra metrics",
          );
        }
      }

      return reply
        .type("text/plain; version=0.0.4")
        .send(body);
    },
  );

  app.post<{ Body: CreateBody }>(
    "/api/v1/links",
    async (request, reply) => {
      // Rate limiting runs before authentication so
      // invalid credentials cannot be guessed without
      // consuming quota.
      if (rateLimiter) {
        try {
          const result =
            await rateLimiter.consume(
              request.ip,
            );

          reply.headers({
            "rate-limit-limit": String(
              result.limit,
            ),
            "rate-limit-remaining": String(
              result.remaining,
            ),
            "rate-limit-reset": String(
              result.retryAfterSeconds,
            ),
          });

          if (!result.allowed) {
            return reply
              .header(
                "retry-after",
                String(
                  result.retryAfterSeconds,
                ),
              )
              .code(429)
              .send({
                error:
                  "link creation rate limit exceeded",
              });
          }
        } catch {
          return reply.code(503).send({
            error:
              "link creation is temporarily unavailable",
          });
        }
      }

      if (
        apiKeyAuthenticator &&
        !apiKeyAuthenticator.authenticate(
          request.headers["x-api-key"],
        )
      ) {
        return reply
          .header(
            "www-authenticate",
            'ApiKey realm="link-creation"',
          )
          .code(401)
          .send({
            error: "valid API key required",
          });
      }

      const targetUrl = urlPolicy
        ? await urlPolicy.validate(
            request.body?.url,
          )
        : validHttpUrl(
            request.body?.url,
          );

      if (!targetUrl) {
        return reply.code(400).send({
          error:
            "url must be a valid and publicly reachable http or https URL",
        });
      }

      const custom =
        request.body.customCode;

      if (
        custom !== undefined &&
        (typeof custom !== "string" ||
          !CODE_PATTERN.test(custom))
      ) {
        return reply.code(400).send({
          error:
            "customCode must be 4-32 URL-safe characters",
        });
      }

      const ttl =
        request.body.expiresInSeconds;

      if (
        ttl !== undefined &&
        (!Number.isSafeInteger(ttl) ||
          (ttl as number) < 1 ||
          (ttl as number) >
            31_536_000)
      ) {
        return reply.code(400).send({
          error:
            "expiresInSeconds must be an integer from 1 to 31536000",
        });
      }

      const expiresAt =
        ttl === undefined
          ? null
          : new Date(
              Date.now() +
                (ttl as number) * 1_000,
            );

      for (
        let attempt = 0;
        attempt < 5;
        attempt += 1
      ) {
        let code: string;

        if (typeof custom === "string") {
          code = custom;
        } else {
          try {
            code = await codeGenerator();
          } catch (error) {
            request.log.error(
              { error },
              "could not generate a short code",
            );

            return reply.code(503).send({
              error:
                "link creation is temporarily unavailable",
            });
          }
        }

        const link =
          await store.create({
            code,
            targetUrl,
            expiresAt,
            codeSource:
              typeof custom === "string"
                ? "custom"
                : "generated",
          });

        if (link) {
          metrics.created();

          return reply.code(201).send({
            code,
            shortUrl:
              `${config.baseUrl}/${code}`,
            targetUrl,
            expiresAt:
              expiresAt?.toISOString() ??
              null,
          });
        }

        if (custom !== undefined) {
          return reply.code(409).send({
            error:
              "customCode is already in use",
          });
        }
      }

      return reply.code(503).send({
        error:
          "could not allocate a unique code",
      });
    },
  );

  app.get<{
    Params: { code: string };
  }>(
    "/:code",
    async (request, reply) => {
      if (
        !CODE_PATTERN.test(
          request.params.code,
        )
      ) {
        metrics.miss();

        return reply.code(404).send({
          error: "link not found",
        });
      }

      const link = await store.find(
        request.params.code,
      );

      if (!link) {
        metrics.miss();

        return reply.code(404).send({
          error: "link not found",
        });
      }

      await store.recordClick(
        link.code,
      );

      metrics.redirect();

      return reply.redirect(
        link.targetUrl,
        302,
      );
    },
  );

  app.get<{
    Params: { code: string };
  }>(
    "/api/v1/links/:code",
    async (request, reply) => {
      const link = await store.find(
        request.params.code,
      );

      if (!link) {
        return reply.code(404).send({
          error: "link not found",
        });
      }

      return {
        code: link.code,
        targetUrl: link.targetUrl,
        shortUrl:
          `${config.baseUrl}/${link.code}`,
        clicks: link.clicks,
        createdAt:
          link.createdAt.toISOString(),
        expiresAt:
          link.expiresAt?.toISOString() ??
          null,
      };
    },
  );

  return app;
}