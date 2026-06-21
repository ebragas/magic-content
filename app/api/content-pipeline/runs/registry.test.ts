// Run-registry harness — exercises the in-memory run registry directly (no
// Apify/Gemini, no network: HARD INVARIANT #2). Locks in the eviction bound that
// stops the runs Map from growing one full RunRecord per run forever over a
// long-lived `next start`.

import { describe, expect, it } from "vitest";
import {
  getRun,
  isRunActive,
  markSucceeded,
  registerRun,
} from "./registry.js";
import type { PipelineResult } from "../../../../lib/core/types.js";

// The registry stores the PipelineResult opaquely (it never reads its fields), so
// a minimal valid value suffices.
const RESULT: PipelineResult = { action: "scrape", creator: "test" };

/** Register a run and immediately drive it to terminal success (one-at-a-time
 *  registry contract), returning its id. */
function runOnce(): string {
  const rec = registerRun("scrape", null);
  markSucceeded(rec.run_id, RESULT);
  return rec.run_id;
}

describe("run registry eviction bound", () => {
  it("evicts oldest terminal runs beyond the cap but keeps recent ones readable", () => {
    const ids: string[] = [];
    // 60 sequential runs > the 50-run cap.
    for (let i = 0; i < 60; i++) ids.push(runOnce());

    // The 10 oldest terminal runs were evicted...
    for (const id of ids.slice(0, 10)) {
      expect(getRun(id)).toBeUndefined();
    }
    // ...and the 50 most recent are still readable by GET.
    for (const id of ids.slice(10)) {
      expect(getRun(id)?.status).toBe("succeeded");
    }
    expect(isRunActive()).toBe(false);
  });

  it("never evicts the active (non-terminal) run", () => {
    // Saturate the registry with terminal runs.
    for (let i = 0; i < 60; i++) runOnce();
    // Now open a fresh run and leave it active (queued, not terminal).
    const active = registerRun("scrape", null);
    expect(isRunActive()).toBe(true);
    // It survives further eviction pressure from terminating older runs... but the
    // one-at-a-time contract blocks new runs while it's active, so just confirm it
    // is still present and active.
    expect(getRun(active.run_id)?.status).toBe("queued");
    // Clean up so the global singleton is left quiescent for other suites.
    markSucceeded(active.run_id, RESULT);
    expect(isRunActive()).toBe(false);
  });
});
