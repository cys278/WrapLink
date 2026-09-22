import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://shortener:shortener@127.0.0.1:55432/shortener";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(currentDirectory, "../../migrations");

const client = new Client({
  connectionString: databaseUrl,
});

async function migrate(): Promise<void> {
  await client.connect();

  // Prevent two application instances from migrating simultaneously.
  await client.query(
    "SELECT pg_advisory_lock(hashtext('wraplink_migrations'))",
  );

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((filename) => filename.endsWith(".sql"))
      .sort();

    const result = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations",
    );

    const appliedMigrations = new Set(
      result.rows.map((row) => row.filename),
    );

    for (const filename of migrationFiles) {
      if (appliedMigrations.has(filename)) {
        console.log(`Already applied: ${filename}`);
        continue;
      }

      const sql = await readFile(
        resolve(migrationsDirectory, filename),
        "utf8",
      );

      console.log(`Applying: ${filename}`);

      await client.query("BEGIN");

      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [filename],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }

      console.log(`Applied: ${filename}`);
    }
  } finally {
    await client.query(
      "SELECT pg_advisory_unlock(hashtext('wraplink_migrations'))",
    );
    await client.end();
  }
}

migrate().catch((error: unknown) => {
  console.error("Migration failed:", error);
  process.exitCode = 1;
});