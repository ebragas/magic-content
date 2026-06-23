// Config + prompt-hash harness. Confirms the YAML config + prompts load, the
// analysis prompt injects categories, and the hash is the SHA-256 first-12-hex of
// the FULLY-RENDERED content (ADR-0003).

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  analysisPromptHash,
  applyNoCap,
  faqPromptHash,
  loadConfig,
  promptHash,
  renderAnalysisPrompt,
  renderCategoriesBlock,
} from "./config.js";

describe("config + prompts", () => {
  const config = loadConfig();

  it("loads creators / categories / settings YAML", () => {
    expect(config.creators.scrape_window_days).toBe(90);
    expect(config.creators.creators[0].username).toBe("itsmariahbrunner");
    expect(config.categories.categories).toHaveLength(7);
    expect(config.categories.categories.map((c) => c.slug)).toEqual([
      "tool_demo",
      "concept_teaching",
      "story_personal",
      "commentary_opinion",
      "promo_offer",
      "news",
      "other",
    ]);
    expect(config.settings.results_limit).toBe(50);
    expect(config.settings.max_analyses_per_run).toBe(25);
    expect(config.settings.comments_per_reel).toBe(150);
    expect(config.settings.gemini_model).toMatch(/gemini/);
    // slice 969 — FAQ settings.
    expect(config.settings.max_faq_extractions_per_run).toBe(25);
    expect(config.settings.faq_model).toMatch(/claude/);
  });

  it("loads the standalone prompt files (incl. FAQ extraction, slice 969)", () => {
    expect(config.prompts.transcription.toLowerCase()).toContain("verbatim");
    expect(config.prompts.videoAnalysisTemplate).toContain("{{CATEGORIES}}");
    // The FAQ prompt is externalized and carries the per-Reel injection tokens.
    expect(config.prompts.faqExtractionTemplate).toContain("{{COMMENTS}}");
    expect(config.prompts.faqExtractionTemplate).toContain("member_indices");
  });

  it("faqPromptHash is the SHA-256 first-12-hex of the FAQ prompt TEMPLATE (slice 969)", () => {
    const expected = createHash("sha256")
      .update(config.prompts.faqExtractionTemplate, "utf8")
      .digest("hex")
      .slice(0, 12);
    expect(faqPromptHash(config)).toBe(expected);
    expect(faqPromptHash(config)).toHaveLength(12);
    // Editing the FAQ prompt template bumps the hash (drives the FAQ re-run, ADR-0007).
    const mutated = structuredClone(config);
    mutated.prompts.faqExtractionTemplate += "\n<!-- edited -->";
    expect(faqPromptHash(mutated)).not.toBe(faqPromptHash(config));
  });

  it("renders the analysis prompt with categories injected at the token", () => {
    const rendered = renderAnalysisPrompt(config);
    expect(rendered).not.toContain("{{CATEGORIES}}");
    expect(rendered).toContain(renderCategoriesBlock(config.categories));
    expect(rendered).toContain("tool_demo");
  });

  it("promptHash is SHA-256 first 12 hex of rendered content", () => {
    const rendered = renderAnalysisPrompt(config);
    const expected = createHash("sha256").update(rendered, "utf8").digest("hex").slice(0, 12);
    expect(promptHash(rendered)).toBe(expected);
    expect(analysisPromptHash(config)).toBe(expected);
    expect(expected).toHaveLength(12);
  });

  it("changing a category definition changes the analysis prompt hash", () => {
    const baseline = analysisPromptHash(config);
    const mutated = structuredClone(config);
    mutated.categories.categories[0].definition = "totally different definition";
    expect(analysisPromptHash(mutated)).not.toBe(baseline);
  });
});

describe("applyNoCap — the Reprocess override (--no-cap)", () => {
  const base = loadConfig();

  it("lifts the two PROCESSING caps to a real (non-Infinity) max", () => {
    const lifted = applyNoCap(base);
    expect(lifted.settings.max_analyses_per_run).toBe(Number.MAX_SAFE_INTEGER);
    expect(lifted.settings.max_faq_extractions_per_run).toBe(Number.MAX_SAFE_INTEGER);
    // MAX_SAFE_INTEGER, never Infinity (which JSON-serializes to null).
    expect(Number.isFinite(lifted.settings.max_analyses_per_run)).toBe(true);
  });

  it("leaves results_limit (the coverage knob) and the 90-day window untouched", () => {
    const lifted = applyNoCap(base);
    // results_limit bounds how many Reels are tracked; Reprocess re-analyzes what's
    // tracked, it does not widen coverage (that's a deliberate config change).
    expect(lifted.settings.results_limit).toBe(base.settings.results_limit);
    expect(lifted.creators.scrape_window_days).toBe(base.creators.scrape_window_days);
    expect(lifted.settings.comments_per_reel).toBe(base.settings.comments_per_reel);
    expect(lifted.settings.gemini_model).toBe(base.settings.gemini_model);
  });

  it("is pure — does not mutate the input config", () => {
    applyNoCap(base);
    expect(base.settings.results_limit).toBe(50);
    expect(base.settings.max_analyses_per_run).toBe(25);
    expect(base.settings.max_faq_extractions_per_run).toBe(25);
  });
});
