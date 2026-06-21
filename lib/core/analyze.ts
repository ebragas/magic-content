// analyze — Gemini transcription + lean-core video analysis, newest-first and
// capped, with prompt-hash provenance (ADR-0003/0004).
//
// Per un-analyzed Reel, NEWEST-FIRST, up to max_analyses_per_run:
//   download the transient Video -> upload to Gemini -> run TWO externalized
//   prompts (verbatim transcription, then lean-core analysis with the Category list
//   injected from config/categories.yaml) -> store the lean-core fields + provenance
//   hashes -> DELETE the Video (CONTEXT.md: only the thumbnail is kept).
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
import type {
  AnalyzeResultSummary,
  Beat,
  BeatLabel,
  Deps,
  GeminiAnalysisResult,
  GeminiPort,
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
 * Analyze a creator's un-analyzed Reels, NEWEST-FIRST, stopping at
 * `max_analyses_per_run`. Reels beyond the cap are left un-analyzed and REPORTED
 * (no silent truncation). Each analyzed Reel stamps both prompt hashes + analyzed_at
 * and sets analysis_status = "analyzed"; a per-Reel failure is recorded
 * (analysis_status = "failed", analysis_error set) and the run continues.
 */
export async function analyze(args: AnalyzeArgs): Promise<AnalyzeResultSummary> {
  const { creator, store } = args;
  const config = args.config ?? loadConfig();
  const username = creator.toLowerCase().replace(/^@/, "");

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

  const toAnalyze = candidates.slice(0, cap);
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
  let done = 0;

  for (const reel of toAnalyze) {
    const videoUrl = getVideoUrl(reel);
    let videoPath: string | null = null;
    try {
      if (!videoUrl) {
        throw new Error(
          "no Video URL available to download (re-analysis requires a fresh scrape — build-spec.md)",
        );
      }
      videoPath = await video.downloadVideo({ url: videoUrl, shortcode: reel.shortcode });

      // 1) Verbatim transcription (prompts/transcription.md).
      const { transcript } = await gemini.transcribe({
        videoPath,
        prompt: transcriptionPrompt,
        model,
      });

      // 2) Lean-core analysis (prompts/video-analysis.md, categories injected) — the
      // same uploaded Video conceptually; the analysis call gets the transcript too.
      const analysis: GeminiAnalysisResult = await gemini.analyzeVideo({
        videoPath,
        prompt: analysisPrompt,
        model,
        transcript,
      });

      const category = validateCategory(analysis.category, config);
      const beat_sequence = sanitizeBeats(analysis.beat_sequence);

      store.updateReelAnalysis({
        shortcode: reel.shortcode,
        // Prefer the verbatim transcript; fall back to the analysis echo.
        transcript: transcript || analysis.transcript || null,
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
      store.updateReelAnalysis({
        shortcode: reel.shortcode,
        analysis_status: "failed",
        analysis_error: err instanceof Error ? err.message : String(err),
      });
      failed += 1;
    } finally {
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

  // `skipped` = already-analyzed Reels that didn't count against the cap (build-spec.md).
  const skipped = all.length - candidates.length;
  return { creator: username, analyzed, skipped, failed, remainingOverCap };
}

/**
 * Resolve the transient Video URL for a Reel. v1 does not persist the (expiring)
 * CDN videoUrl on the Reel row (docs/schema.md), so analyze depends on a current
 * scrape carrying it in-process (build-spec.md: "Re-analysis implies a re-scrape").
 * When run standalone with no cached URL, the Reel canonical URL is not a
 * downloadable .mp4, so there's nothing to fetch — the Reel is recorded as failed.
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
