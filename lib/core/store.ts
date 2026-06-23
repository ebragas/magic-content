// Content Store — the durable, canonical SQLite store (ADR-0001, docs/schema.md).
//
// Server-side only (better-sqlite3). Opening a fresh DB is idempotent: all DDL is
// CREATE ... IF NOT EXISTS, safe to re-run. Tests pass ':memory:' or a temp file.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AppendCreatorStatsInput,
  CommentRow,
  CreatorRow,
  CreatorStatsRow,
  Draft,
  DraftInput,
  FaqClusterWithLinks,
  FaqWithExamples,
  ListCommentsOptions,
  ListReelsOptions,
  ReelAnalysisUpdate,
  ReelFaqProvenanceUpdate,
  ReelMetricsUpdate,
  ReelRow,
  ScrapedComment,
  Store,
  UpsertCreatorInput,
  UpsertReelInput,
} from "./types.js";
import { normalizeUsername } from "./username.js";
import { isTriggerComment, normalizeTriggerKeyword } from "./trigger.js";

export const DEFAULT_DB_PATH = "data/content.db";

function nowIso(): string {
  return new Date().toISOString();
}

// Monotonic ISO clock for creator_stats.captured_at. A single `full` run appends a
// snapshot during scrape and again during refresh; if both land in the same
// millisecond they collide on UNIQUE(creator_username, captured_at). This advances
// by at least 1ms per call within the process so back-to-back snapshots stay
// distinct and strictly orderable — the time-series invariant. It does NOT change
// appendCreatorStats' contract (which still throws on an explicit duplicate
// captured_at); it only ensures the auto-generated "now" stamps don't clash.
let lastMonotonicMs = 0;
/** Strictly-increasing ISO-8601 UTC timestamp (≥ wall clock, ≥ previous call). */
export function monotonicNowIso(): string {
  const ms = Math.max(Date.now(), lastMonotonicMs + 1);
  lastMonotonicMs = ms;
  return new Date(ms).toISOString();
}

function toBit(v: boolean | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return v ? 1 : 0;
}

/** All DDL. Idempotent. Columns/types/nullability/indexes mirror docs/schema.md exactly. */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS creators (
  username        TEXT PRIMARY KEY,
  full_name       TEXT,
  biography       TEXT,
  is_verified     INTEGER,
  profile_url     TEXT,
  first_seen_at   TEXT,
  last_scraped_at TEXT
);

CREATE TABLE IF NOT EXISTS creator_stats (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_username TEXT NOT NULL REFERENCES creators(username),
  captured_at      TEXT NOT NULL,
  followers        INTEGER,
  following        INTEGER,
  posts_count      INTEGER,
  UNIQUE(creator_username, captured_at)
);

CREATE INDEX IF NOT EXISTS idx_creator_stats_username_captured
  ON creator_stats(creator_username, captured_at);

CREATE TABLE IF NOT EXISTS reels (
  shortcode                  TEXT PRIMARY KEY,
  url                        TEXT NOT NULL,
  creator_username           TEXT NOT NULL REFERENCES creators(username),
  caption                    TEXT,
  posted_at                  TEXT,
  duration_sec               REAL,
  thumbnail_path             TEXT,
  top_comments               TEXT,
  likes                      INTEGER,
  comments_count             INTEGER,
  views                      INTEGER,
  shares                     INTEGER,
  last_scraped_at            TEXT,
  performance_score          REAL,
  engagement_rate            REAL,
  is_viral                   INTEGER,
  is_outlier                 INTEGER,
  transcript                 TEXT,
  topic                      TEXT,
  category                   TEXT,
  hook_technique             TEXT,
  beat_sequence              TEXT,
  why_it_works               TEXT,
  trigger_keyword            TEXT,
  analysis_status            TEXT,
  analysis_error             TEXT,
  analyzed_at                TEXT,
  transcription_prompt_hash  TEXT,
  analysis_prompt_hash       TEXT,
  faq_prompt_hash            TEXT,
  faqs_generated_at          TEXT,
  is_favorite                INTEGER NOT NULL DEFAULT 0,
  favorited_at               TEXT,
  is_archived                INTEGER NOT NULL DEFAULT 0,
  archived_at                TEXT
);

