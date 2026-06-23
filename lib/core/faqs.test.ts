// Pipeline-seam harness for the FAQ extraction leg (MAIN-969).
//
// HARD INVARIANT #2: these tests drive the REAL analyze()/extractFaqsForReel() against a REAL
// in-memory SQLite Content Store with ONLY the external ports faked (Anthropic, plus Gemini/
// Video/Apify where the analyze path is exercised). They assert on resulting STORE STATE,
// never internals, and make NO live network calls. A fixture AnthropicPort drives each case.

import { afterEach, describe, expect, it } from "vitest";
import { analysisPromptHash, faqPromptHash, loadConfig, transcriptionPromptHash } from "./config.js";
import { openStore } from "./store.js";
import { analyze, __setVideoUrlForTest, resetVideoUrlCache } from "./analyze.js";
import { extractFaqsForReel, needsFaqExtraction } from "./faqs.js";
import type {
  AnthropicPort,
  Beat,
  FaqCluster,
  GeminiAnalysisResult,
  GeminiPort,
  ScrapedComment,
  Store,
  VideoPort,
} from "./types.js";

const config = loadConfig();

// --- Fixtures -------------------------------------------------------------

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

const BEATS: Beat[] = [
  { label: "HOOK", start_pct: 0, end_pct: 10, text: "hook" },
  { label: "CTA", start_pct: 90, end_pct: 100, text: "follow" },
];

function analysisResult(overrides: Partial<GeminiAnalysisResult> = {}): GeminiAnalysisResult {
  return {
    transcript: "echoed transcript",
    topic: "using Claude to triage email",
    category: "tool_demo",
    hook_technique: "curiosity_gap",
    beat_sequence: BEATS,
    why_it_works: "Strong hook, fast payoff, clear CTA.",
    ...overrides,
  };
}

/** Fake Gemini that records each transcribe/analyze call, so we can assert it was NOT re-invoked. */
function fakeGemini(opts?: { analysisFor?: () => GeminiAnalysisResult }): {
  port: GeminiPort;
  transcribeCalls: string[];
  analyzeCalls: string[];
} {
  const transcribeCalls: string[] = [];
  const analyzeCalls: string[] = [];
  const port: GeminiPort = {
    async transcribe({ videoPath }) {
      transcribeCalls.push(videoPath);
      return { transcript: "verbatim words" };
    },
    async analyzeVideo({ videoPath }) {
      analyzeCalls.push(videoPath);
      return opts?.analysisFor?.() ?? analysisResult();
    },
  };
  return { port, transcribeCalls, analyzeCalls };
}

/** Fake VideoPort that records downloads, so we can assert it was NOT re-invoked. */
function fakeVideo(): { port: VideoPort; downloaded: string[] } {
  const downloaded: string[] = [];
  const port: VideoPort = {
    async downloadVideo({ shortcode }) {
      const path = `/tmp/${shortcode}.mp4`;
      downloaded.push(path);
      return path;
    },
    async downloadThumbnail({ shortcode }) {
      return `data/thumbnails/${shortcode}.jpg`;
    },
    async deleteVideo() {},
  };
  return { port, downloaded };
}

/** Fake AnthropicPort returning a fixed (or per-call) clustering, recording its inputs. */
function fakeAnthropic(
  clustersFor: (input: { comments: { idx: number; text: string; likes: number }[] }) => FaqCluster[],
): { port: AnthropicPort; calls: { comments: { idx: number; text: string; likes: number }[] }[] } {
  const calls: { comments: { idx: number; text: string; likes: number }[] }[] = [];
  const port: AnthropicPort = {
    async extractFaqs(input) {
      calls.push({ comments: input.comments });
      return { clusters: clustersFor(input) };
    },
  };
  return { port, calls };
}

/** Seed ONE creator + ONE pending reel, with a stashed video URL (mirrors what scrape does). */
function seedReel(store: Store, shortcode: string): void {
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
  });
  __setVideoUrlForTest(shortcode, `https://cdn.example/${shortcode}.mp4`);
}

