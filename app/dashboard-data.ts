// Dashboard read path (Slice 3, MAIN-959). Server-side only — opens the Content
// Store via lib/core (better-sqlite3) and assembles the view-model the table
// renders. No CLI/HTTP concerns leak in here; this is a thin read adapter over the
// shared Store API (ADR-0002), used only by the React server component.
//
// All DB access is server-side. The page imports this; the browser never does.
// better-sqlite3 is marked as a server external package in next.config.ts, so this
// module is never bundled for the client even without the `server-only` poison-pill.

// Import directly from the specific core modules (not the barrel): the dashboard
// only needs the Store. Pulling the whole barrel would drag config/scrape/analyze —
// and their import.meta.url path tricks — into the webpack server bundle. The Store
// API surface here is exactly the one the pipeline writes through (ADR-0002).
import { openStore } from "../lib/core/store.js";
import { loadConfig } from "../lib/core/config.js";
import type {
  CreatorStatsRow,
  ReelRow,
  Store,
  ListReelsOptions,
} from "../lib/core/types.js";
import {
  decodeBeats,
  decodeComments,
  hookDescription,
  hookLabel,
  initials,
  splitWhy,
  titleCase,
  type BeatVM,
  type CommentVM,
} from "./content-labels.js";

/**
 * Dashboard sort axes (build-spec.md DoD #4: "sorts by performance / category /
 * virality"). `posted_at` is the default/newest-first axis. These map 1:1 onto the
 * Store's `orderBy` whitelist — performance → performance_score, virality →
 * is_viral — so the SQL stays injection-safe and NULLs-last is enforced in the
 * Store, not the UI.
 */
export type SortKey = "performance" | "virality" | "category" | "posted_at";

const SORT_TO_ORDER_BY: Record<SortKey, NonNullable<ListReelsOptions["orderBy"]>> = {
  performance: "performance_score",
  virality: "is_viral",
  category: "category",
  posted_at: "posted_at",
};

/**
 * Sort direction per axis. Numeric/recency axes read best-first (DESC) so the
 * strongest Reels surface at the top; `category` is a free-text enum, so it reads
 * ascending (natural alphabetical) — DESC would sort categories backwards
 * (tool_demo, story_personal, …). NULLs sort last in either direction (Store rule).
 */
const SORT_TO_DIRECTION: Record<SortKey, NonNullable<ListReelsOptions["direction"]>> = {
  performance: "desc",
  virality: "desc",
  category: "asc",
  posted_at: "desc",
};

export function parseSortKey(raw: string | undefined): SortKey {
  if (raw === "performance" || raw === "virality" || raw === "category" || raw === "posted_at") {
    return raw;
  }
  return "posted_at";
}

/** A single Reel as the dashboard table consumes it: raw ReelRow plus decoded
 * JSON and the creator's follower count from the LATEST creator_stats snapshot. */
export interface ReelView {
  reel: ReelRow;
  /** Followers from the creator's latest Creator Snapshot (NULL if no snapshot). */
  followers: number | null;
  /** Creator display name (full_name, falling back to username). */
  creatorName: string;
}

export interface DashboardData {
  rows: ReelView[];
  total: number;
  sort: SortKey;
  /** When true, the Virality filter (?viral=1) is active. */
  viralOnly: boolean;
  /** Active Category filter (a category slug), or undefined for all. */
  category?: string;
  /** All Category slugs present in the (creator-scoped) store — drives the filter UI. */
  categoriesPresent: string[];
  /**
   * Authored Category display names keyed by slug, from config/categories.yaml —
   * the single source of truth the analysis prompt is parameterized from. The UI
   * looks labels up here (falling back to title-case only for slugs not in config).
   */
  categoryNames: Record<string, string>;
}

export interface DashboardQuery {
  sort?: SortKey;
  /** Filter to viral Reels only (is_viral === 1). */
  viralOnly?: boolean;
  /** Optional creator filter (defaults to all creators). */
  creator?: string;
  /** Optional Category filter (a category slug); undefined = all categories. */
  category?: string;
}

/**
 * Read the Content Store and build the dashboard view-model. Opens its own store
 * handle (default data/content.db) and always closes it — the page calls this once
 * per request. Safe against an EMPTY store: returns zero rows, never throws.
 *
 * `store` is injectable so a seed/smoke harness can drive it against a temp DB
 * without touching the real one (mirrors the pipeline's deps-injection seam).
 */
