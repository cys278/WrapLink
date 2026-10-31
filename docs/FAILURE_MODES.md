# Failure modes

What WrapLink does when a dependency fails, and how to verify it with `scripts/chaos.sh`.

| Failure | Redirects | Link creation | Stats | Readiness | Recovery |
| --- | --- | --- | --- | --- | --- |
| Redis down | Served from PostgreSQL | **503**: rate limiting cannot be enforced, so creation fails closed | From PostgreSQL | 200 | The Redis client gives up after 5 reconnect attempts; restart workers (`docker compose restart app`) |
| Redis slow or erroring | Each failed read falls back to PostgreSQL | Write-behind falls back to a synchronous insert | From PostgreSQL | 200 | Automatic |
| PostgreSQL down | Cached links keep redirecting; uncached links return 500 | 500 in sync mode. Write-behind keeps accepting generated links (queued in Redis) until the process's reserved code block runs out, then 503 | Cached only | **503** | Automatic. Buffered clicks and queued links are retried |
| PostgreSQL slow (write-behind) | Unaffected | Queues grow; past `WRITE_BEHIND_MAX_PENDING` new links fall back to synchronous inserts | Unaffected | 200 | Automatic as the backlog drains |
| Worker crash (`SIGKILL`) | Primary restarts the worker with the same shard index | Queued links are safe in Redis; another worker replays any half-finished batch | | | Automatic. That worker's unflushed clicks (≤ 1 s) are lost |
| Graceful stop (`SIGTERM`) | New requests refused, in-flight requests finish | | | | Final sync drain, then click flush, then shutdown |
| Code collision during sync | Existing PostgreSQL link wins | Record is dead-lettered | | | Inspect with `npm run sync -- --dead-letters` |
| Malformed queue record | | Dead-lettered so it cannot block the queue | | | Inspect dead letters |

## Running the drills

```bash
docker compose up -d --build
API_KEY="$(sed -n 's/^CREATE_API_KEYS=//p' .env | cut -d, -f1)" scripts/chaos.sh all
```

To include write-behind mode:

```bash
COMPOSE_FILES="-f docker-compose.yml -f docker-compose.write-behind.yml" \
API_KEY=... scripts/chaos.sh all
```
