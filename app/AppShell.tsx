"use client";

// The redesigned Magic Content dashboard (implements the claude.ai/design comp
// "Magic Content"). A single client shell over the Magic & Co design system that
// switches between Library / Detail / Creators / Runs views and does all
// filtering, sorting, search, and theme toggling in the browser over the dataset
// the server loaded once (AppData from dashboard-data.getAppData).
//
// What's backed by real data: every Reel + Creator + metric + analysis field
// (topic, category, hook, beats, why-it-works, transcript, top comments). The Runs
// view drives the REAL pipeline run API (the same endpoints the old RunMonitor and
// the CLI write through, ADR-0002) with live per-step progress + results.
//
// Adaptations where the Store has no field for a design element: the detail
// "Structure" shows the beat timeline + legend + full transcript (the comp's
// per-beat verbatim lines aren't a stored field); "Why it works" splits the stored
// rationale into a serif pull-quote + body; "Questions from comments" surfaces the
// stored top_comments (questions first); "Your version" is an editable draft
// scaffold seeded from the Reel's real hook/caption/beats (no generation backend).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { AppData, CreatorVM, ReelVM } from "./dashboard-data.js";
import { fmt, formatDuration } from "./content-labels.js";

// ── Run API types (mirror app/api/content-pipeline/runs registry contract) ──
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
  scrape?: { reelsReturned: number; reelsUpserted: number; droppedOverCap: number };
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

const RUN_ACTIONS: { value: Action; label: string }[] = [
  { value: "full", label: "Full" },
  { value: "scrape", label: "Scrape" },
  { value: "analyze", label: "Analyze" },
  { value: "refresh", label: "Refresh" },
];
const STAGE_LABEL: Record<Stage, string> = { scrape: "Scrape", analyze: "Analyze", refresh: "Refresh" };
const POLL_MS = 1200;
const MAX_POLL_FAILURES = 5;

type View = "library" | "detail" | "creators" | "runs";
type RowStyle = "signal" | "table" | "gallery";
type SortKey = "performance" | "views" | "newest" | "category";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "performance", label: "Performance" },
  { key: "views", label: "Views" },
  { key: "newest", label: "Newest" },
  { key: "category", label: "Category" },
];
const ROW_STYLES: { key: RowStyle; label: string; icon: string }[] = [
  { key: "signal", label: "Signal rows", icon: "☰" },
  { key: "table", label: "Table", icon: "▤" },
  { key: "gallery", label: "Gallery", icon: "▦" },
];

export interface AppShellProps {
  data: AppData;
  initialView?: View;
  initialCreator?: string | null;
}

export function AppShell({ data, initialView = "library", initialCreator = null }: AppShellProps) {
  const [view, setView] = useState<View>(initialView);
  const [rowStyle, setRowStyle] = useState<RowStyle>("signal");
  const [sort, setSort] = useState<SortKey>("performance");
  const [search, setSearch] = useState("");
  const [viralOnly, setViralOnly] = useState(false);
  const [outlierOnly, setOutlierOnly] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [creatorFilter, setCreatorFilter] = useState<string | null>(initialCreator);
  const [selected, setSelected] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  // ── Detail "Your version" draft (local-only scaffold) ──
  const [remixHook, setRemixHook] = useState("");
  const [remixCaption, setRemixCaption] = useState("");
  const [copied, setCopied] = useState(false);

  // ── Runs ──
  const [runAction, setRunAction] = useState<Action>("full");
  const [runCreator, setRunCreator] = useState(initialCreator ?? "");
  const [run, setRun] = useState<RunRecord | null>(null);
  const [results, setResults] = useState<ResultsPayload | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollFailures = useRef(0);
  const mounted = useRef(true);

  const isRunning = run?.status === "queued" || run?.status === "running";

  // Sync theme state with the attribute the layout's bootstrap script already set.
  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    if (current === "dark" || current === "light") setTheme(current);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "light" ? "dark" : "light";
      try {
        localStorage.setItem("mc_theme", next);
      } catch {
        /* private mode — theme just won't persist */
      }
      document.documentElement.setAttribute("data-theme", next);
      return next;
    });
  }, []);

  const reelByShortcode = useMemo(() => {
    const m = new Map<string, ReelVM>();
    for (const r of data.reels) m.set(r.shortcode, r);
    return m;
  }, [data.reels]);

  const selectedReel = selected ? (reelByShortcode.get(selected) ?? null) : null;

  const openReel = useCallback(
    (shortcode: string) => {
      const r = reelByShortcode.get(shortcode);
      setSelected(shortcode);
      setView("detail");
      setRemixHook(r?.topic ?? "");
      setRemixCaption(r?.caption ?? "");
      setCopied(false);
      window.scrollTo({ top: 0 });
    },
    [reelByShortcode],
  );

  const goLibraryForCreator = useCallback((handle: string) => {
    setCreatorFilter(handle);
    setRowStyle("signal");
    setSelected(null);
    setView("library");
    window.scrollTo({ top: 0 });
  }, []);

  // ── Filter + sort (over the in-memory dataset, mirroring the design) ──
  const reels = useMemo(() => {
    let list = data.reels.slice();
    if (creatorFilter) list = list.filter((r) => r.handle === creatorFilter);
    if (categoryFilter) list = list.filter((r) => r.categorySlug === categoryFilter);
    if (viralOnly) list = list.filter((r) => r.viral);
    if (outlierOnly) list = list.filter((r) => r.outlier);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((r) =>
        `${r.topic ?? ""} ${r.caption ?? ""} ${r.handle} ${r.hookLabel}`.toLowerCase().includes(q),
      );
    }
    const nullsLast = (v: number | null) => (v == null ? -Infinity : v);
    list.sort((a, b) => {
      if (sort === "performance") return nullsLast(b.performance) - nullsLast(a.performance);
      if (sort === "views") return nullsLast(b.views) - nullsLast(a.views);
      if (sort === "newest") return (b.postedAt ?? "").localeCompare(a.postedAt ?? "");
      return (a.categoryLabel ?? "").localeCompare(b.categoryLabel ?? "");
    });
    return list;
  }, [data.reels, creatorFilter, categoryFilter, viralOnly, outlierOnly, search, sort]);

  // ── Run polling (the real pipeline API) ──
  const stopPolling = useCallback(() => {
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
      /* best-effort */
    }
  }, []);

  const tick = useCallback(
    async (runId: string) => {
      try {
        const res = await fetch(`/api/content-pipeline/runs/${runId}`, { cache: "no-store" });
        if (res.status === 404) {
          stopPolling();
          pollFailures.current = 0;
          if (mounted.current) setRunError("run not found");
          return;
        }
        if (!res.ok) throw new Error(`status check failed (${res.status})`);
        const dataRec = (await res.json()) as RunRecord;
        if (!mounted.current) return;
        pollFailures.current = 0;
        setRunError(null);
        setRun(dataRec);
        await fetchResults(dataRec.creator);
        if (dataRec.status === "succeeded" || dataRec.status === "failed") {
          stopPolling();
          return;
        }
        pollTimer.current = setTimeout(() => void tick(runId), POLL_MS);
      } catch (e) {
        pollFailures.current += 1;
        if (pollFailures.current >= MAX_POLL_FAILURES) {
          stopPolling();
          pollFailures.current = 0;
          if (mounted.current) setRunError(e instanceof Error ? e.message : String(e));
          return;
        }
        if (mounted.current) setRunError("lost connection, retrying…");
        pollTimer.current = setTimeout(() => void tick(runId), POLL_MS);
      }
    },
    [fetchResults, stopPolling],
  );

  // Attach to an already-active/last run on mount.
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
        /* nothing to attach to */
      }
    })();
    return () => {
      mounted.current = false;
      stopPolling();
    };
  }, [fetchResults, stopPolling, tick]);

  // Elapsed clock while a run is active.
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  const startRun = useCallback(async () => {
    setRunError(null);
    pollFailures.current = 0;
    try {
      const res = await fetch("/api/content-pipeline/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: runAction, creator: runCreator.trim() || undefined }),
      });
      if (res.status === 409) {
        setRunError("a run is already active — it's shown below; wait for it to finish");
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
        setRunError(`failed to start run (${res.status})`);
        return;
      }
      const { run_id } = (await res.json()) as { run_id: string };
      setResults(null);
      setNow(Date.now());
      void tick(run_id);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    }
  }, [runAction, runCreator, tick]);

  const copyDraft = useCallback(() => {
    if (!selectedReel) return;
    const outline = selectedReel.beats.map((b) => `- ${b.label}: ${b.note}`).join("\n");
    const text = `HOOK: ${remixHook}\n\nBEATS:\n${outline}\n\nCAPTION: ${remixCaption}`;
    try {
      void navigator.clipboard.writeText(text);
    } catch {
      /* clipboard blocked */
    }
    setCopied(true);
    setTimeout(() => mounted.current && setCopied(false), 1600);
  }, [selectedReel, remixHook, remixCaption]);

  return (
    <div style={S.app}>
      <Sidebar
        view={view}
        reelCount={data.reelCount}
        creatorCount={data.creatorCount}
        runActive={isRunning}
        themeLabel={theme === "light" ? "Dark mode" : "Light mode"}
        onToggleTheme={toggleTheme}
        onGo={(v) => {
          setSelected(null);
          setView(v);
          window.scrollTo({ top: 0 });
        }}
      />

      <main style={S.main}>
        {view === "library" && (
          <LibraryView
            data={data}
            reels={reels}
            rowStyle={rowStyle}
            setRowStyle={setRowStyle}
            sort={sort}
            setSort={setSort}
            search={search}
            setSearch={setSearch}
            viralOnly={viralOnly}
            setViralOnly={setViralOnly}
            outlierOnly={outlierOnly}
            setOutlierOnly={setOutlierOnly}
            categoryFilter={categoryFilter}
            setCategoryFilter={setCategoryFilter}
            creatorFilter={creatorFilter}
            clearCreator={() => setCreatorFilter(null)}
            onOpen={openReel}
          />
        )}

        {view === "detail" && selectedReel && (
          <DetailView
            reel={selectedReel}
            remixHook={remixHook}
            remixCaption={remixCaption}
            copied={copied}
            onHook={setRemixHook}
            onCaption={setRemixCaption}
            onCopy={copyDraft}
            onBack={() => {
              setView("library");
              setSelected(null);
            }}
          />
        )}

        {view === "creators" && (
          <CreatorsView creators={data.creators} onOpenReel={openReel} onOpenCreator={goLibraryForCreator} />
        )}

        {view === "runs" && (
          <RunsView
            runAction={runAction}
            setRunAction={setRunAction}
            runCreator={runCreator}
            setRunCreator={setRunCreator}
            isRunning={isRunning}
            run={run}
            results={results}
            error={runError}
            now={now}
            onStart={startRun}
            onOpenReel={openReel}
            reelByShortcode={reelByShortcode}
          />
        )}
      </main>
    </div>
  );
}

