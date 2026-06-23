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

/**
 * A row in the dedicated `comments` corpus (mirror docs/schema.md exactly). The
 * accumulating, durable Comment store the FAQ mining (slice 968) reads from —
 * distinct from the thin inline `reels.top_comments` JSON. Upserted by
 * `comment_id` across scrapes so the union accumulates (first_seen_at preserved).
 */
export interface CommentRow {
  comment_id: string; // PK — Instagram's native comment id
  shortcode: string; // FK -> reels(shortcode)
  username: string | null;
  text: string | null;
  likes: number | null;
  posted_at: string | null; // ISO-8601 UTC (best-effort from the actor)
  first_seen_at: string | null; // ISO-8601 UTC — set on first insert, never clobbered
  is_trigger: number; // 0/1 — DDL is NOT NULL DEFAULT 0 (set by the trigger-flag pass)
}

/**
 * A row in the `faqs` table (mirror docs/schema.md exactly). One canonical, mined
 * question per Reel, ranked by strength (MAIN-969 / ADR-0007). support_count /
 * support_likes / strength_score are SNAPSHOTTED here but COMPUTED from the REAL
 * `faq_comments` links — never an LLM-claimed number. faqs + faq_comments are wholesale
 * replaced per FAQ run (replaceFaqs); the `comments` corpus is never mutated by a FAQ run.
 */
export interface FaqRow {
  id: number; // autoincrement surrogate PK
  shortcode: string; // FK -> reels(shortcode)
  question: string; // the canonical clustered question
  /** # of linked Comments (COUNT of faq_comments rows for this FAQ). */
  support_count: number;
  /** Sum of the linked Comments' likes (NULL likes count as 0). */
  support_likes: number;
  /** Deterministic demand score: support_count + ln(1 + support_likes). See faqs.ts. */
  strength_score: number;
}

/** A row in the `faq_comments` join (mirror docs/schema.md exactly). */
export interface FaqCommentRow {
  faq_id: number; // FK -> faqs(id)
  comment_id: string; // FK -> comments(comment_id)
}

/**
 * A row in the `drafts` table (mirror docs/schema.md exactly). The user-owned "your version"
 * of a Reel (MAIN-971 / ADR-0006/0008): ONE per Reel (shortcode PK/FK, no history) — generating
 * again is a destructive full-replace. The generated fields are SNAPSHOTTED as JSON strings:
 * `hooks` (3 options, exactly one suggested) and `beat_scripts` (per-beat talking points, aligned
 * to the Reel's analyzed beats). Categorically user-state (ADR-0006): no pipeline run produces or
 * clobbers it; it's written only through the standalone /api/reels/{shortcode}/draft route.
 */
export interface DraftRow {
  shortcode: string; // PK — FK -> reels(shortcode); one Draft per Reel
  hooks: string; // JSON array of DraftHook
  beat_scripts: string; // JSON array of DraftBeatScript
  reasoning: string; // free text; references which FAQs were baked in
  caption: string; // generated caption (NOT a copy of the original)
  generated_at: string; // ISO-8601 UTC — first generated
  updated_at: string; // ISO-8601 UTC — last (re)generated
}

/** One hook option in a Draft's `hooks` JSON. Exactly one of the three is `suggested`. */
export interface DraftHook {
  text: string;
  suggested: boolean;
}

/**
 * One per-beat talking-points script in a Draft's `beat_scripts` JSON. Aligned 1:1 to the Reel's
 * analyzed beat sequence (same labels, same order); EMPTY when the Reel has no analyzed beats —
 * the Draft NEVER invents beat structure the analysis didn't find.
 */
export interface DraftBeatScript {
  label: BeatLabel;
  script: string;
}

/** Decoded Draft (JSON columns parsed) — the shape the dashboard view-model + tests consume. */
export interface Draft {
  shortcode: string;
  hooks: DraftHook[];
  beat_scripts: DraftBeatScript[];
  reasoning: string;
  caption: string;
  generated_at: string;
  updated_at: string;
}

