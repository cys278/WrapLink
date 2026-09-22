import type { Pool } from "pg";
import type {
  CreateLinkInput,
  Link,
  LinkStore,
} from "../domain/link.js";

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

export class PostgresLinkStore implements LinkStore {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateLinkInput): Promise<Link | null> {
    const result = await this.pool.query<LinkRow>(
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
      [input.code, input.targetUrl, input.expiresAt],
    );

    const row = result.rows[0];
    return row ? mapLink(row) : null;
  }

  async find(code: string): Promise<Link | null> {
    const result = await this.pool.query<LinkRow>(
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

  async recordClick(code: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE links
        SET clicks = clicks + 1
        WHERE code = $1
      `,
      [code],
    );
  }

  async size(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM links",
    );

    return Number(result.rows[0]?.count ?? 0);
  }
}