// ════════════════════════════ SIDEBAR ════════════════════════════

function Sidebar({
  view,
  reelCount,
  creatorCount,
  runActive,
  themeLabel,
  onToggleTheme,
  onGo,
}: {
  view: View;
  reelCount: number;
  creatorCount: number;
  runActive: boolean;
  themeLabel: string;
  onToggleTheme: () => void;
  onGo: (v: View) => void;
}) {
  const navActive = (v: View) => view === v || (v === "library" && view === "detail");
  return (
    <aside style={S.sidebar}>
      <div style={{ padding: "22px 20px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={S.logoMark}>
            <Icon name="sparkle" size={17} stroke="var(--accent)" />
          </div>
          <div style={{ lineHeight: 1.1 }}>
            <div style={{ fontWeight: 500, fontSize: 15, letterSpacing: "-0.01em" }}>Magic Content</div>
            <div style={{ ...micro(9), letterSpacing: "0.18em", marginTop: 2 }}>Content Intel</div>
          </div>
        </div>
      </div>

      <nav style={{ padding: "6px 12px", display: "flex", flexDirection: "column", gap: 2 }}>
        <NavItem active={navActive("library")} onClick={() => onGo("library")} icon="grid" label="Library" count={reelCount} />
        <NavItem active={navActive("creators")} onClick={() => onGo("creators")} icon="users" label="Creators" count={creatorCount} />
        <NavItem active={navActive("runs")} onClick={() => onGo("runs")} icon="arrow" label="Runs" dot={runActive} />
      </nav>

      <div style={S.sidebarFooter}>
        <div style={{ ...micro(9), letterSpacing: "0.16em", marginBottom: 9 }}>Workspace</div>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
          <div style={S.avatar}>EB</div>
          <div style={{ lineHeight: 1.15, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              Eric Bragas
            </div>
            <div style={{ fontSize: 11, color: "var(--fg-faint)" }}>Magic &amp; Co</div>
          </div>
        </div>
        <button onClick={onToggleTheme} style={S.themeBtn} className="mc-press">
          <span style={{ ...micro(10), letterSpacing: "0.12em", color: "var(--fg-muted)" }}>{themeLabel}</span>
        </button>
      </div>
    </aside>
  );
}

function NavItem({
  active,
  onClick,
  icon,
  label,
  count,
  dot,
}: {
  active: boolean;
  onClick: () => void;
  icon: IconName;
  label: string;
  count?: number;
  dot?: boolean;
}) {
  return (
    <div onClick={onClick} style={navItemStyle(active)}>
      <Icon name={icon} size={17} stroke="currentColor" sw={1.8} />
      <span>{label}</span>
      {count != null && (
        <span style={{ marginLeft: "auto", ...micro(11), letterSpacing: 0, textTransform: "none" }}>{count}</span>
      )}
      {dot && <span style={{ marginLeft: "auto", width: 7, height: 7, borderRadius: 999, background: "var(--accent)" }} />}
    </div>
  );
}

// ════════════════════════════ LIBRARY ════════════════════════════

function LibraryView(props: {
  data: AppData;
  reels: ReelVM[];
  rowStyle: RowStyle;
  setRowStyle: (r: RowStyle) => void;
  sort: SortKey;
  setSort: (s: SortKey) => void;
  search: string;
  setSearch: (s: string) => void;
  viralOnly: boolean;
  setViralOnly: (b: boolean) => void;
  outlierOnly: boolean;
  setOutlierOnly: (b: boolean) => void;
  categoryFilter: string | null;
  setCategoryFilter: (s: string | null) => void;
  creatorFilter: string | null;
  clearCreator: () => void;
  onOpen: (shortcode: string) => void;
}) {
  const {
    data,
    reels,
    rowStyle,
    setRowStyle,
    sort,
    setSort,
    search,
    setSearch,
    viralOnly,
    setViralOnly,
    outlierOnly,
    setOutlierOnly,
    categoryFilter,
    setCategoryFilter,
    creatorFilter,
    clearCreator,
    onOpen,
  } = props;

  const subtitle =
    `${data.reelCount} Reels in the Content Store across ${data.creatorCount} creator${data.creatorCount === 1 ? "" : "s"}` +
    (creatorFilter ? ` · @${creatorFilter}` : "");

  return (
    <section className="mc-up">
      {/* header */}
      <div style={S.libHeader}>
        <div>
          <div style={{ ...micro(10), letterSpacing: "0.16em", marginBottom: 6 }}>Content Store</div>
          <h1 style={S.h1}>Library</h1>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--fg-muted)" }}>{subtitle}</p>
        </div>
        <div style={S.searchWrap}>
          <Icon name="search" size={14} stroke="var(--fg-faint)" sw={2} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search topics, hooks, captions"
            style={S.searchInput}
          />
        </div>
      </div>

      {/* controls */}
      <div style={S.controls}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={micro(9)}>Sort</span>
          {SORT_OPTIONS.map((o) => (
            <button key={o.key} onClick={() => setSort(o.key)} style={pillStyle(sort === o.key)}>
              {o.label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={micro(9)}>Filter</span>
          <button onClick={() => setViralOnly(!viralOnly)} style={pillStyle(viralOnly)}>
            Viral only
          </button>
          <button onClick={() => setOutlierOnly(!outlierOnly)} style={pillStyle(outlierOnly)}>
            Outliers
          </button>
        </div>
        {creatorFilter && (
          <button onClick={clearCreator} style={S.creatorChip}>
            @{creatorFilter} <span style={{ fontSize: 14, lineHeight: 1 }}>×</span>
          </button>
        )}
        <div style={S.rowStyleSeg}>
          {ROW_STYLES.map((o) => (
            <button
              key={o.key}
              onClick={() => setRowStyle(o.key)}
              title={o.label}
              style={{ ...segStyle(rowStyle === o.key), fontSize: 13 }}
            >
              {o.icon}
            </button>
          ))}
        </div>
      </div>

      {/* category chips */}
      <div style={S.chipRow}>
        <CategoryChip label="All" count={data.reelCount} active={categoryFilter == null} onClick={() => setCategoryFilter(null)} />
        {data.categoriesPresent.map((c) => (
          <CategoryChip
            key={c.slug}
            label={c.label}
            count={c.count}
            active={categoryFilter === c.slug}
            onClick={() => setCategoryFilter(c.slug)}
          />
        ))}
      </div>

      {reels.length === 0 ? (
        <div style={S.empty}>No Reels match these filters.</div>
      ) : rowStyle === "signal" ? (
        <SignalRows reels={reels} onOpen={onOpen} />
      ) : rowStyle === "table" ? (
        <CommandTable reels={reels} onOpen={onOpen} />
      ) : (
        <GalleryGrid reels={reels} onOpen={onOpen} />
      )}
    </section>
  );
}

function CategoryChip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={pillStyle(active)}>
      {label}
      <span style={{ opacity: 0.5, marginLeft: 6, fontFamily: "var(--font-mono)", fontSize: 10 }}>{count}</span>
    </button>
  );
}

function BeatBars({ beats, height, withTitle }: { beats: ReelVM["beats"]; height: number; withTitle?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 2, width: "100%", height, borderRadius: 2, overflow: "hidden", background: "var(--border-faint)" }}>
      {beats.map((b, i) => (
        <div
          key={`${b.label}-${i}`}
          title={withTitle ? `${b.label} ${b.start}–${b.end}%` : undefined}
          style={{ width: `${b.end - b.start}%`, height: "100%", background: b.color, flex: "none" }}
        />
      ))}
    </div>
  );
}

function Flag({ kind }: { kind: "viral" | "outlier" }) {
  const viral = kind === "viral";
  return (
    <span
      style={{
        ...micro(9),
        letterSpacing: "0.1em",
        padding: "2px 6px",
        borderRadius: 999,
        flex: "none",
        color: viral ? "#fff" : "var(--success-fg)",
        background: viral ? "var(--accent)" : "var(--success)",
      }}
    >
      {viral ? "VIRAL" : "OUTLIER"}
    </span>
  );
}

function SignalRows({ reels, onOpen }: { reels: ReelVM[]; onOpen: (s: string) => void }) {
  return (
    <div>
      {reels.map((r) => {
        const dur = formatDuration(r.durationSec);
        return (
          <div key={r.shortcode} className="mc-row" onClick={() => onOpen(r.shortcode)} style={S.signalRow}>
            <div style={{ position: "relative", flex: "none" }}>
              <div style={thumb(r.thumbUrl, { width: 48, height: 64, borderRadius: 2 })} />
              {dur && <div style={S.durBadge}>{dur}</div>}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={S.signalTopic}>{r.topic ?? "—"}</span>
                {r.viral && <Flag kind="viral" />}
                {r.outlier && <Flag kind="outlier" />}
              </div>
              <div style={S.signalCaption}>{r.caption ?? ""}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 9 }}>
                <span style={{ ...micro(11), letterSpacing: 0, textTransform: "none" }}>@{r.handle}</span>
                {r.categoryLabel && <span style={S.catBadge}>{r.categoryLabel}</span>}
                <span style={{ ...micro(10), letterSpacing: "0.06em", color: "var(--accent)" }}>{r.hookLabel}</span>
                <div style={{ width: 128 }}>
                  <BeatBars beats={r.beats} height={7} withTitle />
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 15, flex: "none", alignItems: "center" }}>
              <Metric label="Views" value={fmt(r.views)} />
              <Metric label="Likes" value={fmt(r.likes)} />
              <Metric label="Comm" value={fmt(r.comments)} muted />
              <Metric label="Perf" value={fmt(r.performance)} accent />
              <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 40, justifyContent: "flex-end" }}>
                <Icon name="message" size={13} stroke="var(--fg-faint)" sw={2} />
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)" }}>
                  {r.topComments.length}
                </span>
              </div>
              <Icon name="chevron" size={16} stroke="var(--border)" sw={2} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Metric({ label, value, accent, muted }: { label: string; value: string; accent?: boolean; muted?: boolean }) {
  return (
    <div style={{ textAlign: "right", minWidth: 40 }}>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          fontVariantNumeric: "tabular-nums",
          color: accent ? "var(--accent)" : muted ? "var(--fg-muted)" : "var(--fg)",
          fontWeight: accent ? 600 : 400,
        }}
      >
        {value}
      </div>
      <div style={{ ...micro(8), letterSpacing: "0.12em", marginTop: 2 }}>{label}</div>
    </div>
  );
}