/** Validated, persistable Draft body — the input to Store.upsertDraft (decoded JSON shapes). */
export interface DraftInput {
  shortcode: string;
  hooks: DraftHook[];
  beat_scripts: DraftBeatScript[];
  reasoning: string;
  caption: string;
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
  // The CTA word viewers comment to fire a DM automation (ManyChat), derived during
  // analysis; normalized (lowercase/trim) on the write, NULL when the Reel has none.
  // Drives comments.is_trigger flagging (slice 968).
  trigger_keyword: string | null;
  analysis_status: AnalysisStatus | null;
  analysis_error: string | null;
  analyzed_at: string | null; // ISO-8601 UTC
  // provenance
  transcription_prompt_hash: string | null;
  analysis_prompt_hash: string | null;
  // FAQ provenance (MAIN-969 / ADR-0007). FAQ extraction has a MUTABLE input (Comments)
  // so it re-runs on absent | hash drift | Comments-re-pulled-since-last-FAQ-run.
  faq_prompt_hash: string | null; // hash of the rendered FAQ prompt that produced the FAQs
  faqs_generated_at: string | null; // ISO-8601 UTC; also the "Comments re-pulled since?" anchor
  // user state (ADR-0006 — the first mutable, user-authored columns; no pipeline run
  // produces or clobbers these). Favorite flag + when it was set.
  is_favorite: number; // 0/1, NOT NULL DEFAULT 0
  favorited_at: string | null; // ISO-8601 UTC when favorited; NULL when not
  // user state (ADR-0006 — slice 967). Archive flag + when it was set. Hidden-by-default:
  // listReels excludes is_archived = 1 unless includeArchived is on. ARCHIVE WINS OVER
  // FAVORITE — an archived favorite stays hidden unless includeArchived.
  is_archived: number; // 0/1, NOT NULL DEFAULT 0
  archived_at: string | null; // ISO-8601 UTC when archived; NULL when not
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
  /** Normalized Trigger Keyword (or null). Coerced lowercase/trim by the analyze leg. */
  trigger_keyword?: string | null;
  analysis_status?: AnalysisStatus | null;
  analysis_error?: string | null;
  analyzed_at?: string | null;
  transcription_prompt_hash?: string | null;
  analysis_prompt_hash?: string | null;
}

/**
 * FAQ-provenance write on the reels row (MAIN-969). Kept distinct from the immutable
 * analysis write because FAQ extraction is a SEPARATE leg with a mutable input (ADR-0007):
 * a FAQ backfill on an already-video-analyzed Reel stamps ONLY these two fields and must
 * not touch the analysis columns or their hashes.
 */
export interface ReelFaqProvenanceUpdate {
  shortcode: string;
  faq_prompt_hash?: string | null;
  faqs_generated_at?: string | null;
}

/**
 * One model-emitted FAQ cluster (the AnthropicPort.extractFaqs return shape). The model
 * groups the supplied comment indices into a canonical question; `member_indices` are the
 * compact 1..N indices we tagged the input Comments with. They are VALIDATED in faqs.ts —
 * out-of-range indices are DROPPED (no hallucinated links), and a cluster with zero valid
 * members is dropped — so support counts derive only from REAL comment links.
 */
export interface FaqCluster {
  question: string;
  member_indices: number[];
}

/**
 * A validated FAQ cluster ready to persist: the canonical question plus the REAL
 * comment_ids it links to (mapped back from member_indices, out-of-range dropped). The
 * input to Store.replaceFaqs — support_count/support_likes/strength_score are computed
 * from these links inside the Store, never supplied by the model.
 */
export interface FaqClusterWithLinks {
  question: string;
  comment_ids: string[];
}

/**
 * One FAQ as the dashboard detail view consumes it (MAIN-969): the snapshotted row plus
 * its live example Comments from the join. listFaqs returns these ranked by strength desc;
 * the example Comments are queried LIVE from faq_comments (no duplicated comment text).
 */
