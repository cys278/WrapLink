import { createHmac } from "node:crypto";

/**
 * Collision-free short codes for the write-behind creation path.
 *
 * Why not random codes?
 * ---------------------
 * The birthday bound says a 50% collision chance is reached after roughly
 * 1.1774 * sqrt(N) draws from N possibilities. For 8 random Base62
 * characters N = 62^8 ≈ 2.18e14, so the 50% point arrives after ≈ 1.74e7
 * codes: about 17 seconds at one million creations per second.
 *
 * The synchronous path survives that because PostgreSQL rejects the
 * duplicate and the request retries. The write-behind path answers the
 * client *before* PostgreSQL sees the row, so a collision would surface
 * minutes later as a broken link. Uniqueness must therefore be structural,
 * not probabilistic.
 *
 * How it works
 * ------------
 * 1. Each process reserves a block of integer IDs from a PostgreSQL
 *    sequence (migration 002). One round trip buys `blockSize` codes, so
 *    PostgreSQL sees ~100 queries/s at 1M creations/s with 10,000-ID blocks.
 * 2. Each integer passes through a keyed Feistel permutation over the code
 *    space. A permutation is a bijection: distinct IDs always produce
 *    distinct codes, while consecutive IDs look unrelated, so codes cannot
 *    be enumerated by counting.
 * 3. The result is written as exactly 9 Base62 characters. Random codes
 *    from the synchronous path are 8 characters, so the two generators can
 *    never produce the same value.
 *
 * Capacity: 62^9 ≈ 1.35e16 codes, i.e. ~428 years at a sustained 1M/s.
 */

const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export const ALLOCATED_CODE_LENGTH = 9;

export const ALLOCATED_CODE_SPACE =
  62n ** BigInt(ALLOCATED_CODE_LENGTH);

/** Reference Base62 encoder (BigInt). The hot path uses CodeScrambler.encode. */
export function encodeBase62Fixed(
  value: bigint,
  length: number,
): string {
  if (value < 0n) {
    throw new Error("value must be non-negative");
  }

  let remaining = value;
  const characters: string[] = new Array<string>(length);

  for (let index = length - 1; index >= 0; index -= 1) {
    characters[index] = ALPHABET[Number(remaining % 62n)]!;
    remaining /= 62n;
  }

  if (remaining !== 0n) {
    throw new Error("value does not fit in the requested length");
  }

  return characters.join("");
}

// The Feistel network permutes 54-bit values split into two 27-bit halves.
// 2^54 / 62^9 ≈ 1.33, so cycle-walking needs ~1.33 permutations per code.
const HALF_BITS = 27;
const HALF_SIZE = 2 ** HALF_BITS;
const HALF_MASK = HALF_SIZE - 1;
const FEISTEL_ROUNDS = 8;

// The code space split the same way: 62^9 = SPACE_HIGH * 2^27 + SPACE_LOW.
const SPACE_HIGH = Number(ALLOCATED_CODE_SPACE / BigInt(HALF_SIZE));
const SPACE_LOW = Number(ALLOCATED_CODE_SPACE % BigInt(HALF_SIZE));

function insideCodeSpace(high: number, low: number): boolean {
  return (
    high < SPACE_HIGH ||
    (high === SPACE_HIGH && low < SPACE_LOW)
  );
}

/**
 * Keyed Feistel permutation over [0, 62^9).
 *
 * Performance: generating a code is on the request path in write-behind
 * mode, so all arithmetic stays in 32-bit integers (no BigInt, no crypto
 * objects per call). Round keys are derived once from the secret with
 * HMAC-SHA256; each round then applies a keyed MurmurHash3-style mixer.
 * A Feistel network is a bijection for *any* round function, so code
 * uniqueness does not depend on the mixer's strength.
 *
 * Security: this makes codes non-sequential and impractical to enumerate
 * without the secret. It is obfuscation, not encryption; do not rely on it
 * to keep links secret. Private destinations need authentication.
 */
export class CodeScrambler {
  private readonly roundKeys: Uint32Array;

