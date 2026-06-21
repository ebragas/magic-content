"use client";

// Live run monitor (the /runs page's interactive core). Starts a pipeline run and
// watches it move through its steps with a progress bar PER stage (scrape /
// analyze / refresh), plus a live results list of reels appearing as each is
// analyzed. Polls the same run API the CLI's core writes through (ADR-0002) — it
// carries no pipeline logic, only talks to the run + results endpoints.
//
//   - POST /api/content-pipeline/runs            → start a run (202 { run_id })
//   - GET  /api/content-pipeline/runs            → attach to active/last run
//   - GET  /api/content-pipeline/runs/{run_id}   → status + per-step progress
//   - GET  /api/content-pipeline/results         → reels (live, as analyzed)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

type Action = "scrape" | "analyze" | "refresh" | "full";
type RunStatus = "queued" | "running" | "succeeded" | "failed";
type Stage = "scrape" | "analyze" | "refresh";
type StepStatus = "pending" | "running" | "done" | "failed";

interface RunStep {
  stage: Stage;
  status: StepStatus;
  done: number;
  total: number;
}

interface PipelineResultLike {
  scrape?: {
    reelsReturned: number;
    reelsUpserted: number;
    droppedOutOfWindow: number;
    droppedOverCap: number;
  };
  analyze?: { analyzed: number; skipped: number; failed: number; remainingOverCap: number };
  refresh?: { reelsRefreshed: number };
}

interface RunRecord {
  run_id: string;
  action: Action;
  creator: string | null;
  status: RunStatus;
  stage: Stage | null;
  progress: { done: number; total: number };
  steps: RunStep[];
  started_at: string;
  finished_at: string | null;
  error: string | null;
  result?: PipelineResultLike | null;
}

interface ResultRow {
  shortcode: string;
  url: string;
  topic: string | null;
  category: string | null;
  hook_technique: string | null;
  analysis_status: string | null;
  analyzed_at: string | null;
  performance_score: number | null;
  has_thumbnail: boolean;
}

interface ResultsPayload {
  rows: ResultRow[];
  counts: { total: number; analyzed: number; pending: number; failed: number };
}

const ACTIONS: { value: Action; label: string }[] = [
  { value: "full", label: "Full (scrape + analyze + refresh)" },
  { value: "scrape", label: "Scrape" },
  { value: "analyze", label: "Analyze" },
  { value: "refresh", label: "Refresh" },
];

const STAGE_LABEL: Record<Stage, string> = {
  scrape: "Scrape",
  analyze: "Analyze",
  refresh: "Refresh",
};

const POLL_MS = 1200;

