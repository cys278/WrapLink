export interface BatchedClickSink {
  /**
   * Persists aggregated clicks. May return the codes that matched no
   * stored link; those clicks are retried on later flushes because the
   * link may still be waiting in the write-behind queue.
   */
  recordClickBatch(
    clicks: ReadonlyMap<string, number>,
  ): Promise<void | ReadonlySet<string>>;
}

export class ClickBuffer {
  private pending =
    new Map<string, number>();

  private pendingTotal = 0;

  private timer:
    | NodeJS.Timeout
    | undefined;

  private flushPromise:
    | Promise<void>
    | undefined;

  private closed = false;

  private readonly unmatchedAttempts =
    new Map<string, number>();

  private dropped = 0;

  constructor(
    private readonly sink: BatchedClickSink,
    private readonly flushIntervalMs = 1_000,
    private readonly maxPendingClicks = 10_000,
    private readonly maxUnmatchedAttempts = 10,
  ) {
    if (
      !Number.isSafeInteger(
        flushIntervalMs,
      ) ||
      flushIntervalMs < 1
    ) {
      throw new Error(
        "flush interval must be a positive integer",
      );
    }

    if (
      !Number.isSafeInteger(
        maxPendingClicks,
      ) ||
      maxPendingClicks < 1
    ) {
      throw new Error(
        "maximum pending clicks must be a positive integer",
      );
    }

    if (
      !Number.isSafeInteger(
        maxUnmatchedAttempts,
      ) ||
      maxUnmatchedAttempts < 1
    ) {
      throw new Error(
        "maximum unmatched attempts must be a positive integer",
      );
    }
  }

  start(): void {
    if (this.closed) {
      throw new Error(
        "click buffer is closed",
      );
    }

    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.flush().catch((error) => {
        console.warn(
          "Could not flush click buffer:",
          error,
        );
      });
    }, this.flushIntervalMs);

    this.timer.unref();
  }

  record(code: string): void {
    if (this.closed) {
      throw new Error(
        "click buffer is closed",
      );
    }

    if (!code) {
      throw new Error(
        "link code must not be empty",
      );
    }

    this.pending.set(
      code,
      (this.pending.get(code) ?? 0) + 1,
    );

    this.pendingTotal += 1;

    if (
      this.pendingTotal >=
      this.maxPendingClicks
    ) {
      void this.flush().catch((error) => {
        console.warn(
          "Could not flush full click buffer:",
          error,
        );
      });
    }
  }

  async flush(): Promise<void> {
    if (this.flushPromise) {
      return this.flushPromise;
    }

    const operation =
      this.performFlush();

    this.flushPromise = operation;

    try {
      await operation;
    } finally {
      if (
        this.flushPromise === operation
      ) {
        this.flushPromise = undefined;
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    if (this.flushPromise) {
      await this.flushPromise;
    }

    while (this.pending.size > 0) {
      await this.flush();
    }
  }

  pendingClicks(): number {
    return this.pendingTotal;
  }

  /** Clicks discarded because their link never appeared in storage. */
  droppedClicks(): number {
    return this.dropped;
  }

  private async performFlush(): Promise<void> {
    if (this.pending.size === 0) {
      return;
    }

    const batch = this.pending;

    this.pending =
      new Map<string, number>();

    this.pendingTotal = 0;

    let unmatched: void | ReadonlySet<string>;

    try {
      unmatched =
        await this.sink.recordClickBatch(
          batch,
        );
    } catch (error) {
      for (const [code, count] of batch) {
        this.pending.set(
          code,
          (this.pending.get(code) ?? 0) +
            count,
        );

        this.pendingTotal += count;
      }

      throw error;
    }

    for (const code of batch.keys()) {
      if (!unmatched?.has(code)) {
        this.unmatchedAttempts.delete(code);
      }
    }

    if (!unmatched || unmatched.size === 0) {
      return;
    }

    for (const code of unmatched) {
      const count = batch.get(code);

      if (count === undefined) {
        continue;
      }

      const attempts =
        (this.unmatchedAttempts.get(code) ?? 0) + 1;

      if (attempts >= this.maxUnmatchedAttempts) {
        this.unmatchedAttempts.delete(code);
        this.dropped += count;
        continue;
      }

      this.unmatchedAttempts.set(code, attempts);

      this.pending.set(
        code,
        (this.pending.get(code) ?? 0) + count,
      );

      this.pendingTotal += count;
    }
  }
}
