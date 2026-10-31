import type { Pool } from "pg";
import type {
  CreateLinkInput,
  Link,
  LinkStore,
  PendingLink,
} from "../domain/link.js";
import type { BatchedClickSink } from "./click-buffer.js";

export interface PendingLinkBatchResult {
  /** Codes that are now durable, including idempotent replays. */
  persisted: string[];
  /** Codes already owned by a *different* link in PostgreSQL. */
  conflicts: PendingLink[];
}

interface LinkRow {
  code: string;
  target_url: string;
  created_at: Date;
  expires_at: Date | null;
  clicks: string;
}

function mapLink(row: LinkRow): Link {
  return {
    code: row.code,
    targetUrl: row.target_url,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    clicks: Number(row.clicks),
  };
}

export class PostgresLinkStore
  implements LinkStore, BatchedClickSink
{
  constructor(
    private readonly pool: Pool,
  ) {}

  async create(
    input: CreateLinkInput,
  ): Promise<Link | null> {
    const result =
      await this.pool.query<LinkRow>(
        `
          INSERT INTO links (
            code,
            target_url,
            expires_at
          )
          VALUES ($1, $2, $3)
          ON CONFLICT (code) DO NOTHING
          RETURNING
            code,
            target_url,
            created_at,
            expires_at,
            clicks
        `,
        [
          input.code,
          input.targetUrl,
          input.expiresAt,
        ],
      );

    const row = result.rows[0];

    return row ? mapLink(row) : null;
  }

  async find(
    code: string,
  ): Promise<Link | null> {
    const result =
      await this.pool.query<LinkRow>(
        `
          SELECT
            code,
            target_url,
            created_at,
            expires_at,
            clicks
          FROM links
          WHERE code = $1
            AND (
              expires_at IS NULL
              OR expires_at > NOW()
            )
        `,
        [code],
      );

    const row = result.rows[0];

    return row ? mapLink(row) : null;
  }

  async recordClick(
    code: string,
  ): Promise<void> {
    await this.recordClicks(code, 1);
  }

  async recordClicks(
    code: string,
    count: number,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(count) ||
      count < 1
    ) {
      throw new Error(
        "click count must be a positive integer",
      );
    }

    await this.pool.query(
      `
        UPDATE links
        SET clicks = clicks + $2
        WHERE code = $1
      `,
      [code, count],
    );
  }

  /**
   * Applies aggregated click increments in one statement and returns the
   * codes that matched no row. A link created through the write-behind
   * path can be clicked before the sync worker has inserted it; the click
   * buffer retries those codes instead of silently dropping the clicks.
   */
  async recordClickBatch(
    clicks: ReadonlyMap<string, number>,
  ): Promise<ReadonlySet<string>> {
    if (clicks.size === 0) {
      return new Set();
    }

    const codes: string[] = [];
    const counts: number[] = [];

    for (const [code, count] of clicks) {
      if (
        !Number.isSafeInteger(count) ||
        count < 1
      ) {
        throw new Error(
          "click count must be a positive integer",
        );
      }

      codes.push(code);
      counts.push(count);
    }

    const result = await this.pool.query<{
      code: string;
    }>(
      `
        UPDATE links AS link
        SET clicks =
          link.clicks + batch.count
        FROM (
          SELECT
            code,
            count
          FROM UNNEST(
            $1::text[],
            $2::bigint[]
          ) AS values(code, count)
        ) AS batch
        WHERE link.code = batch.code
        RETURNING link.code
      `,
      [codes, counts],
    );

    const matched = new Set(
      result.rows.map((row) => row.code),
    );

    return new Set(
      codes.filter((code) => !matched.has(code)),
    );
  }

  /**
   * Inserts links accepted by the write-behind path.
   *
   * The insert is idempotent: if a previous attempt committed but the
   * worker crashed before acknowledging the queue, the replayed rows are
   * recognised (same code, target and creation instant) and reported as
   * persisted rather than as conflicts.
   */
  async insertPendingBatch(
    links: readonly PendingLink[],
  ): Promise<PendingLinkBatchResult> {
    if (links.length === 0) {
      return { persisted: [], conflicts: [] };
    }

    // Deduplicate within the batch; the first occurrence wins.
    const unique = new Map<string, PendingLink>();

    for (const link of links) {
      if (!unique.has(link.code)) {
        unique.set(link.code, link);
      }
    }

    const batch = [...unique.values()];

    const inserted = await this.pool.query<{
      code: string;
    }>(
      `
        INSERT INTO links (
          code,
          target_url,
          created_at,
          expires_at
        )
        SELECT
          code,
          target_url,
          created_at,
          expires_at
        FROM UNNEST(
          $1::text[],
          $2::text[],
          $3::timestamptz[],
          $4::timestamptz[]
        ) AS pending(
          code,
          target_url,
          created_at,
          expires_at
        )
        ON CONFLICT (code) DO NOTHING
        RETURNING code
      `,
      [
        batch.map((link) => link.code),
        batch.map((link) => link.targetUrl),
        batch.map((link) =>
          link.createdAt.toISOString(),
        ),
        batch.map(
          (link) =>
            link.expiresAt?.toISOString() ?? null,
        ),
      ],
    );

    const persisted = new Set(
      inserted.rows.map((row) => row.code),
    );

    const notInserted = batch.filter(
      (link) => !persisted.has(link.code),
    );

    const conflicts: PendingLink[] = [];

    if (notInserted.length > 0) {
      const existing = await this.pool.query<{
        code: string;
        target_url: string;
        created_ms: string;
      }>(
        `
          SELECT
            code,
            target_url,
            (EXTRACT(EPOCH FROM created_at) * 1000)::bigint
              AS created_ms
          FROM links
          WHERE code = ANY($1::text[])
        `,
        [notInserted.map((link) => link.code)],
      );

      const rows = new Map(
        existing.rows.map((row) => [row.code, row]),
      );

      for (const link of notInserted) {
        const row = rows.get(link.code);

        const isReplay =
          row !== undefined &&
          row.target_url === link.targetUrl &&
          Number(row.created_ms) ===
            link.createdAt.getTime();

        if (isReplay) {
          persisted.add(link.code);
        } else {
          conflicts.push(link);
        }
      }
    }

    return {
      persisted: [...persisted],
      conflicts,
    };
  }

  /**
   * Exact row count. COUNT(*) is O(n): PostgreSQL scans the table (or an
   * index) every time. Never call this on a request path; use
   * estimatedSize() for dashboards and metrics.
   */
  async size(): Promise<number> {
    const result = await this.pool.query<{
      count: string;
    }>(
      "SELECT COUNT(*) AS count FROM links",
    );

    return Number(
      result.rows[0]?.count ?? 0,
    );
  }

  /**
   * O(1) planner estimate maintained by VACUUM/ANALYZE. Returns 0 until the
   * table has been analysed at least once.
   */
  async estimatedSize(): Promise<number> {
    const result = await this.pool.query<{
      estimate: string;
    }>(
      `
        SELECT GREATEST(reltuples, 0)::bigint AS estimate
        FROM pg_class
        WHERE oid = 'links'::regclass
      `,
    );

    return Number(result.rows[0]?.estimate ?? 0);
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");

      return true;
    } catch {
      return false;
    }
  }
}