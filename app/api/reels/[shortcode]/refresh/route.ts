// Per-post Refresh route (MAIN-970 / ADR-0007). URL: /api/reels/{shortcode}/refresh.
//
//   POST → re-pull metrics + Comments and RE-MINE FAQs for ONE Reel, leaving the immutable
//          video analysis untouched (ADR-0004/0007). Routed THROUGH the same in-memory run
//          registry as the batch pipeline so the single-writer lock serializes a per-Reel
//          refresh against batch runs: a concurrent active run → 409. Returns 202 { run_id }
//          and drives the core refresh fire-and-forget, mirroring its lifecycle into the
//          registry so the dashboard can poll GET /content-pipeline/runs/{run_id} for status.
//
// Thin entry point (ADR-0002): validate the shortcode, reserve a registry slot, delegate to
// the shared lib/core refreshReel(). ZERO business logic — the metrics/Comments/FAQ behavior
// lives in lib/core, never here.
//
// Import refreshReel + the Store from the SPECIFIC core modules (NOT the lib/core barrel) so
// the Apify/Gemini SDKs stay out of this route's server bundle (HARD INVARIANT #4); the real
// Apify + Anthropic adapters auto-engage inside refreshReel() when their env key is set.
// runtime "nodejs" + force-dynamic: the registry is a module-level singleton in the
// long-running Node server and the write must never be cached.

import { refreshReel } from "../../../../../lib/core/refresh-reel.js";
import { openStore } from "../../../../../lib/core/store.js";
import {
  isRunActive,
  markFailed,
  markRunning,
  markSucceeded,
  registerRun,
  updateProgress,
} from "../../../content-pipeline/runs/registry.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Instagram shortcodes are URL-safe base64-ish: letters, digits, -, _. Reject anything
 *  else before it can touch the Store / pipeline (path-traversal / injection guard). */
function isSafeShortcode(shortcode: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(shortcode);
}

export async function POST(
  _request: Request,
  ctx: { params: Promise<{ shortcode: string }> },
): Promise<Response> {
  const { shortcode } = await ctx.params;
  if (!isSafeShortcode(shortcode)) {
    return Response.json({ error: "invalid shortcode" }, { status: 400 });
  }

  // One writer at a time (build-spec.md). A per-Reel refresh shares the registry's
  // single-writer lock with batch runs so it can't interleave with a scrape/analyze/refresh
  // mid-flight. The upfront check is the fast path; registerRun() re-checks and throws, so we
  // wrap it to keep the registry the single source of truth for 409 (no 500 leaks as a 409).
  if (isRunActive()) {
    return Response.json({ error: "a run is already active" }, { status: 409 });
  }

  let record;
  try {
    // Model the per-Reel refresh as a `refresh` action so the registry record carries a
    // single `refresh` step the monitor can draw. The creator is unknown until the core
    // reads the Reel, so the record's creator stays null (the refresh targets a shortcode).
    record = registerRun("refresh", null);
  } catch {
    return Response.json({ error: "a run is already active" }, { status: 409 });
  }
  const run_id = record.run_id;

  // Fire-and-forget: kick off the shared core and return immediately. The promise is
  // intentionally not awaited; its result/error is recorded into the registry, which GET
  // polls. void-prefixed so no unhandled-rejection escapes.
  void runRefresh(run_id, shortcode);

  return Response.json({ run_id }, { status: 202 });
}

/** Drive the shared core refreshReel() for a registered run, mirroring its lifecycle into
 *  the registry. Never throws — terminal failure is captured on the record. Owns the Store
 *  handle's lifecycle (opens it for the refresh, always closes it). */
async function runRefresh(run_id: string, shortcode: string): Promise<void> {
  markRunning(run_id);
  const store = openStore();
  try {
    // deps:{} lets refreshReel() auto-engage the real Apify + Anthropic adapters when their
    // env key is set (it never engages Gemini/Video — analysis is immutable).
    const result = await refreshReel({
      shortcode,
      store,
      onProgress: (stage, done, total) => updateProgress(run_id, stage, done, total),
    });
    // Shape a minimal PipelineResult so GET surfaces the refresh in the run log without
    // inventing a new registry schema (it carries the `refresh` action already).
    markSucceeded(run_id, {
      action: "refresh",
      creator: shortcode,
      refresh: {
        creator: shortcode,
        reelsRefreshed: result.refreshed ? 1 : 0,
        statsSnapshotId: null,
      },
    });
  } catch (err) {
    markFailed(run_id, err);
  } finally {
    store.close();
  }
}
