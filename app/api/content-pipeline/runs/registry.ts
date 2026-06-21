// In-memory run registry for the content-pipeline run API (build-spec.md §run
// contract, MAIN-962). Server-side only — a MODULE-LEVEL singleton living in the
// long-running Node server process (next dev / next start, NOT serverless —
// ADR-0005). The route handler reads/writes this; the pipeline core's onProgress
// updates the active entry.
//
// This is run-tracking INFRASTRUCTURE, not pipeline business logic — it owns no
// scrape/analyze/refresh behavior (ADR-0002 keeps that in lib/core). It just holds
// the status/stage/progress/timestamps a single run reports while it executes.

import type {
  PipelineAction,
  PipelineResult,
  PipelineStage,
} from "../../../../lib/core/types.js";

export type RunStatus = "queued" | "running" | "succeeded" | "failed";

/** A run record as exposed by GET /content-pipeline/runs/{run_id}. */
export interface RunRecord {
  run_id: string;
  action: PipelineAction;
  creator: string | null;
  status: RunStatus;
  stage: PipelineStage | null;
  progress: { done: number; total: number };
  started_at: string; // ISO-8601 UTC
  finished_at: string | null; // ISO-8601 UTC, set on terminal states
  error: string | null;
  /** The full PipelineResult once succeeded — surfaces analyzed/skipped/failed
   *  counts in the dashboard run log. Null until terminal success. */
  result: PipelineResult | null;
}

// Process-global state, anchored on globalThis (NOT a plain module-level const).
// Next.js can give different route segments (POST vs GET here) separate module
// instances, and dev-mode HMR clears module caches — both would split a plain
// `const runs = new Map()` into multiple Maps, so a run registered by POST would
// be invisible to GET (404). globalThis is the single shared object across every
// module instance in the Node process, so the registry stays one source of truth.
interface RegistryState {
  runs: Map<string, RunRecord>;
  activeRunId: string | null;
}
const GLOBAL_KEY = Symbol.for("magic-content.content-pipeline.run-registry");
const globalScope = globalThis as unknown as { [GLOBAL_KEY]?: RegistryState };
const state: RegistryState = (globalScope[GLOBAL_KEY] ??= {
  runs: new Map<string, RunRecord>(),
  activeRunId: null,
});

/** True while a run is queued or running — used by the route to reject a second
 *  POST with 409 (one run at a time is acceptable for v1, build-spec.md). */
export function isRunActive(): boolean {
  if (state.activeRunId == null) return false;
  const active = state.runs.get(state.activeRunId);
  return active != null && (active.status === "queued" || active.status === "running");
}

/** Register a fresh queued run and mark it active. Throws if a run is already
 *  active — callers (the route) must check isRunActive() first to return 409. */
export function registerRun(action: PipelineAction, creator: string | null): RunRecord {
  if (isRunActive()) {
    throw new Error("a run is already active");
  }
  const run_id = newRunId();
  const record: RunRecord = {
    run_id,
    action,
    creator,
    status: "queued",
    stage: null,
    progress: { done: 0, total: 0 },
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    result: null,
  };
  state.runs.set(run_id, record);
  state.activeRunId = run_id;
  return record;
}

export function getRun(run_id: string): RunRecord | undefined {
  return state.runs.get(run_id);
}

/** Move a queued run to running. */
export function markRunning(run_id: string): void {
  const r = state.runs.get(run_id);
  if (r) r.status = "running";
}

/** onProgress sink: map (stage, done, total) straight onto the run record so the
 *  GET endpoint reports live progress (S5 contract). */
export function updateProgress(
  run_id: string,
  stage: PipelineStage,
  done: number,
  total: number,
): void {
  const r = state.runs.get(run_id);
  if (!r) return;
  r.stage = stage;
  r.progress = { done, total };
}

/** Terminal success — record the PipelineResult, clear the active slot. */
export function markSucceeded(run_id: string, result: PipelineResult): void {
  const r = state.runs.get(run_id);
  if (r) {
    r.status = "succeeded";
    r.result = result;
    r.finished_at = new Date().toISOString();
  }
  if (state.activeRunId === run_id) state.activeRunId = null;
}

/** Terminal failure — record the error, clear the active slot. */
export function markFailed(run_id: string, error: unknown): void {
  const r = state.runs.get(run_id);
  if (r) {
    r.status = "failed";
    r.error = error instanceof Error ? error.message : String(error);
    r.finished_at = new Date().toISOString();
  }
  if (state.activeRunId === run_id) state.activeRunId = null;
}

function newRunId(): string {
  // crypto.randomUUID is available in the Node 18+ runtime Next uses.
  return globalThis.crypto?.randomUUID?.() ?? `run_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
