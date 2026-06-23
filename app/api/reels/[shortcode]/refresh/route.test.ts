// Per-post Refresh route harness (MAIN-970) — exercises the POST handler directly. Mirrors
// app/api/content-pipeline/runs/route.test.ts: no Apify/Gemini/Anthropic, no network. The
// fire-and-forget refreshReel() core call is mocked to a no-op so the route never opens a real
// store or hits an adapter, and openStore is mocked so the route's Store handle is inert. The
// assertions are purely on status codes + the registry's single-writer lock (the 409 contract).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { RefreshReelArgs, RefreshReelResult } from "../../../../../lib/core/refresh-reel.js";

// Mock the core + the Store BEFORE importing the route so the route binds the stubs. This keeps
// the fire-and-forget runRefresh() from opening data/content.db or engaging any adapter — the
// test only cares about the route's status codes + the 409 single-writer guard. vi.hoisted so the
// mocks exist when the hoisted vi.mock factories reference them.
const { refreshReelMock, openStoreMock } = vi.hoisted(() => {
  const refreshReel = vi.fn(
    (_args: RefreshReelArgs): Promise<RefreshReelResult> =>
      Promise.resolve({
        shortcode: "AAA",
        refreshed: true,
        commentsScraped: 0,
        commentsUpserted: 0,
        triggerComments: 0,
        faqExtracted: false,
        faqsWritten: 0,
      }),
  );
  return { refreshReelMock: refreshReel, openStoreMock: vi.fn(() => ({ close: vi.fn() })) };
});
vi.mock("../../../../../lib/core/refresh-reel.js", () => ({ refreshReel: refreshReelMock }));
vi.mock("../../../../../lib/core/store.js", () => ({ openStore: openStoreMock }));

import { POST } from "./route.js";
import {
  __resetForTest,
  isRunActive,
  markSucceeded,
  registerRun,
} from "../../../content-pipeline/runs/registry.js";

function postRefresh(shortcode: string): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/reels/${shortcode}/refresh`, { method: "POST" }),
    { params: Promise.resolve({ shortcode }) },
  );
}

afterEach(() => {
  refreshReelMock.mockClear();
  openStoreMock.mockClear();
  // Clear the shared registry singleton so each test starts from an empty run state.
  __resetForTest();
});

describe("POST /api/reels/{shortcode}/refresh", () => {
  it("registers a run and returns 202 { run_id }, driving the core refresh for the shortcode", async () => {
    const res = await postRefresh("ABC123");
    expect(res.status).toBe(202);
    const { run_id } = (await res.json()) as { run_id: string };
    expect(run_id).toBeTruthy();

    // The fire-and-forget core call targets the requested shortcode.
    expect(refreshReelMock).toHaveBeenCalledTimes(1);
    expect(refreshReelMock.mock.calls[0][0]).toMatchObject({ shortcode: "ABC123" });

    // Let the fire-and-forget promise settle so the run reaches a terminal state and releases
    // the single-writer slot (otherwise it leaks active into the next test).
    await Promise.resolve();
    await Promise.resolve();
  });

  it("returns 409 when a run is already active (registry single-writer lock)", async () => {
    // Reserve the single-writer slot with an unrelated batch run.
    const active = registerRun("full", "itsmariahbrunner");
    expect(isRunActive()).toBe(true);

    // A per-Reel refresh must be rejected with 409 while that run is active — it shares the
    // SAME registry lock as the batch pipeline (the route never starts the core).
    const res = await postRefresh("ABC123");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "a run is already active" });
    // The core was never invoked — the route bailed at the lock.
    expect(refreshReelMock).not.toHaveBeenCalled();

    // Release the slot for sibling suites sharing the singleton.
    markSucceeded(active.run_id, { action: "full", creator: "itsmariahbrunner" });
    expect(isRunActive()).toBe(false);
  });

  it("400s an unsafe shortcode before reserving a run slot", async () => {
    const res = await postRefresh("../etc/passwd");
    expect(res.status).toBe(400);
    expect(refreshReelMock).not.toHaveBeenCalled();
    expect(isRunActive()).toBe(false);
  });
});
