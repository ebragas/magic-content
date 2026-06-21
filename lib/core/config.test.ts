// Config + prompt-hash harness. Confirms the YAML config + prompts load, the
// analysis prompt injects categories, and the hash is the SHA-256 first-12-hex of
// the FULLY-RENDERED content (ADR-0003).

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  analysisPromptHash,
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
    expect(config.settings.gemini_model).toMatch(/gemini/);
  });

  it("loads the two standalone prompt files", () => {
    expect(config.prompts.transcription.toLowerCase()).toContain("verbatim");
    expect(config.prompts.videoAnalysisTemplate).toContain("{{CATEGORIES}}");
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
