import { describe, expect, it } from "vitest";
import {
  isWorkerMetricsMessage,
  MetricsAggregator,
} from "../src/cluster-metrics.js";
import {
  emptyMetricsSnapshot,
  Metrics,
  renderMetrics,
} from "../src/metrics.js";

describe("named counters", () => {
  it("accumulates and renders counters", async () => {
    const metrics = new Metrics();

    metrics.increment("links_synced", 40);
    metrics.increment("links_synced", 2);
    metrics.increment("write_behind_fallbacks");

    expect(metrics.snapshot().counters).toEqual({
      links_synced: 42,
      write_behind_fallbacks: 1,
    });

    const body = await metrics.render();

    expect(body).toContain("# TYPE shortener_links_synced_total counter");
    expect(body).toContain("shortener_links_synced_total 42");
    expect(body).toContain("shortener_write_behind_fallbacks_total 1");
  });

  it("ignores invalid names and non-positive values", () => {
    const metrics = new Metrics();

    metrics.increment("Bad-Name");
    metrics.increment("links_synced", 0);
    metrics.increment("links_synced", -3);
    metrics.increment("links_synced", 1.5);

    expect(metrics.snapshot().counters).toBeUndefined();
  });

  it("omits counters from empty snapshots", () => {
    expect(emptyMetricsSnapshot()).toEqual({
      created: 0,
      redirects: 0,
      misses: 0,
      httpRequests: [],
    });

    expect(renderMetrics(emptyMetricsSnapshot())).not.toContain(
      "links_synced",
    );
  });

  it("merges counters from cluster workers", () => {
    const aggregator = new MetricsAggregator();

    aggregator.add({
      ...emptyMetricsSnapshot(),
      counters: { links_synced: 10 },
    });
    aggregator.add({
      ...emptyMetricsSnapshot(),
      counters: { links_synced: 5, link_sync_conflicts: 1 },
    });
    aggregator.add(emptyMetricsSnapshot());

    expect(aggregator.snapshot().counters).toEqual({
      links_synced: 15,
      link_sync_conflicts: 1,
    });
  });

  it("validates counters received over IPC", () => {
    const message = (counters: unknown) => ({
      type: "metrics:batch",
      snapshot: { ...emptyMetricsSnapshot(), counters },
    });

    expect(isWorkerMetricsMessage(message({ links_synced: 3 }))).toBe(true);
    expect(isWorkerMetricsMessage(message(undefined))).toBe(true);
    expect(isWorkerMetricsMessage(message({ links_synced: -1 }))).toBe(false);
    expect(isWorkerMetricsMessage(message({ "bad name": 1 }))).toBe(false);
    expect(isWorkerMetricsMessage(message([1, 2]))).toBe(false);
    expect(isWorkerMetricsMessage(message("nope"))).toBe(false);
  });
});
