// refresh-reel — the per-post Refresh leg (MAIN-970 / ADR-0007).
//
// A single-Reel refresh gives a freshly-posted Reel a fair re-evaluation: re-pull its
// engagement metrics + Comments and RE-MINE its FAQs, while leaving the immutable video
// analysis UNTOUCHED (the Video is fixed forever; ADR-0004/0007). It exists precisely
// because FAQ extraction has a MUTABLE input — a post scraped minutes after going live has
// thin, unrepresentative Comments, so its FAQs must be recomputed once real engagement
// arrives (ADR-0007).
//
// What it does, for ONE Reel:
//   1. re-pull cheap engagement metrics (likes/comments/views/shares) via Apify,
//   2. recompute + persist the creator's derived metrics (perf/engagement/viral/outlier),
//   3. re-pull up to N Comments and UPSERT them into the accumulating corpus (MAIN-966),
//   4. re-flag is_trigger across the corpus against the Reel's stored Trigger Keyword (968),
//   5. RE-RUN FAQ extraction over the (now-changed) Comments (969 / ADR-0007).
//
// What it MUST NOT do: download the Video or call Gemini (analysis is immutable). It is a
// single-Reel USER action, so it is NOT bounded by the batch caps (max_analyses_per_run /
// max_faq_extractions_per_run) — those govern the bulk pipeline, not a one-Reel refresh.
//
// External I/O is dependency-injected through the SAME ports the pipeline uses (HARD
// INVARIANT #2): Apify for metrics + Comments, Anthropic for FAQ clustering. The real
// adapters engage only when their env key is set; tests inject fakes and assert on store
// state. With no Apify port, this is a safe no-op; with no Anthropic port, the FAQ leg is a
// safe no-op — exactly the walking-skeleton behavior of the rest of the core.

import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { scrapeAndStoreComments } from "./comments.js";
import { extractFaqsForReel } from "./faqs.js";
import { recomputeAndPersistDerived } from "./metrics.js";
import { resolveAnthropic } from "./analyze.js";
import { resolveApify } from "./scrape.js";
import { monotonicNowIso } from "./store.js";
import type {
  AnthropicPort,
  ApifyPort,
  Deps,
  OnProgress,
  ScrapedReel,
  Store,
} from "./types.js";

export interface RefreshReelArgs {
  /** The shortcode of the single Reel to refresh. */
  shortcode: string;
  store: Store;
  config?: AppConfig;
  deps?: Deps;
  onProgress?: OnProgress;
}

export interface RefreshReelResult {
  shortcode: string;
  /** True when the Reel exists and its metrics were re-pulled + re-written. */
  refreshed: boolean;
  /** Comments scraped this refresh (best-effort; 0 when no scrapeComments port). */
  commentsScraped: number;
  /** Comments upserted into the corpus (accumulating union; ≤ commentsScraped). */
  commentsUpserted: number;
  /** Comments flagged is_trigger after re-flagging against the stored keyword. */
  triggerComments: number;
  /** True when the FAQ leg actually ran the model + (re)wrote FAQs (vs. a no-op). */
  faqExtracted: boolean;
  /** Number of FAQs persisted by the re-mine (0 when none mineable or no port). */
  faqsWritten: number;
}

/**
 * Refresh ONE Reel: re-pull metrics + Comments, re-flag triggers, and re-mine FAQs —
 * leaving the immutable analysis (transcript/topic/category/beats/why/keyword) untouched
 * (ADR-0004/0007). It NEVER downloads the Video or calls Gemini, and is NOT bounded by the
 * batch caps (single-Reel user action).
 *
 * The Apify port carries no single-Reel metric endpoint, so we re-pull the creator's
 * recent Reels (the cheap, uncapped metrics path `refresh` already uses) and pluck THIS
 * Reel's fresh metrics out of that pull. Derived metrics are recomputed across the whole
 * creator baseline because is_outlier is creator-relative (one Reel's drift can shift
 * every other Reel's flag) and engagement_rate/is_viral need the latest follower snapshot.
 *
 * Outcomes:
 *   - Reel not found in the store → refreshed:false, everything zero (route maps to 404).
 *   - No Apify port (no key + no injected port) → safe no-op (refreshed:false).
 *   - Reel found but the pull doesn't carry it (e.g. fell out of window) → metrics are
 *     left as-is, but Comments + FAQ still re-run (the FAQ re-mine is the point of Refresh).
 */
