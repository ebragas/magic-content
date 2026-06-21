// Dashboard read view (Slice 3, MAIN-959). A server component that reads the
// Content Store via lib/core Store helpers (server-side only — better-sqlite3) and
// lists every Reel: thumbnail, raw metrics, derived metrics, the Outlier flag, and
// a link back to the original Reel on Instagram.
//
// READ-ONLY: no run trigger, no analysis columns yet (Slices 4 & 6). Sort by
// Performance (?sort=performance) and filter by Virality (?viral=1) are driven by
// query-param links — zero client JS. NULL derived metrics render as "—" and sort
// last (the Store enforces NULLs-last); they are NEVER shown as 0.

import React from "react";
import { getDashboardData, parseSortKey, type SortKey } from "./dashboard-data.js";
import { RunPipelineButton } from "./RunPipelineButton.js";
import type { AnalysisStatus, Beat, ReelRow } from "../lib/core/types.js";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{
    sort?: string;
    viral?: string;
    creator?: string;
    category?: string;
  }>;
}

/** Render a numeric derived/raw metric, honoring the NULL rule: NULL → "—". */
function num(value: number | null | undefined, opts?: { decimals?: number }): string {
  if (value == null) return "—";
  if (opts?.decimals != null) return value.toFixed(opts.decimals);
  // Integer-ish metrics get thousands separators; keep small decimals readable.
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString();
}

/** is_viral / is_outlier are 0/1/NULL. NULL → "—" (never 0 dressed up). */
function boolFlag(value: number | null | undefined): "yes" | "no" | "na" {
  if (value == null) return "na";
  return value === 1 ? "yes" : "no";
}

function buildHref(
  sort: SortKey,
  viralOnly: boolean,
  creator?: string,
  category?: string,
): string {
  const params = new URLSearchParams();
  if (sort !== "posted_at") params.set("sort", sort);
  if (viralOnly) params.set("viral", "1");
  if (creator) params.set("creator", creator);
  if (category) params.set("category", category);
  const qs = params.toString();
  return qs ? `/?${qs}` : "/";
}

/**
 * Human label for a Category slug, resolved from the authored names in
 * config/categories.yaml (the single source of truth the analysis prompt is
 * parameterized from), e.g. story_personal → "Story/Personal". A pure lookup over
 * the map assembled in getDashboardData; falls back to title-casing the slug ONLY
 * for a slug not present in config (defensive — should not happen for stored Reels).
 */
function categoryLabel(slug: string, names: Record<string, string>): string {
  return (
    names[slug] ??
    slug
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ")
  );
}

