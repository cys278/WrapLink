import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const KEY = "k".repeat(40);
const SECRET = "s".repeat(40);

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };

  for (const name of Object.keys(process.env)) {
    if (
      /^(LINK_|WRITE_BEHIND|CODE_SCRAMBLE|TRUST_PROXY|REDIS_|CLICK_|CREATE_|PORT$)/.test(
        name,
      )
    ) {
      delete process.env[name];
    }
  }

  process.env.CREATE_API_KEYS = KEY;
});

afterEach(() => {
  process.env = saved;
});

describe("loadConfig", () => {
  it("defaults to synchronous writes with sync disabled", () => {
    const config = loadConfig();

    expect(config.linkWriteMode).toBe("sync");
    expect(config.linkSyncEnabled).toBe(false);
    expect(config.trustProxy).toBe(false);
    expect(config.redisClusterUseReplicas).toBe(false);
    expect(config.clickFlushIntervalMs).toBe(1_000);
    expect(config.clickBufferMax).toBe(10_000);
    expect(config.writeBehindMaxPending).toBe(1_000_000);
  });

  it("enables the sync worker in write-behind mode", () => {
    process.env.LINK_WRITE_MODE = "write-behind";
    process.env.CODE_SCRAMBLE_SECRET = SECRET;

    const config = loadConfig();

    expect(config.linkWriteMode).toBe("write-behind");
    expect(config.linkSyncEnabled).toBe(true);
    expect(config.codeScrambleSecret).toBe(SECRET);
  });

  it("requires a strong scramble secret in write-behind mode", () => {
    process.env.LINK_WRITE_MODE = "write-behind";
    expect(() => loadConfig()).toThrow("CODE_SCRAMBLE_SECRET");

    process.env.CODE_SCRAMBLE_SECRET = "short";
    expect(() => loadConfig()).toThrow("CODE_SCRAMBLE_SECRET");
  });

  it("rejects unknown write modes", () => {
    process.env.LINK_WRITE_MODE = "yolo";

    expect(() => loadConfig()).toThrow("LINK_WRITE_MODE");
  });

  it("parses booleans strictly", () => {
    process.env.TRUST_PROXY = "yes";
    process.env.REDIS_CLUSTER_USE_REPLICAS = "1";
    process.env.LINK_SYNC_ENABLED = "true";

    const config = loadConfig();

    expect(config.trustProxy).toBe(true);
    expect(config.redisClusterUseReplicas).toBe(true);
    expect(config.linkSyncEnabled).toBe(true);

    process.env.TRUST_PROXY = "maybe";
    expect(() => loadConfig()).toThrow("TRUST_PROXY");
  });

  it("rejects partial or non-positive integers", () => {
    process.env.PORT = "3000abc";
    expect(() => loadConfig()).toThrow("PORT");

    process.env.PORT = "0";
    expect(() => loadConfig()).toThrow("PORT");
  });

  it("parses comma-separated Redis cluster URLs", () => {
    process.env.REDIS_CLUSTER_URLS =
      " redis://a:7001 , ,redis://b:7002 ";

    expect(loadConfig().redisClusterUrls).toEqual([
      "redis://a:7001",
      "redis://b:7002",
    ]);
  });

  it("requires at least one API key", () => {
    delete process.env.CREATE_API_KEYS;

    expect(() => loadConfig()).toThrow("CREATE_API_KEYS");
  });
});
