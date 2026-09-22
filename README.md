# WrapLink

WrapLink is a production-minded URL shortener and performance-engineering lab. It demonstrates how a backend service evolves from in-memory storage into a persistent, cached, observable, and performance-tested system.

The project currently uses TypeScript, Fastify, PostgreSQL, and Redis. Future milestones will explore security, horizontal scaling, observability, load testing, and an optimized C++ redirect service.

## Current capabilities

- Fastify API with strict TypeScript
- Cryptographically generated, unbiased Base62 codes
- Custom aliases and optional link expiration
- Persistent link storage with PostgreSQL
- Versioned, transactional database migrations
- Redis cache-aside link resolution
- Atomic click-count updates in PostgreSQL and Redis
- Graceful PostgreSQL fallback when Redis is unavailable
- PostgreSQL connection pooling
- Expiration-aware cache TTLs
- Collision detection and input validation
- Graceful application shutdown
- Health, readiness, and Prometheus-style metrics endpoints
- Unit, PostgreSQL, Redis, cache, and end-to-end API tests
- Repeatable AutoCannon benchmark command

## Architecture

PostgreSQL is WrapLink's durable source of truth. Redis accelerates frequently accessed links through a cache-aside strategy.

```text
Client request
      |
      v
 Fastify API
      |
      v
 Redis cache -------- cache hit --------> Link response
      |
   cache miss
      |
      v
 PostgreSQL
      |
      v
 Populate Redis
      |
      v
 Link response
```

When Redis is unavailable, WrapLink falls back to PostgreSQL instead of failing the request. PostgreSQL is required during startup because it owns the authoritative link data.

## Technology stack

- Node.js 22+
- TypeScript
- Fastify
- PostgreSQL 17
- Redis 7
- Vitest
- Docker Compose
- AutoCannon

## Requirements

Install the following before running WrapLink:

- Node.js 22 or newer
- npm
- Docker Desktop
- Git

## Run locally

Clone the repository:

```bash
git clone https://github.com/cys278/WrapLink.git
cd WrapLink
```

Install dependencies:

```bash
npm install
```

Start PostgreSQL and Redis:

```bash
docker compose up -d postgres redis
```

Confirm that both services are healthy:

```bash
docker compose ps
```

Apply database migrations:

```bash
npm run db:migrate
```

Start the development server:

```bash
npm run dev
```

The API will be available at:

```text
http://localhost:3000
```

## Environment variables

Copy `.env.example` to `.env` if you want to override the defaults.

```env
HOST=0.0.0.0
PORT=3000
BASE_URL=http://localhost:3000
LOG_LEVEL=info
MAX_LINKS=100000

DATABASE_URL=postgresql://shortener:shortener@127.0.0.1:55432/shortener
DATABASE_POOL_MAX=20

REDIS_URL=redis://127.0.0.1:6379
REDIS_CACHE_TTL_SECONDS=300
```

The Docker PostgreSQL service uses host port `55432` to avoid conflicts with PostgreSQL installations already using port `5432`.

Never commit a real `.env` file.

## Create a short link

Create a link with a custom alias:

```bash
curl -i -X POST http://localhost:3000/api/v1/links \
  -H "content-type: application/json" \
  -d '{
    "url": "https://example.com/docs",
    "customCode": "docs"
  }'
```

Example response:

```json
{
  "code": "docs",
  "shortUrl": "http://localhost:3000/docs",
  "targetUrl": "https://example.com/docs",
  "expiresAt": null
}
```

Open the short URL:

```text
http://localhost:3000/docs
```

WrapLink will respond with an HTTP `302` redirect to the target URL.

## Create an expiring link

```bash
curl -i -X POST http://localhost:3000/api/v1/links \
  -H "content-type: application/json" \
  -d '{
    "url": "https://example.com/temporary",
    "customCode": "temporary",
    "expiresInSeconds": 3600
  }'
```

The Redis cache entry will never outlive the link's actual expiration time.

## Inspect link statistics

```bash
curl http://localhost:3000/api/v1/links/docs
```

Example response:

```json
{
  "code": "docs",
  "targetUrl": "https://example.com/docs",
  "shortUrl": "http://localhost:3000/docs",
  "clicks": 1,
  "createdAt": "2026-09-22T00:00:00.000Z",
  "expiresAt": null
}
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/links` | Create a short link |
| `GET` | `/:code` | Redirect to the target URL |
| `GET` | `/api/v1/links/:code` | Read link statistics |
| `GET` | `/health` | Check whether the application is alive |
| `GET` | `/ready` | Check application and storage readiness |
| `GET` | `/metrics` | Read Prometheus-style service counters |

