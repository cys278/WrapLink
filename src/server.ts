import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { MemoryLinkStore } from "./store/memory-link-store.js";

const config = loadConfig();
const store = new MemoryLinkStore(config.maxLinks);
const app = buildApp(config, store);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
