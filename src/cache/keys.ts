/**
 * Redis key layout.
 *
 * Every link-related key carries a Redis Cluster hash tag such as
 * `{0042}`. Redis hashes only the text inside the braces when choosing a
 * slot, so a link's cache entry, the write-behind queue that references
 * it, and that queue's lock all live on the same cluster node. That is
 * what allows one Lua script to create a link *and* enqueue it for
 * PostgreSQL persistence atomically, even in Redis Cluster.
 *
 * 1,024 shards spread across 16,384 cluster slots keeps the load on each
 * master even while keeping the number of queues small enough for a
 * background worker to scan every interval.
 *
 * NEVER change LINK_KEY_SHARDS or the hash function after data exists:
 * every cached link and every pending queue entry would become unreachable.
 * The C++ redirect service (cpp-redirect/) implements the same function and
 * is verified against the same test vectors.
 */

export const LINK_KEY_SHARDS = 1_024;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * 32-bit FNV-1a over the code's UTF-8 bytes. Link codes are restricted to
 * [A-Za-z0-9_-], so each character is exactly one byte.
 */
export function fnv1a32(value: string): number {
  let hash = FNV_OFFSET_BASIS;

  const bytes = Buffer.from(value, "utf8");

  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }

  return hash >>> 0;
}

export function shardOf(code: string): number {
  return fnv1a32(code) % LINK_KEY_SHARDS;
}

export function shardTag(shard: number): string {
  if (
    !Number.isSafeInteger(shard) ||
    shard < 0 ||
    shard >= LINK_KEY_SHARDS
  ) {
    throw new Error(`invalid shard ${shard}`);
  }

  return `{${String(shard).padStart(4, "0")}}`;
}

export function linkKey(code: string): string {
  return `wraplink:link:${shardTag(shardOf(code))}:${code}`;
}

export function syncQueueKey(shard: number): string {
  return `wraplink:sync:queue:${shardTag(shard)}`;
}

export function syncLockKey(shard: number): string {
  return `wraplink:sync:lock:${shardTag(shard)}`;
}

export function syncDeadLetterKey(shard: number): string {
  return `wraplink:sync:dead:${shardTag(shard)}`;
}

/**
 * Shards owned by one worker when the work is split across `workerCount`
 * processes. Locks still protect each shard, so overlapping ownership
 * (for example during a rolling restart) is safe, just slightly wasteful.
 */
export function shardsForWorker(
  workerIndex: number,
  workerCount: number,
): number[] {
  if (
    !Number.isSafeInteger(workerCount) ||
    workerCount < 1 ||
    !Number.isSafeInteger(workerIndex) ||
    workerIndex < 0 ||
    workerIndex >= workerCount
  ) {
    throw new Error(
      "worker index must be within [0, workerCount)",
    );
  }

  const shards: number[] = [];

  for (
    let shard = workerIndex;
    shard < LINK_KEY_SHARDS;
    shard += workerCount
  ) {
    shards.push(shard);
  }

  return shards;
}

export function allShards(): number[] {
  return shardsForWorker(0, 1);
}