## Health and readiness

Check liveness:

```bash
curl http://localhost:3000/health
```

Example:

```json
{
  "status": "ok"
}
```

Check readiness:

```bash
curl http://localhost:3000/ready
```

Example:

```json
{
  "status": "ready",
  "links": 1
}
```

Inspect metrics:

```bash
curl http://localhost:3000/metrics
```

## Database migrations

Apply every pending migration:

```bash
npm run db:migrate
```

Migrations are:

- applied alphabetically
- recorded in `schema_migrations`
- executed inside transactions
- protected by a PostgreSQL advisory lock
- safe to run repeatedly

Inspect the database tables:

```bash
docker compose exec postgres \
  psql -U shortener -d shortener -c "\dt"
```

Inspect migration history:

```bash
docker compose exec postgres \
  psql -U shortener -d shortener \
  -c "SELECT filename, applied_at FROM schema_migrations;"
```

Do not run `docker compose down -v` unless you intentionally want to delete all local database data.

## Testing

Run fast unit tests:

```bash
npm test
```

Run PostgreSQL and Redis integration tests:

```bash
npm run test:integration
```

Run strict TypeScript validation:

```bash
npm run typecheck
```

Create the production build:

```bash
npm run build
```

Run the complete verification sequence:

```bash
npm test
npm run test:integration
npm run typecheck
npm run build
```

Integration tests truncate the local development `links` table. Never run them against a production database.

## Production build

Build the TypeScript source:

```bash
npm run build
```

Start the compiled server:

```bash
npm start
```

## Benchmark responsibly

Start the production build in one terminal:

```bash
npm run build
npm start
```

Run the baseline benchmark in another terminal:

```bash
npm run bench
```

When publishing benchmark results, record:

- CPU model
- physical and logical core counts
- memory
- operating system
- Node.js version
- test duration
- connection count
- pipelining configuration
- request payload
- throughput
- latency percentiles
- error count
- exact benchmark command

Never publish a requests-per-second result without its testing context.

## Repository structure

```text
WrapLink/
├── migrations/
│   └── 001_create_links.sql
├── src/
│   ├── cache/
│   │   └── redis-client.ts
│   ├── database/
│   │   ├── migrate.ts
│   │   └── pool.ts
│   ├── domain/
│   │   ├── code.ts
│   │   └── link.ts
│   ├── store/
│   │   ├── cached-link-store.ts
│   │   ├── memory-link-store.ts
│   │   └── postgres-link-store.ts
│   ├── app.ts
│   ├── config.ts
│   ├── metrics.ts
│   └── server.ts
├── test/
│   ├── integration/
│   │   ├── cached-link-store.test.ts
│   │   ├── postgres-app.test.ts
│   │   ├── postgres-link-store.test.ts
│   │   └── redis-client.test.ts
│   └── app.test.ts
├── .env.example
├── docker-compose.yml
├── package.json
└── tsconfig.json
```

## Roadmap to the 10/10 portfolio version

- [x] Fastify and TypeScript API
- [x] Secure Base62 short-code generation
- [x] PostgreSQL migrations and persistent storage
- [x] PostgreSQL integration tests
- [x] Redis cache-aside link resolution
- [x] Atomic click counters
- [x] Graceful Redis failure handling
- [x] End-to-end API and database tests
- [ ] Rate limiting and abuse prevention
- [ ] API keys and authentication
- [ ] Secure headers and stricter URL policies
- [ ] Background analytics batching
- [ ] Worker and multi-process scaling
- [ ] Deterministic benchmark profiles
- [ ] OpenTelemetry tracing and dashboards
- [ ] Continuous integration
- [ ] Production container image
- [ ] Deployment guide and threat model
- [ ] C++ and Drogon redirect service
- [ ] Failure injection and profiling report
- [ ] Evidence-based architecture report

## Current limitations

- Click updates still reach PostgreSQL during every redirect.
- Cached click statistics can be temporarily stale following a Redis outage.
- Redis reconnects require restarting the application after the retry limit is exhausted.
- Authentication and rate limiting have not been implemented yet.
- The current benchmark is intended for local development, not production capacity planning.

## License

No license has been selected yet. Add a license before encouraging external reuse or contributions.