export function getDashboardData(
  query: DashboardQuery = {},
  store?: Store,
): DashboardData {
  const sort = query.sort ?? "posted_at";
  const viralOnly = query.viralOnly ?? false;
  const category = query.category?.trim() || undefined;

  const ownsStore = store == null;
  const s = store ?? openStore();
  try {
    // The Store enforces NULLs-last regardless of direction; performance/virality
    // read best-first (DESC) so the strongest Reels surface at the top, while
    // `category` reads ascending (natural alphabetical) — see SORT_TO_DIRECTION.
    const reels = s.listReels({
      creator: query.creator,
      orderBy: SORT_TO_ORDER_BY[sort],
      direction: SORT_TO_DIRECTION[sort],
    });

    // Cache latest-stats per creator so we don't re-query for every Reel.
    const followersCache = new Map<string, number | null>();
    const nameCache = new Map<string, string>();

    // Distinct Category slugs present (over the creator-scoped, pre-filter set) so
    // the filter UI only offers categories that actually have Reels.
    const categoriesPresent = Array.from(
      new Set(reels.map((r) => r.category).filter((c): c is string => !!c)),
    ).sort();

    // Authored slug→name map from config/categories.yaml (the prompt's source of
    // truth). The UI resolves Category labels from this rather than re-deriving a
    // name by title-casing the slug, so e.g. story_personal renders "Story/Personal".
    const categoryNames: Record<string, string> = {};
    for (const c of loadConfig().categories.categories) {
      categoryNames[c.slug] = c.name;
    }

    // Category filter applied in JS (same pattern as the Virality filter); the
    // already-ordered list is preserved.
    const byViral = viralOnly ? reels.filter((r) => r.is_viral === 1) : reels;
    const visible = category ? byViral.filter((r) => r.category === category) : byViral;

    const rows: ReelView[] = visible.map((reel) => {
      const username = reel.creator_username;
      if (!followersCache.has(username)) {
        followersCache.set(username, s.getLatestStats(username)?.followers ?? null);
      }
      if (!nameCache.has(username)) {
        const creator = s.getCreator(username);
        nameCache.set(username, creator?.full_name?.trim() || username);
      }
      return {
        reel,
        followers: followersCache.get(username) ?? null,
        creatorName: nameCache.get(username) ?? username,
      };
    });

    return { rows, total: rows.length, sort, viralOnly, category, categoriesPresent, categoryNames };
  } finally {
    if (ownsStore) s.close();
  }
}

// ---------------------------------------------------------------------------
// App shell view-model (the redesigned dashboard).
//
// The redesigned UI is a single client shell (AppShell) that switches between
// Library / Creators / Runs / Detail views and filters/sorts in the browser. To
// keep that snappy without a fan-out of API routes, the server loads the WHOLE
// (small, last-90-day) dataset once per request and hands the client plain,
// serializable view-models. All DB access stays here (server-side, ADR-0002).
// ---------------------------------------------------------------------------

/** One Reel as the redesigned UI consumes it — plain data, safe to serialize to the client. */
export interface ReelVM {
  shortcode: string;
  url: string;
  /** Streaming thumbnail route; the <img>/background degrades if it 404s. */
  thumbUrl: string;
  handle: string; // creator_username
  creatorName: string;
  creatorInitials: string;
  topic: string | null;
  caption: string | null;
  categorySlug: string | null;
  categoryLabel: string | null;
  hookSlug: string | null;
  hookLabel: string;
  hookDescription: string;
  viral: boolean; // is_viral === 1 (NULL/0 → false)
  outlier: boolean; // is_outlier === 1
  views: number | null;
  likes: number | null;
  comments: number | null;
  performance: number | null;
  engagementRate: number | null;
  followers: number | null; // creator followers at latest snapshot
  durationSec: number | null;
  postedAt: string | null; // ISO-8601 UTC; client sorts "Newest" on this
  analysisStatus: string | null;
  beats: BeatVM[];
  transcript: string | null;
  /** First sentence of why_it_works, as a serif pull-quote. */
  whyPull: string;
  /** Remainder of why_it_works (may be empty). */
  why: string;
  /** Top comments (questions first), for the detail "Questions from comments" block. */
  topComments: CommentVM[];
}

/** One tracked Creator as the Creators view consumes it. */
export interface CreatorVM {
  handle: string;
  name: string;
  initials: string;
  verified: boolean;
  bio: string | null;
  followers: number | null;
  /** Follower delta over ~30 days from creator_stats; NULL when history is too thin. */
  growth: number | null;
  analyzed: number; // Reels with analysis_status === 'analyzed'
  outliers: number;
  reelCount: number;
  /** Up to 3 best-performing Reels, for the card's thumbnails. */
  top: { shortcode: string; thumbUrl: string; topic: string | null; performance: number | null }[];
}

export interface AppData {
  reels: ReelVM[];
  creators: CreatorVM[];
  /** Category slugs present, with display label and Reel count — drives the chips. */
  categoriesPresent: { slug: string; label: string; count: number }[];
  reelCount: number;
  creatorCount: number;
}

