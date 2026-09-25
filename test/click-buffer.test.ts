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
      const recordClicks = vi.fn(
        async () => undefined,
      );

      const sink: BatchedClickSink = {
        recordClicks,
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
        recordClicks,
      ).not.toHaveBeenCalled();

      await buffer.flush();

      expect(
        recordClicks,
      ).toHaveBeenCalledTimes(2);

      expect(
        recordClicks,
      ).toHaveBeenCalledWith(
        "docs",
        3,
      );

      expect(
        recordClicks,
      ).toHaveBeenCalledWith(
        "home",
        2,
      );

      expect(
        buffer.pendingClicks(),
      ).toBe(0);
    },
  );

  it(
    "does not write when the buffer is empty",
    async () => {
      const recordClicks = vi.fn(
        async () => undefined,
      );

      const buffer = new ClickBuffer({
        recordClicks,
      });

      await buffer.flush();

      expect(
        recordClicks,
      ).not.toHaveBeenCalled();
    },
  );

  it(
    "restores a failed batch for retry",
    async () => {
      let shouldFail = true;

      const recordClicks = vi.fn(
        async () => {
          if (shouldFail) {
            throw new Error(
              "database unavailable",
            );
          }
        },
      );

      const buffer = new ClickBuffer({
        recordClicks,
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
        recordClicks,
      ).toHaveBeenLastCalledWith(
        "retry",
        3,
      );
    },
  );

  it(
    "flushes remaining clicks when closed",
    async () => {
      const recordClicks = vi.fn(
        async () => undefined,
      );

      const buffer = new ClickBuffer({
        recordClicks,
      });

      buffer.record("shutdown");
      buffer.record("shutdown");

      await buffer.close();

      expect(
        recordClicks,
      ).toHaveBeenCalledWith(
        "shutdown",
        2,
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
});