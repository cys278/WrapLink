# WrapLink

WrapLink is a production-minded URL shortener and a performance-engineering lab. It shows how a backend evolves from a simple persistent API into a system designed to approach **one million requests per second**: cached, clustered, write-behind, observable, failure-tested, and with an optional C++ hot path.

Stack: TypeScript, Fastify, PostgreSQL 17, Redis 7 (standalone or Cluster), Node.js cluster mode, and C++17 with Drogon and RapidJSON.

## Capabilities

**API and security**
- Fastify API with strict TypeScript
- Hashed, constant-time API key authentication for link creation
- Redis rate limiting that fails closed
- SSRF-safe destination policy (DNS-resolved private-range blocking)
- Security headers, request size and time limits, `x-request-id` propagation
- Custom aliases and expiring links

**Performance**
- Redis cache-aside redirects with PostgreSQL fallback
- Write-behind click counting in batched `UPDATE`s, with retries for links not yet synced
- **Write-behind link creation**: links acknowledged from Redis and synced to PostgreSQL in batches by a crash-safe, idempotent worker with backpressure
- **Collision-free short codes**: PostgreSQL-reserved ID blocks through a keyed Feistel permutation
- **Redis Cluster-safe key layout** with hash-tagged shards, optional replica reads
- Multi-process cluster runtime (up to 512 workers) with stable shard ownership and a connection-budget check
- O(1) table-size estimates, keyset pagination, no O(n) work on request paths
- **C++ Drogon + RapidJSON redirect service** sharing the same cache and tables

**Operations**
- Prometheus metrics aggregated across workers, plus a provisioned Grafana dashboard
- Versioned, transactional, lock-protected migrations
- `sync` and `cache:warm` maintenance jobs
- Failure-injection drills, Linux tuning, live resource monitor
- Benchmark profiles and a **distributed load-test fleet** with synchronized start and result aggregation
- CI: typecheck, unit tests, PostgreSQL/Redis integration tests, C++ core tests, Docker build

## Quick start

```bash
git clone https://github.com/cys278/WrapLink.git
cd WrapLink
npm install

cp .env.example .env
# Set CREATE_API_KEYS to the output of: openssl rand -hex 32

docker compose up -d postgres redis
npm run db:migrate
npm run dev            # http://localhost:3000
```

The Docker PostgreSQL service uses host port `55432` to avoid conflicts with a local PostgreSQL on `5432`.

Run the whole stack in containers instead:

```bash
docker compose up -d --build
```

## Using the API

