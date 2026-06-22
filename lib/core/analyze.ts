// analyze — Gemini transcription + lean-core video analysis, newest-first and
// capped, with prompt-hash provenance (ADR-0003/0004).
//
// Per un-analyzed Reel, NEWEST-FIRST, up to max_analyses_per_run:
//   download the transient Video -> upload to Gemini ONCE (prepareVideo) -> run TWO
//   externalized prompts against that single upload (verbatim transcription, then
//   lean-core analysis with the Category list injected from config/categories.yaml)
//   -> store the lean-core fields + provenance hashes -> release the Gemini upload +
//   DELETE the local Video (CONTEXT.md: only the thumbnail is kept).
//
// First-time (never-analyzed) Reels are queued AHEAD of re-analysis candidates so a
// prompt/category edit can never starve first-time analyses out of the cap (#4).
// A missing fresh Video URL is a SKIP, not a failure (#2); a FAILED re-analysis
// preserves the prior success instead of overwriting it with a red badge (#5).
//
// External I/O (Gemini + the Video download/file lifecycle) is dependency-injected
// through ports (HARD INVARIANT #2): tests fake ONLY those ports and assert on the
// resulting Content Store state. When no Gemini port is injected AND no API key is
// available, analyze is a safe no-op that reports zero work (walking skeleton).
//
// What gets (re)analyzed (Slice 5 — incrementality / ADR-0004): a Reel is a
// candidate when EITHER
//   (a) its analysis_status is not "analyzed" (pending / failed / null), OR
//   (b) it IS analyzed but a producing prompt's content hash has changed —
//       stored transcription_prompt_hash != current OR analysis_prompt_hash !=
//       current. Changing a Category definition in config/categories.yaml changes
//       the injected (rendered) analysis prompt and so its hash, triggering EXACTLY
//       ONE re-analysis (the re-stamp brings the stored hash back in line with the
//       current one, so the very next run skips it again — idempotent).
// Equal hashes on an already-analyzed Reel → skip (immutable; the build-spec smoke
// test wants a 2nd run to analyze 0 new). Re-analysis depends on a current scrape:
// the .mp4 is gone and the CDN video_url expires, so analyze reads a fresh URL from
// the in-run cache that scrape populated (see getVideoUrl + the cache below).

import type { AppConfig } from "./config.js";
import {
  analysisPromptHash,
  loadConfig,
  renderAnalysisPrompt,
  transcriptionPromptHash,
} from "./config.js";
import { normalizeUsername } from "./username.js";
import type {
  AnalyzeResultSummary,
  Beat,
  BeatLabel,
  Deps,
  GeminiAnalysisResult,
  GeminiPort,
  GeminiVideoHandle,
  OnProgress,
  ReelRow,
  Store,
  VideoPort,
} from "./types.js";

export interface AnalyzeArgs {
  creator: string;
  store: Store;
  config?: AppConfig;
  deps?: Deps;
  onProgress?: OnProgress;
}

/**
 * Silent-video sentinel mandated by prompts/transcription.md ("If there is no
 * spoken audio ... output exactly: `[no speech]`"). It is NOT real content: stored
 * as a null transcript so the dashboard doesn't render the literal token and
 * hasAnalysis doesn't count it as a transcript. Kept in sync with that prompt.
 */
const NO_SPEECH_SENTINEL = "[no speech]";

/**
 * Normalize a verbatim transcript for storage: trim, and map the silent-video
 * sentinel (and the empty string) to null so "no speech" is never stored as
 * content. The rest of the analysis (topic/category/etc.) is unaffected.
 */
function normalizeTranscript(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (text === "" || text === NO_SPEECH_SENTINEL) return null;
  return text;
}

const BEAT_LABELS: ReadonlySet<string> = new Set<BeatLabel>([
  "HOOK",
  "CONTEXT",
  "VALUE_1",
  "VALUE_2",
  "VALUE_3",
  "TENSION",
  "PAYOFF",
  "ESCALATION",
  "CTA",
  "LOOP_BRIDGE",
]);

/** The framework §1 hook-technique vocabulary (references/content-strategy-framework.md). */
const HOOK_TECHNIQUES: ReadonlySet<string> = new Set([
  "contrarian",
  "question",
  "mistake",
  "numbered_list",
  "time_based",
  "cold_open",
  "tension_visual",
  "pattern_interrupt",
  "social_proof",
  "curiosity_gap",
  "trend_adoption",
  "transformation",
]);

