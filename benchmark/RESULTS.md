# WrapLink Benchmark Results

This document records a controlled local benchmark of WrapLink before and after introducing write-behind PostgreSQL click persistence.

These results are intended to make performance claims reproducible and properly scoped. They are not distributed-production or one-million-request-per-second results.

## Test environment

| Component | Configuration |
| --- | --- |
| Host | Apple M2 |
| Architecture | ARM64 |
| Logical CPUs | 8 |
| Operating system | macOS 15.6.1 (24G90) |
| Benchmark client | Node.js v25.9.0 |
| Application runtime | Node.js 22 Alpine container |
| Docker | 29.6.1 |
| Docker Compose | v5.3.0 |
| Application workers | 2 |
| Application CPU limit | 2 CPUs |
| Application memory limit | 1 GiB |
| Database | PostgreSQL 17 Alpine |
| Cache | Redis 7.4 Alpine |
| Load generator | AutoCannon |
| Target | `GET /container-demo` |
| Expected response | HTTP `302` |
| Logging during benchmark | `warn` |

The load generator and service ran on the same Apple M2 machine through Docker Desktop networking.

## Application architecture

The benchmarked request path used:

1. Node.js cluster primary with two Fastify workers.
2. Redis cache-aside destination lookup.
3. Atomic Redis click-count updates.
4. PostgreSQL as the durable source of truth.
5. A one-second in-memory write-behind buffer for PostgreSQL click persistence.
6. Graceful buffer draining during worker shutdown.

The optimization replaced one synchronous PostgreSQL update per redirect with aggregated click increments flushed periodically.

## Benchmark profiles

### Baseline profile

```text
Connections: 100
Duration: 30 seconds
Pipelining: 10
```

### Saturation profile

```text
Connections: 250
Duration: 60 seconds
Pipelining: 10
```

The benchmark script performs an HTTP preflight check and refuses to run unless the target returns the expected `302` status.

AutoCannon categorizes `302` responses as non-2xx responses. In these results, `non2xx` represents successful redirects, while `errors` and `timeouts` represent failures.

## Results

### Baseline profile

| Metric | Synchronous writes | Write-behind batching | Change |
| --- | ---: | ---: | ---: |
| Requests/second | 4,431.27 | 7,114.64 | **+60.6%** |
| Total requests | 132,928 | 213,429 | **+60.6%** |
| p50 latency | 179 ms | 96 ms | **−46.4%** |
| p97.5 latency | 488 ms | 651 ms | **+33.4%** |
| p99 latency | 1,228 ms | 1,038 ms | **−15.5%** |
| Errors | 0 | 0 | No regression |
| Timeouts | 0 | 0 | No regression |

The optimized baseline increased throughput and improved median and p99 latency. The p97.5 result regressed in this individual run, demonstrating why repeated trials and percentile reporting are necessary.

### Saturation profile

| Metric | Synchronous writes | Write-behind batching | Change |
| --- | ---: | ---: | ---: |
| Requests/second | 3,423.75 | 5,880.19 | **+71.7%** |
| Total requests | 205,410 | 352,789 | **+71.7%** |
| Mean latency | Not recorded | 424.2 ms | N/A |
| p50 latency | 550 ms | 285 ms | **−48.2%** |
| p97.5 latency | 2,484 ms | 1,827 ms | **−26.4%** |
| p99 latency | 3,181 ms | 2,300 ms | **−27.7%** |
| Errors | 0 | 0 | No regression |
| Timeouts | 0 | 0 | No regression |

Under saturation, write-behind batching increased throughput by 71.7% while reducing all recorded latency percentiles.

## Persistence verification

After the optimized saturation run and a three-second flush window, Redis and PostgreSQL reported the same click count:

```text
Redis:      586151
PostgreSQL: 586151
```

This verified that all buffered increments present at the end of the test were flushed to PostgreSQL.

The optimized saturation run processed 352,789 redirects in 60 seconds with zero errors and zero timeouts.

## Reproduction

Start the controlled benchmark environment:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.benchmark.yml \
  up -d --build
```

Create the benchmark target using a private API key:

```bash
API_KEY="$(sed -n 's/^CREATE_API_KEYS=//p' .env)"

curl -X POST http://localhost:3000/api/v1/links \
  -H "content-type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "url":"https://github.com/cys278/WrapLink",
    "customCode":"container-demo"
  }'
```

Run a warm-up:

```bash
npm run bench:smoke
```

Run the baseline profile:

```bash
npm run bench
```

Run the saturation profile:

```bash
npm run bench:saturation
```

Generated JSON reports are written to `benchmark/results/` and ignored by Git.

Integration tests truncate the development `links` table. Recreate `container-demo` after running integration tests and before running benchmarks.

## Limitations

These results have the following limitations:

- The client and server ran on the same physical machine.
- Docker Desktop networking does not represent a production network.
- The benchmark did not include TLS termination or an external load balancer.
- PostgreSQL and Redis ran on the same host as the application.
- Each reported configuration currently represents one recorded run rather than the median of multiple trials.
- CPU snapshots captured after a benchmark cannot support CPU-efficiency claims.
- The benchmark tested a single hot redirect key.
- The write-behind buffer is process-local and may lose unflushed increments if a worker is forcibly terminated with `SIGKILL`.
- The test does not support a one-million-request-per-second claim.

Future benchmark reports should use at least three trials per profile, report the median, separate the load generator from the service host, and capture CPU and memory continuously during each run.
