// Pipeline-seam harness for the Draft generation leg (MAIN-971).
//
// HARD INVARIANT #2: these tests drive the REAL generateDraft()/generateDraftForReel() against a
// REAL in-memory SQLite Content Store with ONLY the external port faked (Anthropic). They assert on
// resulting STORE STATE (the drafts row), never internals, and make NO live network calls. A fixture
// AnthropicPort drives each case.

import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { openStore } from "./store.js";
import {
  alignBeatScripts,
  generateDraft,
  generateDraftForReel,
  normalizeHooks,
  saveDraft,
} from "./draft.js";
import type { AnthropicPort, Beat, BeatLabel, Store } from "./types.js";

const config = loadConfig();

// --- Fixtures -------------------------------------------------------------

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

const BEATS: Beat[] = [
  { label: "HOOK", start_pct: 0, end_pct: 10, text: "the hook" },
  { label: "VALUE_1", start_pct: 10, end_pct: 60, text: "first value" },
  { label: "CTA", start_pct: 90, end_pct: 100, text: "follow" },
];

/** Seed ONE creator + ONE analyzed reel (with beats + caption) plus a couple of FAQs. */
function seedAnalyzedReel(store: Store, shortcode: string, opts?: { beats?: Beat[] }): void {
  store.upsertCreator({ username: "c" });
  store.appendCreatorStats({
    creator_username: "c",
    captured_at: new Date().toISOString(),
    followers: 10_000,
  });
  store.upsertReel({
    shortcode,
    url: `https://www.instagram.com/reel/${shortcode}/`,
    creator_username: "c",
    posted_at: daysAgo(1),
    duration_sec: 30,
    caption: "original caption here",
  });
  store.updateReelAnalysis({
    shortcode,
    analysis_status: "analyzed",
    analyzed_at: "2026-01-01T00:00:00.000Z",
    topic: "using Claude to triage email",
    category: "tool_demo",
    hook_technique: "curiosity_gap",
    why_it_works: "Strong hook, fast payoff, clear CTA.",
    transcript: "the verbatim transcript",
    beat_sequence: opts?.beats ?? BEATS,
  });
  // A couple of FAQs so we can assert they're fed (strongest first).
  store.upsertComments(shortcode, [
    { comment_id: "q1", text: "is it free?", likes: 10 },
    { comment_id: "q2", text: "does it work on mobile?", likes: 2 },
  ]);
  store.replaceFaqs(shortcode, [
    { question: "Is it free?", comment_ids: ["q1"] },
    { question: "Does it work on mobile?", comment_ids: ["q2"] },
  ]);
}

/** Fake AnthropicPort that records each generateDraft input and returns a fixed (or per-call) Draft. */
function fakeAnthropic(
  draftFor: (input: {
    analysis: { beat_sequence: Beat[] };
    faqs: { question: string; support_count: number; support_likes: number }[];
    originalCaption: string | null;
  }) => {
    hooks: { text: string; suggested: boolean }[];
    beat_scripts: { label: BeatLabel; script: string }[];
    reasoning: string;
    caption: string;
  },
): {
  port: AnthropicPort;
  calls: {
    analysis: { beat_sequence: Beat[]; transcript: string | null };
    faqs: { question: string; support_count: number; support_likes: number }[];
    originalCaption: string | null;
  }[];
} {
  const calls: {
    analysis: { beat_sequence: Beat[]; transcript: string | null };
    faqs: { question: string; support_count: number; support_likes: number }[];
    originalCaption: string | null;
  }[] = [];
  const port: AnthropicPort = {
    async extractFaqs() {
      return { clusters: [] };
    },
    async generateDraft(input) {
      calls.push({
        analysis: { beat_sequence: input.analysis.beat_sequence, transcript: input.analysis.transcript },
        faqs: input.faqs,
        originalCaption: input.originalCaption,
      });
      return draftFor(input);
    },
  };
  return { port, calls };
}

// --- Tests ----------------------------------------------------------------

