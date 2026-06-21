// scrape — pull a creator's recent Reels + profile via Apify, upsert into the
// Content Store, append a creator_stats snapshot, upsert each Reel's metadata +
// metrics + capped top_comments + a saved thumbnail, then recompute the derived
// metrics (performance / engagement / virality / outlier) per the null rule.
//
// External I/O is dependency-injected through the Apify + Video ports (HARD
// INVARIANT #2): tests fake ONLY those ports and assert on the resulting Content
// Store state. When no Apify port is injected, the real adapter is engaged lazily
// from APIFY_TOKEN (see resolveApify, mirroring analyze's GEMINI_API_KEY path); if
// neither is available, scrape is a safe no-op that only ensures the creator row
// exists, so the walking-skeleton pipeline still writes the store with no network.

import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { rememberVideoUrl, resetVideoUrlCache } from "./analyze.js";
import { recomputeAndPersistDerived } from "./metrics.js";
import { monotonicNowIso } from "./store.js";
import type {
  ApifyPort,
  Deps,
  OnProgress,
  ScrapedReel,
  ScrapeResult,
  ScrapeResultSummary,
  Store,
  VideoPort,
} from "./types.js";

export interface ScrapeArgs {
  creator: string;
  store: Store;
  config?: AppConfig;
  deps?: Deps;
  onProgress?: OnProgress;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Normalize Apify's hidden-likes sentinel (-1) to NULL; never store -1. */
function normalizeLikes(likes: number | null | undefined): number | null {
  return likes != null && likes >= 0 ? likes : null;
}

/**
 * Lazily build the real Apify adapter when the caller didn't inject one and
 * APIFY_TOKEN is set (mirrors analyze's GEMINI_API_KEY resolution). Imported
 * dynamically so the SDK is NEVER pulled in by tests, which always inject a fake.
 * Returns undefined when there's no port and no token → scrape falls back to the
 * safe no-op (walking skeleton).
 */
export async function resolveApify(deps: Deps | undefined): Promise<ApifyPort | undefined> {
  if (deps?.apify) return deps.apify;
  if (process.env.APIFY_TOKEN) {
    const { makeApifyPort } = await import("./adapters/apify.js");
    return makeApifyPort();
  }
  return undefined;
}

interface WindowCapResult {
  kept: ScrapedReel[];
  /** Total Reels the actor returned. */
  returned: number;
  /** Dropped because they fell outside the day window. */
  droppedOutOfWindow: number;
  /** Dropped because the result cap was hit. */
  droppedOverCap: number;
}

/**
 * Keep only Reels posted within the day window, sort NEWEST-FIRST, and cap to
 * `resultsLimit`. The Apify port is asked to honor both already, but we enforce
 * them again defensively — the actor occasionally returns posts just outside the
 * window or slightly over the cap, and not always in recency order. Sorting before
 * the cap guarantees the cap deterministically retains the most recent Reels
 * (build-spec.md frames both as keeping recent content). Reels with no `posted_at`
 * are kept (we can't prove they're stale) and sort last but still count against
 * the cap. Drop counts are returned so the run can log them (no silent truncation).
 */
function windowAndCap(
  reels: ScrapedReel[],
  windowDays: number,
  resultsLimit: number,
  now: number,
): WindowCapResult {
  const cutoff = now - windowDays * DAY_MS;
  const inWindow = reels.filter((r) => {
    if (!r.posted_at) return true;
    const t = Date.parse(r.posted_at);
    return Number.isNaN(t) ? true : t >= cutoff;
  });
  const ts = (r: ScrapedReel): number => {
    if (!r.posted_at) return -Infinity; // NULLs sort last under DESC
    const t = Date.parse(r.posted_at);
    return Number.isNaN(t) ? -Infinity : t;
  };
  const sorted = [...inWindow].sort((a, b) => ts(b) - ts(a)); // newest-first
  const kept = sorted.slice(0, resultsLimit);
  return {
    kept,
    returned: reels.length,
    droppedOutOfWindow: reels.length - inWindow.length,
    droppedOverCap: Math.max(0, sorted.length - kept.length),
  };
}

/**
 * Scrape a creator's last-`scrape_window_days` Reels (capped at `results_limit`),
 * upsert them, append a creator_stats snapshot, and recompute derived metrics.
 *
 * STUB path: when no Apify port is injected, performs no network call — it only
 * ensures the creator row exists so downstream slices have a stable seam to extend.
 */
export async function scrape(args: ScrapeArgs): Promise<ScrapeResultSummary> {
  const { creator, store } = args;
  const config = args.config ?? loadConfig();
  const username = creator.toLowerCase().replace(/^@/, "");

  const injectedApify = args.deps?.apify;
  const apify = await resolveApify(args.deps);
  args.onProgress?.("scrape", 0, 0);

  if (!apify) {
    // No port and no APIFY_TOKEN: safe no-op. Ensure the creator exists, write
    // nothing external (walking skeleton / unconfigured environment).
    store.upsertCreator({ username });
    args.onProgress?.("scrape", 0, 0);
    return {
      creator: username,
      reelsScraped: 0,
      reelsUpserted: 0,
      statsSnapshotId: null,
      reelsReturned: 0,
      droppedOutOfWindow: 0,
      droppedOverCap: 0,
    };
  }

  // Resolve the Video port (thumbnails). Only engage the REAL Video port when the
  // REAL Apify adapter was resolved from APIFY_TOKEN — i.e. NOT when the caller
  // injected a fake apify (tests inject apify without video and must stay
  // network-free). An injected fake apify keeps video as whatever was injected
  // (often undefined → thumbnails skipped), preserving prior test behavior.
  let video: VideoPort | undefined = args.deps?.video;
  if (!video && !injectedApify) {
    const { makeVideoPort } = await import("./adapters/video.js");
    video = makeVideoPort();
  }

  // The transient CDN videoUrl is NOT durable (docs/schema.md), so analyze depends
  // on a current scrape carrying it in-process. Reset the in-run cache so a fresh
  // scrape never serves a stale URL, then stash each Reel's videoUrl below for the
  // same-process `full` run's analyze leg (build-spec.md: re-analysis ⇒ re-scrape).
  resetVideoUrlCache();

  const windowDays = config.creators.scrape_window_days;
  const resultsLimit = config.settings.results_limit;
  const now = Date.now();

  // --- Pull (with a single undercount retry) ---
  // apify/instagram-scraper occasionally returns fewer items than requested due to
  // pagination/CDN flakiness. If the first pull comes back short of the cap AND the
  // profile says there are more posts than we got, retry once with a bumped limit
  // and keep whichever pull yielded more Reels. Best-effort, never throws.
  let result: ScrapeResult = await apify.scrapeCreator({
    username,
    windowDays,
    resultsLimit,
  });

  const postsCount = result.profile.posts_count ?? null;
  const undercounted =
    result.reels.length < resultsLimit &&
    postsCount != null &&
    result.reels.length < postsCount;
  if (undercounted) {
    try {
      const retry = await apify.scrapeCreator({
        username,
        windowDays,
        resultsLimit: resultsLimit * 2,
      });
      if (retry.reels.length > result.reels.length) {
        result = retry;
      }
    } catch {
      // Retry is opportunistic; ignore failures and keep the first pull.
    }
  }

  // Monotonic so a back-to-back scrape+refresh in one `full` run can't collide on
  // creator_stats' UNIQUE(creator_username, captured_at). Window/cap still uses the
  // raw wall-clock `now` above.
  const nowIso = monotonicNowIso();
  store.upsertCreator({
    username,
    full_name: result.profile.full_name ?? null,
    biography: result.profile.biography ?? null,
    is_verified: result.profile.is_verified ?? null,
    last_scraped_at: nowIso,
  });
  const snapshot = store.appendCreatorStats({
    creator_username: username,
    captured_at: nowIso,
    followers: result.profile.followers ?? null,
    following: result.profile.following ?? null,
    posts_count: result.profile.posts_count ?? null,
  });

  const wc = windowAndCap(result.reels, windowDays, resultsLimit, now);
  const reels = wc.kept;

  let upserted = 0;
  const total = reels.length;
  for (const reel of reels) {
    // Save the thumbnail — the ONLY media we keep (docs/schema.md). Best-effort:
    // a thumbnail download failure must not abort the whole scrape run.
    let thumbnailPath: string | null = null;
    if (video && reel.thumbnail_url) {
      try {
        thumbnailPath = await video.downloadThumbnail({
          url: reel.thumbnail_url,
          shortcode: reel.shortcode,
        });
      } catch {
        thumbnailPath = null;
      }
    }

    store.upsertReel({
      shortcode: reel.shortcode,
      url: reel.url,
      creator_username: username,
      caption: reel.caption ?? null,
      posted_at: reel.posted_at ?? null,
      duration_sec: reel.duration_sec ?? null,
      thumbnail_path: thumbnailPath,
      top_comments: reel.top_comments ?? null,
    });
    store.updateReelMetrics({
      shortcode: reel.shortcode,
      likes: normalizeLikes(reel.likes), // Apify -1 (hidden) → NULL, never -1
      comments_count: reel.comments_count ?? null,
      views: reel.views ?? null,
      shares: reel.shares ?? null, // best-effort, usually NULL; saves are NOT modeled
      last_scraped_at: nowIso,
    });
    // Stash the transient (expiring) CDN video URL for analyze in this same run.
    rememberVideoUrl(reel.shortcode, reel.video_url);
    upserted += 1;
    args.onProgress?.("scrape", upserted, total);
  }

  // Recompute derived metrics across the WHOLE creator baseline against the fresh
  // snapshot (engagement_rate / is_viral need latest followers; is_outlier is
  // creator-relative). Null rule applied inside.
  recomputeAndPersistDerived(store, username);

  return {
    creator: username,
    reelsScraped: total,
    reelsUpserted: upserted,
    statsSnapshotId: snapshot.id,
    reelsReturned: wc.returned,
    droppedOutOfWindow: wc.droppedOutOfWindow,
    droppedOverCap: wc.droppedOverCap,
  };
}
