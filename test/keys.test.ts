import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allShards,
  fnv1a32,
  LINK_KEY_SHARDS,
  linkKey,
  shardOf,
  shardsForWorker,
  syncLockKey,
  syncQueueKey,
} from "../src/cache/keys.js";

interface Vector {
  code: string;
  fnv1a32: number;
  shard: number;
  key: string;
}

const vectors = JSON.parse(
  readFileSync(
    new URL("./fixtures/shard-vectors.json", import.meta.url),
    "utf8",
  ),
) as Vector[];

function hashTag(key: string): string | undefined {
  return key.match(/\{([^}]+)\}/)?.[1];
}

describe("Redis key layout", () => {
  it("matches published FNV-1a 32-bit reference vectors", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("matches the shared vectors used by the C++ service", () => {
    expect(vectors.length).toBeGreaterThan(5);

    for (const vector of vectors) {
      expect(fnv1a32(vector.code)).toBe(vector.fnv1a32);
      expect(shardOf(vector.code)).toBe(vector.shard);
      expect(linkKey(vector.code)).toBe(vector.key);
    }
  });

  it("puts a link and its sync queue in the same cluster slot", () => {
    for (const code of ["docs", "0aZ9xY7wQ", "my_custom-alias"]) {
      const shard = shardOf(code);

      expect(hashTag(linkKey(code))).toBe(
        hashTag(syncQueueKey(shard)),
      );
      expect(hashTag(syncLockKey(shard))).toBe(
        hashTag(syncQueueKey(shard)),
      );
    }
  });

  it("assigns every shard to exactly one worker", () => {
    const seen = new Map<number, number>();

    for (let worker = 0; worker < 7; worker += 1) {
      for (const shard of shardsForWorker(worker, 7)) {
        seen.set(shard, (seen.get(shard) ?? 0) + 1);
      }
    }

    expect(seen.size).toBe(LINK_KEY_SHARDS);
    expect([...seen.values()].every((count) => count === 1)).toBe(
      true,
    );
    expect(allShards()).toHaveLength(LINK_KEY_SHARDS);
  });

  it("rejects invalid worker identities", () => {
    expect(() => shardsForWorker(3, 3)).toThrow();
    expect(() => shardsForWorker(-1, 3)).toThrow();
    expect(() => shardsForWorker(0, 0)).toThrow();
  });

  it("spreads codes evenly across shards", () => {
    const counts = new Array<number>(LINK_KEY_SHARDS).fill(0);
    const samples = 200_000;

    for (let index = 0; index < samples; index += 1) {
      counts[shardOf(`code${index.toString(36)}`)]! += 1;
    }

    const expected = samples / LINK_KEY_SHARDS;

    // ~195 per shard; a uniform hash keeps every shard within ±40%.
    expect(Math.max(...counts)).toBeLessThanOrEqual(expected * 1.4);
    expect(Math.min(...counts)).toBeGreaterThan(expected * 0.6);
  });
});
