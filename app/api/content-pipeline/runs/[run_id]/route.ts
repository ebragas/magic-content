// content-pipeline run API — status route (build-spec.md §run contract, MAIN-962).
// URL: /api/content-pipeline/runs/{run_id}.
//
//   GET → { status, stage, progress: { done, total }, started_at, finished_at,
//           error? } for the given run, read from the module-level registry. The
//           dashboard polls this (~1–2s) to drive its progress bar.
//
// No business logic — a pure read of the in-memory run record (ADR-0002 keeps
// pipeline behavior in lib/core). Unknown run_id → 404.

import { getRun } from "../registry.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ run_id: string }> },
): Promise<Response> {
  const { run_id } = await ctx.params;
  const run = getRun(run_id);

  if (!run) {
    return Response.json({ error: "run not found" }, { status: 404 });
  }

  // Shape the response exactly per the contract: omit error unless present, and
  // surface the result summary (analyzed/skipped/failed counts) for the run log.
  const payload: Record<string, unknown> = {
    run_id: run.run_id,
    action: run.action,
    creator: run.creator,
    status: run.status,
    stage: run.stage,
    progress: run.progress,
    started_at: run.started_at,
    finished_at: run.finished_at,
  };
  if (run.error) payload.error = run.error;
  if (run.result) payload.result = run.result;

  return Response.json(payload, { status: 200 });
}
