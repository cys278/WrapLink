import { Pool } from "pg";
import type { AppConfig } from "../config.js";

type DatabaseConfig = Pick<
  AppConfig,
  "databaseUrl" | "databasePoolMax"
>;

export function createDatabasePool(config: DatabaseConfig): Pool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  pool.on("error", (error) => {
    console.error("Unexpected PostgreSQL pool error:", error);
  });

  return pool;
}