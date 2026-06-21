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
  ReelRow,
  Store,
  ListReelsOptions,
} from "../lib/core/types.js";

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