export default async function HomePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const sort = parseSortKey(sp.sort);
  const viralOnly = sp.viral === "1";
  const creator = sp.creator?.trim() || undefined;
  const category = sp.category?.trim() || undefined;

  const data = getDashboardData({ sort, viralOnly, creator, category });

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.h1}>Magic Content</h1>
          <p style={styles.subtitle}>
            {data.total} Reel{data.total === 1 ? "" : "s"} in the Content Store
            {creator ? ` · @${creator}` : ""}
            {category ? ` · ${categoryLabel(category, data.categoryNames)}` : ""}
          </p>
        </div>
        {/* Client island: the only client-side JS on the page (table stays SSR). */}
        <RunPipelineButton defaultCreator={creator} />
      </header>

      <section style={styles.controls} aria-label="sort and filter">
        <div style={styles.controlGroup}>
          <span style={styles.controlLabel}>Sort</span>
          <SortLink label="Newest" target="posted_at" current={sort} viralOnly={viralOnly} creator={creator} category={category} />
          <SortLink label="Performance" target="performance" current={sort} viralOnly={viralOnly} creator={creator} category={category} />
          <SortLink label="Virality" target="virality" current={sort} viralOnly={viralOnly} creator={creator} category={category} />
          <SortLink label="Category" target="category" current={sort} viralOnly={viralOnly} creator={creator} category={category} />
        </div>
        <div style={styles.controlGroup}>
          <span style={styles.controlLabel}>Filter</span>
          <a
            href={buildHref(sort, false, creator, category)}
            style={!viralOnly ? styles.pillActive : styles.pill}
          >
            All
          </a>
          <a
            href={buildHref(sort, true, creator, category)}
            style={viralOnly ? styles.pillActive : styles.pill}
          >
            Viral only
          </a>
        </div>
        <div style={styles.controlGroup}>
          <span style={styles.controlLabel}>Category</span>
          <a
            href={buildHref(sort, viralOnly, creator, undefined)}
            style={!category ? styles.pillActive : styles.pill}
          >
            All
          </a>
          {data.categoriesPresent.map((slug) => (
            <a
              key={slug}
              href={buildHref(sort, viralOnly, creator, slug)}
              style={category === slug ? styles.pillActive : styles.pill}
            >
              {categoryLabel(slug, data.categoryNames)}
            </a>
          ))}
        </div>
      </section>

      {data.total === 0 ? (
        <p style={styles.empty}>
          No Reels yet. Run a scrape to populate the Content Store, then refresh this
          page.
        </p>
      ) : (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Thumb</th>
                <th style={styles.thLeft}>Reel</th>
                <th style={styles.th}>Likes</th>
                <th style={styles.th}>Comments</th>
                <th style={styles.th}>Views</th>
                <th style={styles.th}>Shares</th>
                <th style={styles.th}>Performance</th>
                <th style={styles.th}>Engagement</th>
                <th style={styles.th}>Engagement vs followers</th>
                <th style={styles.th}>Viral</th>
                <th style={styles.th}>Outlier</th>
                <th style={styles.thLeft}>Topic</th>
                <th style={styles.thLeft}>Category</th>
                <th style={styles.th}>Analysis</th>
                <th style={styles.th}>Link</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map(({ reel, followers, creatorName }) => (
                <React.Fragment key={reel.shortcode}>
                  <tr style={styles.tr}>
                    <td style={styles.tdThumb}>
                      {/* Points at the streaming route; 404s degrade to alt text. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/thumbnails/${reel.shortcode}`}
                        alt={reel.shortcode}
                        width={64}
                        height={96}
                        style={styles.thumb}
                      />
                    </td>
                    <td style={styles.tdLeft}>
                      <div style={styles.creator}>{creatorName}</div>
                      <div style={styles.caption} title={reel.caption ?? ""}>
                        {truncate(reel.caption, 70)}
                      </div>
                      <div style={styles.shortcode}>{reel.shortcode}</div>
                    </td>
                    <td style={styles.td}>{num(reel.likes)}</td>
                    <td style={styles.td}>{num(reel.comments_count)}</td>
                    <td style={styles.td}>{num(reel.views)}</td>
                    <td style={styles.td}>{num(reel.shares)}</td>
                    <td style={styles.tdStrong}>{num(reel.performance_score, { decimals: 0 })}</td>
                    <td style={styles.td}>{num(reel.engagement_rate, { decimals: 4 })}</td>
                    <td style={styles.td}>{followerRelative(reel.performance_score, followers)}</td>
                    <td style={styles.td}>
                      <Flag state={boolFlag(reel.is_viral)} yes="Viral" />
                    </td>
                    <td style={styles.td}>
                      <Flag state={boolFlag(reel.is_outlier)} yes="Outlier" />
                    </td>
                    <td style={styles.tdLeft}>{textOrDash(reel.topic)}</td>
                    <td style={styles.tdLeft}>
                      {reel.category ? (
                        <span style={styles.catBadge}>{categoryLabel(reel.category, data.categoryNames)}</span>
                      ) : (
                        <span style={styles.muted}>—</span>
                      )}
                    </td>
                    <td style={styles.td}>
                      <AnalysisBadge status={reel.analysis_status} />
                    </td>
                    <td style={styles.td}>
                      <a href={reel.url} target="_blank" rel="noopener noreferrer" style={styles.link}>
                        Open ↗
                      </a>
                    </td>
                  </tr>
                  <AnalysisDetailRow reel={reel} colSpan={15} />
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function SortLink({
  label,
  target,
  current,
  viralOnly,
  creator,
  category,
}: {
  label: string;
  target: SortKey;
  current: SortKey;
  viralOnly: boolean;
  creator?: string;
  category?: string;
}) {
  const active = target === current;
  return (
    <a
      href={buildHref(target, viralOnly, creator, category)}
      style={active ? styles.pillActive : styles.pill}
    >
      {label}
    </a>
  );
}

/** Outlier / Viral badge. "na" → em-dash (the NULL rule), never a misleading "no". */
function Flag({ state, yes }: { state: "yes" | "no" | "na"; yes: string }) {
  if (state === "na") return <span style={styles.muted}>—</span>;
  if (state === "no") return <span style={styles.muted}>no</span>;
  return <span style={styles.badge}>{yes}</span>;
}

/** "X vs Y followers" — follower-relative figure from the LATEST Creator Snapshot.
 *  Either side NULL → "—" (NULL rule), never a fake 0. */
function followerRelative(
  performance: number | null,
  followers: number | null,
): string {
  if (performance == null || followers == null) return "—";
  return `${Math.round(performance).toLocaleString()} vs ${followers.toLocaleString()}`;
}

function truncate(text: string | null, max: number): string {
  if (!text) return "—";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Free-form analysis text cell: truncated topic, or em-dash when empty. */
function textOrDash(text: string | null): React.ReactNode {
  if (!text || !text.trim()) return <span style={styles.muted}>—</span>;
  return <span title={text}>{truncate(text, 48)}</span>;
}

/** analysis_status badge: pending / analyzed / failed / skipped (NULL → pending). */
function AnalysisBadge({ status }: { status: AnalysisStatus | null }) {
  const s = status ?? "pending";
  const style =
    s === "analyzed"
      ? styles.statusAnalyzed
      : s === "failed"
        ? styles.statusFailed
        : styles.statusPending;
  return <span style={style}>{s}</span>;
}

/**
 * Expandable per-Reel detail row (zero client JS — a native <details>). Surfaces the
 * analysis lean-core that doesn't fit the table: verbatim transcript, Topic,
 * why-it-works, and the beat sequence. Hidden until analysis exists.
 */
function AnalysisDetailRow({ reel, colSpan }: { reel: ReelRow; colSpan: number }) {
  const beats = parseBeats(reel.beat_sequence);
  const hasAnalysis =
    reel.analysis_status === "analyzed" ||
    !!reel.transcript ||
    !!reel.why_it_works ||
    !!reel.topic;

  if (!hasAnalysis && !reel.analysis_error) {
    // Nothing to expand yet (un-analyzed Reel); keep the row out of the DOM.
    return null;
  }

  return (
    <tr style={styles.detailTr}>
      <td colSpan={colSpan} style={styles.detailTd}>
        <details>
          <summary style={styles.detailSummary}>
            Analysis {reel.analyzed_at ? `· ${reel.analyzed_at.slice(0, 10)}` : ""}
          </summary>
          <div style={styles.detailBody}>
            {reel.analysis_error ? (
              <div style={styles.detailError}>Error: {reel.analysis_error}</div>
            ) : null}
            {reel.topic ? (
              <div style={styles.detailBlock}>
                <span style={styles.detailLabel}>Topic</span>
                <div>{reel.topic}</div>
              </div>
            ) : null}
            {reel.why_it_works ? (
              <div style={styles.detailBlock}>
                <span style={styles.detailLabel}>Why it works</span>
                <div>{reel.why_it_works}</div>
              </div>
            ) : null}
            {beats.length ? (
              <div style={styles.detailBlock}>
                <span style={styles.detailLabel}>Beats</span>
                <div style={styles.beats}>
                  {beats.map((b, i) => (
                    <span key={`${b.label}-${i}`} style={styles.beatChip}>
                      {b.label} {Math.round(b.start_pct)}–{Math.round(b.end_pct)}%
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            {reel.transcript ? (
              <div style={styles.detailBlock}>
                <span style={styles.detailLabel}>Transcript</span>
                <pre style={styles.transcript}>{reel.transcript}</pre>
              </div>
            ) : null}
          </div>
        </details>
      </td>
    </tr>
  );
}

/** Decode the beat_sequence JSON column; tolerate bad/empty JSON → []. */
function parseBeats(json: string | null): Beat[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Beat[]) : [];
  } catch {
    return [];
  }
}

// --- Inline styles (Slice 3 is a single page; no design-system dependency yet) ---

const styles: Record<string, React.CSSProperties> = {
  main: { fontFamily: "system-ui, -apple-system, sans-serif", padding: "2rem", color: "#111", maxWidth: 1400, margin: "0 auto" },
  header: { marginBottom: "1.25rem", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1.5rem", flexWrap: "wrap" },
  h1: { margin: 0, fontSize: "1.6rem" },
  subtitle: { margin: "0.25rem 0 0", color: "#666", fontSize: "0.9rem" },
  controls: { display: "flex", gap: "2rem", alignItems: "center", marginBottom: "1.25rem", flexWrap: "wrap" },
  controlGroup: { display: "flex", gap: "0.4rem", alignItems: "center" },
  controlLabel: { fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "#999", marginRight: "0.25rem" },
  pill: { padding: "0.3rem 0.7rem", borderRadius: 999, border: "1px solid #ddd", background: "#fff", color: "#333", textDecoration: "none", fontSize: "0.85rem" },
  pillActive: { padding: "0.3rem 0.7rem", borderRadius: 999, border: "1px solid #111", background: "#111", color: "#fff", textDecoration: "none", fontSize: "0.85rem" },
  empty: { color: "#666", fontSize: "0.95rem", padding: "2rem 0" },
  tableWrap: { overflowX: "auto", border: "1px solid #eee", borderRadius: 8 },
  table: { borderCollapse: "collapse", width: "100%", fontSize: "0.85rem" },
  th: { textAlign: "right", padding: "0.6rem 0.75rem", borderBottom: "2px solid #eee", background: "#fafafa", whiteSpace: "nowrap", fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "#888" },
  thLeft: { textAlign: "left", padding: "0.6rem 0.75rem", borderBottom: "2px solid #eee", background: "#fafafa", fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "#888" },
  tr: { borderBottom: "1px solid #f2f2f2" },
  td: { textAlign: "right", padding: "0.5rem 0.75rem", whiteSpace: "nowrap", verticalAlign: "top" },
  tdStrong: { textAlign: "right", padding: "0.5rem 0.75rem", whiteSpace: "nowrap", fontWeight: 600, verticalAlign: "top" },
  tdLeft: { textAlign: "left", padding: "0.5rem 0.75rem", maxWidth: 280, verticalAlign: "top" },
  tdThumb: { padding: "0.5rem 0.75rem", verticalAlign: "top" },
  thumb: { width: 64, height: 96, objectFit: "cover", borderRadius: 4, background: "#f0f0f0", display: "block" },
  creator: { fontWeight: 600 },
  caption: { color: "#555", margin: "0.15rem 0" },
  shortcode: { color: "#aaa", fontFamily: "ui-monospace, monospace", fontSize: "0.75rem" },
  badge: { display: "inline-block", padding: "0.1rem 0.5rem", borderRadius: 4, background: "#fde68a", color: "#92400e", fontWeight: 600, fontSize: "0.75rem" },
  catBadge: { display: "inline-block", padding: "0.1rem 0.5rem", borderRadius: 4, background: "#e0e7ff", color: "#3730a3", fontWeight: 600, fontSize: "0.75rem", whiteSpace: "nowrap" },
  statusAnalyzed: { display: "inline-block", padding: "0.1rem 0.5rem", borderRadius: 4, background: "#dcfce7", color: "#166534", fontWeight: 600, fontSize: "0.72rem" },
  statusFailed: { display: "inline-block", padding: "0.1rem 0.5rem", borderRadius: 4, background: "#fee2e2", color: "#991b1b", fontWeight: 600, fontSize: "0.72rem" },
  statusPending: { display: "inline-block", padding: "0.1rem 0.5rem", borderRadius: 4, background: "#f3f4f6", color: "#6b7280", fontWeight: 600, fontSize: "0.72rem" },
  muted: { color: "#bbb" },
  link: { color: "#2563eb", textDecoration: "none", fontWeight: 500 },
  detailTr: { borderBottom: "1px solid #f2f2f2" },
  detailTd: { padding: "0 0.75rem 0.5rem", background: "#fcfcfd" },
  detailSummary: { cursor: "pointer", color: "#555", fontSize: "0.78rem", padding: "0.35rem 0", userSelect: "none" },
  detailBody: { padding: "0.5rem 0 0.75rem", display: "flex", flexDirection: "column", gap: "0.6rem", maxWidth: 900 },
  detailError: { color: "#991b1b", fontSize: "0.8rem", background: "#fef2f2", padding: "0.4rem 0.6rem", borderRadius: 4 },
  detailBlock: { display: "flex", flexDirection: "column", gap: "0.2rem" },
  detailLabel: { fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "#999", fontWeight: 600 },
  beats: { display: "flex", flexWrap: "wrap", gap: "0.3rem" },
  beatChip: { display: "inline-block", padding: "0.1rem 0.45rem", borderRadius: 4, background: "#f1f5f9", color: "#334155", fontSize: "0.72rem", fontFamily: "ui-monospace, monospace" },
  transcript: { margin: 0, whiteSpace: "pre-wrap", fontFamily: "ui-monospace, monospace", fontSize: "0.78rem", color: "#333", background: "#fff", border: "1px solid #eee", borderRadius: 4, padding: "0.5rem 0.6rem", maxHeight: 240, overflow: "auto" },
};
