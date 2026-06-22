// Domain types + dependency PORTS for the shared pipeline core (ADR-0002).
//
// Everything here is server-side only and free of CLI/HTTP concerns. The external
// I/O — Apify, Gemini, and the Video download/file system — is expressed as typed
// PORTS so the CLI, the skill, the dashboard route, and tests all inject the same
// shape. Tests fake ONLY these ports and drive the real pipeline + real SQLite
// (see HARD INVARIANT #2).

// ---------------------------------------------------------------------------
// Store row shapes (mirror docs/schema.md exactly).
// ---------------------------------------------------------------------------

export interface CreatorRow {
  username: string; // PK, lowercased, no '@'
  full_name: string | null;
  biography: string | null;
  is_verified: number | null; // 0/1
  profile_url: string | null;
  first_seen_at: string | null; // ISO-8601 UTC
  last_scraped_at: string | null; // ISO-8601 UTC
}

export interface CreatorStatsRow {
  id: number; // autoincrement surrogate PK
  creator_username: string; // FK -> creators(username)
  captured_at: string; // ISO-8601 UTC
  followers: number | null;
  following: number | null;
  posts_count: number | null;
}

/** Comment as stored in reels.top_comments (JSON). */
export interface TopComment {
  username: string;
  text: string;
  likes: number;
}

/** A single beat in reels.beat_sequence (JSON). */
export interface Beat {
  label: BeatLabel;
  start_pct: number;
  end_pct: number;
  /**
   * Verbatim transcript words spoken during this beat (the transcript segmented
   * along beat boundaries). `""` for a speechless beat (e.g. a visual-only HOOK or
   * a silent LOOP_BRIDGE). Best-effort: the flat `reels.transcript` stays canonical
   * and is NOT reconstructed from these slices.
   */
  text: string;
}

export type BeatLabel =
  | "HOOK"
  | "CONTEXT"
  | "VALUE_1"
  | "VALUE_2"
  | "VALUE_3"
  | "TENSION"
  | "PAYOFF"
  | "ESCALATION"
  | "CTA"
  | "LOOP_BRIDGE";

export type AnalysisStatus = "pending" | "analyzed" | "failed" | "skipped";

export interface ReelRow {
  // identity
  shortcode: string; // PK
  url: string;
  creator_username: string;
  // metadata
  caption: string | null;
  posted_at: string | null; // ISO-8601 UTC
  duration_sec: number | null;
  thumbnail_path: string | null;
  top_comments: string | null; // JSON array of TopComment
  // metric (raw, refreshed each run)
  likes: number | null; // Apify -1 (hidden) normalized to NULL
  comments_count: number | null;
  views: number | null;
  shares: number | null; // best-effort, usually NULL
  last_scraped_at: string | null; // ISO-8601 UTC
  // derived (recomputed each refresh; null rule applies)
  performance_score: number | null;
  engagement_rate: number | null;
  is_viral: number | null; // 0/1
  is_outlier: number | null; // 0/1
  // analysis (immutable; recomputed only on prompt-hash change)
  transcript: string | null;
  topic: string | null;
  category: string | null;
  hook_technique: string | null;
  beat_sequence: string | null; // JSON array of Beat
  why_it_works: string | null;
  analysis_status: AnalysisStatus | null;
  analysis_error: string | null;
  analyzed_at: string | null; // ISO-8601 UTC
  // provenance
  transcription_prompt_hash: string | null;
  analysis_prompt_hash: string | null;
}

// ---------------------------------------------------------------------------
// Inputs to store helpers (decoded shapes — JSON columns as parsed objects).
// ---------------------------------------------------------------------------

export interface UpsertCreatorInput {
  username: string;
  full_name?: string | null;
  biography?: string | null;
  is_verified?: boolean | number | null;
  profile_url?: string | null;
  last_scraped_at?: string | null;
}

export interface AppendCreatorStatsInput {
  creator_username: string;
  captured_at: string;
  followers?: number | null;
  following?: number | null;
  posts_count?: number | null;
}

