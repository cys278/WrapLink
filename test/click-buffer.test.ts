import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ClickBuffer,
  type BatchedClickSink,
} from "../src/store/click-buffer.js";

describe("ClickBuffer", () => {
  it(
    "combines clicks for each link",
    async () => {
      const recordClickBatch = vi.fn(
        async () => undefined,
      );

      const sink: BatchedClickSink = {
        recordClickBatch,
      };

      const buffer = new ClickBuffer(
        sink,
      );

      buffer.record("docs");
      buffer.record("docs");
      buffer.record("docs");
      buffer.record("home");
      buffer.record("home");

      expect(
        buffer.pendingClicks(),
      ).toBe(5);

      expect(
        recordClickBatch,
      ).not.toHaveBeenCalled();

      await buffer.flush();

      expect(
        recordClickBatch,
      ).toHaveBeenCalledTimes(1);

      expect(
        recordClickBatch,
      ).toHaveBeenCalledWith(
        new Map([
          ["docs", 3],
          ["home", 2],
        ]),
      );

      expect(
        buffer.pendingClicks(),
      ).toBe(0);
    },
  );

  it(
    "does not write when the buffer is empty",
    async () => {
      const recordClickBatch = vi.fn(
        async () => undefined,
      );

      const buffer = new ClickBuffer({
        recordClickBatch,
      });

      await buffer.flush();

      expect(
        recordClickBatch,
      ).not.toHaveBeenCalled();
    },
  );

  it(
    "restores a failed batch for retry",
    async () => {
      let shouldFail = true;

      const recordClickBatch = vi.fn(
        async () => {
          if (shouldFail) {
            throw new Error(
              "database unavailable",
            );
          }
        },
      );

      const buffer = new ClickBuffer({
        recordClickBatch,
      });

      buffer.record("retry");
      buffer.record("retry");
      buffer.record("retry");

      await expect(
        buffer.flush(),
      ).rejects.toThrow(
        "database unavailable",
      );

      expect(
        buffer.pendingClicks(),
      ).toBe(3);

      shouldFail = false;

      await buffer.flush();

      expect(
        buffer.pendingClicks(),
      ).toBe(0);

      expect(
        recordClickBatch,
      ).toHaveBeenLastCalledWith(
        new Map([
          ["retry", 3],
        ]),
      );
    },
  );

  it(
    "flushes remaining clicks when closed",
    async () => {
      const recordClickBatch = vi.fn(
        async () => undefined,
      );

      const buffer = new ClickBuffer({
        recordClickBatch,
      });

      buffer.record("shutdown");
      buffer.record("shutdown");

      await buffer.close();

      expect(
        recordClickBatch,
      ).toHaveBeenCalledWith(
        new Map([
          ["shutdown", 2],
        ]),
      );

      expect(
        buffer.pendingClicks(),
      ).toBe(0);

      expect(() => {
        buffer.record("late");
      }).toThrow(
        "click buffer is closed",
      );
    },
  );

  it(
    "retries clicks for links that are not stored yet",
    async () => {
      let stored = false;

      const recordClickBatch = vi.fn(
        async (clicks: ReadonlyMap<string, number>) =>
          stored
            ? new Set<string>()
            : new Set([...clicks.keys()].filter((code) => code === "fresh")),
      );

      const buffer = new ClickBuffer({ recordClickBatch });

      buffer.record("fresh");
      buffer.record("fresh");
      buffer.record("old");

      await buffer.flush();

      // "old" was stored; "fresh" is still in the write-behind queue.
      expect(buffer.pendingClicks()).toBe(2);

      stored = true;
      await buffer.flush();

      expect(buffer.pendingClicks()).toBe(0);
      expect(buffer.droppedClicks()).toBe(0);
      expect(recordClickBatch).toHaveBeenLastCalledWith(
        new Map([["fresh", 2]]),
      );
    },
  );

  it(
    "drops clicks for links that never appear",
    async () => {
      const buffer = new ClickBuffer(
        {
          recordClickBatch: async (clicks) =>
            new Set(clicks.keys()),
        },
        1_000,
        10_000,
        3,
      );

      buffer.record("ghost");
      buffer.record("ghost");

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await buffer.flush();
      }

      expect(buffer.pendingClicks()).toBe(0);
      expect(buffer.droppedClicks()).toBe(2);
    },
  );
});