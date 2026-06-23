// comments — the dedicated, accumulating Comment corpus leg (MAIN-966 / ADR-0007).
//
// Unlike the immutable video analysis (ADR-0004), Comments are a MUTABLE input that
// accumulates over time: a Reel scraped minutes after going live has thin comments,
// so the corpus must grow as real engagement arrives. This module owns the small,
// reusable core operation — "scrape up to N Comments for a Reel and UPSERT them into
// the corpus by comment_id" — so the analyze leg (and the refresh / FAQ slices that
// follow) can share ONE accumulation path that's directly testable against a real
// in-memory store (HARD INVARIANT #2).
//
// The Apify comment scrape is OPTIONAL on the port (ScrapedComment via
// ApifyPort.scrapeComments). When the port doesn't implement it (test fakes that
// only provide scrapeCreator, or a walking-skeleton environment), this is a SAFE
// NO-OP that writes nothing — mirroring the rest of the pipeline's no-key behavior.

import type { ApifyPort, ScrapedComment, Store } from "./types.js";

export interface ScrapeAndStoreCommentsArgs {
  /** The Reel whose Comments to scrape (its canonical instagram.com URL is passed through). */
  shortcode: string;
  url: string;
  /** Per-Reel cap (settings.comments_per_reel). */
  limit: number;
  store: Store;
  /** Resolved Apify port; when it lacks scrapeComments, the call is a no-op. */
  apify: ApifyPort | undefined;
}

export interface ScrapeAndStoreCommentsResult {
  /** Comments the scrape returned for this Reel. */
  scraped: number;
  /** Rows written to the corpus (accumulating union; ≤ scraped). */
  upserted: number;
}

/**
 * Scrape up to `limit` Comments for one Reel and UPSERT them into the `comments`
 * corpus BY comment_id, so repeated calls ACCUMULATE the union (existing Comments
 * are never lost; see Store.upsertComments). Returns the scraped + upserted counts.
 *
 * Safe no-op (returns zeros) when no Apify port is available or the port doesn't
 * implement scrapeComments. Best-effort: a scrape error is swallowed so a single
 * Reel's comment fetch can never abort the surrounding analyze run — the corpus is
 * additive and the Reel's analysis has already succeeded by the time we get here.
 */
export async function scrapeAndStoreComments(
  args: ScrapeAndStoreCommentsArgs,
): Promise<ScrapeAndStoreCommentsResult> {
  const { shortcode, url, limit, store, apify } = args;
  if (!apify?.scrapeComments) return { scraped: 0, upserted: 0 };

  let comments: ScrapedComment[];
  try {
    comments = await apify.scrapeComments({ shortcode, url, limit });
  } catch {
    // Comment scraping is additive and best-effort; never fail the run on it.
    return { scraped: 0, upserted: 0 };
  }
  if (!Array.isArray(comments) || comments.length === 0) {
    return { scraped: 0, upserted: 0 };
  }

  const upserted = store.upsertComments(shortcode, comments);
  return { scraped: comments.length, upserted };
}