/** Identity + metadata used to first create / metadata-update a Reel. */
export interface UpsertReelInput {
  shortcode: string;
  url: string;
  creator_username: string;
  caption?: string | null;
  posted_at?: string | null;
  duration_sec?: number | null;
  thumbnail_path?: string | null;
  top_comments?: TopComment[] | null;
}

/** Raw + derived metric write (refresh path). */
export interface ReelMetricsUpdate {
  shortcode: string;
  likes?: number | null;
  comments_count?: number | null;
  views?: number | null;
  shares?: number | null;
  last_scraped_at?: string | null;
  performance_score?: number | null;
  engagement_rate?: number | null;
  is_viral?: number | null;
  is_outlier?: number | null;
}

/** Analysis write (immutable path; stamped with provenance). */
export interface ReelAnalysisUpdate {
  shortcode: string;
  transcript?: string | null;
  topic?: string | null;
  category?: string | null;
  hook_technique?: string | null;
  beat_sequence?: Beat[] | null;
  why_it_works?: string | null;
  analysis_status?: AnalysisStatus | null;
  analysis_error?: string | null;
  analyzed_at?: string | null;
  transcription_prompt_hash?: string | null;
  analysis_prompt_hash?: string | null;
}

// ---------------------------------------------------------------------------
// The Store API surface (lib/core/store.ts implements this).
// ---------------------------------------------------------------------------

export interface Store {
  /** Raw better-sqlite3 handle, for advanced queries/tests. */
  readonly db: import("better-sqlite3").Database;
  upsertCreator(input: UpsertCreatorInput): void;
  getCreator(username: string): CreatorRow | undefined;
  appendCreatorStats(input: AppendCreatorStatsInput): CreatorStatsRow;
  getLatestStats(username: string): CreatorStatsRow | undefined;
  listCreatorStats(username: string): CreatorStatsRow[];
  upsertReel(input: UpsertReelInput): void;
  getReel(shortcode: string): ReelRow | undefined;
  listReels(opts?: ListReelsOptions): ReelRow[];
  updateReelMetrics(update: ReelMetricsUpdate): void;
  updateReelAnalysis(update: ReelAnalysisUpdate): void;
  close(): void;
}

export interface ListReelsOptions {
  creator?: string;
  /** Default ordering is posted_at DESC (newest-first), NULLs last. */
  orderBy?: "posted_at" | "performance_score" | "is_viral" | "category";
  direction?: "asc" | "desc";
  limit?: number;
}

// ---------------------------------------------------------------------------
// Dependency PORTS — the external I/O seams (faked in tests).
// ---------------------------------------------------------------------------

/** What `scrape` needs from Apify, expressed as a port (not the SDK directly). */
export interface ScrapedCreatorProfile {
  username: string;
  full_name?: string | null;
  biography?: string | null;
  is_verified?: boolean | null;
  followers?: number | null;
  following?: number | null;
  posts_count?: number | null;
}

export interface ScrapedReel {
  shortcode: string;
  url: string;
  caption?: string | null;
  posted_at?: string | null; // ISO-8601 UTC
  duration_sec?: number | null;
  /** Raw likes from Apify; -1 means hidden and is normalized to NULL by the core. */
  likes?: number | null;
  comments_count?: number | null;
  views?: number | null;
  shares?: number | null;
  /** Remote thumbnail URL (downloaded by the VideoPort). */
  thumbnail_url?: string | null;
  /** Transient CDN video URL (expires); used by analyze. */
  video_url?: string | null;
  top_comments?: TopComment[] | null;
}

export interface ScrapeResult {
  profile: ScrapedCreatorProfile;
  reels: ScrapedReel[];
}

export interface ApifyPort {
  /** Scrape a creator's recent Reels + profile within a day window, capped. */
  scrapeCreator(args: {
    username: string;
    windowDays: number;
    resultsLimit: number;
  }): Promise<ScrapeResult>;
}

/** What `analyze` needs from Gemini, expressed as a port. */
export interface GeminiTranscriptResult {
  transcript: string;
}

