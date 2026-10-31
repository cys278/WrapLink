# WrapLink C++ redirect service

A Drogon + RapidJSON implementation of WrapLink's hottest path, `GET /:code → 302`. It shares Redis keys, hash fields and PostgreSQL tables with the Node.js API. You can run it alongside the API and route redirects to it (see `docs/DEPLOYMENT.md`).

## Behaviour

- Validates codes with the same rule as the API (`^[A-Za-z0-9_-]{4,32}$`).
- Reads `targetUrl` and `expiresAt` from `wraplink:link:{shard}:code` with `HMGET`. Pending write-behind links are served too.
- On a cache miss or Redis error, reads PostgreSQL and re-caches the link with the same fields and TTL rules as Node.
- Increments the cached click counter with the same Lua script as Node, and batches PostgreSQL click updates every second with the same `UNNEST` statement. Failed flushes are retried, and pending clicks are flushed on `SIGTERM`/`SIGINT`.
- `GET /health` (liveness) and `GET /ready` (PostgreSQL reachable).
- Compression and request logging are disabled. A redirect body is tiny, so both would cost more CPU than they save.

## Configuration (environment)

| Variable | Default |
| --- | --- |
| `HOST`, `PORT` | `0.0.0.0`, `5555` |
| `THREADS` | `0` (one event loop per hardware thread) |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | `127.0.0.1`, `55432`, `shortener`, `shortener`, `shortener` |
| `PG_CONNECTIONS` | `16` |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_CONNECTIONS` | `127.0.0.1`, `6379`, empty, `16` |
| `REDIS_CACHE_TTL_SECONDS` | `300` |
| `CLICK_FLUSH_INTERVAL_MS` | `1000` |
| `LOG_LEVEL` | `WARN` |

## Build

With Docker (compiles Drogon v1.9.10 from source; takes several minutes the first time):

```bash
docker compose -f docker-compose.yml -f docker-compose.cpp.yml up -d --build
curl -i http://localhost:5555/container-demo
```

Natively, with Drogon (built with PostgreSQL and Redis support) and `rapidjson-dev` installed:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
./build/core_test
./build/wraplink_redirect
```

The shared core (`src/core.hpp`) has no dependencies and is tested on every CI run:

```bash
npm run test:cpp     # from the repository root
```

## Status and limitations

- `src/core.hpp` and `test/core_test.cc` are compiled and tested in CI. Its key derivation is verified against the same vectors as the Node service.
- `src/main.cc` targets the Drogon 1.9 API. Build it with the Dockerfile before relying on it, and pin `DROGON_VERSION` to the release you validate.
- Drogon's Redis client does not support Redis Cluster. Use a standalone Redis (or replicas) for this service.
- Static routes (`/health`, `/ready`) take precedence over `/{code}`, so those two words cannot be used as short codes on this service. The Node API has the same restriction.
