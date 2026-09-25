import type { RedisClient } from "../cache/redis-client.js";
import type {
  CreateLinkInput,
  Link,
  LinkStore,
} from "../domain/link.js";
import type { ClickBuffer } from "./click-buffer.js";

const INCREMENT_CACHED_CLICK = `
  if redis.call("EXISTS", KEYS[1]) == 1 then
    return redis.call("HINCRBY", KEYS[1], "clicks", 1)
  end

  return 0
`;

export class CachedLinkStore
  implements LinkStore
{
  constructor(
    private readonly source: LinkStore,
    private readonly redis: RedisClient,
    private readonly ttlSeconds: number,
    private readonly clickBuffer?: ClickBuffer,
  ) {}

  async create(
    input: CreateLinkInput,
  ): Promise<Link | null> {
    const link =
      await this.source.create(input);

    if (link) {
      await this.cacheSafely(link);
    }

    return link;
  }

  async find(
    code: string,
  ): Promise<Link | null> {
    const cached =
      await this.readSafely(code);

    if (cached) {
      return cached;
    }

    const link =
      await this.source.find(code);

    if (link) {
      await this.cacheSafely(link);
    }

    return link;
  }

  async recordClick(
    code: string,
  ): Promise<void> {
    if (this.clickBuffer) {
      // PostgreSQL remains authoritative, but the
      // update is written asynchronously in batches.
      this.clickBuffer.record(code);
    } else {
      // Tests and alternative stores can continue
      // using immediate durable persistence.
      await this.source.recordClick(code);
    }

    // Redis is optional. Avoid calling a
    // disconnected client.
    if (!this.redis.isReady) {
      return;
    }

    try {
      await this.redis.eval(
        INCREMENT_CACHED_CLICK,
        {
          keys: [this.key(code)],
          arguments: [],
        },
      );
    } catch (error) {
      console.warn(
        "Could not update cached click count:",
        error,
      );
    }
  }

  async size(): Promise<number> {
    return this.source.size();
  }

  async isHealthy(): Promise<boolean> {
    return this.source.isHealthy();
  }

  private key(code: string): string {
    return `wraplink:link:${code}`;
  }

  private async cacheSafely(
    link: Link,
  ): Promise<void> {
    // Fall back to PostgreSQL when Redis
    // is unavailable.
    if (!this.redis.isReady) {
      return;
    }

    try {
      await this.cache(link);
    } catch (error) {
      console.warn(
        "Could not cache link:",
        error,
      );
    }
  }

  private async cache(
    link: Link,
  ): Promise<void> {
    let ttl = this.ttlSeconds;

    if (link.expiresAt) {
      const remainingSeconds = Math.floor(
        (link.expiresAt.getTime() -
          Date.now()) /
          1_000,
      );

      if (remainingSeconds <= 0) {
        await this.redis.del(
          this.key(link.code),
        );

        return;
      }

      ttl = Math.min(
        ttl,
        remainingSeconds,
      );
    }

    await this.redis
      .multi()
      .hSet(this.key(link.code), {
        code: link.code,
        targetUrl: link.targetUrl,
        createdAt:
          link.createdAt.toISOString(),
        expiresAt:
          link.expiresAt?.toISOString() ??
          "",
        clicks: String(link.clicks),
      })
      .expire(
        this.key(link.code),
        ttl,
      )
      .exec();
  }

  private async readSafely(
    code: string,
  ): Promise<Link | null> {
    // A cache miss and an unavailable cache
    // both fall back to PostgreSQL.
    if (!this.redis.isReady) {
      return null;
    }

    try {
      const values =
        await this.redis.hGetAll(
          this.key(code),
        );

      if (
        Object.keys(values).length === 0
      ) {
        return null;
      }

      const {
        code: cachedCode,
        targetUrl,
        createdAt: createdAtValue,
        expiresAt: expiresAtValue,
        clicks: clicksValue,
      } = values;

      if (
        !cachedCode ||
        !targetUrl ||
        !createdAtValue ||
        clicksValue === undefined
      ) {
        await this.redis.del(
          this.key(code),
        );

        return null;
      }

      const createdAt = new Date(
        createdAtValue,
      );

      const expiresAt = expiresAtValue
        ? new Date(expiresAtValue)
        : null;

      const clicks = Number(
        clicksValue,
      );

      if (
        Number.isNaN(
          createdAt.getTime(),
        ) ||
        (expiresAt &&
          Number.isNaN(
            expiresAt.getTime(),
          )) ||
        !Number.isSafeInteger(clicks) ||
        clicks < 0
      ) {
        await this.redis.del(
          this.key(code),
        );

        return null;
      }

      if (
        expiresAt &&
        expiresAt.getTime() <=
          Date.now()
      ) {
        await this.redis.del(
          this.key(code),
        );

        return null;
      }

      return {
        code: cachedCode,
        targetUrl,
        createdAt,
        expiresAt,
        clicks,
      };
    } catch (error) {
      console.warn(
        "Could not read cached link:",
        error,
      );

      return null;
    }
  }
}