export interface GeminiAnalysisResult {
  transcript: string;
  topic: string;
  category: string;
  hook_technique: string;
  beat_sequence: Beat[];
  why_it_works: string;
}

/**
 * Opaque handle to a video already uploaded to Gemini's Files API and polled to
 * ACTIVE. Lets analyze upload a Reel's Video ONCE and reuse it for BOTH the
 * transcription and the analysis call (one upload, two generateContent calls).
 * Its shape is the real adapter's private business; callers treat it as opaque.
 */
export type GeminiVideoHandle = unknown;

export interface GeminiPort {
  /**
   * Upload a local video to Gemini ONCE and wait until it's ACTIVE, returning a
   * reusable handle. Optional: when a port doesn't implement it (test fakes),
   * analyze falls back to per-call upload via `videoPath`. Pair with releaseVideo.
   */
  prepareVideo?(args: { videoPath: string }): Promise<GeminiVideoHandle>;
  /** Delete a previously-uploaded video handle (best-effort). */
  releaseVideo?(handle: GeminiVideoHandle): Promise<void>;
  /**
   * Transcribe a video verbatim using the given prompt. Pass a `video` handle from
   * prepareVideo to reuse a single upload; otherwise the adapter uploads `videoPath`.
   */
  transcribe(args: {
    videoPath: string;
    prompt: string;
    model: string;
    video?: GeminiVideoHandle;
  }): Promise<GeminiTranscriptResult>;
  /**
   * Run lean-core analysis on a video using the given (rendered) prompt. Pass a
   * `video` handle from prepareVideo to reuse a single upload; otherwise the adapter
   * uploads `videoPath`.
   */
  analyzeVideo(args: {
    videoPath: string;
    prompt: string;
    model: string;
    transcript: string;
    video?: GeminiVideoHandle;
  }): Promise<GeminiAnalysisResult>;
}

/** Video download + thumbnail + file lifecycle (download -> analyze -> delete). */
export interface VideoPort {
  /** Download a transient video file from a CDN URL; returns its local path. */
  downloadVideo(args: { url: string; shortcode: string }): Promise<string>;
  /** Download + persist a thumbnail; returns the local thumbnail path. */
  downloadThumbnail(args: { url: string; shortcode: string }): Promise<string>;
  /** Delete a transient video file (the .mp4 is never kept). */
  deleteVideo(path: string): Promise<void>;
}

/** Bundle of injectable external ports. All optional — defaults are real adapters. */
export interface Deps {
  apify?: ApifyPort;
  gemini?: GeminiPort;
  video?: VideoPort;
}

// ---------------------------------------------------------------------------
// Pipeline action surface.
// ---------------------------------------------------------------------------

export type PipelineAction = "scrape" | "analyze" | "refresh" | "full";

export type PipelineStage = "scrape" | "analyze" | "refresh";

/** Progress hook used by the future run API to drive a progress bar. */
export type OnProgress = (stage: PipelineStage, done: number, total: number) => void;

export interface ScrapeResultSummary {
  creator: string;
  reelsScraped: number;
  reelsUpserted: number;
  statsSnapshotId: number | null;
  /** Total Reels the actor returned, before the window + cap were applied. */
  reelsReturned: number;
  /** Reels dropped because they fell outside the scrape_window_days window. */
  droppedOutOfWindow: number;
  /** Reels dropped because results_limit was hit (no silent truncation, build-spec.md). */
  droppedOverCap: number;
}

export interface AnalyzeResultSummary {
  creator: string;
  analyzed: number;
  skipped: number;
  failed: number;
  /** Reels left un-analyzed because the per-run cap was hit (no silent truncation). */
  remainingOverCap: number;
}

export interface RefreshResultSummary {
  creator: string;
  reelsRefreshed: number;
  statsSnapshotId: number | null;
}

export interface PipelineResult {
  action: PipelineAction;
  creator: string;
  scrape?: ScrapeResultSummary;
  analyze?: AnalyzeResultSummary;
  refresh?: RefreshResultSummary;
}
