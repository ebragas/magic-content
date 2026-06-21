// Unit tests for the run registry's per-step state machine (MAIN-962 monitor).
// Pure in-memory logic — no network, no DB. Vitest's default glob covers app/**,
// so these run under `npm test`. The registry is a globalThis singleton, so each
// test resets it first via __resetForTest().

import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetForTest,
  getActiveOrLatestRun,
  isRunActive,
  markFailed,
  markRunning,
  markSucceeded,
  registerRun,
  updateProgress,
} from "./registry.js";

beforeEach(() => __resetForTest());

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
