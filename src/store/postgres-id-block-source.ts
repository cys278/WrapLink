import type { Pool } from "pg";
import type {
  IdBlock,
  IdBlockSource,
} from "../domain/code-allocator.js";

/**
 * Reserves blocks of short-code IDs from the durable PostgreSQL sequence
 * created by migration 002. The block size comes from the sequence
 * definition itself, so the application can never disagree with it.
 */
export class PostgresIdBlockSource
  implements IdBlockSource
{
  constructor(private readonly pool: Pool) {}

  async reserveBlock(): Promise<IdBlock> {
    const result = await this.pool.query<{
      start: string;
      size: string;
    }>(
      `
        SELECT
          nextval('link_code_block_seq')::text AS start,
          (
            SELECT increment_by
            FROM pg_sequences
            WHERE schemaname = current_schema()
              AND sequencename = 'link_code_block_seq'
          )::text AS size
      `,
    );

    const row = result.rows[0];

    if (!row || row.size === null) {
      throw new Error(
        "link_code_block_seq is missing; run npm run db:migrate",
      );
    }

    return {
      start: BigInt(row.start),
      size: Number(row.size),
    };
  }
}
