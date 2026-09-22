# Hyper Shortener

A production-minded URL shortener and performance engineering lab. The goal is to learn how a real service evolves from one process and in-memory storage to PostgreSQL, Redis, multiple workers, and an optimized C++ hot path—while measuring every claim.

## Milestone 1 (current)

- Fastify + TypeScript API
- cryptographically generated, unbiased Base62 codes
- custom aliases, expiration and click counts
- health, readiness and Prometheus-style metrics endpoints
- replaceable storage interface (currently bounded in-memory storage)
- validation, collision handling and graceful shutdown
- API tests and a repeatable AutoCannon benchmark
- PostgreSQL and Redis containers prepared for Milestone 2

## Run locally

Requirements: Node.js 22 or newer. Docker is optional until Milestone 2.

```bash
npm install
npm test
npm run dev
```

Create a link:

```bash
curl -i -X POST http://localhost:3000/api/v1/links \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/docs","customCode":"docs"}'
```

Then visit `http://localhost:3000/docs`. Inspect link statistics at `GET /api/v1/links/docs` and service metrics at `GET /metrics`.

## Benchmark responsibly

Start the production build in one terminal:

```bash
npm run build
npm start
```

Run the baseline in another:

```bash
npm run bench
```

Close unrelated programs and record CPU model, core count, memory, OS, Node version, throughput, latency percentiles, errors, payload and exact command. Never publish a throughput number without this context.

## Roadmap to the 10/10 portfolio version

1. PostgreSQL migrations, repository implementation and integration tests
2. Redis cache, atomic counters and write-behind batching
3. rate limiting, API keys, abuse controls and SSRF-safe URL policy
4. worker/process scaling and deterministic benchmark profiles
5. OpenTelemetry traces, dashboards and load-test reports
6. CI, container image, deployment guide and threat model
7. C++/Drogon redirect service with identical contract
8. failure injection, profiling and an evidence-based architecture report

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/links` | Create a short link |
| `GET` | `/:code` | Redirect to its target |
| `GET` | `/api/v1/links/:code` | Read link statistics |
| `GET` | `/health` | Liveness check |
| `GET` | `/ready` | Readiness check |
| `GET` | `/metrics` | Service counters |

This milestone intentionally uses memory only: restarting the process clears all links. Persistent storage arrives next.
