// Unit tests for the EXACT Trigger-Keyword matching predicate (slice 968) — the
// server-side replacement for the retired fuzzy read-time ManyChat heuristic.

import { describe, expect, it } from "vitest";
import { isTriggerComment, normalizeTriggerKeyword } from "./trigger.js";

describe("normalizeTriggerKeyword", () => {
  it("lowercases, strips punctuation/emoji, collapses whitespace", () => {
    expect(normalizeTriggerKeyword("RITUAL")).toBe("ritual");
    expect(normalizeTriggerKeyword("  Loop!! ")).toBe("loop");
    expect(normalizeTriggerKeyword("🔁 tracker")).toBe("tracker");
  });

  it("coerces empty / whitespace / punctuation-only / null to null", () => {
    expect(normalizeTriggerKeyword(null)).toBeNull();
    expect(normalizeTriggerKeyword(undefined)).toBeNull();
    expect(normalizeTriggerKeyword("")).toBeNull();
    expect(normalizeTriggerKeyword("   ")).toBeNull();
    expect(normalizeTriggerKeyword("🔥😂")).toBeNull();
  });
});

describe("isTriggerComment — exact, not fuzzy", () => {
  it("matches a comment whose normalized text EXACTLY equals the keyword", () => {
    expect(isTriggerComment("ritual", "ritual")).toBe(true);
    expect(isTriggerComment("RITUAL!!", "ritual")).toBe(true);
    expect(isTriggerComment("🔁 Loop", "loop")).toBe(true);
  });

  it("matches a short (<=3-word) comment whose tokens include the keyword", () => {
    expect(isTriggerComment("ritual please", "ritual")).toBe(true);
    expect(isTriggerComment("drop ritual now", "ritual")).toBe(true);
  });

  it("does NOT match a longer comment that merely mentions the word", () => {
    expect(isTriggerComment("this ritual changed my whole morning routine", "ritual")).toBe(false);
  });

  it("does NOT match an unrelated comment", () => {
    expect(isTriggerComment("does this work on the free plan?", "ritual")).toBe(false);
  });

  it("never matches when the keyword is null/empty", () => {
    expect(isTriggerComment("ritual", null)).toBe(false);
    expect(isTriggerComment("ritual", "")).toBe(false);
    expect(isTriggerComment("", "ritual")).toBe(false);
  });

  it("matches a multi-word keyword only by exact equality (no token inclusion)", () => {
    expect(isTriggerComment("free guide", "free guide")).toBe(true);
    expect(isTriggerComment("free", "free guide")).toBe(false);
  });
});

describe("isTriggerComment — prefix (stem/plural/elongation) matching", () => {
  it("flags a short comment whose token STARTS WITH the keyword", () => {
    // The motivating bug: ManyChat replies vary the CTA word.
    expect(isTriggerComment("Loops", "loop")).toBe(true); // plural
    expect(isTriggerComment("loopppp", "loop")).toBe(true); // elongation
    expect(isTriggerComment("Loop….thx", "loop")).toBe(true); // token "loop" of ["loop","thx"]
    expect(isTriggerComment("loop!!", "loop")).toBe(true); // punctuation stripped → exact
  });

  it("still ignores a long comment even when a word starts with the keyword", () => {
    expect(isTriggerComment("this loop changed my whole routine", "loop")).toBe(false);
  });

  it("prefix-matches only when the keyword is >=3 chars (guards tiny keywords)", () => {
    expect(isTriggerComment("diys", "diy")).toBe(true); // 3-char keyword, prefix ok
    expect(isTriggerComment("gold rush", "go")).toBe(false); // 2-char keyword, prefix disabled
    expect(isTriggerComment("go", "go")).toBe(true); // exact still matches a tiny keyword
  });

  it("prefix matching is single-word-keyword only", () => {
    expect(isTriggerComment("free guides", "free guide")).toBe(false);
  });

  it("accepts the documented over-match: a word that merely starts with the keyword", () => {
    // Deliberate trade-off (CONTEXT/Q5): cheap false-positive (count survives) beats
    // a false-negative that leaks automation spam into FAQ mining.
    expect(isTriggerComment("loophole", "loop")).toBe(true);
  });
});
