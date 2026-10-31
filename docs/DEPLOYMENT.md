# Deployment guide

## Single host (Docker Compose)

```bash
cp .env.example .env
# Set CREATE_API_KEYS (and CODE_SCRAMBLE_SECRET for write-behind) using
#   openssl rand -hex 32
docker compose up -d --build
```

Optional overlays, combined with `-f docker-compose.yml`:

| File | Adds |
| --- | --- |
| `docker-compose.write-behind.yml` | Write-behind link creation |
| `docker-compose.cpp.yml` | C++ redirect service on port 5555 |
| `docker-compose.observability.yml` | Prometheus (9090) and Grafana (3001, dashboard provisioned) |
| `docker-compose.benchmark.yml` | CPU and memory limits for controlled benchmarks |
| `docker-compose.redis-cluster.yml` | 3-node Redis Cluster for integration tests |

## Production checklist

**Secrets**
- Generate API keys and `CODE_SCRAMBLE_SECRET` with `openssl rand -hex 32`. Store them in a secret manager, not in the image.
- Never rotate `CODE_SCRAMBLE_SECRET` once write-behind links exist (see ARCHITECTURE.md §4).
- Change the default PostgreSQL password and restrict network access to PostgreSQL and Redis.

**Network**
- Terminate TLS at a load balancer or reverse proxy and set `BASE_URL` to the public `https://` origin.
- Set `TRUST_PROXY=true` only when a proxy you control sets `X-Forwarded-For`; otherwise clients can spoof their rate-limit identity.
- To use the C++ service, route `GET /:code` to it and everything else to Node, for example with NGINX:

```nginx
upstream api      { server 127.0.0.1:3000; keepalive 256; }
upstream redirect { server 127.0.0.1:5555; keepalive 256; }

server {
  listen 443 ssl;
  location ~ ^/[A-Za-z0-9_-]{4,32}$ { proxy_pass http://redirect; proxy_http_version 1.1; proxy_set_header Connection ""; }
  location /                        { proxy_pass http://api;      proxy_http_version 1.1; proxy_set_header Connection ""; proxy_set_header X-Forwarded-For $remote_addr; }
}
```

**Database**
- Run `npm run db:migrate` (or the `migrate` service) before starting new application versions. Migrations are transactional and serialized with an advisory lock.
- Size connections: `WEB_CONCURRENCY × DATABASE_POOL_MAX` must stay below PostgreSQL's `max_connections` minus a margin. Use PgBouncer for large worker counts.
- Back up PostgreSQL. It is the source of truth.

**Redis**
- Enable AOF and replicas, especially in write-behind mode.
- Set `maxmemory` and `maxmemory-policy volatile-lru`.
- For more than about 150k Redis operations per second, use Redis Cluster (`scripts/redis-cluster.sh` locally; a managed cluster in production) and set `REDIS_CLUSTER_URLS`.

**Hosts**
- Apply `scripts/tune-linux.sh` (connection backlog, ephemeral ports, file descriptors) on API hosts and load generators.
- Set `LimitNOFILE=1048576` for systemd-managed services.

**Observability**
- Scrape `/metrics`. Alert on `shortener_link_sync_backlog` growing, any `shortener_link_sync_conflicts_total`, p99 latency, and 5xx rate.
- `/ready` is suitable for load balancer health checks; `/health` is liveness only.
- Every response carries `x-request-id`; a valid incoming `x-request-id` is propagated.

## Load testing a deployment

1. Single host: `npm run bench`, `npm run bench:saturation`, or `BENCHMARK_API_KEY=... npm run bench:create`. Raise `CREATE_RATE_LIMIT_MAX` for creation runs because the limit is per client IP.
2. Fleet: launch tester instances with the repository and `npm ci`, then run `benchmark/distributed/ssm-run.sh` (AWS) or `benchmark/distributed/ssh-fleet.sh` (anywhere). Testers start at a synchronized instant and the results are aggregated automatically.
3. Watch `scripts/monitor.sh` on the server during the run to see which resource saturates first.

**Cost control:** a fleet of large instances costs tens of dollars per hour. Use short durations first, cancel unneeded runs (`ssm-run.sh cancel`), and terminate everything afterwards.
