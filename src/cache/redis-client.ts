import { createClient } from "redis";
import type { AppConfig } from "../config.js";

type RedisConfig = Pick<AppConfig, "redisUrl">;

export function createRedisClient(config: RedisConfig) {
  const client = createClient({
    url: config.redisUrl,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy(retries) {
        return Math.min(retries * 50, 1_000);
      },
    },
  });

  client.on("error", (error) => {
    console.error("Redis client error:", error);
  });

  return client;
}

export type RedisClient = ReturnType<
  typeof createRedisClient
>;