function CommandTable({ reels, onOpen }: { reels: ReelVM[]; onOpen: (s: string) => void }) {
  const grid = "1.6fr 0.7fr 0.8fr 64px 64px 56px 64px 56px";
  const th = (text: string, right?: boolean): CSSProperties => ({ ...micro(9), textAlign: right ? "right" : "left" });
  return (
    <div style={{ padding: "0 28px" }}>
      <div style={{ display: "grid", gridTemplateColumns: grid, alignItems: "center", padding: "11px 0", borderBottom: "1px solid var(--border)" }}>
        <span style={th("Reel")}>Reel</span>
        <span style={th("Category")}>Category</span>
        <span style={th("Hook")}>Hook</span>
        <span style={th("Views", true)}>Views</span>
        <span style={th("Likes", true)}>Likes</span>
        <span style={th("Comm", true)}>Comm</span>
        <span style={th("Perf", true)}>Perf</span>
        <span style={th("Flags", true)}>Flags</span>
      </div>
      {reels.map((r) => {
        const flags = `${r.viral ? "◆" : ""}${r.outlier ? "▲" : ""}` || "·";
        const cell: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 12.5, textAlign: "right", fontVariantNumeric: "tabular-nums" };
        return (
          <div
            key={r.shortcode}
            className="mc-row"
            onClick={() => onOpen(r.shortcode)}
            style={{ display: "grid", gridTemplateColumns: grid, alignItems: "center", padding: "10px 0", borderBottom: "1px solid var(--border-faint)", cursor: "pointer" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, paddingRight: 12 }}>
              <div style={thumb(r.thumbUrl, { width: 26, height: 34, borderRadius: 2 })} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {r.topic ?? "—"}
                </div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-faint)" }}>@{r.handle}</div>
              </div>
            </div>
            <span style={{ fontSize: 12, color: "var(--fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", paddingRight: 8 }}>
              {r.categoryLabel ?? "—"}
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--accent)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", paddingRight: 8 }}>
              {r.hookLabel}
            </span>
            <span style={cell}>{fmt(r.views)}</span>
            <span style={cell}>{fmt(r.likes)}</span>
            <span style={{ ...cell, color: "var(--fg-muted)" }}>{fmt(r.comments)}</span>
            <span style={{ ...cell, color: "var(--accent)", fontWeight: 600 }}>{fmt(r.performance)}</span>
            <span style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 14, letterSpacing: 1 }}>{flags}</span>
          </div>
        );
      })}
    </div>
  );
}