/**
 * Coerce the model's hook_technique to the governed §1 vocabulary. Unlike category
 * (a hard-validated, dashboard-filtered enum that throws on miss), hook is a softer
 * signal: an out-of-vocabulary value is coerced to NULL — mirroring sanitizeBeats —
 * so a hallucinated slug never pollutes the dashboard's hook filter.
 */
function coerceHookTechnique(hook: string | null | undefined): string | null {
  const slug = (hook ?? "").trim();
  return HOOK_TECHNIQUES.has(slug) ? slug : null;
}

/**
 * A Reel needs (re)analysis when it isn't analyzed yet, OR it is analyzed but a
 * producing prompt's content hash has drifted from the current one (ADR-0004
 * incrementality). Re-stamping on re-analysis makes this self-healing: once the
 * stored hashes match the current hashes again, the Reel is skipped on the next run.
 *
 * NOTE: a missing stored hash on an "analyzed" Reel (e.g. legacy/manually-stamped)
 * counts as drift too — `null !== <12 hex chars>` — so it gets brought into line.
 */
function needsAnalysis(
  reel: ReelRow,
  currentTranscriptionHash: string,
  currentAnalysisHash: string,
): boolean {
  if (reel.analysis_status !== "analyzed") return true;
  return (
    reel.transcription_prompt_hash !== currentTranscriptionHash ||
    reel.analysis_prompt_hash !== currentAnalysisHash
  );
}

/**
 * A re-analysis candidate is a Reel that already carries a successful analysis
 * (analysis_status === "analyzed") and is only being revisited because a producing
 * prompt's hash drifted (ADR-0004). A first-time candidate is anything else
 * (pending / failed / null). This split drives both cap prioritization (#4: never
 * starve first-time analyses) and failure handling (#5: never destroy a prior
 * success on a failed re-analysis).
 */
function isReanalysisCandidate(reel: ReelRow): boolean {
  return reel.analysis_status === "analyzed";
}

/** Validate the model's category against the governed enum; throw on miss. */
function validateCategory(category: string, config: AppConfig): string {
  const slug = (category ?? "").trim();
  const allowed = config.categories.categories.map((c) => c.slug);
  if (!allowed.includes(slug)) {
    throw new Error(
      `category "${slug}" is not one of config/categories.yaml: ${allowed.join(", ")}`,
    );
  }
  return slug;
}

/** Keep only beats with a label in the framework §2 vocabulary; clamp 0–100. */
function sanitizeBeats(beats: Beat[] | undefined | null): Beat[] {
  if (!Array.isArray(beats)) return [];
  const clamp = (n: number): number => Math.max(0, Math.min(100, Number(n) || 0));
  return beats
    .filter((b) => b && BEAT_LABELS.has(b.label))
    .map((b) => ({
      label: b.label,
      start_pct: clamp(b.start_pct),
      end_pct: clamp(b.end_pct),
      // Carry the per-beat verbatim transcript slice through; default "" when the
      // model omits it (older prompt) or returns a non-string. The flat transcript
      // stays canonical, so we trim edges but never validate/reconstruct from these.
      text: typeof b.text === "string" ? b.text.trim() : "",
    }));
}

/**
 * Lazily build the real Gemini + Video adapters when the caller didn't inject one.
 * Imported dynamically so the SDK / fetch path is NEVER pulled in by tests (which
 * always inject fakes) and so the lib/core barrel stays free of SDK side effects.
 */
async function resolvePorts(
  deps: Deps | undefined,
): Promise<{ gemini: GeminiPort | undefined; video: VideoPort | undefined }> {
  let gemini = deps?.gemini;
  let video = deps?.video;
  if (!gemini && process.env.GEMINI_API_KEY) {
    const { makeGeminiPort } = await import("./adapters/gemini.js");
    gemini = makeGeminiPort();
  }
  if (gemini && !video) {
    const { makeVideoPort } = await import("./adapters/video.js");
    video = makeVideoPort();
  }
  return { gemini, video };
}

/**
 * Analyze a creator's candidate Reels, first-time-before-re-analysis and NEWEST-FIRST
 * within each group, stopping at `max_analyses_per_run` (#4). Reels beyond the cap are
 * left un-analyzed and REPORTED (no silent truncation). Each analyzed Reel stamps both
 * prompt hashes + analyzed_at and sets analysis_status = "analyzed".
 *
 * Per-Reel outcomes when work can't complete (run always continues):
 *   - No fresh Video URL → SKIPPED, prior state untouched, counted in `skipped` (#2).
 *   - First-time failure (no prior success) → analysis_status = "failed" + error.
 *   - Re-analysis failure (had a prior success) → prior analysis + hashes preserved,
 *     only analysis_error recorded, so it stays a re-analysis candidate to retry (#5).
 */
