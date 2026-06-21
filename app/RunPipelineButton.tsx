"use client";

// "Run pipeline" client island (MAIN-962). The ONLY client-side JS on the
// dashboard — the table stays server-rendered (Slice 3). It:
//   1. lets the user pick an action (scrape / analyze / refresh / full),
//   2. POSTs /api/content-pipeline/runs to launch the SHARED pipeline core,
//   3. polls GET /api/content-pipeline/runs/{run_id} (~1.5s) to drive a progress
//      bar from the run registry's live {stage, done, total},
//   4. on completion calls router.refresh() to re-render the server table against
//      the now-updated Content Store.
//
// Carries no pipeline logic — it only talks to the run API (ADR-0002).

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Action = "scrape" | "analyze" | "refresh" | "full";
type RunStatus = "queued" | "running" | "succeeded" | "failed";

const ACTIONS: { value: Action; label: string }[] = [
  { value: "full", label: "Full (scrape + analyze + refresh)" },
  { value: "scrape", label: "Scrape" },
  { value: "analyze", label: "Analyze" },
  { value: "refresh", label: "Refresh" },
];

const POLL_INTERVAL_MS = 1500;
// A single transient poll failure (network blip, dev-server reload) must NOT end
// the run — the server pipeline keeps going and the run stays active. Tolerate up
// to this many CONSECUTIVE failures, surfacing a soft "retrying" notice, before
// giving up on the UI side.
const MAX_POLL_FAILURES = 5;

interface RunStatusResponse {
  status: RunStatus;
  stage: "scrape" | "analyze" | "refresh" | null;
  progress: { done: number; total: number };
  error?: string;
  result?: {
    analyze?: { analyzed: number; skipped: number; failed: number; remainingOverCap: number };
    scrape?: { reelsScraped: number; reelsUpserted: number };
    refresh?: { reelsRefreshed: number };
  };
}