function GalleryGrid({ reels, onOpen }: { reels: ReelVM[]; onOpen: (s: string) => void }) {
  return (
    <div style={S.gallery}>
      {reels.map((r) => (
        <div key={r.shortcode} className="mc-card" onClick={() => onOpen(r.shortcode)} style={S.galleryCard}>
          <div style={{ position: "relative", aspectRatio: "9 / 13", background: "var(--bg-deep)" }}>
            <div style={thumb(r.thumbUrl, { width: "100%", height: "100%" })} />
            <div style={{ position: "absolute", top: 8, left: 8, display: "flex", gap: 5 }}>
              {r.viral && <Flag kind="viral" />}
              {r.outlier && (
                <span style={{ ...micro(9), letterSpacing: "0.1em", padding: "3px 7px", borderRadius: 999, background: "rgba(0,0,0,0.55)", color: "#fff" }}>
                  OUTLIER
                </span>
              )}
            </div>
            <div style={S.galleryBeatGrad}>
              <BeatBars beats={r.beats} height={6} />
            </div>
          </div>
          <div style={{ padding: "11px 12px 13px" }}>
            <div style={S.galleryTopic}>{r.topic ?? "—"}</div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 9 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-faint)" }}>@{r.handle}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--accent)", fontWeight: 600 }}>{fmt(r.performance)}</span>
            </div>
            <div style={S.galleryFooter}>
              <span>{fmt(r.views)} views</span>
              <span>{fmt(r.likes)} likes</span>
              <span style={{ marginLeft: "auto" }}>{r.topComments.length} Q</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ════════════════════════════ DETAIL ════════════════════════════

function DetailView({
  reel,
  remixHook,
  remixCaption,
  copied,
  onHook,
  onCaption,
  onCopy,
  onBack,
}: {
  reel: ReelVM;
  remixHook: string;
  remixCaption: string;
  copied: boolean;
  onHook: (s: string) => void;
  onCaption: (s: string) => void;
  onCopy: () => void;
  onBack: () => void;
}) {
  const questions = reel.topComments.filter((c) => c.isQuestion);
  const commentsToShow = questions.length ? questions : reel.topComments;
  const commentsHeading = questions.length ? "Questions from comments" : "Top comments";
  const engagement = reel.engagementRate != null ? `${(reel.engagementRate * 100).toFixed(1)}% eng. rate` : null;

  return (
    <section className="mc-up" style={{ padding: "0 0 60px" }}>
      <div style={S.detailBar}>
        <button onClick={onBack} style={S.backBtn} className="mc-press">
          <Icon name="back" size={14} stroke="currentColor" sw={2} /> Library
        </button>
        <span style={{ ...micro(10), letterSpacing: "0.12em" }}>{reel.shortcode}</span>
        <a href={reel.url} target="_blank" rel="noopener noreferrer" style={S.igLink} className="mc-press">
          Open on Instagram <span style={{ fontSize: 13 }}>↗</span>
        </a>
      </div>

      <div style={S.detailBody}>
        {/* left rail */}
        <div style={S.detailRail}>
          <div style={{ borderRadius: 2, overflow: "hidden", border: "1px solid var(--border-faint)", background: "var(--bg-deep)" }}>
            <div style={thumb(reel.thumbUrl, { width: "100%", aspectRatio: "9 / 16" })} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 14 }}>
            <div style={{ ...S.avatar, width: 30, height: 30 }}>{reel.creatorInitials}</div>
            <div style={{ lineHeight: 1.2 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{reel.creatorName}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-faint)" }}>
                @{reel.handle}
                {reel.followers != null ? ` · ${fmt(reel.followers)} followers` : ""}
              </div>
            </div>
          </div>
          <div style={S.statGrid}>
            <Stat label="Views" value={fmt(reel.views)} />
            <Stat label="Likes" value={fmt(reel.likes)} />
            <Stat label="Comments" value={fmt(reel.comments)} />
            <Stat label="Performance" value={fmt(reel.performance)} accent />
          </div>
          <div style={{ display: "flex", gap: 7, marginTop: 14, flexWrap: "wrap" }}>
            {reel.viral && <Flag kind="viral" />}
            {reel.outlier && <Flag kind="outlier" />}
            {engagement && (
              <span style={{ ...micro(10), letterSpacing: "0.08em", padding: "4px 9px", borderRadius: 999, background: "var(--bg-deep)", color: "var(--fg-muted)" }}>
                {engagement}
              </span>
            )}
          </div>
        </div>

        {/* right body */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...micro(11), letterSpacing: "0.12em", color: "var(--accent)", marginBottom: 8 }}>{reel.categoryLabel ?? "—"}</div>
          <h1 style={{ margin: 0, fontWeight: 300, fontSize: 30, lineHeight: 1.15, letterSpacing: "-0.02em" }}>{reel.topic ?? "—"}</h1>
          {reel.caption && <p style={{ margin: "12px 0 0", fontSize: 14, color: "var(--fg-muted)", lineHeight: 1.6, maxWidth: 680 }}>{reel.caption}</p>}

          {/* STRUCTURE */}
          {reel.beats.length > 0 && (
            <div style={{ marginTop: 30 }}>
              <SectionHead title="Structure" meta={`Hook · ${reel.hookLabel}`} />
              <div style={S.panel}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, paddingBottom: 14, borderBottom: "1px solid var(--border-faint)" }}>
                  <div style={{ width: 30, height: 30, borderRadius: 2, background: "var(--warning)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
                    <Icon name="bolt" size={15} stroke="var(--accent)" sw={2} />
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{reel.hookLabel}</div>
                    <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>{reel.hookDescription}</div>
                  </div>
                </div>
                <div style={{ display: "flex", height: 42, borderRadius: 2, overflow: "hidden", gap: 2 }}>
                  {reel.beats.map((b, i) => (
                    <div
                      key={`${b.label}-${i}`}
                      style={{ width: `${b.end - b.start}%`, flex: "none", background: b.color, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px" }}
                    >
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.04em", color: "#fff", whiteSpace: "nowrap", overflow: "hidden" }}>{b.short}</span>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", flexDirection: "column", marginTop: 14 }}>
                  {reel.beats.map((b, i) => (
                    <div key={`${b.label}-${i}`} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "11px 0", borderTop: "1px solid var(--border-faint)" }}>
                      <span style={{ width: 9, height: 9, borderRadius: 2, flex: "none", background: b.color, marginTop: 5 }} />
                      <div style={{ flex: "none", width: 120 }}>
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.06em" }}>{b.label}</div>
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-faint)", marginTop: 3 }}>
                          {b.start}–{b.end}%
                        </div>
                      </div>
                      {/* Verbatim transcript for this beat when present (the per-beat
                          segmentation); the generic "what this beat does" note drops to a
                          faint super-label. Pre-backfill / speechless beats fall back to
                          just the note — exactly today's view. */}
                      {b.text.trim() ? (
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 11, color: "var(--fg-faint)", marginBottom: 4 }}>{b.note}</div>
                          <div style={{ fontSize: 13.5, color: "var(--fg)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{b.text}</div>
                        </div>
                      ) : (
                        <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--fg-muted)" }}>{b.note}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TRANSCRIPT */}
          {reel.transcript && (
            <div style={{ marginTop: 28 }}>
              <details>
                <summary style={S.summary}>Transcript</summary>
                <pre style={S.transcript}>{reel.transcript}</pre>
              </details>
            </div>
          )}

          {/* WHY IT WORKS */}
          {(reel.whyPull || reel.why) && (
            <div style={{ marginTop: 28 }}>
              <h2 style={{ margin: "0 0 13px", fontWeight: 500, fontSize: 16 }}>Why it works</h2>
              <div style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", borderRadius: 20, padding: "24px 26px" }}>
                {reel.whyPull && (
                  <div style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 21, lineHeight: 1.35, color: "var(--fg)", marginBottom: reel.why ? 14 : 0 }}>
                    {reel.whyPull}
                  </div>
                )}
                {reel.why && <p style={{ margin: 0, fontSize: 14, lineHeight: 1.7, color: "var(--fg-muted)" }}>{reel.why}</p>}
              </div>
            </div>
          )}

          {/* COMMENTS */}
          {commentsToShow.length > 0 && (
            <div style={{ marginTop: 28 }}>
              <SectionHead
                title={commentsHeading}
                meta={`${questions.length ? `${questions.length} questions · ` : ""}${fmt(reel.comments)} comments`}
              />
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {commentsToShow.map((c, i) => (
                  <div key={i} style={S.faqCard}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 11 }}>
                      <span style={{ fontFamily: "var(--font-serif)", fontSize: 26, lineHeight: 0.8, color: "var(--accent)", flex: "none" }}>
                        {c.isQuestion ? "?" : "“"}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 500, color: "var(--fg)", lineHeight: 1.4 }}>{c.text}</div>
                        {c.username && (
                          <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-faint)", marginTop: 6 }}>@{c.username}</div>
                        )}
                      </div>
                      <span style={S.faqCount}>{c.likes} likes</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* YOUR VERSION */}
          <div style={{ marginTop: 30 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 13 }}>
              <h2 style={{ margin: 0, fontWeight: 500, fontSize: 16 }}>Your version</h2>
              <span style={{ ...micro(10), letterSpacing: "0.1em" }}>Editable draft</span>
            </div>
            <div style={{ border: "1px solid var(--accent)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ background: "var(--warning)", padding: "11px 18px", display: "flex", alignItems: "center", gap: 9 }}>
                <Icon name="sparkle" size={14} stroke="var(--accent)" sw={2} />
                <span style={{ fontSize: 12.5, color: "var(--fg)" }}>Seeded from this Reel. Edit any field; drafts stay local to this session.</span>
              </div>
              <div style={{ background: "var(--bg-elevated)", padding: 20 }}>
                <div style={{ ...micro(9), letterSpacing: "0.14em", marginBottom: 7 }}>Hook · first 3 seconds</div>
                <input value={remixHook} onChange={(e) => onHook(e.target.value)} style={S.remixInput} />
                {reel.beats.length > 0 && (
                  <>
                    <div style={{ ...micro(9), letterSpacing: "0.14em", margin: "18px 0 9px" }}>Beat outline</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {reel.beats.map((b, i) => (
                        <div key={`${b.label}-${i}`} style={{ display: "flex", alignItems: "flex-start", gap: 11 }}>
                          <span style={S.beatTag}>{b.label}</span>
                          <span style={{ fontSize: 13.5, color: "var(--fg)", lineHeight: 1.5 }}>{b.note}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                <div style={{ ...micro(9), letterSpacing: "0.14em", margin: "18px 0 9px" }}>Caption draft</div>
                <textarea value={remixCaption} onChange={(e) => onCaption(e.target.value)} rows={3} style={S.remixTextarea} />
                <div style={{ display: "flex", gap: 9, marginTop: 16, alignItems: "center" }}>
                  <button onClick={onCopy} style={S.copyBtn} className="mc-press">
                    {copied ? "Copied" : "Copy draft"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function SectionHead({ title, meta }: { title: string; meta: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 13 }}>
      <h2 style={{ margin: 0, fontWeight: 500, fontSize: 16 }}>{title}</h2>
      <span style={{ ...micro(10), letterSpacing: "0.1em" }}>{meta}</span>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ background: "var(--bg-elevated)", padding: "12px 13px" }}>
      <div style={{ ...micro(9), letterSpacing: "0.1em" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 18, marginTop: 3, color: accent ? "var(--accent)" : "var(--fg)" }}>{value}</div>
    </div>
  );
}

// ════════════════════════════ CREATORS ════════════════════════════

function CreatorsView({
  creators,
  onOpenReel,
  onOpenCreator,
}: {
  creators: CreatorVM[];
  onOpenReel: (s: string) => void;
  onOpenCreator: (handle: string) => void;
}) {
  return (
    <section className="mc-up" style={{ padding: "26px 28px 60px" }}>
      <div style={{ ...micro(10), letterSpacing: "0.16em", marginBottom: 6 }}>Tracked accounts</div>
      <h1 style={{ ...S.h1, marginBottom: 4 }}>Creators</h1>
      <p style={{ margin: "0 0 24px", fontSize: 13, color: "var(--fg-muted)" }}>The accounts you model. Performance is creator-relative.</p>
      {creators.length === 0 ? (
        <div style={S.empty}>No creators yet. Run a scrape to populate the Content Store.</div>
      ) : (
        <div style={S.creatorGrid}>
          {creators.map((c) => (
            <div key={c.handle} style={S.creatorCard}>
              <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
                <div style={{ ...S.avatar, width: 46, height: 46, fontSize: 16 }}>{c.initials}</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 16, fontWeight: 500 }}>{c.name}</span>
                    {c.verified && <Icon name="verified" size={14} />}
                  </div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-faint)" }}>@{c.handle}</div>
                </div>
                <button onClick={() => onOpenCreator(c.handle)} style={S.viewReelsBtn} className="mc-press">
                  View Reels →
                </button>
              </div>
              {c.bio && <p style={{ margin: "13px 0 0", fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.55 }}>{c.bio}</p>}
              <div style={S.creatorStatGrid}>
                <CreatorStat value={fmt(c.followers)} label="Followers" />
                <CreatorStat value={c.growth != null ? `${c.growth >= 0 ? "+" : ""}${fmt(c.growth)}` : "—"} label="30d" sage />
                <CreatorStat value={String(c.analyzed)} label="Analyzed" />
                <CreatorStat value={String(c.outliers)} label="Outliers" accent />
              </div>
              {c.top.length > 0 && (
                <>
                  <div style={{ ...micro(9), letterSpacing: "0.12em", margin: "17px 0 9px" }}>Top performing</div>
                  <div style={{ display: "flex", gap: 9 }}>
                    {c.top.map((t) => (
                      <div key={t.shortcode} onClick={() => onOpenReel(t.shortcode)} style={{ cursor: "pointer", flex: 1, minWidth: 0 }}>
                        <div style={{ position: "relative", aspectRatio: "9 / 13", borderRadius: 2, overflow: "hidden", background: "var(--bg-deep)" }}>
                          <div style={thumb(t.thumbUrl, { width: "100%", height: "100%" })} />
                        </div>
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--accent)", marginTop: 5 }}>{fmt(t.performance)}</div>
                        <div style={S.topTopic}>{t.topic ?? "—"}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function CreatorStat({ value, label, accent, sage }: { value: string; label: string; accent?: boolean; sage?: boolean }) {
  return (
    <div style={{ background: "var(--bg-surface)", padding: "11px 12px" }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 16, color: accent ? "var(--accent)" : sage ? "var(--sage-muted)" : "var(--fg)" }}>{value}</div>
      <div style={{ ...micro(8), letterSpacing: "0.1em", marginTop: 3 }}>{label}</div>
    </div>
  );
}

// ════════════════════════════ RUNS ════════════════════════════

function RunsView({
  runAction,
  setRunAction,
  runCreator,
  setRunCreator,
  isRunning,
  run,
  results,
  error,
  now,
  onStart,
  onOpenReel,
  reelByShortcode,
}: {
  runAction: Action;
  setRunAction: (a: Action) => void;
  runCreator: string;
  setRunCreator: (s: string) => void;
  isRunning: boolean;
  run: RunRecord | null;
  results: ResultsPayload | null;
  error: string | null;
  now: number;
  onStart: () => void;
  onOpenReel: (s: string) => void;
  reelByShortcode: Map<string, ReelVM>;
}) {
  const elapsedMs = run ? (run.finished_at ? Date.parse(run.finished_at) : now) - Date.parse(run.started_at) : 0;
  const analyzedRows = (results?.rows ?? [])
    .filter((r) => r.analysis_status === "analyzed")
    .sort((a, b) => (b.analyzed_at ?? "").localeCompare(a.analyzed_at ?? ""));

  return (
    <section className="mc-up" style={{ padding: "26px 28px 60px", maxWidth: 920 }}>
      <div style={{ ...micro(10), letterSpacing: "0.16em", marginBottom: 6 }}>Pipeline</div>
      <h1 style={{ ...S.h1, marginBottom: 4 }}>Runs</h1>
      <p style={{ margin: "0 0 24px", fontSize: 13, color: "var(--fg-muted)" }}>Pull fresh Reels and analyze them. One run at a time.</p>

      <div style={S.panel}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <div style={{ ...micro(9), letterSpacing: "0.12em", marginBottom: 7 }}>Action</div>
            <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 2, overflow: "hidden" }}>
              {RUN_ACTIONS.map((a) => (
                <button key={a.value} onClick={() => setRunAction(a.value)} disabled={isRunning} style={segStyle(runAction === a.value)}>
                  {a.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ ...micro(9), letterSpacing: "0.12em", marginBottom: 7 }}>Creator</div>
            <input
              value={runCreator}
              onChange={(e) => setRunCreator(e.target.value)}
              placeholder="all creators"
              disabled={isRunning}
              style={S.runInput}
            />
          </div>
          <button onClick={onStart} disabled={isRunning} style={startBtnStyle(isRunning)}>
            {isRunning ? "Running…" : "Start run"}
          </button>
        </div>
        <div style={{ fontSize: 12, color: "var(--fg-faint)", marginTop: 12, lineHeight: 1.5 }}>
          Caps: scrape window + cap, analyze newest first, refresh uncapped and cheap. Already-analyzed Reels are skipped.
        </div>
      </div>

      {error && <div style={S.runError}>{error}</div>}

      {run ? (
        <div style={{ marginTop: 22 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>{run.action}</span>
            <span style={{ fontSize: 13, color: "var(--fg-muted)" }}>@{run.creator ?? "—"}</span>
            <StatusBadge status={run.status} />
            <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-muted)" }}>{formatElapsed(elapsedMs)}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 15 }}>
            {run.steps.map((s) => (
              <StepBar key={s.stage} step={s} />
            ))}
          </div>
          {run.status === "succeeded" && run.result && <div style={S.runSummary}>{summarize(run.result)}</div>}
          {run.status === "failed" && run.error && <div style={S.runError}>Run failed: {run.error}</div>}

          <div style={{ marginTop: 26 }}>
            <SectionHead
              title="Live results"
              meta={results ? `${results.counts.analyzed} analyzed · ${results.counts.pending} pending` : ""}
            />
            {analyzedRows.length === 0 ? (
              <p style={{ fontSize: 13, color: "var(--fg-faint)" }}>Analyzed Reels appear here as each completes.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {analyzedRows.map((r) => (
                  <div key={r.shortcode} onClick={() => onOpenReel(r.shortcode)} style={S.runResultRow} className="mc-press">
                    <div style={thumb(r.has_thumbnail ? `/api/thumbnails/${r.shortcode}` : "", { width: 32, height: 42, borderRadius: 2 })} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.topic ?? "—"}</div>
                      <div style={{ display: "flex", gap: 8, marginTop: 3 }}>
                        {r.hook_technique && <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--accent)", textTransform: "uppercase" }}>{reelByShortcode.get(r.shortcode)?.hookLabel ?? r.hook_technique}</span>}
                        {r.category && <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>{reelByShortcode.get(r.shortcode)?.categoryLabel ?? r.category}</span>}
                      </div>
                    </div>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--success-fg)", background: "var(--success)", padding: "3px 8px", borderRadius: 999 }}>analyzed</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <p style={{ fontSize: 13, color: "var(--fg-faint)", marginTop: 22 }}>No runs yet. Start one above.</p>
      )}
    </section>
  );
}

function StepBar({ step }: { step: RunStep }) {
  const indeterminate = step.status === "running" && step.total === 0;
  const pct = step.total > 0 ? Math.min(100, Math.round((step.done / step.total) * 100)) : step.status === "done" ? 100 : 0;
  const meta =
    step.status === "pending"
      ? "pending"
      : indeterminate
        ? "working…"
        : step.total > 0
          ? `${step.done}/${step.total} (${pct}%)`
          : step.status;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
        <span style={{ fontWeight: 500 }}>{STAGE_LABEL[step.stage]}</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)" }}>
          {meta}
          {step.status === "done" ? " ✓" : step.status === "failed" ? " ✗" : ""}
        </span>
      </div>
      <div style={{ height: 9, borderRadius: 999, background: "var(--border-faint)", overflow: "hidden", position: "relative" }}>
        {indeterminate ? (
          <div style={{ position: "absolute", top: 0, bottom: 0, width: "25%", borderRadius: 999, background: "var(--accent)", animation: "mc-indet 1.1s ease-in-out infinite" }} />
        ) : (
          <div
            style={{
              height: "100%",
              width: `${pct}%`,
              borderRadius: 999,
              transition: "width 0.25s ease",
              background: step.status === "failed" ? "var(--error-fg)" : step.status === "done" ? "var(--sage-muted)" : "var(--accent)",
            }}
          />
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: RunStatus }) {
  const map: Record<RunStatus, CSSProperties> = {
    running: { background: "var(--info)", color: "var(--info-fg)" },
    queued: { background: "var(--bg-deep)", color: "var(--fg-muted)" },
    succeeded: { background: "var(--success)", color: "var(--success-fg)" },
    failed: { background: "var(--error)", color: "var(--error-fg)" },
  };
  return (
    <span style={{ ...map[status], fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", padding: "4px 9px", borderRadius: 999 }}>
      {status}
    </span>
  );
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

function summarize(r: PipelineResultLike): string {
  const parts: string[] = ["Run complete."];
  if (r.scrape) parts.push(`scraped ${r.scrape.reelsReturned} (${r.scrape.reelsUpserted} upserted${r.scrape.droppedOverCap > 0 ? `, ${r.scrape.droppedOverCap} over cap` : ""})`);
  if (r.analyze) parts.push(`analyzed ${r.analyze.analyzed}, skipped ${r.analyze.skipped}, failed ${r.analyze.failed}`);
  if (r.refresh) parts.push(`refreshed ${r.refresh.reelsRefreshed}`);
  return parts.join(" · ");
}

// ════════════════════════════ SHARED STYLE HELPERS ════════════════════════════

function micro(size: number): CSSProperties {
  return { fontFamily: "var(--font-mono)", fontSize: size, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--fg-faint)" };
}

function pillStyle(active: boolean): CSSProperties {
  return {
    padding: "5px 11px",
    borderRadius: 999,
    border: active ? "1px solid var(--fg)" : "1px solid var(--border)",
    background: active ? "var(--fg)" : "transparent",
    color: active ? "var(--bg)" : "var(--fg-muted)",
    fontSize: 12,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

function segStyle(active: boolean): CSSProperties {
  return {
    padding: "7px 11px",
    border: "none",
    borderRight: "1px solid var(--border)",
    cursor: "pointer",
    fontSize: 12,
    background: active ? "var(--fg)" : "var(--bg-elevated)",
    color: active ? "var(--bg)" : "var(--fg-muted)",
    display: "flex",
    alignItems: "center",
    gap: 6,
  };
}

function navItemStyle(active: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 11,
    padding: "9px 12px",
    borderRadius: 2,
    cursor: "pointer",
    fontSize: 13.5,
    fontWeight: active ? 500 : 400,
    color: active ? "var(--fg)" : "var(--fg-muted)",
    background: active ? "var(--glass)" : "transparent",
    borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
  };
}

function startBtnStyle(running: boolean): CSSProperties {
  return {
    padding: "9px 18px",
    borderRadius: 2,
    border: "none",
    fontSize: 13,
    fontWeight: 500,
    background: running ? "var(--border)" : "var(--accent)",
    color: "#fff",
    cursor: running ? "not-allowed" : "pointer",
  };
}

function thumb(url: string, extra: CSSProperties): CSSProperties {
  return {
    backgroundImage: url ? `url("${url}")` : undefined,
    backgroundSize: "cover",
    backgroundPosition: "center",
    backgroundColor: "var(--bg-deep)",
    flex: "none",
    ...extra,
  };
}

// ── Inline SVG icon set (matches the design comp's line icons) ──
type IconName =
  | "sparkle"
  | "grid"
  | "users"
  | "arrow"
  | "search"
  | "chevron"
  | "message"
  | "back"
  | "bolt"
  | "verified";

function Icon({ name, size = 16, stroke = "currentColor", sw = 2 }: { name: IconName; size?: number; stroke?: string; sw?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none" as const };
  const lineProps = { stroke, strokeWidth: sw, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "sparkle":
      return (
        <svg {...common} {...lineProps}>
          <path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z" />
        </svg>
      );
    case "grid":
      return (
        <svg {...common} {...lineProps}>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      );
    case "users":
      return (
        <svg {...common} {...lineProps}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case "arrow":
      return (
        <svg {...common} {...lineProps}>
          <path d="M5 12h14" />
          <path d="M12 5l7 7-7 7" />
        </svg>
      );
    case "search":
      return (
        <svg {...common} {...lineProps}>
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
      );
    case "chevron":
      return (
        <svg {...common} {...lineProps}>
          <path d="M9 18l6-6-6-6" />
        </svg>
      );
    case "message":
      return (
        <svg {...common} {...lineProps}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case "back":
      return (
        <svg {...common} {...lineProps}>
          <path d="M15 18l-6-6 6-6" />
        </svg>
      );
    case "bolt":
      return (
        <svg {...common} {...lineProps}>
          <path d="M13 2L3 14h9l-1 8 10-12h-9z" />
        </svg>
      );
    case "verified":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="var(--accent)" stroke="none">
          <path d="M12 2l2.4 1.8 3-.3 1.2 2.8 2.6 1.5-.6 2.9 1.8 2.3-1.8 2.3.6 2.9-2.6 1.5-1.2 2.8-3-.3L12 22l-2.4-1.8-3 .3-1.2-2.8L2.8 16l.6-2.9L1.6 12l1.8-2.3-.6-2.9 2.6-1.5L6.6 2.5l3 .3z" />
          <path d="M9 12l2 2 4-4" stroke="#fff" strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}

// ── Static structural styles ──
const S: Record<string, CSSProperties> = {
  app: { display: "flex", minHeight: "100vh", background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-sans)" },
  main: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" },

  sidebar: {
    width: 250,
    flex: "none",
    borderRight: "1px solid var(--border-faint)",
    height: "100vh",
    position: "sticky",
    top: 0,
    display: "flex",
    flexDirection: "column",
    background: "var(--bg)",
  },
  logoMark: { width: 30, height: 30, borderRadius: 2, background: "var(--fg)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" },
  sidebarFooter: { marginTop: "auto", padding: "16px 16px 18px", borderTop: "1px solid var(--border-faint)" },
  avatar: { width: 26, height: 26, borderRadius: 999, background: "var(--warning)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600, flex: "none" },
  themeBtn: { width: "100%", display: "flex", alignItems: "center", gap: 8, justifyContent: "center", padding: "8px 10px", border: "1px solid var(--border)", background: "transparent", borderRadius: 2, cursor: "pointer" },

  h1: { margin: 0, fontWeight: 300, fontSize: 30, letterSpacing: "-0.02em" },

  libHeader: { padding: "26px 28px 0", display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 20, flexWrap: "wrap" },
  searchWrap: { display: "flex", alignItems: "center", gap: 7, border: "1px solid var(--border)", borderRadius: 2, padding: "7px 11px", background: "var(--bg-elevated)" },
  searchInput: { border: "none", background: "transparent", outline: "none", color: "var(--fg)", fontSize: 13, width: 210 },
  controls: { padding: "18px 28px 14px", display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap", borderBottom: "1px solid var(--border-faint)", position: "sticky", top: 0, background: "var(--bg)", zIndex: 5 },
  creatorChip: { display: "flex", alignItems: "center", gap: 6, border: "1px solid var(--accent)", color: "var(--accent)", background: "var(--warning)", borderRadius: 999, padding: "5px 11px", fontSize: 12, cursor: "pointer" },
  rowStyleSeg: { marginLeft: "auto", display: "flex", border: "1px solid var(--border)", borderRadius: 2, overflow: "hidden" },
  chipRow: { padding: "12px 28px", display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", borderBottom: "1px solid var(--border-faint)" },
  empty: { padding: "60px 28px", textAlign: "center", color: "var(--fg-muted)", fontSize: 14 },

  signalRow: { display: "flex", gap: 16, alignItems: "center", padding: "15px 28px", borderBottom: "1px solid var(--border-faint)", cursor: "pointer" },
  durBadge: { position: "absolute", bottom: 0, left: 0, right: 0, padding: "3px 0 2px", textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: "0.1em", color: "#fff", background: "linear-gradient(transparent, rgba(0,0,0,0.55))" },
  signalTopic: { fontWeight: 500, fontSize: 15, color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 380 },
  signalCaption: { fontSize: 12, color: "var(--fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 480, marginTop: 2 },
  catBadge: { fontSize: 11, fontWeight: 500, color: "var(--fg-muted)", background: "var(--bg-deep)", padding: "2px 8px", borderRadius: 999 },

  gallery: { padding: "22px 28px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(208px, 1fr))", gap: 18 },
  galleryCard: { cursor: "pointer", border: "1px solid var(--border-faint)", borderRadius: 2, overflow: "hidden", background: "var(--bg-elevated)" },
  galleryBeatGrad: { position: "absolute", left: 0, right: 0, bottom: 0, padding: "26px 10px 9px", background: "linear-gradient(transparent, rgba(0,0,0,0.7))" },
  galleryTopic: { fontSize: 13.5, fontWeight: 500, lineHeight: 1.25, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: 34 },
  galleryFooter: { display: "flex", alignItems: "center", gap: 12, marginTop: 8, paddingTop: 9, borderTop: "1px solid var(--border-faint)", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-muted)" },

  detailBar: { padding: "18px 28px", borderBottom: "1px solid var(--border-faint)", position: "sticky", top: 0, background: "var(--bg)", zIndex: 5, display: "flex", alignItems: "center", gap: 14 },
  backBtn: { display: "flex", alignItems: "center", gap: 7, border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--fg-muted)", borderRadius: 2, padding: "7px 12px", fontSize: 12, cursor: "pointer" },
  igLink: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 7, textDecoration: "none", color: "var(--bg)", background: "var(--fg)", borderRadius: 2, padding: "8px 14px", fontSize: 12.5, fontWeight: 500 },
  detailBody: { display: "flex", gap: 34, padding: "30px 28px", alignItems: "flex-start", maxWidth: 1280 },
  detailRail: { width: 264, flex: "none", position: "sticky", top: 90 },
  statGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, marginTop: 16, background: "var(--border-faint)", border: "1px solid var(--border-faint)", borderRadius: 2, overflow: "hidden" },
  panel: { background: "var(--bg-elevated)", border: "1px solid var(--border-faint)", borderRadius: 2, padding: 18 },
  summary: { cursor: "pointer", color: "var(--fg-muted)", fontSize: 13, padding: "8px 0", userSelect: "none" },
  transcript: { margin: "8px 0 0", whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--fg-muted)", background: "var(--bg-elevated)", border: "1px solid var(--border-faint)", borderRadius: 2, padding: "14px 16px", maxHeight: 280, overflow: "auto", lineHeight: 1.6 },
  faqCard: { background: "var(--bg-elevated)", border: "1px solid var(--border-faint)", borderRadius: 2, padding: "15px 17px" },
  faqCount: { fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-faint)", background: "var(--bg-deep)", padding: "4px 8px", borderRadius: 999, flex: "none", whiteSpace: "nowrap" },
  remixInput: { width: "100%", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", borderRadius: 2, padding: "12px 14px", fontSize: 16, fontWeight: 500, outline: "none" },
  remixTextarea: { width: "100%", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", borderRadius: 2, padding: "12px 14px", fontSize: 13.5, lineHeight: 1.6, outline: "none" },
  beatTag: { fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.06em", color: "var(--bg)", background: "var(--fg)", padding: "3px 7px", borderRadius: 2, flex: "none", marginTop: 1 },
  copyBtn: { display: "flex", alignItems: "center", gap: 7, background: "var(--fg)", color: "var(--bg)", border: "none", borderRadius: 2, padding: "9px 16px", fontSize: 13, fontWeight: 500, cursor: "pointer" },

  creatorGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(420px, 1fr))", gap: 18 },
  creatorCard: { border: "1px solid var(--border-faint)", borderRadius: 2, background: "var(--bg-elevated)", padding: 20, display: "flex", flexDirection: "column" },
  viewReelsBtn: { border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg-muted)", borderRadius: 2, padding: "7px 12px", fontSize: 12, cursor: "pointer", flex: "none" },
  creatorStatGrid: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 1, marginTop: 17, background: "var(--border-faint)", border: "1px solid var(--border-faint)", borderRadius: 2, overflow: "hidden" },
  topTopic: { fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" },

  runInput: { border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", borderRadius: 2, padding: "9px 12px", fontSize: 13, outline: "none", width: 200 },
  runError: { marginTop: 16, fontSize: 13, color: "var(--error-fg)", background: "var(--error)", borderRadius: 2, padding: "11px 14px" },
  runSummary: { marginTop: 16, fontSize: 13, color: "var(--success-fg)", background: "var(--success)", borderRadius: 2, padding: "11px 14px" },
  runResultRow: { display: "flex", alignItems: "center", gap: 12, border: "1px solid var(--border-faint)", borderRadius: 2, padding: "9px 12px", cursor: "pointer", background: "var(--bg-elevated)" },
};