export interface FaqWithExamples {
  id: number;
  question: string;
  support_count: number;
  support_likes: number;
  strength_score: number;
  examples: CommentRow[];
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
  /**
   * Set or clear a Reel's Favorite flag — the first user-state WRITE path (ADR-0006).
   * Stamps favorited_at on favorite, clears it on unfavorite, and returns the updated
   * ReelRow so the PATCH route can echo the new state to the optimistic client.
   * Returns undefined when the shortcode doesn't exist (the route maps that to 404).
   */
  setFavorite(shortcode: string, favorite: boolean): ReelRow | undefined;
  /**
   * Set or clear a Reel's Archive flag (ADR-0006 / slice 967) — the second user-state
   * WRITE path, mirroring setFavorite. Stamps archived_at on archive, clears it on
   * unarchive, and returns the updated ReelRow so the PATCH route can echo the new state
   * to the optimistic client. Archived Reels are HIDDEN BY DEFAULT in listReels (even
   * archived favorites — archive wins over favorite). Returns undefined when the shortcode
   * doesn't exist (the route maps that to 404).
   */
  setArchived(shortcode: string, archived: boolean): ReelRow | undefined;
  /**
   * UPSERT a batch of scraped Comments for one Reel into the `comments` corpus BY
   * comment_id. Accumulates the union across repeated scrapes — an existing comment
   * is never lost; its first_seen_at is preserved while likes/text/username/posted_at
   * refresh to the newest pull (MAIN-966 / ADR-0007). is_trigger is preserved on
   * conflict (slice 968 owns it). Returns the number of rows written.
   */
  upsertComments(shortcode: string, comments: ScrapedComment[]): number;
  /** Read a Reel's accumulated Comment corpus (likes DESC, NULLs last). */
  listComments(shortcode: string, opts?: ListCommentsOptions): CommentRow[];
  /**
   * (Re)compute the is_trigger flag for every Comment of one Reel against its known
   * Trigger Keyword via a single non-destructive UPDATE (slice 968). A Comment is a
   * trigger when its normalized text EXACTLY equals the normalized keyword, or it's a
   * short (≤3-word) comment whose tokens include the keyword — tight/exact, NOT the
   * fuzzy read-time heuristic. Always clears flags first, so passing a null/empty
   * keyword un-flags every Comment. Recomputable because the keyword can arrive AFTER
   * a comment scrape (refresh-before-analyze). Returns the count of flagged Comments.
   */
  flagTriggerComments(shortcode: string, keyword: string | null | undefined): number;
  /**
   * Stamp the FAQ provenance (faq_prompt_hash / faqs_generated_at) on the reels row
   * WITHOUT touching the immutable analysis columns — the FAQ leg owns these (ADR-0007).
   */
  updateReelFaqProvenance(update: ReelFaqProvenanceUpdate): void;
  /**
   * WHOLESALE-replace a Reel's FAQs (MAIN-969). DELETES every existing `faqs` + `faq_comments`
   * row for the shortcode and reinserts the given clusters together in one transaction. For
   * each cluster, support_count = #linked comments, support_likes = SUM of their likes (NULL
   * likes count 0), strength_score = support_count + ln(1 + support_likes) — all computed FROM
   * THE REAL faq_comments links and snapshotted onto the faqs row. The `comments` corpus is
   * NEVER mutated. Clusters with zero comment_ids are skipped. Returns the number of FAQs written.
   */
  replaceFaqs(shortcode: string, clusters: FaqClusterWithLinks[]): number;
  /** Read a Reel's FAQs ranked by strength_score DESC (then id), each with its live example Comments. */
  listFaqs(shortcode: string): FaqWithExamples[];
  /** Live-query a single FAQ's example Comments from the join (likes DESC, NULLs last). No duplicated text. */
  listFaqExampleComments(faqId: number): CommentRow[];
  /**
   * UPSERT a Reel's Draft (MAIN-971 / ADR-0006/0008) — ONE per Reel (shortcode PK), no history.
   * A second call destructively FULL-REPLACES every generated field (hooks / beat_scripts /
   * reasoning / caption) and preserves generated_at (first generation) while bumping updated_at.
   * The hooks + beat_scripts arrays are JSON-encoded here from their decoded shapes. Returns the
   * decoded Draft so the route can echo it back. Categorically user-state — no pipeline run writes it.
   */
  upsertDraft(input: DraftInput): Draft;
  /**
   * SAVE a user's hand-edits to an EXISTING Draft (MAIN-972 / ADR-0006) — the hand-editing
   * counterpart to generate/regenerate (upsertDraft). Updates the editable generated fields
   * (hooks / beat_scripts / reasoning / caption) of the one drafts row and BUMPS updated_at,
   * PRESERVING generated_at. Distinct from upsertDraft in that it NEVER creates a row: a save
   * only persists edits to a Draft that was already generated. Returns the decoded Draft so the
   * PUT route can echo it back, or undefined when no Draft exists for the shortcode (the route
   * maps that to 404 — there's nothing to edit). Categorically user-state — no pipeline run writes it.
   */
  saveDraft(input: DraftInput): Draft | undefined;
  /** Read a Reel's Draft (decoded JSON), or undefined when none has been generated. */
  getDraft(shortcode: string): Draft | undefined;
  close(): void;
}

export interface ListCommentsOptions {
  /** Cap the number of rows returned (default: all). */
  limit?: number;
}