describe("Draft generation → Content Store (faked Anthropic)", () => {
  it("(#1) generating writes a drafts row with 3 hooks (one suggested), beat scripts, reasoning, caption; generated_at stamped", async () => {
    const store = openStore(":memory:");
    seedAnalyzedReel(store, "AAA");
    const { port: anthropic } = fakeAnthropic(() => ({
      hooks: [
        { text: "Hook A", suggested: false },
        { text: "Hook B", suggested: true },
        { text: "Hook C", suggested: false },
      ],
      beat_scripts: [
        { label: "HOOK", script: "open with the surprise" },
        { label: "VALUE_1", script: "show the workflow" },
        { label: "CTA", script: "tell them to comment" },
      ],
      reasoning: "Baked in the 'Is it free?' FAQ up front.",
      caption: "Here's my version — comment FREE for the link.",
    }));

    const result = await generateDraft({ shortcode: "AAA", store, config, deps: { anthropic } });
    expect(result.found).toBe(true);
    expect(result.found && result.ran).toBe(true);

    // The drafts row was written.
    const draft = store.getDraft("AAA")!;
    expect(draft).toBeTruthy();
    expect(draft.hooks).toHaveLength(3);
    expect(draft.hooks.filter((h) => h.suggested)).toHaveLength(1);
    expect(draft.hooks.find((h) => h.suggested)!.text).toBe("Hook B");
    // Beat scripts mirror the analyzed beats' labels in order.
    expect(draft.beat_scripts.map((b) => b.label)).toEqual(["HOOK", "VALUE_1", "CTA"]);
    expect(draft.beat_scripts[1].script).toBe("show the workflow");
    expect(draft.reasoning).toContain("Is it free?");
    expect(draft.caption).toBe("Here's my version — comment FREE for the link.");
    // generated_at stamped (== updated_at on first generation).
    expect(draft.generated_at).toBeTruthy();
    expect(draft.updated_at).toBe(draft.generated_at);
    // Exactly ONE drafts row for the Reel.
    const n = store.db.prepare(`SELECT COUNT(*) AS n FROM drafts WHERE shortcode = 'AAA'`).get() as { n: number };
    expect(n.n).toBe(1);

    store.close();
  });

  it("(#2) generation is fed the Reel's analysis + FAQs (strongest first) + original caption; reasoning references baked-in FAQs", async () => {
    const store = openStore(":memory:");
    seedAnalyzedReel(store, "AAA");
    const { port: anthropic, calls } = fakeAnthropic((input) => ({
      hooks: [{ text: "h", suggested: true }],
      beat_scripts: [],
      // Echo the top FAQ into reasoning to prove it was passed in, strongest-first.
      reasoning: `Answered "${input.faqs[0]?.question}".`,
      caption: "cap",
    }));

    await generateDraft({ shortcode: "AAA", store, config, deps: { anthropic } });

    expect(calls).toHaveLength(1);
    // Analysis (transcript + beats) was passed.
    expect(calls[0].analysis.transcript).toBe("the verbatim transcript");
    expect(calls[0].analysis.beat_sequence.map((b) => b.label)).toEqual(["HOOK", "VALUE_1", "CTA"]);
    // FAQs strongest-first: "Is it free?" (10 likes) outranks "Does it work on mobile?" (2 likes).
    expect(calls[0].faqs.map((f) => f.question)).toEqual(["Is it free?", "Does it work on mobile?"]);
    expect(calls[0].faqs[0].support_likes).toBe(10);
    // Original caption was passed.
    expect(calls[0].originalCaption).toBe("original caption here");
    // Reasoning references the baked-in FAQ.
    expect(store.getDraft("AAA")!.reasoning).toContain("Is it free?");

    store.close();
  });

  it("(#3) regenerate REPLACES the generated fields (including caption) and preserves generated_at; the rendered Draft updates", async () => {
    const store = openStore(":memory:");
    seedAnalyzedReel(store, "AAA");
    let phase = 0;
    const { port: anthropic } = fakeAnthropic(() => {
      phase += 1;
      return phase === 1
        ? {
            hooks: [{ text: "First A", suggested: true }, { text: "First B", suggested: false }, { text: "First C", suggested: false }],
            beat_scripts: [{ label: "HOOK", script: "first hook script" }],
            reasoning: "first reasoning",
            caption: "FIRST caption",
          }
        : {
            hooks: [{ text: "Second A", suggested: false }, { text: "Second B", suggested: true }, { text: "Second C", suggested: false }],
            beat_scripts: [{ label: "HOOK", script: "second hook script" }],
            reasoning: "second reasoning",
            caption: "SECOND caption",
          };
    });

    await generateDraft({ shortcode: "AAA", store, config, deps: { anthropic } });
    const first = store.getDraft("AAA")!;
    expect(first.caption).toBe("FIRST caption");

    await generateDraft({ shortcode: "AAA", store, config, deps: { anthropic } });
    const second = store.getDraft("AAA")!;

    // Destructive full-replace of every generated field, INCLUDING caption.
    expect(second.caption).toBe("SECOND caption");
    expect(second.reasoning).toBe("second reasoning");
    expect(second.hooks.find((h) => h.suggested)!.text).toBe("Second B");
    // generated_at preserved; updated_at bumped (>= first).
    expect(second.generated_at).toBe(first.generated_at);
    expect(second.updated_at >= first.updated_at).toBe(true);
    // Still exactly ONE row (no history).
    const n = store.db.prepare(`SELECT COUNT(*) AS n FROM drafts`).get() as { n: number };
    expect(n.n).toBe(1);

    store.close();
  });

  it("beat_scripts are EMPTY when the Reel has no analyzed beats (never invent structure)", async () => {
    const store = openStore(":memory:");
    seedAnalyzedReel(store, "AAA", { beats: [] });
    // The model wrongly returns beat scripts; we must drop them (no analyzed beats to align to).
    const { port: anthropic } = fakeAnthropic(() => ({
      hooks: [{ text: "h", suggested: true }],
      beat_scripts: [{ label: "HOOK", script: "should be dropped" }],
      reasoning: "r",
      caption: "c",
    }));

    await generateDraft({ shortcode: "AAA", store, config, deps: { anthropic } });
    expect(store.getDraft("AAA")!.beat_scripts).toEqual([]);

    store.close();
  });

  it("a missing Reel is found:false (the route maps this to 404); no draft written", async () => {
    const store = openStore(":memory:");
    const { port: anthropic } = fakeAnthropic(() => ({
      hooks: [{ text: "h", suggested: true }],
      beat_scripts: [],
      reasoning: "r",
      caption: "c",
    }));
    const result = await generateDraft({ shortcode: "NOPE", store, config, deps: { anthropic } });
    expect(result.found).toBe(false);
    expect(store.getDraft("NOPE")).toBeUndefined();
    store.close();
  });

  it("no Anthropic port + no API key → Draft leg is a safe no-op (ran:false, no row written)", async () => {
    const store = openStore(":memory:");
    seedAnalyzedReel(store, "AAA");
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await generateDraft({ shortcode: "AAA", store, config });
      expect(result.found).toBe(true);
      expect(result.found && result.ran).toBe(false);
      expect(store.getDraft("AAA")).toBeUndefined();
    } finally {
      if (prev != null) process.env.ANTHROPIC_API_KEY = prev;
    }
    store.close();
  });

  it("a port without generateDraft is a safe no-op (the optional-seam case)", async () => {
    const store = openStore(":memory:");
    seedAnalyzedReel(store, "AAA");
    const anthropic: AnthropicPort = {
      async extractFaqs() {
        return { clusters: [] };
      },
      // no generateDraft
    };
    const result = await generateDraftForReel({
      reel: store.getReel("AAA")!,
      store,
      config,
      anthropic,
    });
    expect(result.ran).toBe(false);
    expect(store.getDraft("AAA")).toBeUndefined();
    store.close();
  });
});

