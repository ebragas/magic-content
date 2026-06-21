// Content Store — the durable, canonical SQLite store (ADR-0001, docs/schema.md).
//
// Server-side only (better-sqlite3). Opening a fresh DB is idempotent: all DDL is
// CREATE ... IF NOT EXISTS, safe to re-run. Tests pass ':memory:' or a temp file.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AppendCreatorStatsInput,
  CreatorRow,
  CreatorStatsRow,
  ListReelsOptions,
  ReelAnalysisUpdate,
  ReelMetricsUpdate,
  ReelRow,
  Store,
  UpsertCreatorInput,
  UpsertReelInput,
} from "./types.js";

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
  analysis_status            TEXT,
  analysis_error             TEXT,
  analyzed_at                TEXT,
  transcription_prompt_hash  TEXT,
  analysis_prompt_hash       TEXT
);

CREATE INDEX IF NOT EXISTS idx_reels_creator_username ON reels(creator_username);
CREATE INDEX IF NOT EXISTS idx_reels_posted_at        ON reels(posted_at);
CREATE INDEX IF NOT EXISTS idx_reels_performance_score ON reels(performance_score);
CREATE INDEX IF NOT EXISTS idx_reels_is_viral         ON reels(is_viral);
`;

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

  const upsertCreator = (input: UpsertCreatorInput): void => {
    const username = input.username.toLowerCase().replace(/^@/, "");
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
      .get(username.toLowerCase().replace(/^@/, "")) as CreatorRow | undefined;
  };

  const appendCreatorStats = (input: AppendCreatorStatsInput): CreatorStatsRow => {
    const username = input.creator_username.toLowerCase().replace(/^@/, "");
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
      .get(username.toLowerCase().replace(/^@/, "")) as CreatorStatsRow | undefined;
  };

  const listCreatorStats = (username: string): CreatorStatsRow[] => {
    return db
      .prepare(
        `SELECT * FROM creator_stats
         WHERE creator_username = ?
         ORDER BY captured_at ASC, id ASC`,
      )
      .all(username.toLowerCase().replace(/^@/, "")) as CreatorStatsRow[];
  };

  const upsertReel = (input: UpsertReelInput): void => {
    const creator_username = input.creator_username.toLowerCase().replace(/^@/, "");
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
      params.creator = opts.creator.toLowerCase().replace(/^@/, "");
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
    close,
  };
}
