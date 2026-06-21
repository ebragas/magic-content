// Run-registry harness — exercises the in-memory run registry directly (no
// Apify/Gemini, no network: HARD INVARIANT #2). Covers two concerns:
//   1. The per-step state machine (MAIN-962 monitor) — registerRun seeds steps
//      from the action; updateProgress / markSucceeded / markFailed drive them.
//   2. The eviction bound that stops the runs Map from growing one full
//      RunRecord per run forever over a long-lived `next start`.
// The registry is a globalThis singleton, so every test resets it first via
// __resetForTest() (beforeEach) — this also makes the eviction counts deterministic.

import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetForTest,
  getActiveOrLatestRun,
  getRun,
  isRunActive,
  markFailed,
  markRunning,
  markSucceeded,
  registerRun,
  updateProgress,
} from "./registry.js";
import type { PipelineResult } from "../../../../lib/core/types.js";

beforeEach(() => __resetForTest());

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

describe("registerRun initializes steps from the action", () => {
  it("full → three pending steps in scrape→analyze→refresh order", () => {
    const run = registerRun("full", "itsmariahbrunner");
    expect(run.status).toBe("queued");
    expect(run.steps.map((s) => s.stage)).toEqual(["scrape", "analyze", "refresh"]);
    expect(run.steps.every((s) => s.status === "pending" && s.done === 0 && s.total === 0)).toBe(true);
  });

  it("a single-stage action → one step", () => {
    expect(registerRun("scrape", null).steps.map((s) => s.stage)).toEqual(["scrape"]);
    __resetForTest();
    expect(registerRun("analyze", null).steps.map((s) => s.stage)).toEqual(["analyze"]);
    __resetForTest();
    expect(registerRun("refresh", null).steps.map((s) => s.stage)).toEqual(["refresh"]);
  });
});

describe("updateProgress drives the step machine", () => {
  it("marks the reported stage running and earlier stages done", () => {
    const run = registerRun("full", "c");
    markRunning(run.run_id);

    updateProgress(run.run_id, "scrape", 5, 10);
    let r = getActiveOrLatestRun()!;
    expect(r.steps[0]).toMatchObject({ stage: "scrape", status: "running", done: 5, total: 10 });
    expect(r.steps[1].status).toBe("pending");
    expect(r.steps[2].status).toBe("pending");

    // Moving to analyze implies scrape finished — earlier step clamped to done.
    updateProgress(run.run_id, "analyze", 1, 3);
    r = getActiveOrLatestRun()!;
    expect(r.steps[0]).toMatchObject({ stage: "scrape", status: "done", done: 10, total: 10 });
    expect(r.steps[1]).toMatchObject({ stage: "analyze", status: "running", done: 1, total: 3 });
    expect(r.steps[2].status).toBe("pending");

    // Refresh starts → analyze done too.
    updateProgress(run.run_id, "refresh", 0, 6);
    r = getActiveOrLatestRun()!;
    expect(r.steps[1].status).toBe("done");
    expect(r.steps[2]).toMatchObject({ stage: "refresh", status: "running" });
  });

  it("an indeterminate stage (total 0) stays running until a later stage advances", () => {
    const run = registerRun("full", "c");
    updateProgress(run.run_id, "scrape", 0, 0); // Apify fetch in flight, totals unknown
    const r = getActiveOrLatestRun()!;
    expect(r.steps[0]).toMatchObject({ status: "running", done: 0, total: 0 });
  });
});

describe("terminal transitions", () => {
  it("markSucceeded clamps every step to done and clears the active slot", () => {
    const run = registerRun("full", "c");
    updateProgress(run.run_id, "analyze", 2, 5);
    markSucceeded(run.run_id, { action: "full", creator: "c" });
    const r = getActiveOrLatestRun()!;
    expect(r.status).toBe("succeeded");
    expect(r.steps.every((s) => s.status === "done")).toBe(true);
    expect(isRunActive()).toBe(false);
  });

  it("markFailed marks the in-flight step failed, leaving earlier steps done", () => {
    const run = registerRun("full", "c");
    updateProgress(run.run_id, "scrape", 10, 10);
    updateProgress(run.run_id, "analyze", 1, 3);
    markFailed(run.run_id, new Error("gemini boom"));
    const r = getActiveOrLatestRun()!;
    expect(r.status).toBe("failed");
    expect(r.error).toContain("gemini boom");
    expect(r.steps[0].status).toBe("done"); // scrape finished before the failure
    expect(r.steps[1].status).toBe("failed"); // analyze was in flight
    expect(r.steps[2].status).toBe("pending"); // refresh never started
    expect(isRunActive()).toBe(false);
  });
});

describe("concurrency + lookup", () => {
  it("a second registerRun while active throws (one run at a time → 409)", () => {
    registerRun("full", "c");
    expect(() => registerRun("scrape", "c")).toThrow(/already active/);
  });

  it("getActiveOrLatestRun returns the active run, else the most recent", () => {
    expect(getActiveOrLatestRun()).toBeNull();

    const first = registerRun("scrape", "a");
    expect(getActiveOrLatestRun()?.run_id).toBe(first.run_id); // active
    markSucceeded(first.run_id, { action: "scrape", creator: "a" });
    expect(getActiveOrLatestRun()?.run_id).toBe(first.run_id); // latest (none active)

    const second = registerRun("analyze", "a");
    expect(getActiveOrLatestRun()?.run_id).toBe(second.run_id); // now-active wins
  });
});

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
