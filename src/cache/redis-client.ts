import {
  createClient,
  createCluster,
} from "redis";
import type { AppConfig } from "../config.js";

type RedisConfig = Pick<
  AppConfig,
  "redisUrl" | "redisClusterUrls"
>;

function reconnectStrategy(
  retries: number,
): number | Error {
  if (retries >= 5) {
    return new Error(
      "Redis reconnection limit reached",
    );
  }

  return Math.min(retries * 50, 1_000);
}

export function createRedisClient(
  config: RedisConfig,
) {
  const client =
    config.redisClusterUrls.length > 0
      ? createCluster({
          rootNodes:
            config.redisClusterUrls.map(
              (url) => ({ url }),
            ),
          defaults: {
            socket: {
              connectTimeout: 5_000,
              reconnectStrategy,
            },
          },
        })
      : createClient({
          url: config.redisUrl,
          socket: {
            connectTimeout: 5_000,
            reconnectStrategy,
          },
        });

  client.on("error", (error) => {
    console.error(
      "Redis client error:",
      error,
    );
  });

  return client;
}

export type RedisClient = ReturnType<
  typeof createRedisClient
>;
