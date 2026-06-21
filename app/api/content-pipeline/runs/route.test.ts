// Run-route harness — exercises the POST collection handler directly (no
// Apify/Gemini, no network: HARD INVARIANT #2). The fire-and-forget pipeline()
// call is mocked to a no-op so the route never opens a real store or hits an
// adapter; the assertions are purely on the registered run identity.
//
// Locks in #8: the POST route must canonicalize body.creator with the SAME
// normalizeUsername() the store keys under, so the echoed RunRecord.creator (and
// the GET status payload, which mirrors it) matches the canonical store key —
// '@ItsMariahBrunner' must register as 'itsmariahbrunner', never the raw handle.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineArgs } from "../../../../lib/core/pipeline.js";
import type { PipelineResult } from "../../../../lib/core/types.js";

// Mock the pipeline core BEFORE importing the route so the route binds the stub.
// This keeps the fire-and-forget runPipeline() from opening data/content.db or
// engaging any adapter — the test only cares about the registered run identity.
// vi.hoisted so the mock fn exists when the hoisted vi.mock factory references it.
const { pipelineMock } = vi.hoisted(() => {
  // Typed so .mock.calls[0][0] is PipelineArgs (lets us assert the creator passed).
  const fn = (_args: PipelineArgs): Promise<PipelineResult> =>
    Promise.resolve({ action: "scrape", creator: "" });
  return { pipelineMock: vi.fn(fn) };
});
vi.mock("../../../../lib/core/pipeline.js", () => ({ pipeline: pipelineMock }));

import { POST } from "./route.js";
import { getRun, isRunActive, markSucceeded } from "./registry.js";

function postRun(body: unknown): Promise<Response> {
  return POST(new Request("http://localhost/api/content-pipeline/runs", {
    method: "POST",
    body: JSON.stringify(body),
  }));
}

afterEach(() => {
  pipelineMock.mockClear();
});

describe("POST /content-pipeline/runs creator canonicalization (#8)", () => {
  it("normalizes the echoed run creator to the canonical store key", async () => {
    const res = await postRun({ action: "scrape", creator: "@ItsMariahBrunner" });
    expect(res.status).toBe(202);
    const { run_id } = (await res.json()) as { run_id: string };

    // The registered record (which GET echoes verbatim) must carry the canonical
    // key, not the raw '@ItsMariahBrunner' the user typed.
    expect(getRun(run_id)?.creator).toBe("itsmariahbrunner");

    // The pipeline core is driven with the same canonical creator so the run
    // identity and the store key can't diverge.
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    expect(pipelineMock.mock.calls[0][0]).toMatchObject({ creator: "itsmariahbrunner" });

    // Release the one-at-a-time slot for sibling suites sharing the singleton.
    markSucceeded(run_id, { action: "scrape", creator: "itsmariahbrunner" });
    expect(isRunActive()).toBe(false);
  });

  it("maps an empty / '@'-only creator to undefined (let pipeline default it)", async () => {
    const res = await postRun({ action: "full", creator: "  @  " });
    expect(res.status).toBe(202);
    const { run_id } = (await res.json()) as { run_id: string };

    expect(getRun(run_id)?.creator).toBeNull();
    expect(pipelineMock.mock.calls[0][0]).toMatchObject({ creator: undefined });

    markSucceeded(run_id, { action: "full", creator: "" });
    expect(isRunActive()).toBe(false);
  });
});
