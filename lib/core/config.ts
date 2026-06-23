// Config + prompt loading (ADR-0003).
//
// Prompts live as standalone files under prompts/ and are NEVER inlined in code.
// A prompt's version is the SHA-256 (first 12 hex chars) of its FULLY-RENDERED
// content — for the analysis prompt that means AFTER config/categories.yaml has
// been injected, so changing a category definition invalidates prior analysis.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// Project root: this file lives at <root>/lib/core/config.ts, so two levels up.
// Derive it via fileURLToPath(import.meta.url) rather than `new URL("../../",
// import.meta.url)`: webpack statically detects the `new URL(<literal>,
// import.meta.url)` form and tries to resolve the path as a bundled asset (which
// fails the Next build when this module is pulled into a route). dirname() of the
// resolved file path is webpack-inert and behaves identically under tsx/vitest.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface CreatorConfigEntry {
  username: string;
}

export interface CreatorsConfig {
  scrape_window_days: number;
  creators: CreatorConfigEntry[];
}

export interface CategoryConfigEntry {
  slug: string;
  name: string;
  definition: string;
}

export interface CategoriesConfig {
  categories: CategoryConfigEntry[];
}

export interface SettingsConfig {
  results_limit: number;
  max_analyses_per_run: number;
  /** Per-Reel cap on Comments scraped into the accumulating corpus (MAIN-966). */
  comments_per_reel: number;
  gemini_model: string;
  /**
   * Per-run cap on FAQ extractions (MAIN-969). Caps INDEPENDENTLY of max_analyses_per_run
   * (ADR-0007): a FAQ backfill on an already-video-analyzed Reel runs even when the analysis
   * cap is exhausted, and vice-versa.
   */
  max_faq_extractions_per_run: number;
  /** Claude model used for FAQ clustering via AnthropicPort.extractFaqs (ADR-0008). */
  faq_model: string;
  /**
   * Claude model used for Draft generation via AnthropicPort.generateDraft (MAIN-971 / ADR-0008).
   * The stronger Sonnet (vs. cheap Haiku for FAQs) because the Draft is the feature's payoff —
   * instruction-following + writing quality matter most here.
   */
  draft_model: string;
}

export interface Prompts {
  transcription: string;
  /** Raw video-analysis prompt template (before category injection). */
  videoAnalysisTemplate: string;
  /** Raw FAQ-extraction prompt template (before per-Reel comments/context injection). */
  faqExtractionTemplate: string;
  /** Raw Draft-generation prompt template (before per-Reel analysis/FAQs/caption injection). */
  draftGenerationTemplate: string;
}

export interface AppConfig {
  creators: CreatorsConfig;
  categories: CategoriesConfig;
  settings: SettingsConfig;
  prompts: Prompts;
  /** Project root used to resolve config/prompt/data paths. */
  root: string;
}

function readText(...segments: string[]): string {
  return readFileSync(resolve(ROOT, ...segments), "utf8");
}

/** Load all YAML config + the two prompt files. `root` override is for tests. */
export function loadConfig(root: string = ROOT): AppConfig {
  const read = (...segments: string[]): string =>
    readFileSync(resolve(root, ...segments), "utf8");
  const creators = parseYaml(read("config", "creators.yaml")) as CreatorsConfig;
  const categories = parseYaml(read("config", "categories.yaml")) as CategoriesConfig;
  const settings = parseYaml(read("config", "settings.yaml")) as SettingsConfig;
  const prompts: Prompts = {
    transcription: read("prompts", "transcription.md"),
    videoAnalysisTemplate: read("prompts", "video-analysis.md"),
    faqExtractionTemplate: read("prompts", "faq-extraction.md"),
    draftGenerationTemplate: read("prompts", "draft-generation.md"),
  };
  return { creators, categories, settings, prompts, root };
}

