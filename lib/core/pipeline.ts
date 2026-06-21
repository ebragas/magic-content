// pipeline — the shared core (ADR-0002). The CLI, the skill (over the CLI), and
// the dashboard route handler all import THESE functions. Free of CLI/HTTP
// concerns: no process.argv, no Request/Response.

import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { openStore, monotonicNowIso } from "./store.js";
import { analyze } from "./analyze.js";
import { recomputeAndPersistDerived } from "./metrics.js";
import { resolveApify, scrape } from "./scrape.js";
import type {
  Deps,
  OnProgress,
  PipelineAction,
  PipelineResult,
  RefreshResultSummary,
  Store,
} from "./types.js";

export interface RefreshArgs {
  creator: string;
  store: Store;
  config?: AppConfig;
  deps?: Deps;
  onProgress?: OnProgress;
}

/**
 * refresh — re-pull cheap reel metrics + append a creator_stats snapshot, then
 * recompute derived fields. No video, no Gemini; uncapped (build-spec.md).
 *
 * Analysis columns are untouched (ADR-0004): we only re-scrape drifting metrics
 * (likes / comments / views / shares) + a fresh follower snapshot, then recompute
 * the derived fields against that snapshot. The Apify port is injected; with none
 * available this is a safe no-op that just ensures the creator row exists.
 */
export async function refresh(args: RefreshArgs): Promise<RefreshResultSummary> {
  const { creator, store } = args;
  const config = args.config ?? loadConfig();
  const username = creator.toLowerCase().replace(/^@/, "");
  args.onProgress?.("refresh", 0, 0);

  // Engage the real Apify adapter from APIFY_TOKEN when no port is injected (same
  // resolution as scrape); with neither available, refresh is a safe no-op.
  const apify = await resolveApify(args.deps);
  if (!apify) {
    store.upsertCreator({ username });
    return { creator: username, reelsRefreshed: 0, statsSnapshotId: null };
  }

  // Re-pull metrics (uncapped per build-spec.md — it's cheap, no video/Gemini).
  const result = await apify.scrapeCreator({
    username,
    windowDays: config.creators.scrape_window_days,
    resultsLimit: config.settings.results_limit,
  });

  // Monotonic so a back-to-back scrape+refresh in one `full` run can't collide on
  // creator_stats' UNIQUE(creator_username, captured_at).
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

  let refreshed = 0;
  const total = result.reels.length;
  for (const reel of result.reels) {
    // Only refresh metrics for Reels we already track — refresh never (re)creates
    // identity/metadata or downloads media; that's scrape's job.
    if (!store.getReel(reel.shortcode)) {
      args.onProgress?.("refresh", refreshed, total);
      continue;
    }
    store.updateReelMetrics({
      shortcode: reel.shortcode,
      // Apify -1 (hidden) → NULL, never -1.
      likes: reel.likes != null && reel.likes >= 0 ? reel.likes : null,
      comments_count: reel.comments_count ?? null,
      views: reel.views ?? null,
      shares: reel.shares ?? null,
      last_scraped_at: nowIso,
    });
    refreshed += 1;
    args.onProgress?.("refresh", refreshed, total);
  }

  // Recompute derived metrics across the whole baseline against the fresh snapshot.
  recomputeAndPersistDerived(store, username);

  return { creator: username, reelsRefreshed: refreshed, statsSnapshotId: snapshot.id };
}

export interface PipelineArgs {
  action: PipelineAction;
  creator?: string;
  /** Injectable store; defaults to the real Content Store at data/content.db. */
  store?: Store;
  config?: AppConfig;
  deps?: Deps;
  onProgress?: OnProgress;
}

/**
 * Dispatch a pipeline action. `full` runs scrape -> analyze -> refresh in order.
 * Owns store lifecycle ONLY when it opened the store itself (callers passing a
 * store are responsible for closing it).
 */
export async function pipeline(args: PipelineArgs): Promise<PipelineResult> {
  const config = args.config ?? loadConfig();
  const creator =
    (args.creator ?? config.creators.creators[0]?.username ?? "")
      .toLowerCase()
      .replace(/^@/, "");
  if (!creator) {
    throw new Error("pipeline: no creator specified and none found in config");
  }

  const ownsStore = args.store == null;
  const store = args.store ?? openStore();
  const common = { creator, store, config, deps: args.deps, onProgress: args.onProgress };

  try {
    const result: PipelineResult = { action: args.action, creator };
    switch (args.action) {
      case "scrape":
        result.scrape = await scrape(common);
        break;
      case "analyze":
        result.analyze = await analyze(common);
        break;
      case "refresh":
        result.refresh = await refresh(common);
        break;
      case "full":
        result.scrape = await scrape(common);
        result.analyze = await analyze(common);
        result.refresh = await refresh(common);
        break;
      default: {
        const _exhaustive: never = args.action;
        throw new Error(`pipeline: unknown action ${String(_exhaustive)}`);
      }
    }
    return result;
  } finally {
    if (ownsStore) store.close();
  }
}