/** Mark a reel as already video-analyzed under the CURRENT hashes (a real prior analyze). */
function markAnalyzed(store: Store, shortcode: string): void {
  store.updateReelAnalysis({
    shortcode,
    analysis_status: "analyzed",
    analyzed_at: "2026-01-01T00:00:00.000Z",
    topic: "topic",
    transcript: "old transcript",
    transcription_prompt_hash: "tx",
    analysis_prompt_hash: "an",
  });
}

afterEach(() => {
  resetVideoUrlCache();
});

// --- Tests ----------------------------------------------------------------

describe("FAQ extraction → Content Store (faked Anthropic)", () => {
  it("(#1) analyzing a Reel extracts FAQs over its NON-trigger Comments and persists faqs + faq_comments", async () => {
    const store = openStore(":memory:");
    seedReel(store, "AAA");
    const apify = {
      async scrapeCreator() {
        return { profile: { username: "c" }, reels: [] };
      },
      async scrapeComments(): Promise<ScrapedComment[]> {
        return [
          { comment_id: "q1", username: "a", text: "does this work on the free plan?", likes: 12 },
          { comment_id: "q2", username: "b", text: "is it free?", likes: 3 },
          { comment_id: "q3", username: "c", text: "how much does it cost?", likes: 5 },
          { comment_id: "tk", username: "d", text: "ritual", likes: 0 }, // trigger → excluded
        ];
      },
    };
    const { port: gemini } = fakeGemini({
      analysisFor: () => analysisResult({ trigger_keyword: "ritual" }),
    });
    const { port: video } = fakeVideo();
    // The model clusters the two "is it free / free plan" asks (indices 1,2) into one FAQ.
    const { port: anthropic, calls } = fakeAnthropic(() => [
      { question: "Is it free?", member_indices: [1, 2] },
      { question: "How much does it cost?", member_indices: [3] },
    ]);

    const summary = await analyze({ creator: "c", store, config, deps: { apify, gemini, video, anthropic } });
    expect(summary.analyzed).toBe(1);
    expect(summary.faqExtracted).toBe(1);

    // The model was fed ONLY the 3 non-trigger comments (the trigger one was filtered out).
    expect(calls).toHaveLength(1);
    expect(calls[0].comments.map((c) => c.text).sort()).toEqual(
      ["does this work on the free plan?", "how much does it cost?", "is it free?"],
    );

    const faqs = store.listFaqs("AAA");
    expect(faqs.map((f) => f.question)).toContain("Is it free?");
    // faqs + faq_comments persisted.
    const faqRows = store.db.prepare(`SELECT COUNT(*) AS n FROM faqs`).get() as { n: number };
    const linkRows = store.db.prepare(`SELECT COUNT(*) AS n FROM faq_comments`).get() as { n: number };
    expect(faqRows.n).toBe(2);
    expect(linkRows.n).toBe(3); // 2 + 1 links

    store.close();
  });

  it("(#2) support_count/support_likes/strength_score derive from REAL links; out-of-range indices are DROPPED", async () => {
    const store = openStore(":memory:");
    seedReel(store, "AAA");
    const apify = {
      async scrapeCreator() {
        return { profile: { username: "c" }, reels: [] };
      },
      async scrapeComments(): Promise<ScrapedComment[]> {
        return [
          { comment_id: "c1", username: "a", text: "how do I start?", likes: 10 },
          { comment_id: "c2", username: "b", text: "where do I begin?", likes: 5 },
        ];
      },
    };
    const { port: gemini } = fakeGemini();
    const { port: video } = fakeVideo();
    // The model links the 2 real indices (1,2) AND hallucinates an out-of-range index 99.
    const { port: anthropic } = fakeAnthropic(() => [
      { question: "How do I get started?", member_indices: [1, 2, 99] },
      // A cluster whose only index is hallucinated → must be DROPPED entirely.
      { question: "Ghost question", member_indices: [42] },
    ]);

    await analyze({ creator: "c", store, config, deps: { apify, gemini, video, anthropic } });

    const faqs = store.listFaqs("AAA");
    // Only the real cluster survives; the all-hallucinated one is dropped.
    expect(faqs).toHaveLength(1);
    const faq = faqs[0];
    // support_count = #VALID links (2 — index 99 dropped), not 3.
    expect(faq.support_count).toBe(2);
    // support_likes = SUM of the 2 real comments' likes (10 + 5).
    expect(faq.support_likes).toBe(15);
    // strength_score = support_count + ln(1 + support_likes), deterministic.
    expect(faq.strength_score).toBeCloseTo(2 + Math.log1p(15), 10);
    // The example Comments are the 2 real ones (live-queried from the join), likes DESC.
    expect(faq.examples.map((c) => c.comment_id)).toEqual(["c1", "c2"]);
    // No faq_comments row points at a hallucinated/absent comment id.
    const linkIds = (store.db.prepare(`SELECT comment_id FROM faq_comments`).all() as { comment_id: string }[]).map((r) => r.comment_id);
    expect(linkIds.sort()).toEqual(["c1", "c2"]);

    store.close();
  });

  it("(#3a) FAQ extraction SKIPS when FAQs present + prompt hash unchanged + no new comments", async () => {
    const store = openStore(":memory:");
    seedReel(store, "AAA");
    markAnalyzed(store, "AAA");
    store.upsertComments("AAA", [{ comment_id: "c1", text: "is it free?", likes: 1 }]);

    let calls = 0;
    const anthropic: AnthropicPort = {
      async extractFaqs() {
        calls += 1;
        return { clusters: [{ question: "Is it free?", member_indices: [1] }] };
      },
    };

    // First analyze (no Gemini → no video work, but FAQ leg runs): extracts once.
    const s1 = await analyze({ creator: "c", store, config, deps: { anthropic } });
    expect(s1.faqExtracted).toBe(1);
    expect(calls).toBe(1);
    expect(store.getReel("AAA")!.faq_prompt_hash).toBe(faqPromptHash(config));

    // Second analyze with NOTHING changed: FAQ extraction is skipped (model NOT called again).
    const s2 = await analyze({ creator: "c", store, config, deps: { anthropic } });
    expect(s2.faqExtracted).toBe(0);
    expect(calls).toBe(1); // unchanged — no re-extraction

    store.close();
  });

  it("(#3b) re-runs on faq_prompt_hash DRIFT", async () => {
    const store = openStore(":memory:");
    seedReel(store, "AAA");
    markAnalyzed(store, "AAA");
    store.upsertComments("AAA", [{ comment_id: "c1", text: "is it free?", likes: 1 }]);
    let calls = 0;
    const anthropic: AnthropicPort = {
      async extractFaqs() {
        calls += 1;
        return { clusters: [{ question: "Is it free?", member_indices: [1] }] };
      },
    };
    await analyze({ creator: "c", store, config, deps: { anthropic } });
    expect(calls).toBe(1);

    // Simulate a FAQ-prompt edit by stamping a stale hash on the row (drift from current).
    store.updateReelFaqProvenance({ shortcode: "AAA", faq_prompt_hash: "0000staleh000" });
    const s = await analyze({ creator: "c", store, config, deps: { anthropic } });
    expect(s.faqExtracted).toBe(1); // re-extracted
    expect(calls).toBe(2);
    // Re-stamped to the current hash → the very next run skips again (idempotent).
    expect(store.getReel("AAA")!.faq_prompt_hash).toBe(faqPromptHash(config));
    const s2 = await analyze({ creator: "c", store, config, deps: { anthropic } });
    expect(s2.faqExtracted).toBe(0);
    expect(calls).toBe(2);

    store.close();
  });

  it("(#3c) re-runs when Comments were RE-PULLED since the last FAQ run", async () => {
    const store = openStore(":memory:");
    seedReel(store, "AAA");
    markAnalyzed(store, "AAA");
    store.upsertComments("AAA", [{ comment_id: "c1", text: "is it free?", likes: 1 }]);
    let lastCommentCount = 0;
    const anthropic: AnthropicPort = {
      async extractFaqs(input) {
        lastCommentCount = input.comments.length;
        return { clusters: [{ question: "q", member_indices: input.comments.map((c) => c.idx) }] };
      },
    };
    await analyze({ creator: "c", store, config, deps: { anthropic } });
    expect(lastCommentCount).toBe(1);
    const generatedAt = store.getReel("AAA")!.faqs_generated_at!;
    expect(generatedAt).toBeTruthy();

    // A new Comment lands AFTER the FAQ run (its first_seen_at is newer than faqs_generated_at).
    // Force a strictly-newer first_seen_at to make the "re-pulled" comparison deterministic.
    const newer = new Date(Date.parse(generatedAt) + 1000).toISOString();
    store.db
      .prepare(
        `INSERT INTO comments (comment_id, shortcode, username, text, likes, first_seen_at, is_trigger)
         VALUES ('c2', 'AAA', 'x', 'and on mobile?', 2, @fs, 0)`,
      )
      .run({ fs: newer });

    // The predicate fires (newer max first_seen_at) → re-extract over the GROWN corpus.
    expect(needsFaqExtraction(store.getReel("AAA")!, store, faqPromptHash(config))).toBe(true);
    const s = await analyze({ creator: "c", store, config, deps: { anthropic } });
    expect(s.faqExtracted).toBe(1);
    expect(lastCommentCount).toBe(2); // saw both comments this time

    store.close();
  });

  it("(#3d/#5) a pure FAQ backfill on an already-video-analyzed Reel does NOT re-invoke Gemini/Video", async () => {
    const store = openStore(":memory:");
    seedReel(store, "AAA");
    // Already video-analyzed under CURRENT hashes → NOT an analysis candidate; only FAQs are stale.
    store.updateReelAnalysis({
      shortcode: "AAA",
      analysis_status: "analyzed",
      analyzed_at: "2026-01-01T00:00:00.000Z",
      topic: "topic",
      transcript: "t",
      transcription_prompt_hash: transcriptionPromptHash(config),
      analysis_prompt_hash: analysisPromptHash(config),
    });
    store.upsertComments("AAA", [{ comment_id: "c1", text: "is it free?", likes: 1 }]);

    const { port: gemini, transcribeCalls, analyzeCalls } = fakeGemini();
    const { port: video, downloaded } = fakeVideo();
    const { port: anthropic, calls } = fakeAnthropic(() => [{ question: "Is it free?", member_indices: [1] }]);

    const summary = await analyze({ creator: "c", store, config, deps: { gemini, video, anthropic } });

    // No video analysis happened (the Reel was already analyzed) ...
    expect(summary.analyzed).toBe(0);
    expect(transcribeCalls).toEqual([]);
    expect(analyzeCalls).toEqual([]);
    expect(downloaded).toEqual([]);
    // ... but the FAQ leg DID run.
    expect(summary.faqExtracted).toBe(1);
    expect(calls).toHaveLength(1);
    expect(store.listFaqs("AAA")).toHaveLength(1);

    store.close();
  });

  it("(#3e) max_faq_extractions_per_run caps INDEPENDENTLY of max_analyses_per_run", async () => {
    const store = openStore(":memory:");
    store.upsertCreator({ username: "c" });
    store.appendCreatorStats({ creator_username: "c", captured_at: new Date().toISOString(), followers: 10_000 });
    // 3 already-video-analyzed Reels, each with comments + stale FAQs. NONE need re-analysis.
    for (let i = 0; i < 3; i++) {
      const sc = `R${i}`;
      store.upsertReel({ shortcode: sc, url: `u${i}`, creator_username: "c", posted_at: daysAgo(i + 1) });
      store.updateReelAnalysis({
        shortcode: sc,
        analysis_status: "analyzed",
        analyzed_at: "2026-01-01T00:00:00.000Z",
        topic: "t",
        transcription_prompt_hash: transcriptionPromptHash(config),
        analysis_prompt_hash: analysisPromptHash(config),
      });
      store.upsertComments(sc, [{ comment_id: `${sc}-c1`, text: "is it free?", likes: 1 }]);
    }

    // FAQ cap = 1, analysis cap = 0. The analysis cap being exhausted must NOT block the FAQ leg.
    const capped = structuredClone(config);
    capped.settings.max_faq_extractions_per_run = 1;
    capped.settings.max_analyses_per_run = 0;
    const { port: anthropic } = fakeAnthropic(() => [{ question: "Is it free?", member_indices: [1] }]);

    const summary = await analyze({ creator: "c", store, config: capped, deps: { anthropic } });
    // No analyses (cap 0), but the FAQ leg ran ONE Reel and reports 2 over its own cap.
    expect(summary.analyzed).toBe(0);
    expect(summary.faqExtracted).toBe(1);
    expect(summary.faqRemainingOverCap).toBe(2);
    // Exactly one Reel has FAQs.
    const withFaqs = ["R0", "R1", "R2"].filter((sc) => store.listFaqs(sc).length > 0);
    expect(withFaqs).toHaveLength(1);

    store.close();
  });

  it("a wholesale re-extraction REPLACES prior FAQs (and never mutates the comments corpus)", async () => {
    const store = openStore(":memory:");
    seedReel(store, "AAA");
    markAnalyzed(store, "AAA");
    store.upsertComments("AAA", [
      { comment_id: "c1", text: "is it free?", likes: 1 },
      { comment_id: "c2", text: "how much?", likes: 2 },
    ]);
    let phase = 0;
    const anthropic: AnthropicPort = {
      async extractFaqs() {
        phase += 1;
        return phase === 1
          ? { clusters: [{ question: "First question", member_indices: [1, 2] }] }
          : { clusters: [{ question: "Second question", member_indices: [1] }] };
      },
    };

    await analyze({ creator: "c", store, config, deps: { anthropic } });
    expect(store.listFaqs("AAA").map((f) => f.question)).toEqual(["First question"]);
    const commentsBefore = store.listComments("AAA").map((c) => c.comment_id).sort();

    // Force a re-run (prompt drift) → wholesale replace.
    store.updateReelFaqProvenance({ shortcode: "AAA", faq_prompt_hash: "drifted00000" });
    await analyze({ creator: "c", store, config, deps: { anthropic } });

    const faqs = store.listFaqs("AAA");
    expect(faqs.map((f) => f.question)).toEqual(["Second question"]); // replaced, not appended
    // The comments corpus is untouched by the FAQ run.
    expect(store.listComments("AAA").map((c) => c.comment_id).sort()).toEqual(commentsBefore);

    store.close();
  });

  it("no Anthropic port + no API key → FAQ leg is a safe no-op", async () => {
    const store = openStore(":memory:");
    seedReel(store, "AAA");
    markAnalyzed(store, "AAA");
    store.upsertComments("AAA", [{ comment_id: "c1", text: "is it free?", likes: 1 }]);
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const summary = await analyze({ creator: "c", store, config });
      expect(summary.faqExtracted).toBe(0);
      expect(store.listFaqs("AAA")).toEqual([]);
      // No provenance stamped (nothing ran).
      expect(store.getReel("AAA")!.faqs_generated_at).toBeNull();
    } finally {
      if (prev != null) process.env.ANTHROPIC_API_KEY = prev;
    }
    store.close();
  });

  it("a Reel with no non-trigger Comments stamps provenance and writes zero FAQs (no model call)", async () => {
    const store = openStore(":memory:");
    seedReel(store, "AAA");
    markAnalyzed(store, "AAA");
    // Only a trigger comment exists → nothing mineable.
    store.upsertComments("AAA", [{ comment_id: "tk", text: "ritual", likes: 0 }]);
    store.flagTriggerComments("AAA", "ritual");
    let called = false;
    const anthropic: AnthropicPort = {
      async extractFaqs() {
        called = true;
        return { clusters: [] };
      },
    };

    const result = await extractFaqsForReel({ reel: store.getReel("AAA")!, store, config, anthropic });
    expect(result.ran).toBe(true);
    expect(result.faqsWritten).toBe(0);
    expect(called).toBe(false); // model not called when there's nothing to mine
    // Provenance stamped so the predicate settles.
    expect(store.getReel("AAA")!.faq_prompt_hash).toBe(faqPromptHash(config));
    expect(store.listFaqs("AAA")).toEqual([]);

    store.close();
  });
});