export interface ListReelsOptions {
  creator?: string;
  /** Default ordering is posted_at DESC (newest-first), NULLs last. */
  orderBy?: "posted_at" | "performance_score" | "is_viral" | "category";
  direction?: "asc" | "desc";
  limit?: number;
  /** Restrict to user-favorited Reels (is_favorite = 1) — slice 965 / ADR-0006. */
  favoritesOnly?: boolean;
  /**
   * Include archived Reels (is_archived = 1) in the result — slice 967 / ADR-0006.
   * DEFAULT (false/absent) EXCLUDES archived Reels, so archived is hidden by default
   * EVEN for favorites: archive wins over favorite. favoritesOnly composes WITHIN the
   * visible (non-archived) scope unless includeArchived is on. The dashboard load path
   * passes `true` so the client shell holds the full set and applies the hide locally.
   */
  includeArchived?: boolean;
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

/**
 * A single Comment as the dedicated comment scrape returns it (port shape — NOT a
 * store row). `comment_id` is Instagram's native id, mapped robustly from the
 * actor's id/pk/commentId fields. Upserted into the `comments` corpus by id.
 */
export interface ScrapedComment {
  comment_id: string;
  username?: string | null;
  text?: string | null;
  likes?: number | null;
  posted_at?: string | null; // ISO-8601 UTC, best-effort
}

export interface ApifyPort {
  /** Scrape a creator's recent Reels + profile within a day window, capped. */
  scrapeCreator(args: {
    username: string;
    windowDays: number;
    resultsLimit: number;
  }): Promise<ScrapeResult>;
  /**
   * Scrape up to `limit` Comments for a single Reel (newest + top-liked), for the
   * dedicated accumulating corpus (MAIN-966). OPTIONAL so existing fakes/tests that
   * implement only `scrapeCreator` still satisfy the port; when absent, the comment
   * scrape leg is a safe no-op. `limit` comes from settings.comments_per_reel.
   */
  scrapeComments?(args: {
    shortcode: string;
    url: string;
    limit: number;
  }): Promise<ScrapedComment[]>;
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
  /**
   * The spoken/caption CTA word viewers comment to fire a DM automation (e.g. "comment
   * RITUAL"); null/absent when the Reel has no such CTA. Normalized + stored on the Reel.
   */
  trigger_keyword?: string | null;
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

/**
 * What the FAQ (and, in slice 971, Draft) legs need from Claude, expressed as a port
 * (ADR-0008). Claude owns the LANGUAGE tasks — clustering many phrasings of the same ask
 * into one canonical question — distinct from Gemini, which owns the immutable VIDEO.
 * The real adapter (adapters/anthropic.ts) is dynamic-import()ed ONLY when ANTHROPIC_API_KEY
 * is set, so the SDK NEVER loads in tests (HARD INVARIANT #2); tests inject a fake port.
 */
export interface AnthropicPort {
  /**
   * Cluster a Reel's NON-trigger Comments into ranked FAQs. Input: the Comments tagged with
   * compact 1..N indices ({idx, text, likes}) plus optional context (topic + transcript).
   * Output: clusters of {question, member_indices}. The CALLER (faqs.ts) validates the
   * indices — out-of-range member_indices are DROPPED, a cluster with zero valid members is
   * dropped — so the persisted support counts derive only from REAL comment links, never
   * from the model's word.
   */
  extractFaqs(input: {
    comments: { idx: number; text: string; likes: number }[];
    context?: { topic: string | null; transcript: string | null };
  }): Promise<{ clusters: FaqCluster[] }>;
  /**
   * Generate the user's "your version" of a Reel (MAIN-971): 3 hook options (exactly one
   * suggested), per-beat talking-points scripts aligned to the Reel's analyzed beat sequence
   * (EMPTY when the Reel has no analyzed beats — never invent structure), a FAQ-aware reasoning
   * note, and a fresh caption. Runs on the stronger Sonnet model (settings.draft_model) since this
   * is the feature's payoff (ADR-0008). The CALLER (draft.ts) VALIDATES + repairs the shape — forces
   * exactly 3 hooks with one suggested, and re-aligns beat_scripts to the real beat labels/order —
   * so a malformed model response can never persist a wrong structure.
   *
   * OPTIONAL so existing fakes/tests that implement only extractFaqs still satisfy the port; when
   * absent, the Draft leg is a safe no-op (mirrors the optional scrapeComments / prepareVideo seam).
   */
  generateDraft?(input: {
    analysis: {
      transcript: string | null;
      beat_sequence: Beat[];
      hook_technique: string | null;
      why_it_works: string | null;
      topic: string | null;
      category: string | null;
    };
    faqs: { question: string; support_count: number; support_likes: number }[];
    originalCaption: string | null;
  }): Promise<{
    hooks: { text: string; suggested: boolean }[];
    beat_scripts: { label: BeatLabel; script: string }[];
    reasoning: string;
    caption: string;
  }>;
}

/** Bundle of injectable external ports. All optional — defaults are real adapters. */
export interface Deps {
  apify?: ApifyPort;
  gemini?: GeminiPort;
  video?: VideoPort;
  anthropic?: AnthropicPort;
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
  /** Reels whose FAQs were (re)extracted this run (MAIN-969). */
  faqExtracted: number;
  /** Reels left without FAQ work because max_faq_extractions_per_run was hit (no silent truncation). */
  faqRemainingOverCap: number;
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