export async function analyze(args: AnalyzeArgs): Promise<AnalyzeResultSummary> {
  const { creator, store } = args;
  const config = args.config ?? loadConfig();
  const username = normalizeUsername(creator);

  const { gemini, video } = await resolvePorts(args.deps);

  // Fully-rendered prompt hashes (analysis hash is AFTER category injection).
  const currentAnalysisHash = analysisPromptHash(config);
  const currentTranscriptionHash = transcriptionPromptHash(config);
  const analysisPrompt = renderAnalysisPrompt(config);
  const transcriptionPrompt = config.prompts.transcription;
  const model = config.settings.gemini_model;
  const cap = config.settings.max_analyses_per_run;

  // Candidates, NEWEST-FIRST (posted_at DESC, NULLs last — Store enforces it).
  // A candidate is un-analyzed OR analyzed-but-prompt-hash-drifted (re-analysis).
  const all = store.listReels({ creator: username, orderBy: "posted_at", direction: "desc" });
  const candidates = all.filter((r) =>
    needsAnalysis(r, currentTranscriptionHash, currentAnalysisHash),
  );

  // Prioritize NEVER-analyzed (first-time) Reels ahead of re-analysis candidates so
  // a categories.yaml/prompt edit can never starve first-time analyses: after such an
  // edit the newest already-analyzed Reels would otherwise eat the whole cap. Both
  // groups stay newest-first (candidates is already posted_at DESC); re-analyses
  // consume only the cap budget left over after every first-timer is queued (#4).
  const firstTime = candidates.filter((r) => !isReanalysisCandidate(r));
  const reanalysis = candidates.filter((r) => isReanalysisCandidate(r));
  const prioritized = [...firstTime, ...reanalysis];

  const toAnalyze = prioritized.slice(0, cap);
  const remainingOverCap = candidates.length - toAnalyze.length;
  const total = toAnalyze.length;

  args.onProgress?.("analyze", 0, total);

  // No Gemini available (no injected port + no API key): safe no-op. Nothing is
  // analyzed; the cap report still reflects what WOULD have been left over, and
  // `skipped` reports already-analyzed Reels consistently with the real path.
  if (!gemini || !video) {
    const skipped = all.length - candidates.length;
    return { creator: username, analyzed: 0, skipped, failed: 0, remainingOverCap };
  }

  let analyzed = 0;
  let failed = 0;
  // Reels we couldn't even attempt because no fresh Video URL was available (cache
  // miss with nothing durable to re-resolve from). These are SKIPPED — never failed —
  // so a missing URL is not a durable red regression decided by entry point (#2).
  let urlMissSkipped = 0;
  let done = 0;

  for (const reel of toAnalyze) {
    const reanalysis = isReanalysisCandidate(reel);

    // (#2) A missing Video URL must NOT mark the Reel failed. v1 doesn't persist the
    // expiring CDN videoUrl (docs/schema.md) and the Reel's canonical URL is the
    // instagram.com page, not a downloadable .mp4 — so with no cached URL there is
    // genuinely nothing to fetch. Skip (count as skipped), leaving the Reel's prior
    // state intact so it retries on the next run with a current scrape:
    //   - a first-time candidate stays pending (untouched),
    //   - a re-analysis candidate keeps its prior success + un-advanced hashes,
    //     so it remains a re-analysis candidate (mirrors the #5 failure contract).
    const videoUrl = getVideoUrl(reel);
    if (!videoUrl) {
      urlMissSkipped += 1;
      done += 1;
      args.onProgress?.("analyze", done, total);
      continue;
    }

    let videoPath: string | null = null;
    // (#13) Upload each Reel's Video to Gemini ONCE and reuse the handle for BOTH the
    // transcription and the analysis call, halving upload bytes + poll waits.
    let videoHandle: GeminiVideoHandle | undefined;
    try {
      videoPath = await video.downloadVideo({ url: videoUrl, shortcode: reel.shortcode });
      videoHandle = await gemini.prepareVideo?.({ videoPath });

      // 1) Verbatim transcription (prompts/transcription.md).
      const { transcript } = await gemini.transcribe({
        videoPath,
        prompt: transcriptionPrompt,
        model,
        video: videoHandle,
      });

      // 2) Lean-core analysis (prompts/video-analysis.md, categories injected) — the
      // SAME uploaded Video (videoHandle); the analysis call gets the transcript too.
      const analysis: GeminiAnalysisResult = await gemini.analyzeVideo({
        videoPath,
        prompt: analysisPrompt,
        model,
        transcript,
        video: videoHandle,
      });

      const category = validateCategory(analysis.category, config);
      const beat_sequence = sanitizeBeats(analysis.beat_sequence);

      store.updateReelAnalysis({
        shortcode: reel.shortcode,
        // (#6) Prefer the verbatim transcript; fall back to the analysis echo. The
        // silent-video sentinel and empty string normalize to null (not content).
        transcript:
          normalizeTranscript(transcript) ?? normalizeTranscript(analysis.transcript),
        topic: analysis.topic ?? null,
        category,
        hook_technique: coerceHookTechnique(analysis.hook_technique),
        beat_sequence,
        why_it_works: analysis.why_it_works ?? null,
        analysis_status: "analyzed",
        analysis_error: null,
        analyzed_at: new Date().toISOString(),
        transcription_prompt_hash: currentTranscriptionHash,
        analysis_prompt_hash: currentAnalysisHash,
      });
      analyzed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // (#5) Distinguish first-time failure from re-analysis failure:
      //   - NO prior success → record status=failed + error (today's behavior).
      //   - HAD a prior success (re-analysis) → do NOT destroy it: preserve the prior
      //     analysis fields and do NOT advance the prompt hashes, so the Reel remains
      //     a re-analysis candidate and retries next run. Record the error WITHOUT
      //     claiming success — analysis_status stays "analyzed" (the prior success),
      //     never a green analysis wearing a red 'failed' badge, and the provenance
      //     hash contract (stored hash drifted vs current) stays honest.
      if (reanalysis) {
        store.updateReelAnalysis({
          shortcode: reel.shortcode,
          analysis_error: message,
        });
      } else {
        store.updateReelAnalysis({
          shortcode: reel.shortcode,
          analysis_status: "failed",
          analysis_error: message,
        });
      }
      failed += 1;
    } finally {
      // Release the single Gemini upload (best-effort) before deleting the local .mp4.
      if (videoHandle !== undefined && gemini.releaseVideo) {
        try {
          await gemini.releaseVideo(videoHandle);
        } catch {
          // Remote cleanup is best-effort; files expire on their own.
        }
      }
      // Always DELETE the transient Video — only the thumbnail is kept (CONTEXT.md).
      if (videoPath) {
        try {
          await video.deleteVideo(videoPath);
        } catch {
          // Cleanup is best-effort; never fail the run on a delete error.
        }
      }
      done += 1;
      args.onProgress?.("analyze", done, total);
    }
  }

  // `skipped` = already-up-to-date Reels that weren't candidates (build-spec.md) PLUS
  // candidates we couldn't attempt for lack of a fresh Video URL (#2) — both are
  // skipped, not failed.
  const skipped = all.length - candidates.length + urlMissSkipped;
  return { creator: username, analyzed, skipped, failed, remainingOverCap };
}