  constructor(secret: string) {
    if (secret.length === 0) {
      throw new Error("scramble secret must not be empty");
    }

    const material = Buffer.concat([
      createHmac("sha256", secret)
        .update("wraplink-feistel-keys-0")
        .digest(),
      createHmac("sha256", secret)
        .update("wraplink-feistel-keys-1")
        .digest(),
    ]);

    // Two 32-bit words per round.
    this.roundKeys = new Uint32Array(FEISTEL_ROUNDS * 2);

    for (let index = 0; index < this.roundKeys.length; index += 1) {
      this.roundKeys[index] = material.readUInt32BE(index * 4);
    }
  }

  /** Bijective map from [0, 62^9) to [0, 62^9). */
  permute(id: bigint): bigint {
    if (id < 0n || id >= ALLOCATED_CODE_SPACE) {
      throw new Error("id is outside the code space");
    }

    const [high, low] = this.permuteHalves(
      Number(id / BigInt(HALF_SIZE)),
      Number(id % BigInt(HALF_SIZE)),
    );

    return BigInt(high) * BigInt(HALF_SIZE) + BigInt(low);
  }

  encode(id: bigint): string {
    if (id < 0n || id >= ALLOCATED_CODE_SPACE) {
      throw new Error("id is outside the code space");
    }

    let [high, low] = this.permuteHalves(
      Number(id / BigInt(HALF_SIZE)),
      Number(id % BigInt(HALF_SIZE)),
    );

    // Base62 digits of high * 2^27 + low using only safe integers:
    // divide the two-part number by 62, carrying the remainder down.
    const characters = new Array<string>(ALLOCATED_CODE_LENGTH);

    for (
      let index = ALLOCATED_CODE_LENGTH - 1;
      index >= 0;
      index -= 1
    ) {
      const highRemainder = high % 62;
      high = Math.floor(high / 62);

      const combined = highRemainder * HALF_SIZE + low;
      low = Math.floor(combined / 62);

      characters[index] = ALPHABET[combined % 62]!;
    }

    return characters.join("");
  }

  private permuteHalves(
    high: number,
    low: number,
  ): [number, number] {
    let [left, right] = this.feistel(high, low);

    // Cycle-walking keeps the permutation inside [0, 62^9).
    while (!insideCodeSpace(left, right)) {
      [left, right] = this.feistel(left, right);
    }

    return [left, right];
  }

  private feistel(
    high: number,
    low: number,
  ): [number, number] {
    let left = high;
    let right = low;

    for (let round = 0; round < FEISTEL_ROUNDS; round += 1) {
      const mixed =
        (left ^
          this.round(
            right,
            this.roundKeys[round * 2]!,
            this.roundKeys[round * 2 + 1]!,
          )) &
        HALF_MASK;

      left = right;
      right = mixed;
    }

    return [left, right];
  }

  private round(
    half: number,
    keyA: number,
    keyB: number,
  ): number {
    let hash = (half ^ keyA) >>> 0;
    hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
    hash = (hash ^ (hash >>> 16)) >>> 0;
    hash = Math.imul(hash ^ keyB, 0x9e3779b1);

    return (hash ^ (hash >>> 15)) & HALF_MASK;
  }
}

export interface IdBlock {
  start: bigint;
  size: number;
}

export interface IdBlockSource {
  reserveBlock(): Promise<IdBlock>;
}

/**
 * Hands out codes from locally reserved blocks. Concurrent callers share a
 * single in-flight reservation, so a burst of requests never reserves more
 * blocks than it needs.
 */
export class BlockCodeAllocator {
  private next = 0n;
  private end = 0n;
  private reservation: Promise<void> | undefined;

  constructor(
    private readonly source: IdBlockSource,
    private readonly scrambler: CodeScrambler,
  ) {}

  async nextCode(): Promise<string> {
    while (this.next >= this.end) {
      if (!this.reservation) {
        this.reservation = this.reserve().finally(() => {
          this.reservation = undefined;
        });
      }

      await this.reservation;
    }

    const id = this.next;
    this.next += 1n;

    return this.scrambler.encode(id);
  }

  remainingInBlock(): bigint {
    return this.end - this.next;
  }

  private async reserve(): Promise<void> {
    const block = await this.source.reserveBlock();

    if (
      block.start < 0n ||
      !Number.isSafeInteger(block.size) ||
      block.size < 1
    ) {
      throw new Error("invalid ID block");
    }

    const end = block.start + BigInt(block.size);

    if (end > ALLOCATED_CODE_SPACE) {
      throw new Error("short code space exhausted");
    }

    this.next = block.start;
    this.end = end;
  }
}