export function RunMonitor({ defaultCreator }: { defaultCreator?: string }) {
  const [action, setAction] = useState<Action>("full");
  const [creator, setCreator] = useState(defaultCreator ?? "");
  const [run, setRun] = useState<RunRecord | null>(null);
  const [results, setResults] = useState<ResultsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const isActive = run?.status === "queued" || run?.status === "running";

  const stop = useCallback(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const fetchResults = useCallback(async (cr: string | null | undefined) => {
    try {
      const qs = cr && cr.trim() ? `?creator=${encodeURIComponent(cr.trim())}` : "";
      const res = await fetch(`/api/content-pipeline/results${qs}`, { cache: "no-store" });
      if (res.ok && mounted.current) setResults((await res.json()) as ResultsPayload);
    } catch {
      // results are best-effort; a transient miss just shows stale data next tick
    }
  }, []);

  const tick = useCallback(
    async (runId: string) => {
      try {
        const res = await fetch(`/api/content-pipeline/runs/${runId}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`status check failed (${res.status})`);
        const data = (await res.json()) as RunRecord;
        if (!mounted.current) return;
        setRun(data);
        await fetchResults(data.creator);
        if (data.status === "succeeded" || data.status === "failed") {
          stop();
          return;
        }
        pollTimer.current = setTimeout(() => void tick(runId), POLL_MS);
      } catch (e) {
        stop();
        if (mounted.current) setError(e instanceof Error ? e.message : String(e));
      }
    },
    [fetchResults, stop],
  );

  // On mount: attach to an already-active/last run so a fresh /runs load mid-run
  // shows it (and keeps polling if it's still in flight).
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        const res = await fetch("/api/content-pipeline/runs", { cache: "no-store" });
        if (!res.ok) return;
        const { run: existing } = (await res.json()) as { run: RunRecord | null };
        if (!existing || !mounted.current) return;
        setRun(existing);
        await fetchResults(existing.creator);
        if (existing.status === "queued" || existing.status === "running") {
          pollTimer.current = setTimeout(() => void tick(existing.run_id), POLL_MS);
        }
      } catch {
        // no active run / endpoint not ready — nothing to attach to
      }
    })();
    return () => {
      mounted.current = false;
      stop();
    };
  }, [fetchResults, stop, tick]);

  // Tick a clock while a run is active so the elapsed timer updates smoothly.
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isActive]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/content-pipeline/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, creator: creator.trim() || undefined }),
      });
      if (res.status === 409) {
        setError("a run is already active — it's shown below; wait for it to finish");
        // Attach to the active run instead of starting a new one.
        const c = await fetch("/api/content-pipeline/runs", { cache: "no-store" });
        if (c.ok) {
          const { run: existing } = (await c.json()) as { run: RunRecord | null };
          if (existing && mounted.current) {
            setRun(existing);
            pollTimer.current = setTimeout(() => void tick(existing.run_id), POLL_MS);
          }
        }
        return;
      }
      if (!res.ok) {
        setError(`failed to start run (${res.status})`);
        return;
      }
      const { run_id } = (await res.json()) as { run_id: string };
      setResults(null);
      setNow(Date.now());
      void tick(run_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [action, creator, tick]);

  const elapsedMs = run
    ? (run.finished_at ? Date.parse(run.finished_at) : now) - Date.parse(run.started_at)
    : 0;

  // Analyzed reels, most-recently-analyzed first — the live "results appearing" feed.
  const analyzedRows = useMemo(() => {
    const rows = (results?.rows ?? []).filter((r) => r.analysis_status === "analyzed");
    return rows.sort((a, b) => (b.analyzed_at ?? "").localeCompare(a.analyzed_at ?? ""));
  }, [results]);

  return (
    <main style={styles.main}>
      {/* one-off keyframes for the indeterminate bar (the app uses inline styles) */}
      <style>{INDETERMINATE_KEYFRAMES}</style>

      <header style={styles.header}>
        <div>
          <h1 style={styles.h1}>Run monitor</h1>
          <p style={styles.subtitle}>Start a pipeline run and watch it live.</p>
        </div>
        <Link href="/" style={styles.backLink}>
          ← Dashboard
        </Link>
      </header>

      <section style={styles.controls} aria-label="start a run">
        <select
          aria-label="pipeline action"
          value={action}
          onChange={(e) => setAction(e.target.value as Action)}
          disabled={isActive}
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
          disabled={isActive}
          style={styles.input}
        />
        <button
          type="button"
          onClick={() => void start()}
          disabled={isActive}
          style={isActive ? styles.buttonDisabled : styles.button}
        >
          {isActive ? "Running…" : "Start run"}
        </button>
      </section>

      {error ? <div style={styles.error}>{error}</div> : null}

      {run ? (
        <>
          <section style={styles.runHeader} aria-live="polite">
            <span style={styles.runMetaStrong}>{run.action}</span>
            <span style={styles.runMeta}>· @{run.creator ?? "—"}</span>
            <StatusBadge status={run.status} />
            <span style={styles.runMeta}>· {formatElapsed(elapsedMs)}</span>
          </section>

          <section style={styles.steps} aria-label="step progress">
            {run.steps.map((step) => (
              <StepBar key={step.stage} step={step} />
            ))}
          </section>

          {run.status === "failed" && run.error ? (
            <div style={styles.error}>Run failed: {run.error}</div>
          ) : null}

          {run.status === "succeeded" && run.result ? (
            <div style={styles.summary}>{summarize(run.result)}</div>
          ) : null}

          <section style={styles.resultsSection} aria-label="live results">
            <div style={styles.resultsHead}>
              <h2 style={styles.h2}>Live results</h2>
              {results ? (
                <span style={styles.counts}>
                  {results.counts.analyzed} analyzed · {results.counts.pending} pending
                  {results.counts.failed > 0 ? ` · ${results.counts.failed} failed` : ""} ·{" "}
                  {results.counts.total} total
                </span>
              ) : null}
            </div>

            {analyzedRows.length === 0 ? (
              <p style={styles.empty}>No analyzed reels yet — they’ll appear here as each completes.</p>
            ) : (
              <ul style={styles.resultList}>
                {analyzedRows.map((r) => (
                  <li key={r.shortcode} style={styles.resultItem}>
                    {r.has_thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/thumbnails/${r.shortcode}`}
                        alt=""
                        width={48}
                        height={64}
                        style={styles.thumb}
                      />
                    ) : (
                      <div style={styles.thumbPlaceholder} aria-hidden />
                    )}
                    <div style={styles.resultBody}>
                      <div style={styles.resultTopic}>{r.topic ?? "—"}</div>
                      <div style={styles.resultMeta}>
                        {r.category ? (
                          <span style={styles.tag}>{categoryLabel(r.category)}</span>
                        ) : null}
                        {r.hook_technique ? <span style={styles.muted}>{r.hook_technique}</span> : null}
                      </div>
                    </div>
                    <a href={r.url} target="_blank" rel="noopener noreferrer" style={styles.openLink}>
                      Open ↗
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : (
        <p style={styles.empty}>No runs yet. Start one above.</p>
      )}
    </main>
  );
}