/**
 * Resolve the transient Video URL for a Reel. v1 does not persist the (expiring)
 * CDN videoUrl on the Reel row (docs/schema.md), so analyze depends on a current
 * scrape carrying it in-process (build-spec.md: "Re-analysis implies a re-scrape").
 * When run standalone with no cached URL, the Reel canonical URL is not a
 * downloadable .mp4, so there's nothing to fetch — the Reel is SKIPPED (left in its
 * prior state to retry on the next scrape-backed run), never marked failed (#2).
 */
function getVideoUrl(reel: ReelRow): string | null {
  return videoUrlCache.get(reel.shortcode) ?? null;
}

// ---------------------------------------------------------------------------
// In-run Video-URL cache. The expiring CDN videoUrl is NOT durable (schema.md), so
// scrape stashes it here for the same-process `full` run; analyze reads it. Cleared
// by scrape at the start of each scrape so it never serves a stale URL across runs.
// ---------------------------------------------------------------------------

const videoUrlCache = new Map<string, string>();

/** Record a Reel's transient Video URL for the current process run (scrape -> analyze). */
export function rememberVideoUrl(shortcode: string, url: string | null | undefined): void {
  if (url) videoUrlCache.set(shortcode, url);
}

/** Reset the in-run Video-URL cache (called at the start of each scrape). */
export function resetVideoUrlCache(): void {
  videoUrlCache.clear();
}

/** Test seam: directly seed the in-run Video-URL cache. */
export function __setVideoUrlForTest(shortcode: string, url: string): void {
  videoUrlCache.set(shortcode, url);
}
