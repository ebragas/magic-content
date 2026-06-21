// content-pipeline run API — collection route (build-spec.md §run contract,
// MAIN-962). URL: /api/content-pipeline/runs.
//
//   POST → validate input, register a run, launch the SHARED pipeline core
//          (ADR-0002 — the exact same lib/core function the CLI calls) as a
//          fire-and-forget async task, return 202 { run_id }. A second POST while
//          a run is active → 409.
//
// ZERO business logic here: the handler validates the body, reserves a registry
// slot, and delegates to pipeline(). All scrape/analyze/refresh behavior stays in
// lib/core (ADR-0002). onProgress is wired straight into the run registry so GET
// can report live progress.
//
// Import pipeline() from the specific module (NOT the lib/core barrel) so the
// Apify/Gemini SDKs stay out of the route's bundle (S5 contract); the real Gemini
// + Video adapters auto-engage inside analyze() when GEMINI_API_KEY is set.

import { pipeline } from "../../../../lib/core/pipeline.js";
import { normalizeUsername } from "../../../../lib/core/username.js";
import type { PipelineAction } from "../../../../lib/core/types.js";
import {
  isRunActive,
  markFailed,
  markRunning,
  markSucceeded,
  registerRun,
  updateProgress,
} from "./registry.js";

// The registry is a module-level singleton in the long-running Node server, so this
// route must run on the Node runtime (not edge/serverless) and never be cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS: readonly PipelineAction[] = ["scrape", "analyze", "refresh", "full"];

function isAction(v: unknown): v is PipelineAction {
  return typeof v === "string" && (ACTIONS as readonly string[]).includes(v);
}

interface RunRequestBody {
  action?: unknown;
  creator?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  let body: RunRequestBody;
  try {
    body = (await request.json()) as RunRequestBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!isAction(body.action)) {
    return Response.json(
      { error: `action must be one of ${ACTIONS.join(", ")}` },
      { status: 400 },
    );
  }
  const action = body.action;

  if (body.creator != null && typeof body.creator !== "string") {
    return Response.json({ error: "creator must be a string" }, { status: 400 });
  }
  // Canonicalize to the store key (normalizeUsername: lowercase + strip a leading
  // '@') so the echoed RunRecord.creator and the GET status payload match the key
  // pipeline/scrape/analyze write under — not the raw '@ItsMariahBrunner' a user
  // typed (#8). Map an empty/'@'-only handle to undefined (let pipeline default it).
  const rawCreator = (body.creator as string | undefined)?.trim();
  const creator = rawCreator ? normalizeUsername(rawCreator) || undefined : undefined;

  // One run at a time (build-spec.md). Reject a concurrent POST with 409. The
  // upfront check is the fast path; registerRun() re-checks and throws, so we wrap
  // it to keep the registry the single source of truth for 409 even under an
  // interleaving between the check and the register (no 500 leaks as a 409).
  if (isRunActive()) {
    return Response.json({ error: "a run is already active" }, { status: 409 });
  }

  let record;
  try {
    record = registerRun(action, creator ?? null);
  } catch {
    return Response.json({ error: "a run is already active" }, { status: 409 });
  }
  const run_id = record.run_id;

  // Fire-and-forget: kick off the shared core and return immediately. The promise
  // is intentionally not awaited; its result/error is recorded into the registry,
  // which GET polls. void-prefixed so no unhandled-rejection escapes.
  void runPipeline(run_id, action, creator);

  return Response.json({ run_id }, { status: 202 });
}

/** Drive the shared pipeline core for a registered run, mirroring its lifecycle
 *  into the registry. Never throws — terminal failure is captured on the record. */
async function runPipeline(
  run_id: string,
  action: PipelineAction,
  creator: string | undefined,
): Promise<void> {
  markRunning(run_id);
  try {
    // deps:{} (empty) lets analyze() auto-engage the real Gemini + Video adapters
    // when GEMINI_API_KEY is set (S5 contract). pipeline() opens/closes
    // data/content.db itself since no store is passed.
    const result = await pipeline({
      action,
      creator,
      onProgress: (stage, done, total) => updateProgress(run_id, stage, done, total),
    });
    markSucceeded(run_id, result);
  } catch (err) {
    markFailed(run_id, err);
  }
}
