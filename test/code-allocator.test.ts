import { describe, expect, it, vi } from "vitest";
import {
  ALLOCATED_CODE_LENGTH,
  ALLOCATED_CODE_SPACE,
  BlockCodeAllocator,
  CodeScrambler,
  encodeBase62Fixed,
  type IdBlockSource,
} from "../src/domain/code-allocator.js";
import { generateCode } from "../src/domain/code.js";

const SECRET = "test-scramble-secret-0000000000000001";

function blockSource(size: number): IdBlockSource & {
  reserveBlock: ReturnType<typeof vi.fn>;
} {
  let next = 0n;

  return {
    reserveBlock: vi.fn(async () => {
      const start = next;
      next += BigInt(size);

      return { start, size };
    }),
  };
}

describe("Base62 encoding", () => {
  it("encodes fixed-width values", () => {
    expect(encodeBase62Fixed(0n, 4)).toBe("0000");
    expect(encodeBase62Fixed(61n, 2)).toBe("0z");
    expect(encodeBase62Fixed(62n, 2)).toBe("10");
    expect(
      encodeBase62Fixed(ALLOCATED_CODE_SPACE - 1n, 9),
    ).toBe("zzzzzzzzz");
  });

  it("rejects values that do not fit", () => {
    expect(() => encodeBase62Fixed(62n ** 2n, 2)).toThrow();
    expect(() => encodeBase62Fixed(-1n, 2)).toThrow();
  });
});

describe("CodeScrambler", () => {
  it("is deterministic for the same secret", () => {
    const first = new CodeScrambler(SECRET);
    const second = new CodeScrambler(SECRET);

    for (const id of [0n, 1n, 2n, 12_345n, 10n ** 15n]) {
      expect(first.encode(id)).toBe(second.encode(id));
    }
  });

  it("produces distinct, fixed-length, URL-safe codes", () => {
    const scrambler = new CodeScrambler(SECRET);
    const codes = new Set<string>();

    for (let id = 0n; id < 50_000n; id += 1n) {
      const code = scrambler.encode(id);

      expect(code).toHaveLength(ALLOCATED_CODE_LENGTH);
      codes.add(code);
    }

    // A permutation never maps two IDs to one code.
    expect(codes.size).toBe(50_000);
    expect(
      [...codes].every((code) => /^[0-9A-Za-z]{9}$/.test(code)),
    ).toBe(true);
  });

  it("encodes exactly like the BigInt reference implementation", () => {
    const scrambler = new CodeScrambler(SECRET);

    for (const id of [
      0n,
      1n,
      61n,
      62n,
      123_456_789n,
      2n ** 53n,
      ALLOCATED_CODE_SPACE - 1n,
    ]) {
      expect(scrambler.encode(id)).toBe(
        encodeBase62Fixed(scrambler.permute(id), ALLOCATED_CODE_LENGTH),
      );
    }
  });

  it("is a true permutation of a small window", () => {
    // Every ID maps back to a distinct value inside the code space.
    const scrambler = new CodeScrambler(SECRET);
    const values = new Set<bigint>();

    for (let id = ALLOCATED_CODE_SPACE - 20_000n; id < ALLOCATED_CODE_SPACE; id += 1n) {
      const value = scrambler.permute(id);

      expect(value >= 0n && value < ALLOCATED_CODE_SPACE).toBe(true);
      values.add(value);
    }

    expect(values.size).toBe(20_000);
  });

  it("generates codes fast enough for the request path", () => {
    const scrambler = new CodeScrambler(SECRET);
    const started = performance.now();

    for (let id = 0n; id < 100_000n; id += 1n) {
      scrambler.encode(id);
    }

    const microsecondsPerCode =
      ((performance.now() - started) * 1_000) / 100_000;

    // Typically ~1 µs. The generous bound only catches regressions such as
    // reintroducing per-call crypto objects (~100 µs on a laptop).
    expect(microsecondsPerCode).toBeLessThan(25);
  });

  it("hides the sequential order of IDs", () => {
    const scrambler = new CodeScrambler(SECRET);
    const a = scrambler.permute(1_000n);
    const b = scrambler.permute(1_001n);
    const distance = a > b ? a - b : b - a;

    // Neighbouring IDs land far apart in the code space.
    expect(distance > 1_000_000n).toBe(true);
  });

  it("depends on the secret", () => {
    const first = new CodeScrambler(SECRET);
    const second = new CodeScrambler(`${SECRET}-other`);

    expect(first.encode(42n)).not.toBe(second.encode(42n));
  });

  it("stays inside the code space at the boundary", () => {
    const scrambler = new CodeScrambler(SECRET);

    for (
      let id = ALLOCATED_CODE_SPACE - 100n;
      id < ALLOCATED_CODE_SPACE;
      id += 1n
    ) {
      const value = scrambler.permute(id);

      expect(value >= 0n && value < ALLOCATED_CODE_SPACE).toBe(true);
    }

    expect(() => scrambler.permute(ALLOCATED_CODE_SPACE)).toThrow();
  });

  it("never overlaps with random synchronous codes", () => {
    expect(generateCode()).toHaveLength(8);
    expect(new CodeScrambler(SECRET).encode(7n)).toHaveLength(9);
  });
});

describe("BlockCodeAllocator", () => {
  it("reserves one block per blockSize codes", async () => {
    const source = blockSource(100);
    const allocator = new BlockCodeAllocator(
      source,
      new CodeScrambler(SECRET),
    );

    const codes = new Set<string>();

    for (let index = 0; index < 250; index += 1) {
      codes.add(await allocator.nextCode());
    }

    expect(codes.size).toBe(250);
    expect(source.reserveBlock).toHaveBeenCalledTimes(3);
  });

  it("shares one reservation between concurrent callers", async () => {
    const source = blockSource(1_000);
    const allocator = new BlockCodeAllocator(
      source,
      new CodeScrambler(SECRET),
    );

    const codes = await Promise.all(
      Array.from({ length: 500 }, () => allocator.nextCode()),
    );

    expect(new Set(codes).size).toBe(500);
    expect(source.reserveBlock).toHaveBeenCalledTimes(1);
  });

  it("propagates reservation failures and recovers afterwards", async () => {
    let fail = true;
    const allocator = new BlockCodeAllocator(
      {
        reserveBlock: async () => {
          if (fail) {
            throw new Error("database unavailable");
          }

          return { start: 0n, size: 10 };
        },
      },
      new CodeScrambler(SECRET),
    );

    await expect(allocator.nextCode()).rejects.toThrow(
      "database unavailable",
    );

    fail = false;

    expect(await allocator.nextCode()).toHaveLength(9);
  });

  it("refuses to run past the end of the code space", async () => {
    const allocator = new BlockCodeAllocator(
      {
        reserveBlock: async () => ({
          start: ALLOCATED_CODE_SPACE - 5n,
          size: 10,
        }),
      },
      new CodeScrambler(SECRET),
    );

    await expect(allocator.nextCode()).rejects.toThrow("exhausted");
  });
});