export function RunPipelineButton({ defaultCreator }: { defaultCreator?: string }) {
  const router = useRouter();
  const [action, setAction] = useState<Action>("full");
  const [creator, setCreator] = useState(defaultCreator ?? "");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Track the active poll timer so we can stop it on unmount / completion.
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Count consecutive poll failures so a single transient blip doesn't abort.
  const pollFailures = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const poll = useCallback(
    async (runId: string) => {
      try {
        const res = await fetch(`/api/content-pipeline/runs/${runId}`, { cache: "no-store" });
        // A 404 means the registry no longer knows this run — a definitive end
        // state, not a transient blip — so stop rather than retry forever.
        if (res.status === 404) {
          stopPolling();
          pollFailures.current = 0;
          setRunning(false);
          setError("run not found");
          return;
        }
        if (!res.ok) {
          throw new Error(`status check failed (${res.status})`);
        }
        const data = (await res.json()) as RunStatusResponse;
        // Got a real status — clear any transient-failure state.
        pollFailures.current = 0;
        setError(null);
        setStatus(data.status);
        setStage(data.stage);
        setProgress(data.progress ?? { done: 0, total: 0 });

        if (data.status === "succeeded" || data.status === "failed") {
          stopPolling();
          setRunning(false);
          if (data.status === "failed") {
            setError(data.error ?? "run failed");
          } else {
            setMessage(summarize(data));
            // Re-render the server-rendered table against the updated store.
            router.refresh();
          }
          return;
        }
        // Still running — schedule the next poll.
        pollTimer.current = setTimeout(() => void poll(runId), POLL_INTERVAL_MS);
      } catch (err) {
        // Transient failure (network blip / dev-server reload). The server
        // pipeline is still running, so keep polling instead of aborting the run.
        pollFailures.current += 1;
        if (pollFailures.current >= MAX_POLL_FAILURES) {
          stopPolling();
          pollFailures.current = 0;
          setRunning(false);
          setError(err instanceof Error ? err.message : String(err));
          return;
        }
        // Soft notice — we're still trying. Don't clear status/progress.
        setError("lost connection, retrying…");
        pollTimer.current = setTimeout(() => void poll(runId), POLL_INTERVAL_MS);
      }
    },
    [router, stopPolling],
  );

  const start = useCallback(async () => {
    setError(null);
    setMessage(null);
    setStatus(null);
    setStage(null);
    setProgress({ done: 0, total: 0 });
    pollFailures.current = 0;
    setRunning(true);
    try {
      const res = await fetch("/api/content-pipeline/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, creator: creator.trim() || undefined }),
      });
      if (res.status === 409) {
        setRunning(false);
        setError("a run is already active — wait for it to finish");
        return;
      }
      if (!res.ok) {
        const detail = await safeError(res);
        setRunning(false);
        setError(detail ?? `failed to start run (${res.status})`);
        return;
      }
      const { run_id } = (await res.json()) as { run_id: string };
      setStatus("queued");
      pollTimer.current = setTimeout(() => void poll(run_id), POLL_INTERVAL_MS);
    } catch (err) {
      setRunning(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [action, creator, poll]);

  const pct =
    progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;

  return (
    <div style={styles.wrap}>
      <div style={styles.row}>
        <select
          aria-label="pipeline action"
          value={action}
          onChange={(e) => setAction(e.target.value as Action)}
          disabled={running}
          style={styles.select}
        >
          {ACTIONS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        <input
          aria-label="creator"
          type="text"
          placeholder="creator (optional)"
          value={creator}
          onChange={(e) => setCreator(e.target.value)}
          disabled={running}
          style={styles.input}
        />
        <button type="button" onClick={() => void start()} disabled={running} style={running ? styles.buttonDisabled : styles.button}>
          {running ? "Running…" : "Run pipeline"}
        </button>
      </div>

      {running || status ? (
        <div style={styles.progressWrap} aria-live="polite">
          <div style={styles.progressMeta}>
            <span>
              {status === "queued" ? "queued" : stage ? `${stage}` : status ?? ""}
            </span>
            <span>
              {progress.total > 0 ? `${progress.done}/${progress.total} (${pct}%)` : ""}
            </span>
          </div>
          <div style={styles.progressTrack} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ ...styles.progressBar, width: `${pct}%` }} />
          </div>
        </div>
      ) : null}

      {message ? <div style={styles.success}>{message}</div> : null}
      {error ? <div style={styles.error}>{error}</div> : null}
    </div>
  );
}

/** Build a human run-log line from the terminal result (no silent truncation —
 *  surface analyzed/skipped/failed/cap counts, build-spec.md). */
function summarize(data: RunStatusResponse): string {
  const parts: string[] = ["Run complete."];
  const r = data.result;
  if (r?.scrape) parts.push(`scraped ${r.scrape.reelsScraped} (${r.scrape.reelsUpserted} upserted)`);
  if (r?.analyze) {
    parts.push(
      `analyzed ${r.analyze.analyzed}, skipped ${r.analyze.skipped}, failed ${r.analyze.failed}` +
        (r.analyze.remainingOverCap > 0 ? `, ${r.analyze.remainingOverCap} left over cap` : ""),
    );
  }
  if (r?.refresh) parts.push(`refreshed ${r.refresh.reelsRefreshed}`);
  return parts.join(" · ");
}

async function safeError(res: Response): Promise<string | null> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error ?? null;
  } catch {
    return null;
  }
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: "flex", flexDirection: "column", gap: "0.5rem", minWidth: 320 },
  row: { display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" },
  select: { padding: "0.35rem 0.5rem", borderRadius: 6, border: "1px solid #ddd", background: "#fff", fontSize: "0.85rem", color: "#333" },
  input: { padding: "0.35rem 0.5rem", borderRadius: 6, border: "1px solid #ddd", fontSize: "0.85rem", width: 150, color: "#333" },
  button: { padding: "0.4rem 0.9rem", borderRadius: 6, border: "1px solid #111", background: "#111", color: "#fff", fontSize: "0.85rem", fontWeight: 600, cursor: "pointer" },
  buttonDisabled: { padding: "0.4rem 0.9rem", borderRadius: 6, border: "1px solid #999", background: "#999", color: "#fff", fontSize: "0.85rem", fontWeight: 600, cursor: "not-allowed" },
  progressWrap: { display: "flex", flexDirection: "column", gap: "0.25rem" },
  progressMeta: { display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#666", textTransform: "capitalize" },
  progressTrack: { height: 8, borderRadius: 999, background: "#eee", overflow: "hidden" },
  progressBar: { height: "100%", background: "#2563eb", borderRadius: 999, transition: "width 0.3s ease" },
  success: { fontSize: "0.8rem", color: "#166534", background: "#dcfce7", padding: "0.4rem 0.6rem", borderRadius: 6 },
  error: { fontSize: "0.8rem", color: "#991b1b", background: "#fee2e2", padding: "0.4rem 0.6rem", borderRadius: 6 },
};