// --- saveDraft (hand-edit, MAIN-972) → Content Store -----------------------

describe("saveDraft — persist hand-edits to an existing Draft (MAIN-972)", () => {
  /** Generate a baseline Draft (no model) so there's an existing row to edit. */
  function generated(store: Store, shortcode: string): void {
    store.upsertDraft({
      shortcode,
      hooks: [
        { text: "gen A", suggested: true },
        { text: "gen B", suggested: false },
        { text: "gen C", suggested: false },
      ],
      beat_scripts: [
        { label: "HOOK", script: "gen hook" },
        { label: "VALUE_1", script: "gen value" },
        { label: "CTA", script: "gen cta" },
      ],
      reasoning: "gen reasoning",
      caption: "gen caption",
    });
  }

  it("persists every edited field (3 hooks/one suggested, beats, reasoning, caption) and preserves generated_at", () => {
    const store = openStore(":memory:");
    seedAnalyzedReel(store, "AAA");
    generated(store, "AAA");
    const before = store.getDraft("AAA")!;

    const result = saveDraft({
      shortcode: "AAA",
      store,
      edits: {
        hooks: [
          { text: "edited A", suggested: false },
          { text: "edited B", suggested: true },
          { text: "edited C", suggested: false },
        ],
        beat_scripts: [
          { label: "HOOK", script: "my hook" },
          { label: "VALUE_1", script: "my value" },
          { label: "CTA", script: "my cta" },
        ],
        reasoning: "  my edited reasoning  ",
        caption: "  my edited caption  ",
      },
    });

    expect(result.found).toBe(true);
    const saved = store.getDraft("AAA")!;
    expect(saved.hooks.find((h) => h.suggested)!.text).toBe("edited B");
    expect(saved.beat_scripts.map((b) => b.script)).toEqual(["my hook", "my value", "my cta"]);
    expect(saved.reasoning).toBe("my edited reasoning"); // trimmed by the core
    expect(saved.caption).toBe("my edited caption"); // trimmed by the core
    // An edit is not a regeneration: generated_at preserved, updated_at bumped.
    expect(saved.generated_at).toBe(before.generated_at);
    expect(saved.updated_at >= before.updated_at).toBe(true);
    store.close();
  });

  it("REPAIRS a malformed edit: forces 3 hooks/one suggested and re-aligns beats to the analyzed sequence", () => {
    const store = openStore(":memory:");
    seedAnalyzedReel(store, "AAA"); // analyzed beats: HOOK, VALUE_1, CTA
    generated(store, "AAA");

    saveDraft({
      shortcode: "AAA",
      store,
      edits: {
        // Only one hook, none suggested → padded to 3, first suggested.
        hooks: [{ text: "lonely hook", suggested: false }],
        // Out of order + an invented PAYOFF beat → re-aligned to HOOK/VALUE_1/CTA, PAYOFF dropped.
        beat_scripts: [
          { label: "CTA", script: "cta edit" },
          { label: "PAYOFF", script: "invented — must be dropped" },
          { label: "HOOK", script: "hook edit" },
        ],
        reasoning: "r",
        caption: "c",
      },
    });

    const saved = store.getDraft("AAA")!;
    expect(saved.hooks).toHaveLength(3);
    expect(saved.hooks.filter((h) => h.suggested)).toHaveLength(1);
    expect(saved.hooks[0].suggested).toBe(true);
    expect(saved.beat_scripts.map((b) => b.label)).toEqual(["HOOK", "VALUE_1", "CTA"]);
    expect(saved.beat_scripts[0].script).toBe("hook edit");
    expect(saved.beat_scripts[1].script).toBe(""); // no VALUE_1 supplied → empty, not dropped
    expect(saved.beat_scripts[2].script).toBe("cta edit");
    store.close();
  });

  it("is found:false (route → 404) when no Draft exists; writes nothing (UPDATE-only)", () => {
    const store = openStore(":memory:");
    seedAnalyzedReel(store, "AAA"); // Reel exists, but NO Draft generated yet
    const result = saveDraft({
      shortcode: "AAA",
      store,
      edits: {
        hooks: [{ text: "x", suggested: true }],
        beat_scripts: [],
        reasoning: "r",
        caption: "c",
      },
    });
    expect(result.found).toBe(false);
    expect(store.getDraft("AAA")).toBeUndefined();
    store.close();
  });
});