```bash
API_KEY="$(sed -n 's/^CREATE_API_KEYS=//p' .env | cut -d, -f1)"

curl -i -X POST http://localhost:3000/api/v1/links \
  -H "content-type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"url":"https://example.com/docs","customCode":"docs","expiresInSeconds":3600}'

curl -i http://localhost:3000/docs                 # 302 redirect
curl    http://localhost:3000/api/v1/links/docs    # statistics
```

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/links` | Create a short link (requires `x-api-key`) |
| `GET` | `/:code` | Redirect to the target URL |
| `GET` | `/api/v1/links/:code` | Link statistics |
| `GET` | `/health` | Liveness |
| `GET` | `/ready` | Readiness (PostgreSQL reachable) |
| `GET` | `/metrics` | Prometheus metrics |

## Write-behind mode

Synchronous mode inserts every link into PostgreSQL before responding. That caps creation at the database's single-row write rate. Write-behind mode acknowledges generated links from Redis in one atomic step and lets a background worker insert them in large batches:

```bash
# .env
LINK_WRITE_MODE=write-behind
CODE_SCRAMBLE_SECRET=<openssl rand -hex 32>   # never change once links exist
```

```bash
docker compose -f docker-compose.yml -f docker-compose.write-behind.yml up -d --build
```

Custom aliases still go straight to PostgreSQL. If Redis is unavailable or the backlog limit is reached, creation falls back to a synchronous insert. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design, the durability trade-off, and the birthday-paradox analysis behind the code generator.

```bash
npm run sync                         # drain all queues now
npm run sync -- --dead-letters       # inspect collisions and bad records
npm run cache:warm -- --ttl 0        # load PostgreSQL links into Redis
```

## Scaling Redis

A single Redis process is single-threaded (about 100–200k ops/s). Run a cluster:

```bash
npm run redis:cluster -- setup                       # 15 masters + 15 replicas
npm run redis:cluster -- setup --masters 3 --replicas 0
npm run redis:cluster -- urls                        # prints REDIS_CLUSTER_URLS=...
```

Set `REDIS_CLUSTER_URLS` and, optionally, `REDIS_CLUSTER_USE_REPLICAS=true`.

## C++ redirect service

```bash
docker compose -f docker-compose.yml -f docker-compose.cpp.yml up -d --build
curl -i http://localhost:5555/docs
```

See [cpp-redirect/README.md](cpp-redirect/README.md).

## Observability

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

Grafana at http://localhost:3001 (admin/admin) has a provisioned **WrapLink** dashboard covering request rates, latency percentiles, redirects, the write-behind pipeline, sync backlog and problems, click buffers, and table size. On benchmark hosts, `scripts/monitor.sh` prints CPU idle, network Gbit/s and memory once per second.

## Testing

```bash
npm test                    # unit tests
npm run db:migrate
npm run test:integration    # needs PostgreSQL and Redis (truncates the links table)
npm run typecheck
npm run build
npm run test:cpp            # C++ core tests (needs g++)
API_KEY=... npm run chaos   # failure drills against the Compose stack
```

Never run integration tests or chaos drills against a production database.

## Benchmarking

```bash
npm run build && npm start             # terminal 1
npm run bench                          # terminal 2: baseline redirect profile
npm run bench:saturation
BENCHMARK_API_KEY=$API_KEY npm run bench:create   # raise CREATE_RATE_LIMIT_MAX first
BENCHMARK_WORKERS=8 BENCHMARK_CONNECTIONS=1000 npm run bench
```

The runner prints in-flight concurrency (connections × pipelining) and throughput in Gbit/s, so you can tell a CPU limit from a network limit.

For multi-machine tests, see `benchmark/distributed/`. `tester.mjs` runs on each load generator with a synchronized `--start-at`. `ssm-run.sh` (AWS Systems Manager) or `ssh-fleet.sh` fans it out, and `aggregate.mjs` combines results into total requests, RPS, data moved, errors and start skew. Apply `sudo scripts/tune-linux.sh` on every host first.

When publishing results, record hardware, OS, Node.js version, duration, connections, pipelining, payload, throughput, latency percentiles, errors and the exact command. Existing local results are in [benchmark/RESULTS.md](benchmark/RESULTS.md).

## Configuration

All settings are documented in [.env.example](.env.example). The most important:

| Variable | Default | Notes |
| --- | --- | --- |
| `CREATE_API_KEYS` | required | Comma-separated, 32+ characters each |
| `LINK_WRITE_MODE` | `sync` | `sync` or `write-behind` |
| `CODE_SCRAMBLE_SECRET` | | Required for write-behind; never rotate |
| `WEB_CONCURRENCY` | CPU cores | Worker processes (max 512) |
| `DATABASE_POOL_MAX` | `20` | Per worker |
| `REDIS_CLUSTER_URLS` | | Enables Redis Cluster |
| `TRUST_PROXY` | `false` | `true` only behind a proxy you control |
| `WRITE_BEHIND_MAX_PENDING` | `1000000` | Backlog bound before falling back to sync |

## Documentation

- [Architecture and performance report](docs/ARCHITECTURE.md)
- [Failure modes and drills](docs/FAILURE_MODES.md)
- [Deployment guide](docs/DEPLOYMENT.md)
- [Threat model](docs/THREAT_MODEL.md)

## Repository structure

```text
WrapLink/
├── .github/workflows/ci.yml
├── benchmark/
│   ├── distributed/         tester.mjs, aggregate.mjs, ssm-run.sh, ssh-fleet.sh
│   ├── RESULTS.md
│   └── run.mjs
├── cpp-redirect/            Drogon + RapidJSON redirect service
├── docs/
├── migrations/              001 links table, 002 code block sequence
├── observability/           Prometheus config, Grafana dashboard
├── scripts/                 redis-cluster, monitor, tune-linux, chaos
├── src/
│   ├── cache/               Redis client and key layout
│   ├── database/            pool and migrator
│   ├── domain/              links, random codes, block code allocator
│   ├── jobs/                sync-links, warm-cache
│   ├── security/            API keys, rate limiting, URL policy
│   ├── store/               memory, PostgreSQL, cached, write-behind, sync worker, click buffer
│   ├── app.ts  cluster.ts  cluster-metrics.ts  config.ts  metrics.ts  server.ts
├── test/                    unit tests, integration/, fixtures/
└── docker-compose*.yml
```

## Roadmap

- [x] Fastify and TypeScript API
- [x] Secure Base62 short-code generation
- [x] PostgreSQL migrations and persistent storage
- [x] Redis cache-aside resolution with graceful fallback
- [x] Atomic, batched click counters
- [x] Rate limiting and API key authentication
- [x] Secure headers and SSRF-safe URL policy
- [x] Background analytics batching
- [x] Multi-process cluster runtime
- [x] Deterministic benchmark profiles and distributed load testing
- [x] Write-behind link creation with crash-safe sync
- [x] Collision-free code allocation
- [x] Redis Cluster support
- [x] Metrics, dashboards and request IDs
- [x] Continuous integration
- [x] Production container image
- [x] Deployment guide and threat model
- [x] C++ and Drogon redirect service
- [x] Failure injection drills
- [x] Architecture report
- [ ] OpenTelemetry distributed tracing (request IDs are propagated today)
- [ ] User accounts and link ownership
- [ ] Destination reputation checks
- [ ] Redis Cluster support in the C++ service
- [ ] Published multi-machine benchmark results

## License

No license has been selected yet. Add one before encouraging external reuse or contributions.