/**
 * Return a copy of `config` with the per-run PROCESSING caps lifted — the "Reprocess"
 * override (CONTEXT.md). A video-analysis prompt/schema change drifts the hash for every
 * Reel at once, so a deliberate re-analysis of the TRACKED set must not be clipped by the
 * routine per-run guardrails. Lifts the two processing caps:
 *   - `max_analyses_per_run`        so every drifted Reel in the working set is re-analyzed
 *                                   in one pass (not just the newest 25), and
 *   - `max_faq_extractions_per_run` so every Reel's FAQs are re-mined too.
 *
 * `results_limit` is intentionally LEFT ALONE: it bounds how many Reels `scrape` pulls +
 * caches a fresh video URL for (the working set analyze can reach), and it is the
 * deliberate "how much do we track" knob — lifting it widens COVERAGE (pulling the whole
 * 90-day window: potentially hundreds of Reels for a prolific creator), which is a
 * different decision from re-deriving analysis for what's already tracked. To reprocess a
 * larger set, raise `results_limit` in config first. The 90-day window is likewise left
 * untouched. Pure: spreads rather than mutating, so the shared loaded config is never
 * poisoned. MAX_SAFE_INTEGER (not Infinity) so any JSON-serialized run result stays a real number.
 */
export function applyNoCap(config: AppConfig): AppConfig {
  return {
    ...config,
    settings: {
      ...config.settings,
      max_analyses_per_run: Number.MAX_SAFE_INTEGER,
      max_faq_extractions_per_run: Number.MAX_SAFE_INTEGER,
    },
  };
}

const CATEGORY_TOKEN = "{{CATEGORIES}}";

/** Render the categories block injected into the analysis prompt. */
export function renderCategoriesBlock(categories: CategoriesConfig): string {
  return categories.categories
    .map((c) => `- \`${c.slug}\` — ${c.name}: ${c.definition}`)
    .join("\n");
}

/**
 * Render the analysis prompt with the category config injected at the
 * {{CATEGORIES}} token. This fully-rendered text is what gets hashed.
 */
export function renderAnalysisPrompt(config: AppConfig): string {
  const block = renderCategoriesBlock(config.categories);
  return config.prompts.videoAnalysisTemplate.replace(CATEGORY_TOKEN, block);
}

/** SHA-256, first 12 hex chars, of the given (already-rendered) prompt text. */
export function promptHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

/** Convenience: the current analysis prompt hash (categories injected). */
export function analysisPromptHash(config: AppConfig): string {
  return promptHash(renderAnalysisPrompt(config));
}

/** Convenience: the current transcription prompt hash. */
export function transcriptionPromptHash(config: AppConfig): string {
  return promptHash(config.prompts.transcription);
}

/**
 * Convenience: the current FAQ-extraction prompt hash (MAIN-969 / ADR-0003). Hashes the
 * prompt TEMPLATE (the static instruction text), NOT the per-Reel content injected at call
 * time (comments/topic/transcript). Editing the FAQ prompt bumps this hash → exactly one
 * FAQ re-extraction per Reel; per-Reel comment changes are tracked SEPARATELY via the
 * "Comments re-pulled since the last FAQ run" signal (faqs_generated_at), not this hash.
 */
export function faqPromptHash(config: AppConfig): string {
  return promptHash(config.prompts.faqExtractionTemplate);
}

/**
 * Convenience: the current Draft-generation prompt hash (MAIN-971 / ADR-0003). Hashes the prompt
 * TEMPLATE (the static instruction text), NOT the per-Reel content injected at call time (analysis/
 * FAQs/caption). Unlike the immutable-analysis legs, the Draft is on-demand + user-state (ADR-0006),
 * so there is no hash-drift re-run predicate; this exists for parity/provenance only.
 */
export function draftPromptHash(config: AppConfig): string {
  return promptHash(config.prompts.draftGenerationTemplate);
}

export { ROOT as PROJECT_ROOT };
export { readText };
