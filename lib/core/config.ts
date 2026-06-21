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
  gemini_model: string;
}

export interface Prompts {
  transcription: string;
  /** Raw video-analysis prompt template (before category injection). */
  videoAnalysisTemplate: string;
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
  };
  return { creators, categories, settings, prompts, root };
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

export { ROOT as PROJECT_ROOT };
export { readText };
