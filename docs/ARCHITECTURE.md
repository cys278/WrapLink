# WrapLink architecture and performance report

This document explains how WrapLink is built to approach one million requests per second, and why each design decision was made. Every claim about cost or throughput below is either derived from first principles (shown) or marked as something to measure on your own hardware.

## 1. Request paths

```text
                        ┌──────────────────────── Node.js cluster (one worker per core) ─────────────┐
 POST /api/v1/links ──► │ rate limit (Redis) → API key → URL policy → code → store.create()          │
                        │                                                                             │
 GET /:code ──────────► │ Redis HMGET ──hit──► 302 ─► click buffer ──(1s batches)──► PostgreSQL       │
                        │      └─miss─► PostgreSQL ─► cache in Redis ─► 302                           │
                        └─────────────────────────────────────────────────────────────────────────────┘
 GET /:code ──────────► C++ Drogon service (optional, same Redis keys and tables)
```

PostgreSQL is always the source of truth. Redis is a cache, a rate limiter, and, in write-behind mode, a short-lived durable buffer.

## 2. Two creation modes

| | `LINK_WRITE_MODE=sync` (default) | `LINK_WRITE_MODE=write-behind` |
| --- | --- | --- |
| When the client gets 201 | After the PostgreSQL `INSERT` commits | After one atomic Redis script |
| Generated code | 8 random Base62 characters | 9-character scrambled block ID |
| Custom alias | PostgreSQL insert | PostgreSQL insert (always) |
| Bottleneck | PostgreSQL write IOPS and CPU | Redis cluster throughput |
| Durability window | None | Until the sync worker commits (normally < 1 s) |

### Why write-behind exists

A single large PostgreSQL instance handled tens of thousands of single-row inserts per second in the experiments this project is modelled on, and raising provisioned IOPS bought only a small multiple at a large monthly cost. One million inserts per second is not a tuning problem; it is the wrong shape of work. Write-behind changes the shape. Redis absorbs each create in memory, and PostgreSQL receives a few thousand multi-row `INSERT ... SELECT FROM UNNEST(...)` statements per second instead of a million single-row ones.

### The write-behind pipeline

1. **Enqueue (atomic).** `WriteBehindLinkStore` runs one Lua script on the shard that owns the code. The script refuses a code that already exists, applies backpressure if the shard queue is full, writes the link hash with `pending=1`, and `RPUSH`es a JSON record onto the shard's queue. Redirects can serve the link immediately.
2. **Sync (batched).** Every `LINK_SYNC_INTERVAL_MS` each worker scans the shards it owns. For a non-empty shard it takes a short `SET NX PX` lock, reads up to `LINK_SYNC_BATCH_SIZE` records with `LRANGE`, and inserts them in one statement.
3. **Complete (atomic).** A second Lua script runs only if the worker still owns the lock. It clears `pending` and gives each synced link the normal cache TTL. It deletes cache entries for collisions so PostgreSQL's row wins. It appends collisions and malformed records to a capped dead-letter list, trims the consumed records, and releases the lock.

**Crash safety.** Records leave the queue only after PostgreSQL has committed. If a worker dies between `COMMIT` and the trim, its lock expires and another worker replays the batch. The insert recognises a replay (same code, target URL and creation instant) and reports it as persisted rather than as a collision. Delivery is therefore at-least-once with idempotent effects.

**Backpressure.** `WRITE_BEHIND_MAX_PENDING` bounds the total backlog, divided evenly across the 1,024 shards. When a shard is full, creation falls back to a synchronous PostgreSQL insert instead of growing Redis memory without limit. The `shortener_write_behind_backpressure_total` counter shows when this happens.

**Clicks on links that are not synced yet.** The click buffer's batched `UPDATE ... RETURNING` reports codes that matched no row. Those clicks are retried on later flushes (up to 10) instead of being lost.

## 3. Redis Cluster key design

A single Redis process executes commands on one thread and tops out around 100–200k operations per second. Redis Cluster spreads 16,384 hash slots over many processes, so throughput scales with cores. A Lua script, however, may only touch keys in one slot.

WrapLink therefore puts a hash tag in every key:

```text
wraplink:link:{0210}:docs        cached or pending link
wraplink:sync:queue:{0210}       write-behind queue for shard 210
wraplink:sync:lock:{0210}        that queue's lock
wraplink:sync:dead:{0210}        that queue's dead letters
```

Redis hashes only the text between the braces, so all four keys share a slot. The shard is `FNV-1a-32(code) mod 1024`. 1,024 shards spread over 16,384 slots keeps masters evenly loaded, while staying few enough that a worker can scan its queues every 250 ms (about 4,000 `LLEN` calls per second in total, which is negligible).

The shard count and hash function are part of the data format. The Node.js service (`src/cache/keys.ts`) and the C++ service (`cpp-redirect/src/core.hpp`) are both tested against the same vectors (`test/fixtures/shard-vectors.json`). Changing either orphans every cached and pending link.

**Memory policy.** Run Redis with `maxmemory-policy volatile-lru`. Under pressure Redis then evicts only keys that carry a TTL (cached links). Pending links and queues have no TTL and are never evicted. Use AOF (`appendonly yes`, `appendfsync everysec`) and replicas in write-behind mode, because pending links live only in Redis until synced.

## 4. Short codes and the birthday paradox

For `N` equally likely codes, a collision becomes more likely than not after about `1.1774 × √N` draws.

