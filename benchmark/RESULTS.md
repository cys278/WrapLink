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