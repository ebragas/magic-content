// Derived-metric + null-rule harness (docs/schema.md). Pure functions, no I/O.

import { describe, expect, it } from "vitest";
import { computeDerivedMetrics, computeOutlierFlags } from "./metrics.js";

describe("computeDerivedMetrics", () => {
  it("computes performance / engagement / viral with followers present", () => {
    const d = computeDerivedMetrics(
      { likes: 5000, comments_count: 120, views: 90_000 },
      100_000,
    );
    expect(d.performance_score).toBe(5000 + 3 * 120 + 0.1 * 90_000); // 14360
    expect(d.engagement_rate).toBeCloseTo(14360 / 100_000);
    expect(d.is_viral).toBe(0);
  });

  it("flags virality when likes >= 5 * followers", () => {
    const d = computeDerivedMetrics({ likes: 60, comments_count: 0, views: 0 }, 10);
    expect(d.is_viral).toBe(1); // 60 >= 50
  });

  it("hidden likes (NULL) → score / rate / viral all NULL", () => {
    const d = computeDerivedMetrics({ likes: null, comments_count: 10, views: 100 }, 1000);
    expect(d.performance_score).toBeNull();
    expect(d.engagement_rate).toBeNull();
    expect(d.is_viral).toBeNull();
  });

  it("followers NULL or 0 → rate / viral NULL but score still computed", () => {
    const dNull = computeDerivedMetrics({ likes: 100, comments_count: 0, views: 0 }, null);
    expect(dNull.performance_score).toBe(100);
    expect(dNull.engagement_rate).toBeNull();
    expect(dNull.is_viral).toBeNull();

    const dZero = computeDerivedMetrics({ likes: 100, comments_count: 0, views: 0 }, 0);
    expect(dZero.performance_score).toBe(100);
    expect(dZero.engagement_rate).toBeNull();
    expect(dZero.is_viral).toBeNull();
  });
});

describe("computeOutlierFlags", () => {
  it("flags engagement_rate > mean + 2σ; excludes NULL-rate reels from baseline", () => {
    // 20 tight baseline points + one extreme value. With a large baseline the
    // outlier no longer caps itself at mean+2σ the way a tiny sample does.
    const reels: { shortcode: string; engagement_rate: number | null }[] = [];
    for (let i = 0; i < 20; i++) {
      reels.push({ shortcode: `b${i}`, engagement_rate: 0.1 });
    }
    reels.push({ shortcode: "outlier", engagement_rate: 10.0 });
    reels.push({ shortcode: "hidden", engagement_rate: null });

    const flags = computeOutlierFlags(reels);
    expect(flags.get("outlier")).toBe(1);
    expect(flags.get("b0")).toBe(0);
    expect(flags.get("hidden")).toBeNull(); // NULL rate stays NULL, excluded from baseline
  });

  it("returns 0 (not outlier) when baseline too small", () => {
    const flags = computeOutlierFlags([{ shortcode: "only", engagement_rate: 0.5 }]);
    expect(flags.get("only")).toBe(0);
  });
});