| Scheme | Space `N` | 50% collision after | At 1M creations/s |
| --- | --- | --- | --- |
| 8 random Base62 chars | 62⁸ ≈ 2.18 × 10¹⁴ | ≈ 1.7 × 10⁷ codes | **≈ 17 seconds** |
| 12 random Base62 chars | 62¹² ≈ 3.2 × 10²¹ | ≈ 6.7 × 10¹⁰ codes | ≈ 18.6 hours |
| UUIDv4 (122 random bits) | 2¹²² | ≈ 2.7 × 10¹⁸ codes | ≈ 86,000 years |
| WrapLink block IDs | 62⁹ ≈ 1.35 × 10¹⁶ | **never** (bijection) | ≈ 428 years to exhaust |

Random 8-character codes are fine on the synchronous path because PostgreSQL's primary key rejects the duplicate and the request retries. On the write-behind path the client receives the code before PostgreSQL sees it, so uniqueness must be structural. A UUID gives it statistically but makes a 22–36 character "short" link.

`BlockCodeAllocator` instead reserves blocks of 10,000 integers from the PostgreSQL sequence `link_code_block_seq` (one query per 10,000 links per process). Each integer is passed through a keyed 8-round Feistel permutation with cycle-walking over `[0, 62⁹)`. It uses 32-bit integer mixing (round keys derived once with HMAC-SHA256), so a code costs about a microsecond. An earlier version ran HMAC-SHA256 in every round and cost ~100 µs per code, which is far too slow for a request path at this scale. A permutation is a bijection, so distinct IDs always give distinct codes, while neighbouring IDs look unrelated. This is obfuscation, not encryption: it stops casual enumeration, but private destinations still need authentication. The result is 9 characters, so it can never equal an 8-character random code.

The permutation key is `CODE_SCRAMBLE_SECRET`. **Never change it after launch:** a new key could map future IDs onto codes already issued. Any such collision would be caught at sync time and dead-lettered, but it would still break a link a user already holds.

## 5. Avoiding O(n) on hot paths

At a million requests per second, an O(n) step is an outage.

| Pattern | Cost | WrapLink |
| --- | --- | --- |
| `ORDER BY random() LIMIT 1` | Full scan and sort of every row | Not used |
| `SELECT COUNT(*)` | Full scan (MVCC means no stored count) | Only `size()`, never on a request path. Dashboards use `estimatedSize()` (`pg_class.reltuples`, O(1)) |
| `OFFSET n` pagination | Rescans all skipped rows; a full export is O(n²) | `cache:warm` uses keyset pagination (`WHERE code > $last ORDER BY code`) |
| Lookup by primary key | O(log n) B-tree | Every redirect and stats read |
| Readiness probe | | `SELECT 1`, not a table scan |

## 6. Capacity planning from first principles

**Concurrency.** In-flight requests at the server ≈ connections × pipelining. The benchmark runner prints it, and `aggregate.mjs` sums it across a tester fleet.

**Network.** Throughput (bit/s) = RPS × bytes per response × 8. One million redirects of about 200 bytes is 1.6 Gbit/s, which is trivial. One million 30 KB JSON responses is 240 Gbit/s, which exceeds most NICs. If the server's CPU is idle while `scripts/monitor.sh` shows rx/tx near the NIC's line rate, the network is the bottleneck. Shrink or compress the payload, or move to a larger-NIC instance.

**PostgreSQL connections.** Every worker owns its own pool: total = `WEB_CONCURRENCY × DATABASE_POOL_MAX`. 128 workers × 10 is already 1,280 connections. `cluster.ts` prints the budget and warns above 500. Use PgBouncer in transaction mode or lower the pool size.

**Redis memory.** Each cached link costs roughly its URL length plus about 150 bytes of Redis overhead. Ten million links with 60-byte URLs fit in about 2–3 GB. A write-behind backlog of one million links adds about 400 MB.

**CPU percentages.** `ps`/`top` report per-process CPU where 100% is one core, so a 128-core host can show 12,800%. `scripts/monitor.sh` reports system-wide idle percentage across all cores. Near 0% idle means CPU-bound. High idle with low throughput means the service is waiting on something else, such as the database, a lock, or a single-threaded process.

## 7. The C++ redirect service

The redirect handler does almost no work, so framework and runtime overhead dominate. `cpp-redirect/` serves `GET /:code` with Drogon (one event loop per core, no garbage collector, no primary-to-worker hand-off) and RapidJSON. It reads the same Redis keys and PostgreSQL rows, increments the same cached click counter, and batches PostgreSQL click updates the same way. Creation, authentication and rate limiting stay in Node.js. Route redirects to the C++ service at the proxy (see `docs/DEPLOYMENT.md`).

Limitation: Drogon's Redis client does not speak the Cluster protocol. Point it at a standalone Redis, or at each cluster node behind a cluster-aware proxy.

## 8. Scaling beyond one machine

Large services do not run one giant server. They run many medium servers in several regions behind load balancers and route each user to the nearest one. WrapLink's application tier is stateless apart from per-process click buffers, so it scales horizontally:

- Add API hosts behind an L4/L7 load balancer, with `TRUST_PROXY=true` so rate limits see client IPs.
- Shared Redis Cluster plus PostgreSQL primary, with read replicas if stats reads grow.
- Managed load balancers have capacity units. Very high sustained throughput may need capacity reserved in advance from the provider.

## 9. Known limitations

- Write-behind trades a sub-second durability window for throughput. A simultaneous loss of a Redis master and its replica, before sync, loses those links.
- Click counts are eventually consistent: up to `CLICK_FLUSH_INTERVAL_MS` behind in PostgreSQL, and process-local until flushed (`SIGKILL` loses the buffer).
- The C++ service has no Redis Cluster support.
- Benchmarks in `benchmark/RESULTS.md` are single-machine Docker runs and do not support a million-RPS claim. Use the distributed tester to measure your own deployment.
