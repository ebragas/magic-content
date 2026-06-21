// Derived metrics (docs/schema.md "Derived-metric computation & null rule").
//
// performance_score = likes + 3*comments_count + 0.1*views
// engagement_rate   = performance_score / followers   (creator's LATEST snapshot)
// is_viral          = likes >= 5 * followers           (latest snapshot)
// is_outlier        = engagement_rate > creator mean + 2σ (creator-relative)
//
// NULL RULE:
//   - likes NULL (hidden)      -> performance_score / engagement_rate / is_viral all NULL,
//                                 and the Reel is EXCLUDED from the outlier baseline.
//   - followers NULL or 0      -> engagement_rate / is_viral NULL; performance_score still computed.
//
// Slice 1 implements the per-Reel + outlier math; Slice 2 wires it into scrape/refresh
// via recomputeAndPersistDerived (reads the creator's latest snapshot + all their Reels,
// computes the per-Reel derived fields and the creator-relative outlier flags, then
// persists them through the Store's updateReelMetrics).

import type { Store } from "./types.js";

export interface DerivedMetrics {
  performance_score: number | null;
  engagement_rate: number | null;
  is_viral: number | null; // 0/1
}

export interface RawMetricsInput {
  likes: number | null;
  comments_count: number | null;
  views: number | null;
}

/**
 * Compute performance_score / engagement_rate / is_viral for one Reel against the
 * creator's latest follower count. is_outlier is computed separately (needs the
 * whole creator baseline) — see {@link computeOutlierFlags}.
 */
export function computeDerivedMetrics(
  raw: RawMetricsInput,
  followers: number | null,
): DerivedMetrics {
  // Hidden likes poison every follower/likes-derived metric.
  if (raw.likes == null) {
    return { performance_score: null, engagement_rate: null, is_viral: null };
  }

  const comments = raw.comments_count ?? 0;
  const views = raw.views ?? 0;
  const performance_score = raw.likes + 3 * comments + 0.1 * views;

  // followers missing/zero: performance still computed, but rate/viral are NULL.
  if (followers == null || followers === 0) {
    return { performance_score, engagement_rate: null, is_viral: null };
  }

  const engagement_rate = performance_score / followers;
  const is_viral = raw.likes >= 5 * followers ? 1 : 0;
  return { performance_score, engagement_rate, is_viral };
}

/**
 * Given each Reel's engagement_rate (NULL ones already excluded by the null rule),
 * flag outliers: engagement_rate > mean + 2σ across the creator's own baseline.
 * Returns a map of shortcode -> is_outlier (0/1), with NULL for Reels lacking a rate.
 */
export function computeOutlierFlags(
  reels: { shortcode: string; engagement_rate: number | null }[],
): Map<string, number | null> {
  const result = new Map<string, number | null>();
  const baseline = reels
    .map((r) => r.engagement_rate)
    .filter((v): v is number => v != null);

  // Need at least 2 points for a meaningful std-dev baseline.
  if (baseline.length < 2) {
    for (const r of reels) {
      result.set(r.shortcode, r.engagement_rate == null ? null : 0);
    }
    return result;
  }

  const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  const variance =
    baseline.reduce((a, b) => a + (b - mean) ** 2, 0) / baseline.length;
  const std = Math.sqrt(variance);
  const threshold = mean + 2 * std;

  for (const r of reels) {
    if (r.engagement_rate == null) {
      result.set(r.shortcode, null);
    } else {
      result.set(r.shortcode, r.engagement_rate > threshold ? 1 : 0);
    }
  }
  return result;
}

export interface RecomputeDerivedResult {
  /** Number of Reels whose derived fields were (re)written. */
  reelsRecomputed: number;
  /** Latest follower count used for engagement_rate / is_viral (NULL if no snapshot). */
  followersUsed: number | null;
}

/**
 * Recompute and persist EVERY derived field (performance_score, engagement_rate,
 * is_viral, is_outlier) for all of a creator's Reels, then write them back through
 * the Store. This is the single seam both `scrape` and `refresh` call after the raw
 * metrics + a fresh creator_stats snapshot are in place.
 *
 * Why "all of a creator's Reels" and not just the ones touched this run: is_outlier
 * is creator-relative (mean + 2σ over the creator's own baseline), so adding or
 * updating one Reel can shift every other Reel's outlier flag. engagement_rate and
 * is_viral also depend on the creator's LATEST snapshot, which the run just appended.
 *
 * The null rule (docs/schema.md) is applied throughout: hidden-likes Reels get NULL
 * derived fields and are excluded from the outlier baseline; missing/zero followers
 * yield NULL engagement_rate/is_viral but a computed performance_score.
 */
export function recomputeAndPersistDerived(
  store: Store,
  username: string,
): RecomputeDerivedResult {
  const creator = username.toLowerCase().replace(/^@/, "");
  const followers = store.getLatestStats(creator)?.followers ?? null;
  const reels = store.listReels({ creator });

  // First pass: per-Reel performance / engagement / viral against latest followers.
  const derivedByShortcode = new Map<string, DerivedMetrics>();
  for (const reel of reels) {
    derivedByShortcode.set(
      reel.shortcode,
      computeDerivedMetrics(
        {
          likes: reel.likes,
          comments_count: reel.comments_count,
          views: reel.views,
        },
        followers,
      ),
    );
  }

  // Second pass: creator-relative outlier flags over the engagement-rate baseline.
  const outlierFlags = computeOutlierFlags(
    reels.map((r) => ({
      shortcode: r.shortcode,
      engagement_rate: derivedByShortcode.get(r.shortcode)!.engagement_rate,
    })),
  );

  for (const reel of reels) {
    const d = derivedByShortcode.get(reel.shortcode)!;
    store.updateReelMetrics({
      shortcode: reel.shortcode,
      performance_score: d.performance_score,
      engagement_rate: d.engagement_rate,
      is_viral: d.is_viral,
      is_outlier: outlierFlags.get(reel.shortcode) ?? null,
    });
  }

  return { reelsRecomputed: reels.length, followersUsed: followers };
}