export async function refreshReel(args: RefreshReelArgs): Promise<RefreshReelResult> {
  const { shortcode, store } = args;
  const config = args.config ?? loadConfig();
  args.onProgress?.("refresh", 0, 1);

  const empty: RefreshReelResult = {
    shortcode,
    refreshed: false,
    commentsScraped: 0,
    commentsUpserted: 0,
    triggerComments: 0,
    faqExtracted: false,
    faqsWritten: 0,
  };

  // The Reel must already be tracked — Refresh never (re)creates identity/metadata or
  // downloads media; that's scrape's job. A missing Reel is the route's 404 signal.
  const reel = store.getReel(shortcode);
  if (!reel) return empty;

  // Engage the real Apify adapter from APIFY_TOKEN when no port is injected (same
  // resolution as scrape/refresh); with neither available, refresh is a safe no-op.
  const apify: ApifyPort | undefined = await resolveApify(args.deps);
  if (!apify) return empty;

  const username = reel.creator_username;

  // 1) Re-pull cheap metrics. Apify exposes no single-Reel metric call, so re-pull the
  //    creator's recent Reels (uncapped, no video/Gemini) and find THIS Reel by shortcode.
  const pull = await apify.scrapeCreator({
    username,
    windowDays: config.creators.scrape_window_days,
    resultsLimit: config.settings.results_limit,
  });
  const fresh: ScrapedReel | undefined = pull.reels.find((r) => r.shortcode === shortcode);

  // Monotonic so a refresh that lands in the same millisecond as another write can't
  // collide on creator_stats' UNIQUE(creator_username, captured_at) downstream.
  const nowIso = monotonicNowIso();

  let refreshed = false;
  if (fresh) {
    store.updateReelMetrics({
      shortcode,
      // Apify -1 (hidden) → NULL, never -1.
      likes: fresh.likes != null && fresh.likes >= 0 ? fresh.likes : null,
      comments_count: fresh.comments_count ?? null,
      views: fresh.views ?? null,
      shares: fresh.shares ?? null,
      last_scraped_at: nowIso,
    });
    refreshed = true;
  }

  // 2) Recompute derived metrics across the whole creator baseline (is_outlier is
  //    creator-relative; engagement_rate/is_viral need the latest snapshot). Cheap.
  recomputeAndPersistDerived(store, username);
  args.onProgress?.("refresh", 0, 1);

  // 3) Re-pull up to N Comments and UPSERT into the accumulating corpus (MAIN-966). Reuses
  //    the SAME scrape+upsert helper the analyze leg uses; safe no-op without a
  //    scrapeComments-capable port. This is the mutable input that makes the FAQ re-mine
  //    meaningful (ADR-0007).
  const commentScrape = await scrapeAndStoreComments({
    shortcode,
    url: reel.url,
    limit: config.settings.comments_per_reel,
    store,
    apify,
  });

  // 4) Re-flag is_trigger across the (grown) corpus against the Reel's KNOWN Trigger
  //    Keyword (slice 968) — a non-destructive UPDATE, so it flags Comments scraped this
  //    refresh as well as any from an earlier run. The keyword comes from the immutable
  //    analysis we DON'T re-run; null keyword un-flags all.
  const triggerComments = store.flagTriggerComments(shortcode, reel.trigger_keyword);

  // 5) RE-RUN FAQ extraction over the changed Comments (ADR-0007). This is the heart of
  //    Refresh: a Reel whose comments just grew gets fresh FAQs. We pass a FRESH read of
  //    the Reel so extractFaqsForReel sees the current topic/transcript context, and we
  //    call it directly (NOT through runFaqPass) so it runs UNCONDITIONALLY for this one
  //    Reel — unbounded by max_faq_extractions_per_run (single-Reel user action). It uses
  //    ONLY the Anthropic port, never Gemini/Video, so the immutable analysis is untouched.
  const anthropic: AnthropicPort | undefined = await resolveAnthropic(args.deps, config);
  const reelForFaq = store.getReel(shortcode) ?? reel;
  const faq = await extractFaqsForReel({ reel: reelForFaq, store, config, anthropic });

  args.onProgress?.("refresh", 1, 1);

  return {
    shortcode,
    refreshed,
    commentsScraped: commentScrape.scraped,
    commentsUpserted: commentScrape.upserted,
    triggerComments,
    faqExtracted: faq.ran,
    faqsWritten: faq.faqsWritten,
  };
}