// --- Pure validation/repair unit tests (the structural guarantees) --------

describe("normalizeHooks — force exactly 3 with exactly one suggested", () => {
  it("pads a short list to 3 and marks the first suggested when none flagged", () => {
    const hooks = normalizeHooks([{ text: "only one", suggested: false }]);
    expect(hooks).toHaveLength(3);
    expect(hooks.filter((h) => h.suggested)).toHaveLength(1);
    expect(hooks[0].suggested).toBe(true);
  });

  it("trims a long list to 3 and keeps a single suggested (the first flagged)", () => {
    const hooks = normalizeHooks([
      { text: "a", suggested: false },
      { text: "b", suggested: true },
      { text: "c", suggested: true },
      { text: "d", suggested: false },
    ]);
    expect(hooks).toHaveLength(3);
    expect(hooks.filter((h) => h.suggested)).toHaveLength(1);
    expect(hooks[1].suggested).toBe(true);
    expect(hooks[2].suggested).toBe(false);
  });

  it("handles a missing/garbage array → 3 empty hooks, first suggested", () => {
    const hooks = normalizeHooks(undefined);
    expect(hooks).toHaveLength(3);
    expect(hooks.filter((h) => h.suggested)).toHaveLength(1);
    expect(hooks[0].suggested).toBe(true);
  });
});

describe("alignBeatScripts — mirror the analyzed beats' labels/order; empty when no beats", () => {
  const beats: Beat[] = [
    { label: "HOOK", start_pct: 0, end_pct: 10, text: "" },
    { label: "VALUE_1", start_pct: 10, end_pct: 60, text: "" },
    { label: "CTA", start_pct: 90, end_pct: 100, text: "" },
  ];

  it("re-aligns to the real labels/order, pulling scripts by matching label", () => {
    // Model returns them out of order + with an extra label not in the analysis.
    const aligned = alignBeatScripts(
      [
        { label: "CTA", script: "cta script" },
        { label: "PAYOFF", script: "invented — must be ignored" },
        { label: "HOOK", script: "hook script" },
      ],
      beats,
    );
    expect(aligned.map((b) => b.label)).toEqual(["HOOK", "VALUE_1", "CTA"]);
    expect(aligned[0].script).toBe("hook script");
    expect(aligned[1].script).toBe(""); // no VALUE_1 from the model → empty, not dropped
    expect(aligned[2].script).toBe("cta script");
  });

  it("returns [] when the Reel has no analyzed beats (never invents structure)", () => {
    expect(alignBeatScripts([{ label: "HOOK", script: "x" }], [])).toEqual([]);
  });
});
