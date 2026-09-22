import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabasePool } from "./database/pool.js";
import { PostgresLinkStore } from "./store/postgres-link-store.js";

const config = loadConfig();
const pool = createDatabasePool(config);
const store = new PostgresLinkStore(pool);
const app = buildApp(config, store);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info({ signal }, "shutting down");

  try {
    await app.close();
    await pool.end();
    process.exitCode = 0;
  } catch (error) {
    app.log.error(error, "graceful shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  // Fail during startup instead of accepting requests with a broken database.
  await pool.query("SELECT 1");
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error, "server startup failed");
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
}