CREATE INDEX IF NOT EXISTS idx_reels_creator_username ON reels(creator_username);
CREATE INDEX IF NOT EXISTS idx_reels_posted_at        ON reels(posted_at);
CREATE INDEX IF NOT EXISTS idx_reels_performance_score ON reels(performance_score);
CREATE INDEX IF NOT EXISTS idx_reels_is_viral         ON reels(is_viral);

CREATE TABLE IF NOT EXISTS comments (
  comment_id     TEXT PRIMARY KEY,
  shortcode      TEXT NOT NULL REFERENCES reels(shortcode),
  username       TEXT,
  text           TEXT,
  likes          INTEGER,
  posted_at      TEXT,
  first_seen_at  TEXT,
  is_trigger     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_comments_shortcode ON comments(shortcode);

CREATE TABLE IF NOT EXISTS faqs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  shortcode      TEXT NOT NULL REFERENCES reels(shortcode),
  question       TEXT NOT NULL,
  support_count  INTEGER NOT NULL,
  support_likes  INTEGER NOT NULL,
  strength_score REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_faqs_shortcode ON faqs(shortcode);

CREATE TABLE IF NOT EXISTS faq_comments (
  faq_id     INTEGER NOT NULL REFERENCES faqs(id) ON DELETE CASCADE,
  comment_id TEXT NOT NULL REFERENCES comments(comment_id),
  PRIMARY KEY (faq_id, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_faq_comments_faq_id ON faq_comments(faq_id);

CREATE TABLE IF NOT EXISTS drafts (
  shortcode    TEXT PRIMARY KEY REFERENCES reels(shortcode),
  hooks        TEXT NOT NULL,
  beat_scripts TEXT NOT NULL,
  reasoning    TEXT NOT NULL,
  caption      TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
`;

/**
 * Idempotent additive-column migrations for DBs created before a column existed.
 * The base DDL is CREATE ... IF NOT EXISTS, which never alters an existing table, so a
 * pre-existing data/content.db won't gain new columns from SCHEMA_SQL alone. Fresh DBs
 * (and every test's `:memory:` store) already have these from the DDL, so each ADD is
 * guarded by a table_info probe and is a harmless no-op there.
 *
 * Each entry mirrors a column added to SCHEMA_SQL above (and docs/schema.md). SQLite
 * adds a nullable column with no default cheaply; existing rows read NULL.
 */
const ADDITIVE_COLUMNS: { table: string; column: string; ddl: string }[] = [
  // slice 968 — the Reel's derived Trigger Keyword (ManyChat CTA word).
  { table: "reels", column: "trigger_keyword", ddl: "ALTER TABLE reels ADD COLUMN trigger_keyword TEXT" },
  // slice 969 — FAQ provenance (hash of the rendered FAQ prompt + when FAQs were generated).
  { table: "reels", column: "faq_prompt_hash", ddl: "ALTER TABLE reels ADD COLUMN faq_prompt_hash TEXT" },
  { table: "reels", column: "faqs_generated_at", ddl: "ALTER TABLE reels ADD COLUMN faqs_generated_at TEXT" },
  // slice 965 — the first user-state WRITE path (ADR-0006): Favorite flag + when it was set.
  // SQLite can't ALTER-ADD a NOT-NULL-DEFAULT column with a non-constant default, but a
  // constant `DEFAULT 0` is fine; existing rows backfill to 0 (not favorited).
  { table: "reels", column: "is_favorite", ddl: "ALTER TABLE reels ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0" },
  { table: "reels", column: "favorited_at", ddl: "ALTER TABLE reels ADD COLUMN favorited_at TEXT" },
  // slice 967 — the second user-state flag (ADR-0006): Archive flag + when it was set.
  // Same constant-DEFAULT-0 trick as is_favorite; existing rows backfill to 0 (not archived).
  { table: "reels", column: "is_archived", ddl: "ALTER TABLE reels ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0" },
  { table: "reels", column: "archived_at", ddl: "ALTER TABLE reels ADD COLUMN archived_at TEXT" },
];

/** Apply additive-column migrations not covered by CREATE-IF-NOT-EXISTS DDL. */
function applyAdditiveColumns(db: Database.Database): void {
  for (const { table, column, ddl } of ADDITIVE_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(ddl);
  }
}

/**
 * Open (or create) the Content Store. Idempotent: re-opening an existing DB
 * re-runs DDL harmlessly. Pass ':memory:' or a temp path in tests; defaults to
 * data/content.db (gitignored).
 */
export function openStore(path: string = DEFAULT_DB_PATH): Store {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyAdditiveColumns(db);

  const upsertCreator = (input: UpsertCreatorInput): void => {
    const username = normalizeUsername(input.username);
    const stmt = db.prepare(`
      INSERT INTO creators (username, full_name, biography, is_verified, profile_url, first_seen_at, last_scraped_at)
      VALUES (@username, @full_name, @biography, @is_verified, @profile_url, @first_seen_at, @last_scraped_at)
      ON CONFLICT(username) DO UPDATE SET
        full_name       = COALESCE(excluded.full_name, creators.full_name),
        biography       = COALESCE(excluded.biography, creators.biography),
        is_verified     = COALESCE(excluded.is_verified, creators.is_verified),
        profile_url     = COALESCE(excluded.profile_url, creators.profile_url),
        last_scraped_at = COALESCE(excluded.last_scraped_at, creators.last_scraped_at)
    `);
    stmt.run({
      username,
      full_name: input.full_name ?? null,
      biography: input.biography ?? null,
      is_verified: toBit(input.is_verified),
      profile_url: input.profile_url ?? `https://www.instagram.com/${username}/`,
      first_seen_at: nowIso(),
      last_scraped_at: input.last_scraped_at ?? null,
    });
  };

  const getCreator = (username: string): CreatorRow | undefined => {
    return db
      .prepare(`SELECT * FROM creators WHERE username = ?`)
      .get(normalizeUsername(username)) as CreatorRow | undefined;
  };

  const appendCreatorStats = (input: AppendCreatorStatsInput): CreatorStatsRow => {
    const username = normalizeUsername(input.creator_username);
    const info = db
      .prepare(
        `INSERT INTO creator_stats (creator_username, captured_at, followers, following, posts_count)
         VALUES (@creator_username, @captured_at, @followers, @following, @posts_count)`,
      )
      .run({
        creator_username: username,
        captured_at: input.captured_at,
        followers: input.followers ?? null,
        following: input.following ?? null,
        posts_count: input.posts_count ?? null,
      });
    return db
      .prepare(`SELECT * FROM creator_stats WHERE id = ?`)
      .get(info.lastInsertRowid as number) as CreatorStatsRow;
  };

  const getLatestStats = (username: string): CreatorStatsRow | undefined => {
    return db
      .prepare(
        `SELECT * FROM creator_stats
         WHERE creator_username = ?
         ORDER BY captured_at DESC, id DESC
         LIMIT 1`,
      )
      .get(normalizeUsername(username)) as CreatorStatsRow | undefined;
  };

  const listCreatorStats = (username: string): CreatorStatsRow[] => {
    return db
      .prepare(
        `SELECT * FROM creator_stats
         WHERE creator_username = ?
         ORDER BY captured_at ASC, id ASC`,
      )
      .all(normalizeUsername(username)) as CreatorStatsRow[];
  };

  const upsertReel = (input: UpsertReelInput): void => {
    const creator_username = normalizeUsername(input.creator_username);
    const top_comments =
      input.top_comments == null ? null : JSON.stringify(input.top_comments);
    const stmt = db.prepare(`
      INSERT INTO reels (shortcode, url, creator_username, caption, posted_at, duration_sec, thumbnail_path, top_comments, analysis_status)
      VALUES (@shortcode, @url, @creator_username, @caption, @posted_at, @duration_sec, @thumbnail_path, @top_comments, @analysis_status)
      ON CONFLICT(shortcode) DO UPDATE SET
        url            = excluded.url,
        caption        = COALESCE(excluded.caption, reels.caption),
        posted_at      = COALESCE(excluded.posted_at, reels.posted_at),
        duration_sec   = COALESCE(excluded.duration_sec, reels.duration_sec),
        thumbnail_path = COALESCE(excluded.thumbnail_path, reels.thumbnail_path),
        top_comments   = COALESCE(excluded.top_comments, reels.top_comments)
    `);
    stmt.run({
      shortcode: input.shortcode,
      url: input.url,
      creator_username,
      caption: input.caption ?? null,
      posted_at: input.posted_at ?? null,
      duration_sec: input.duration_sec ?? null,
      thumbnail_path: input.thumbnail_path ?? null,
      top_comments,
      analysis_status: "pending",
    });
  };

  const getReel = (shortcode: string): ReelRow | undefined => {
    return db.prepare(`SELECT * FROM reels WHERE shortcode = ?`).get(shortcode) as
      | ReelRow
      | undefined;
  };

  const listReels = (opts: ListReelsOptions = {}): ReelRow[] => {
    const orderCol = opts.orderBy ?? "posted_at";
    const dir = (opts.direction ?? "desc").toUpperCase() === "ASC" ? "ASC" : "DESC";
    // Whitelist columns to avoid SQL injection via orderBy.
    const allowed: Record<string, string> = {
      posted_at: "posted_at",
      performance_score: "performance_score",
      is_viral: "is_viral",
      category: "category",
    };
    const col = allowed[orderCol] ?? "posted_at";
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.creator) {
      where.push(`creator_username = @creator`);
      params.creator = normalizeUsername(opts.creator);
    }
    // Archive filter (slice 967) — archived Reels are HIDDEN BY DEFAULT. Unless
    // includeArchived is on, exclude is_archived = 1 FIRST, so it wins over the
    // favorites filter below: an archived favorite stays hidden (archive wins over
    // favorite). includeArchived lifts this and lets favoritesOnly compose across the
    // whole set. (DEFAULT 0 means is_archived is never NULL, but be defensive anyway.)
    if (!opts.includeArchived) {
      where.push(`(is_archived = 0 OR is_archived IS NULL)`);
    }
    // Favorites filter (slice 965) — restrict to user-favorited Reels at the Store
    // seam. NULL/0 is_favorite is excluded; only is_favorite = 1 passes. Composes
    // WITHIN the (non-archived) visible scope unless includeArchived is on.
    if (opts.favoritesOnly) {
      where.push(`is_favorite = 1`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    // NULLs sort last regardless of direction (dashboard rule).
    const limitSql = opts.limit != null ? `LIMIT ${Number(opts.limit)}` : "";
    const sql = `
      SELECT * FROM reels
      ${whereSql}
      ORDER BY (${col} IS NULL) ASC, ${col} ${dir}
      ${limitSql}
    `;
    return db.prepare(sql).all(params) as ReelRow[];
  };

  const updateReelMetrics = (update: ReelMetricsUpdate): void => {
    const fields: string[] = [];
    const params: Record<string, unknown> = { shortcode: update.shortcode };
    const set = <K extends keyof ReelMetricsUpdate>(key: K) => {
      if (Object.prototype.hasOwnProperty.call(update, key) && key !== "shortcode") {
        fields.push(`${key} = @${key}`);
        params[key] = (update[key] ?? null) as unknown;
      }
    };
    set("likes");
    set("comments_count");
    set("views");
    set("shares");
    set("last_scraped_at");
    set("performance_score");
    set("engagement_rate");
    set("is_viral");
    set("is_outlier");
    if (fields.length === 0) return;
    db.prepare(`UPDATE reels SET ${fields.join(", ")} WHERE shortcode = @shortcode`).run(
      params,
    );
  };

  const updateReelAnalysis = (update: ReelAnalysisUpdate): void => {
    const fields: string[] = [];
    const params: Record<string, unknown> = { shortcode: update.shortcode };
    const setRaw = (col: string, value: unknown) => {
      fields.push(`${col} = @${col}`);
      params[col] = value ?? null;
    };
    if ("transcript" in update) setRaw("transcript", update.transcript);
    if ("topic" in update) setRaw("topic", update.topic);
    if ("category" in update) setRaw("category", update.category);
    if ("hook_technique" in update) setRaw("hook_technique", update.hook_technique);
    if ("beat_sequence" in update)
      setRaw(
        "beat_sequence",
        update.beat_sequence == null ? null : JSON.stringify(update.beat_sequence),
      );
    if ("why_it_works" in update) setRaw("why_it_works", update.why_it_works);
    if ("trigger_keyword" in update) setRaw("trigger_keyword", update.trigger_keyword);
    if ("analysis_status" in update) setRaw("analysis_status", update.analysis_status);
    if ("analysis_error" in update) setRaw("analysis_error", update.analysis_error);
    if ("analyzed_at" in update) setRaw("analyzed_at", update.analyzed_at);
    if ("transcription_prompt_hash" in update)
      setRaw("transcription_prompt_hash", update.transcription_prompt_hash);
    if ("analysis_prompt_hash" in update)
      setRaw("analysis_prompt_hash", update.analysis_prompt_hash);
    if (fields.length === 0) return;
    db.prepare(`UPDATE reels SET ${fields.join(", ")} WHERE shortcode = @shortcode`).run(
      params,
    );
  };

  const setFavorite = (shortcode: string, favorite: boolean): ReelRow | undefined => {
    // The first user-state WRITE path (ADR-0006). Sets/clears is_favorite and
    // stamps/clears favorited_at together so the two never disagree. No pipeline run
    // produces or clobbers this — it's user-authored, mutable state, categorically
    // distinct from the immutable analysis and the refreshed metrics. Returns the
    // updated row (the route echoes the new state back to the optimistic client) or
    // undefined when the Reel doesn't exist (the route maps that to a 404).
    db.prepare(
      `UPDATE reels
         SET is_favorite = @is_favorite, favorited_at = @favorited_at
       WHERE shortcode = @shortcode`,
    ).run({
      shortcode,
      is_favorite: favorite ? 1 : 0,
      favorited_at: favorite ? nowIso() : null,
    });
    return getReel(shortcode);
  };

  const setArchived = (shortcode: string, archived: boolean): ReelRow | undefined => {
    // The second user-state WRITE path (ADR-0006 / slice 967), mirroring setFavorite.
    // Sets/clears is_archived and stamps/clears archived_at together so the two never
    // disagree. Independent of is_favorite — a Reel can be both favorited AND archived;
    // archive just hides it by default in listReels (archive wins over favorite). No
    // pipeline run produces or clobbers this. Returns the updated row (the route echoes
    // the new state to the optimistic client) or undefined when the Reel doesn't exist.
    db.prepare(
      `UPDATE reels
         SET is_archived = @is_archived, archived_at = @archived_at
       WHERE shortcode = @shortcode`,
    ).run({
      shortcode,
      is_archived: archived ? 1 : 0,
      archived_at: archived ? nowIso() : null,
    });
    return getReel(shortcode);
  };

  const upsertComments = (shortcode: string, comments: ScrapedComment[]): number => {
    if (!Array.isArray(comments) || comments.length === 0) return 0;
    const now = nowIso();
    // UPSERT BY comment_id so repeated scrapes ACCUMULATE the union: a comment we've
    // already seen is never dropped. On conflict we refresh the mutable fields
    // (likes/text/username/posted_at) to the newest pull but PRESERVE first_seen_at
    // (the corpus's "since when have we known this comment" anchor) and is_trigger
    // (slice 968 owns the flag; a re-scrape must not reset it to the default 0).
    const stmt = db.prepare(`
      INSERT INTO comments (comment_id, shortcode, username, text, likes, posted_at, first_seen_at, is_trigger)
      VALUES (@comment_id, @shortcode, @username, @text, @likes, @posted_at, @first_seen_at, 0)
      ON CONFLICT(comment_id) DO UPDATE SET
        username  = COALESCE(excluded.username, comments.username),
        text      = COALESCE(excluded.text, comments.text),
        likes     = COALESCE(excluded.likes, comments.likes),
        posted_at = COALESCE(excluded.posted_at, comments.posted_at)
    `);
    const tx = db.transaction((rows: ScrapedComment[]) => {
      let n = 0;
      for (const c of rows) {
        if (!c || !c.comment_id) continue; // a comment with no id can't be deduped
        stmt.run({
          comment_id: c.comment_id,
          shortcode,
          username: c.username ?? null,
          text: c.text ?? null,
          likes: c.likes ?? null,
          posted_at: c.posted_at ?? null,
          first_seen_at: now,
        });
        n += 1;
      }
      return n;
    });
    return tx(comments);
  };

  const listComments = (
    shortcode: string,
    opts: ListCommentsOptions = {},
  ): CommentRow[] => {
    // likes DESC with NULLs last, then id for a stable tiebreak (the corpus order
    // the dashboard/FAQ slices consume); cap defensively when a limit is given.
    const limitSql = opts.limit != null ? `LIMIT ${Number(opts.limit)}` : "";
    return db
      .prepare(
        `SELECT * FROM comments
         WHERE shortcode = ?
         ORDER BY (likes IS NULL) ASC, likes DESC, comment_id ASC
         ${limitSql}`,
      )
      .all(shortcode) as CommentRow[];
  };

  const flagTriggerComments = (
    shortcode: string,
    keyword: string | null | undefined,
  ): number => {
    // Non-destructive recompute: ALWAYS clear the Reel's flags first (so a changed or
    // removed keyword can un-flag previously-flagged Comments), then re-flag the
    // matches. An UPDATE — never a DELETE — so the corpus rows survive and the flag is
    // re-derivable when the keyword arrives AFTER a comment scrape (refresh-before-analyze).
    const clear = db.prepare(`UPDATE comments SET is_trigger = 0 WHERE shortcode = @shortcode`);
    const flag = db.prepare(
      `UPDATE comments SET is_trigger = 1 WHERE comment_id = @comment_id`,
    );
    const select = db.prepare(
      `SELECT comment_id, text FROM comments WHERE shortcode = @shortcode`,
    );
    const tx = db.transaction((): number => {
      clear.run({ shortcode });
      const kw = normalizeTriggerKeyword(keyword);
      if (!kw) return 0; // a null/empty keyword leaves every Comment un-flagged
      const rows = select.all({ shortcode }) as { comment_id: string; text: string | null }[];
      let n = 0;
      for (const row of rows) {
        if (isTriggerComment(row.text, kw)) {
          flag.run({ comment_id: row.comment_id });
          n += 1;
        }
      }
      return n;
    });
    return tx();
  };

  const updateReelFaqProvenance = (update: ReelFaqProvenanceUpdate): void => {
    // The FAQ leg owns ONLY these two columns (ADR-0007). Stamping them must never touch
    // the immutable analysis columns — so a FAQ backfill on an already-video-analyzed Reel
    // leaves analysis untouched. Same partial-write shape as updateReelAnalysis.
    const fields: string[] = [];
    const params: Record<string, unknown> = { shortcode: update.shortcode };
    if ("faq_prompt_hash" in update) {
      fields.push(`faq_prompt_hash = @faq_prompt_hash`);
      params.faq_prompt_hash = update.faq_prompt_hash ?? null;
    }
    if ("faqs_generated_at" in update) {
      fields.push(`faqs_generated_at = @faqs_generated_at`);
      params.faqs_generated_at = update.faqs_generated_at ?? null;
    }
    if (fields.length === 0) return;
    db.prepare(`UPDATE reels SET ${fields.join(", ")} WHERE shortcode = @shortcode`).run(
      params,
    );
  };

  const replaceFaqs = (shortcode: string, clusters: FaqClusterWithLinks[]): number => {
    // Wholesale replace (ADR-0007): delete THIS Reel's faqs + faq_comments, reinsert the
    // given clusters together in one transaction. support_count / support_likes /
    // strength_score are computed FROM THE REAL links here, never supplied by the model.
    // The `comments` corpus is read (to sum likes) but NEVER mutated by a FAQ run.
    const delFaqComments = db.prepare(
      `DELETE FROM faq_comments WHERE faq_id IN (SELECT id FROM faqs WHERE shortcode = ?)`,
    );
    const delFaqs = db.prepare(`DELETE FROM faqs WHERE shortcode = ?`);
    const insFaq = db.prepare(
      `INSERT INTO faqs (shortcode, question, support_count, support_likes, strength_score)
       VALUES (@shortcode, @question, @support_count, @support_likes, @strength_score)`,
    );
    const insLink = db.prepare(
      `INSERT OR IGNORE INTO faq_comments (faq_id, comment_id) VALUES (@faq_id, @comment_id)`,
    );
    // Read a comment's likes (NULL → 0) so support_likes sums REAL engagement.
    const getLikes = db.prepare(`SELECT likes FROM comments WHERE comment_id = ?`);

    const tx = db.transaction((rows: FaqClusterWithLinks[]): number => {
      delFaqComments.run(shortcode);
      delFaqs.run(shortcode);
      let written = 0;
      for (const cluster of rows) {
        // Dedupe + drop empties: a cluster with no real comment links is not persisted.
        const ids = Array.from(new Set((cluster.comment_ids ?? []).filter(Boolean)));
        if (ids.length === 0) continue;
        const support_count = ids.length;
        let support_likes = 0;
        for (const id of ids) {
          const row = getLikes.get(id) as { likes: number | null } | undefined;
          support_likes += row?.likes ?? 0;
        }
        // Deterministic demand score: count, plus a damped contribution from total likes so a
        // few highly-liked askers can't dominate a broadly-asked question. ln(1+x) === log1p.
        const strength_score = support_count + Math.log1p(support_likes);
        const info = insFaq.run({ shortcode, question: cluster.question, support_count, support_likes, strength_score });
        const faqId = info.lastInsertRowid as number;
        for (const id of ids) insLink.run({ faq_id: faqId, comment_id: id });
        written += 1;
      }
      return written;
    });
    return tx(clusters);
  };

  const listFaqExampleComments = (faqId: number): CommentRow[] => {
    // Live-query the example Comments from the join (no duplicated comment text on the FAQ
    // row). likes DESC with NULLs last, then comment_id for a stable tiebreak.
    return db
      .prepare(
        `SELECT c.* FROM faq_comments fc
         JOIN comments c ON c.comment_id = fc.comment_id
         WHERE fc.faq_id = ?
         ORDER BY (c.likes IS NULL) ASC, c.likes DESC, c.comment_id ASC`,
      )
      .all(faqId) as CommentRow[];
  };

  const listFaqs = (shortcode: string): FaqWithExamples[] => {
    const faqs = db
      .prepare(
        `SELECT * FROM faqs WHERE shortcode = ? ORDER BY strength_score DESC, id ASC`,
      )
      .all(shortcode) as {
      id: number;
      question: string;
      support_count: number;
      support_likes: number;
      strength_score: number;
    }[];
    return faqs.map((f) => ({
      id: f.id,
      question: f.question,
      support_count: f.support_count,
      support_likes: f.support_likes,
      strength_score: f.strength_score,
      examples: listFaqExampleComments(f.id),
    }));
  };

  const decodeDraft = (row: {
    shortcode: string;
    hooks: string;
    beat_scripts: string;
    reasoning: string;
    caption: string;
    generated_at: string;
    updated_at: string;
  }): Draft => ({
    shortcode: row.shortcode,
    hooks: JSON.parse(row.hooks) as Draft["hooks"],
    beat_scripts: JSON.parse(row.beat_scripts) as Draft["beat_scripts"],
    reasoning: row.reasoning,
    caption: row.caption,
    generated_at: row.generated_at,
    updated_at: row.updated_at,
  });

  const getDraft = (shortcode: string): Draft | undefined => {
    const row = db.prepare(`SELECT * FROM drafts WHERE shortcode = ?`).get(shortcode) as
      | { shortcode: string; hooks: string; beat_scripts: string; reasoning: string; caption: string; generated_at: string; updated_at: string }
      | undefined;
    return row ? decodeDraft(row) : undefined;
  };

  const upsertDraft = (input: DraftInput): Draft => {
    // ONE Draft per Reel (shortcode PK), no history (MAIN-971 / ADR-0006). A second call is a
    // DESTRUCTIVE full-replace of every generated field INCLUDING caption (the caption is a
    // generated field now, not a copy of the original). On first insert generated_at == updated_at;
    // on conflict we PRESERVE generated_at (first generation) and bump updated_at, mirroring the
    // favorited_at/archived_at "stamp on the write" pattern. hooks + beat_scripts are JSON-encoded.
    const now = nowIso();
    db.prepare(`
      INSERT INTO drafts (shortcode, hooks, beat_scripts, reasoning, caption, generated_at, updated_at)
      VALUES (@shortcode, @hooks, @beat_scripts, @reasoning, @caption, @now, @now)
      ON CONFLICT(shortcode) DO UPDATE SET
        hooks        = excluded.hooks,
        beat_scripts = excluded.beat_scripts,
        reasoning    = excluded.reasoning,
        caption      = excluded.caption,
        updated_at   = excluded.updated_at
    `).run({
      shortcode: input.shortcode,
      hooks: JSON.stringify(input.hooks),
      beat_scripts: JSON.stringify(input.beat_scripts),
      reasoning: input.reasoning,
      caption: input.caption,
      now,
    });
    return getDraft(input.shortcode)!;
  };

  const saveDraft = (input: DraftInput): Draft | undefined => {
    // SAVE hand-edits to an EXISTING Draft (MAIN-972 / ADR-0006) — the hand-editing counterpart to
    // generate/regenerate (upsertDraft). UPDATE-only (never an INSERT): a save persists edits to a
    // Draft that was already generated, so it returns undefined when none exists (the route 404s —
    // nothing to edit). Bumps updated_at and PRESERVES generated_at (the UPDATE leaves it untouched),
    // mirroring upsertDraft's conflict path. hooks + beat_scripts are JSON-encoded from decoded shapes.
    const now = nowIso();
    const info = db
      .prepare(
        `UPDATE drafts
           SET hooks = @hooks, beat_scripts = @beat_scripts, reasoning = @reasoning,
               caption = @caption, updated_at = @now
         WHERE shortcode = @shortcode`,
      )
      .run({
        shortcode: input.shortcode,
        hooks: JSON.stringify(input.hooks),
        beat_scripts: JSON.stringify(input.beat_scripts),
        reasoning: input.reasoning,
        caption: input.caption,
        now,
      });
    if (info.changes === 0) return undefined; // no Draft to edit
    return getDraft(input.shortcode);
  };

  const close = (): void => {
    db.close();
  };

  return {
    db,
    upsertCreator,
    getCreator,
    appendCreatorStats,
    getLatestStats,
    listCreatorStats,
    upsertReel,
    getReel,
    listReels,
    updateReelMetrics,
    updateReelAnalysis,
    setFavorite,
    setArchived,
    upsertComments,
    listComments,
    flagTriggerComments,
    updateReelFaqProvenance,
    replaceFaqs,
    listFaqs,
    listFaqExampleComments,
    upsertDraft,
    saveDraft,
    getDraft,
    close,
  };
}