function StepBar({ step }: { step: RunStep }) {
  const indeterminate = step.status === "running" && step.total === 0;
  const pct =
    step.total > 0
      ? Math.min(100, Math.round((step.done / step.total) * 100))
      : step.status === "done"
        ? 100
        : 0;

  return (
    <div style={styles.step}>
      <div style={styles.stepHead}>
        <span style={styles.stepLabel}>{STAGE_LABEL[step.stage]}</span>
        <span style={styles.stepMeta}>
          {step.status === "pending"
            ? "pending"
            : indeterminate
              ? "working…"
              : step.total > 0
                ? `${step.done}/${step.total} (${pct}%)`
                : step.status}
          {step.status === "done" ? " ✓" : step.status === "failed" ? " ✗" : ""}
        </span>
      </div>
      <div
        style={styles.track}
        role="progressbar"
        aria-valuenow={indeterminate ? undefined : pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        {indeterminate ? (
          <div style={styles.barIndeterminate} />
        ) : (
          <div
            style={{
              ...styles.bar,
              width: `${pct}%`,
              background: step.status === "failed" ? "#dc2626" : step.status === "done" ? "#16a34a" : "#2563eb",
            }}
          />
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: RunStatus }) {
  const map: Record<RunStatus, React.CSSProperties> = {
    queued: { background: "#e5e7eb", color: "#374151" },
    running: { background: "#dbeafe", color: "#1d4ed8" },
    succeeded: { background: "#dcfce7", color: "#166534" },
    failed: { background: "#fee2e2", color: "#991b1b" },
  };
  return <span style={{ ...styles.badge, ...map[status] }}>{status}</span>;
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${ss.toString().padStart(2, "0")}`;
}

function categoryLabel(slug: string): string {
  return slug
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Build a human run-log line from the terminal result (no silent truncation —
 *  surface scrape/analyze/refresh counts, build-spec.md). */
function summarize(r: PipelineResultLike): string {
  const parts: string[] = ["Run complete."];
  if (r.scrape) {
    parts.push(
      `scraped ${r.scrape.reelsReturned} (${r.scrape.reelsUpserted} upserted` +
        (r.scrape.droppedOverCap > 0 ? `, ${r.scrape.droppedOverCap} over cap` : "") +
        ")",
    );
  }
  if (r.analyze) {
    parts.push(
      `analyzed ${r.analyze.analyzed}, skipped ${r.analyze.skipped}, failed ${r.analyze.failed}` +
        (r.analyze.remainingOverCap > 0 ? `, ${r.analyze.remainingOverCap} left over cap` : ""),
    );
  }
  if (r.refresh) parts.push(`refreshed ${r.refresh.reelsRefreshed}`);
  return parts.join(" · ");
}

const INDETERMINATE_KEYFRAMES = `
@keyframes mc-indeterminate {
  0% { transform: translateX(-110%); }
  100% { transform: translateX(440%); }
}`;

const styles: Record<string, React.CSSProperties> = {
  main: { fontFamily: "system-ui, -apple-system, sans-serif", padding: "2rem", color: "#111", maxWidth: 1000, margin: "0 auto" },
  header: { marginBottom: "1.25rem", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1.5rem", flexWrap: "wrap" },
  h1: { fontSize: "1.6rem", margin: 0 },
  h2: { fontSize: "1rem", margin: 0 },
  subtitle: { color: "#666", margin: "0.25rem 0 0", fontSize: "0.9rem" },
  backLink: { color: "#2563eb", textDecoration: "none", fontSize: "0.9rem", fontWeight: 600 },
  controls: { display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginBottom: "1rem" },
  select: { padding: "0.4rem 0.5rem", borderRadius: 6, border: "1px solid #ddd", background: "#fff", fontSize: "0.85rem", color: "#333" },
  input: { padding: "0.4rem 0.5rem", borderRadius: 6, border: "1px solid #ddd", fontSize: "0.85rem", width: 170, color: "#333" },
  button: { padding: "0.45rem 1rem", borderRadius: 6, border: "1px solid #111", background: "#111", color: "#fff", fontSize: "0.85rem", fontWeight: 600, cursor: "pointer" },
  buttonDisabled: { padding: "0.45rem 1rem", borderRadius: 6, border: "1px solid #999", background: "#999", color: "#fff", fontSize: "0.85rem", fontWeight: 600, cursor: "not-allowed" },
  runHeader: { display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem", fontSize: "0.9rem" },
  runMetaStrong: { fontWeight: 700, textTransform: "capitalize" },
  runMeta: { color: "#666" },
  badge: { fontSize: "0.72rem", fontWeight: 700, padding: "0.15rem 0.5rem", borderRadius: 999, textTransform: "uppercase", letterSpacing: "0.03em" },
  steps: { display: "flex", flexDirection: "column", gap: "0.85rem", marginBottom: "1.25rem" },
  step: { display: "flex", flexDirection: "column", gap: "0.3rem" },
  stepHead: { display: "flex", justifyContent: "space-between", fontSize: "0.82rem" },
  stepLabel: { fontWeight: 600 },
  stepMeta: { color: "#666", fontVariantNumeric: "tabular-nums" },
  track: { position: "relative", height: 10, borderRadius: 999, background: "#eee", overflow: "hidden" },
  bar: { height: "100%", borderRadius: 999, transition: "width 0.3s ease" },
  barIndeterminate: { position: "absolute", top: 0, bottom: 0, width: "25%", borderRadius: 999, background: "#2563eb", animation: "mc-indeterminate 1.1s ease-in-out infinite" },
  summary: { fontSize: "0.82rem", color: "#166534", background: "#dcfce7", padding: "0.5rem 0.7rem", borderRadius: 6, marginBottom: "1rem" },
  error: { fontSize: "0.82rem", color: "#991b1b", background: "#fee2e2", padding: "0.5rem 0.7rem", borderRadius: 6, marginBottom: "1rem" },
  resultsSection: { marginTop: "0.5rem" },
  resultsHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "1rem", marginBottom: "0.6rem", flexWrap: "wrap" },
  counts: { fontSize: "0.8rem", color: "#666", fontVariantNumeric: "tabular-nums" },
  empty: { color: "#888", fontSize: "0.88rem", padding: "0.5rem 0" },
  resultList: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" },
  resultItem: { display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.5rem", border: "1px solid #eee", borderRadius: 8 },
  thumb: { borderRadius: 6, objectFit: "cover", background: "#f3f4f6", flexShrink: 0 },
  thumbPlaceholder: { width: 48, height: 64, borderRadius: 6, background: "#f3f4f6", flexShrink: 0 },
  resultBody: { flex: 1, minWidth: 0 },
  resultTopic: { fontSize: "0.9rem", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  resultMeta: { display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.2rem" },
  tag: { fontSize: "0.72rem", fontWeight: 600, color: "#3730a3", background: "#e0e7ff", padding: "0.1rem 0.45rem", borderRadius: 999 },
  muted: { fontSize: "0.72rem", color: "#888" },
  openLink: { color: "#2563eb", textDecoration: "none", fontSize: "0.8rem", fontWeight: 600, flexShrink: 0 },
};