/** Follower growth over ~30 days from a creator's snapshot history (NULL if too thin). */
function followerGrowth(stats: CreatorStatsRow[]): number | null {
  if (stats.length < 2) return null;
  const latest = stats[stats.length - 1];
  if (latest.followers == null) return null;
  const latestMs = Date.parse(latest.captured_at);
  const targetMs = latestMs - 30 * 24 * 60 * 60 * 1000;
  // Snapshot whose capture time is closest to 30 days before the latest one.
  let best: CreatorStatsRow | null = null;
  let bestDist = Infinity;
  for (const s of stats) {
    if (s === latest || s.followers == null) continue;
    const dist = Math.abs(Date.parse(s.captured_at) - targetMs);
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  if (!best || best.followers == null) return null;
  return latest.followers - best.followers;
}

/**
 * Read the WHOLE Content Store and assemble the redesigned UI's view-model: every
 * Reel (newest-first), every tracked Creator with aggregates, and the Category
 * chips. Opens its own store handle (injectable for tests/seed harnesses) and
 * always closes it. Safe against an empty store — returns empty arrays, never throws.
 */
export function getAppData(store?: Store): AppData {
  const ownsStore = store == null;
  const s = store ?? openStore();
  try {
    const reels = s.listReels({ orderBy: "posted_at", direction: "desc" });

    // Authored slug → display name from config/categories.yaml (the prompt's source
    // of truth). Labels resolve here; title-case is only a defensive fallback.
    const categoryNames: Record<string, string> = {};
    for (const c of loadConfig().categories.categories) categoryNames[c.slug] = c.name;
    const catLabel = (slug: string | null): string | null =>
      slug == null ? null : (categoryNames[slug] ?? titleCase(slug));

    // Per-creator caches (followers + display name) so we don't re-query per Reel.
    const followersCache = new Map<string, number | null>();
    const nameCache = new Map<string, string>();
    const resolveCreator = (username: string) => {
      if (!nameCache.has(username)) {
        const creator = s.getCreator(username);
        nameCache.set(username, creator?.full_name?.trim() || username);
      }
      if (!followersCache.has(username)) {
        followersCache.set(username, s.getLatestStats(username)?.followers ?? null);
      }
      return {
        name: nameCache.get(username) ?? username,
        followers: followersCache.get(username) ?? null,
      };
    };

    const reelVMs: ReelVM[] = reels.map((reel) => {
      const { name, followers } = resolveCreator(reel.creator_username);
      const { pull, body } = splitWhy(reel.why_it_works);
      return {
        shortcode: reel.shortcode,
        url: reel.url,
        thumbUrl: `/api/thumbnails/${reel.shortcode}`,
        handle: reel.creator_username,
        creatorName: name,
        creatorInitials: initials(name),
        topic: reel.topic,
        caption: reel.caption,
        categorySlug: reel.category,
        categoryLabel: catLabel(reel.category),
        hookSlug: reel.hook_technique,
        hookLabel: hookLabel(reel.hook_technique),
        hookDescription: hookDescription(reel.hook_technique),
        viral: reel.is_viral === 1,
        outlier: reel.is_outlier === 1,
        views: reel.views,
        likes: reel.likes,
        comments: reel.comments_count,
        performance: reel.performance_score,
        engagementRate: reel.engagement_rate,
        followers,
        durationSec: reel.duration_sec,
        postedAt: reel.posted_at,
        analysisStatus: reel.analysis_status,
        beats: decodeBeats(reel.beat_sequence),
        transcript: reel.transcript,
        whyPull: pull,
        why: body,
        topComments: decodeComments(reel.top_comments, {
          caption: reel.caption,
          creatorUsername: reel.creator_username,
        }),
      };
    });

    // Distinct creators present (in Reel order: newest activity first), with aggregates.
    const creatorVMs: CreatorVM[] = [];
    const seen = new Set<string>();
    for (const reel of reels) {
      const username = reel.creator_username;
      if (seen.has(username)) continue;
      seen.add(username);
      const creator = s.getCreator(username);
      const { name, followers } = resolveCreator(username);
      const mine = reelVMs.filter((r) => r.handle === username);
      const top = mine
        .slice()
        .sort((a, b) => (b.performance ?? -Infinity) - (a.performance ?? -Infinity))
        .slice(0, 3)
        .map((r) => ({
          shortcode: r.shortcode,
          thumbUrl: r.thumbUrl,
          topic: r.topic,
          performance: r.performance,
        }));
      creatorVMs.push({
        handle: username,
        name,
        initials: initials(name),
        verified: creator?.is_verified === 1,
        bio: creator?.biography ?? null,
        followers,
        growth: followerGrowth(s.listCreatorStats(username)),
        analyzed: mine.filter((r) => r.analysisStatus === "analyzed").length,
        outliers: mine.filter((r) => r.outlier).length,
        reelCount: mine.length,
        top,
      });
    }

    // Category chips: slugs present, with counts, ordered by config then alphabetical.
    const counts = new Map<string, number>();
    for (const r of reelVMs) {
      if (r.categorySlug) counts.set(r.categorySlug, (counts.get(r.categorySlug) ?? 0) + 1);
    }
    const configOrder = loadConfig().categories.categories.map((c) => c.slug);
    const categoriesPresent = Array.from(counts.keys())
      .sort((a, b) => {
        const ia = configOrder.indexOf(a);
        const ib = configOrder.indexOf(b);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return a.localeCompare(b);
      })
      .map((slug) => ({ slug, label: catLabel(slug) ?? slug, count: counts.get(slug)! }));

    return {
      reels: reelVMs,
      creators: creatorVMs,
      categoriesPresent,
      reelCount: reelVMs.length,
      creatorCount: creatorVMs.length,
    };
  } finally {
    if (ownsStore) s.close();
  }
}
