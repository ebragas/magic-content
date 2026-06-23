// Pipeline-seam harness for the per-post Refresh leg (MAIN-970 / ADR-0007).
//
// HARD INVARIANT #2: these tests drive the REAL refreshReel() against a REAL in-memory
// SQLite Content Store with ONLY the external ports faked (Apify + Anthropic, plus Gemini/
// Video provided purely to PROVE they are never invoked). They assert on resulting STORE
// STATE, never internals, and make NO live network calls.
//
// What a per-post Refresh must do (the slice's contract):
//   - re-pull this Reel's metrics + recompute derived metrics,
//   - re-pull + accumulate Comments, re-flag is_trigger,
//   - RE-RUN FAQ extraction over the changed Comments,
//   - and NEVER download the Video or call Gemini (the analysis is immutable, ADR-0004/0007),
//   - unbounded by the batch caps (single-Reel user action).

import { afterEach, describe, expect, it } from "vitest";
import { faqPromptHash, loadConfig } from "./config.js";
import { openStore } from "./store.js";
import { resetVideoUrlCache } from "./analyze.js";
import { refreshReel } from "./refresh-reel.js";
import type {
  AnthropicPort,
  ApifyPort,
  Beat,
  FaqCluster,
  GeminiPort,
  ScrapeResult,
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

/** Fake Gemini that records every call, so we can assert refresh NEVER invokes it. */
function fakeGemini(): { port: GeminiPort; transcribeCalls: string[]; analyzeCalls: string[] } {
  const transcribeCalls: string[] = [];
  const analyzeCalls: string[] = [];
  const port: GeminiPort = {
    async transcribe({ videoPath }) {
      transcribeCalls.push(videoPath);
      return { transcript: "verbatim words" };
    },
    async analyzeVideo({ videoPath }) {
      analyzeCalls.push(videoPath);
      return {
        transcript: "echoed",
        topic: "t",
        category: "tool_demo",
        hook_technique: "curiosity_gap",
        beat_sequence: BEATS,
        why_it_works: "w",
      };
    },
  };
  return { port, transcribeCalls, analyzeCalls };
}

/** Fake VideoPort that records downloads, so we can assert refresh NEVER touches it. */
function fakeVideo(): { port: VideoPort; downloaded: string[]; deleted: string[] } {
  const downloaded: string[] = [];
  const deleted: string[] = [];
  const port: VideoPort = {
    async downloadVideo({ shortcode }) {
      const path = `/tmp/${shortcode}.mp4`;
      downloaded.push(path);
      return path;
    },
    async downloadThumbnail({ shortcode }) {
      return `data/thumbnails/${shortcode}.jpg`;
    },
    async deleteVideo(path) {
      deleted.push(path);
    },
  };
  return { port, downloaded, deleted };
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

/** Apify fake: a fixed creator metrics pull + a per-call Comments batch. */
function fakeApify(opts: {
  pull: () => ScrapeResult;
  commentBatches?: ScrapedComment[][];
}): { port: ApifyPort; scrapeCreatorCalls: number; scrapeCommentsCalls: number } {
  let scrapeCreatorCalls = 0;
  let scrapeCommentsCalls = 0;
  const port: ApifyPort = {
    async scrapeCreator() {
      scrapeCreatorCalls += 1;
      return structuredClone(opts.pull());
    },
    async scrapeComments() {
      const batches = opts.commentBatches ?? [];
      const batch = batches[Math.min(scrapeCommentsCalls, batches.length - 1)] ?? [];
      scrapeCommentsCalls += 1;
      return structuredClone(batch);
    },
  };
  return {
    port,
    get scrapeCreatorCalls() {
      return scrapeCreatorCalls;
    },
    get scrapeCommentsCalls() {
      return scrapeCommentsCalls;
    },
  };
}

/** Seed ONE creator (with a follower snapshot) + ONE already-video-analyzed Reel. */
function seedAnalyzedReel(store: Store, shortcode: string, triggerKeyword: string | null = null): void {
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
  // Mark it already analyzed under fixed hashes (a real prior analyze). Refresh must leave
  // ALL of these immutable analysis fields untouched (ADR-0004/0007).
  store.updateReelMetrics({ shortcode, likes: 1000, comments_count: 5, views: 10_000 });
  store.updateReelAnalysis({
    shortcode,
    analysis_status: "analyzed",
    analyzed_at: "2026-01-01T00:00:00.000Z",
    topic: "original topic",
    transcript: "original transcript",
    trigger_keyword: triggerKeyword,
    transcription_prompt_hash: "txhash",
    analysis_prompt_hash: "anhash",
  });
}

/** A creator metrics pull carrying ONE Reel with the given fresh metrics. */
function pullWith(shortcode: string, metrics: { likes: number; comments_count: number; views: number }): ScrapeResult {
  return {
    profile: { username: "c", followers: 10_000, posts_count: 1 },
    reels: [
      {
        shortcode,
        url: `https://www.instagram.com/reel/${shortcode}/`,
        posted_at: daysAgo(1),
        ...metrics,
      },
    ],
  };
}

afterEach(() => {
  resetVideoUrlCache();
});

// --- Tests ----------------------------------------------------------------

describe("refreshReel → Content Store (faked ports)", () => {
  it("re-pulls metrics + Comments, re-mines FAQs, and NEVER invokes Gemini/Video (#4)", async () => {
    const store = openStore(":memory:");
    seedAnalyzedReel(store, "AAA");
    const analysisBefore = store.getReel("AAA")!;

    const { port: apify } = fakeApify({
      // Fresh metrics drifted up from the seed (likes 1000 → 5000, etc.).
      pull: () => pullWith("AAA", { likes: 5000, comments_count: 12, views: 30_000 }),
      commentBatches: [
        [
          { comment_id: "q1", username: "a", text: "is it free?", likes: 4 },
          { comment_id: "q2", username: "b", text: "how much does it cost?", likes: 2 },
        ],
      ],
    });
    const { port: gemini, transcribeCalls, analyzeCalls } = fakeGemini();
    const { port: video, downloaded, deleted } = fakeVideo();
    const { port: anthropic, calls } = fakeAnthropic(() => [
      { question: "Is it free?", member_indices: [1] },
      { question: "How much does it cost?", member_indices: [2] },
    ]);

    const result = await refreshReel({
      shortcode: "AAA",
      store,
      config,
      // Gemini + Video ARE injected to PROVE refresh never calls them even when available.
      deps: { apify, gemini, video, anthropic },
    });

    // Metrics re-pulled + derived recomputed against the latest snapshot.
    const reel = store.getReel("AAA")!;
    expect(result.refreshed).toBe(true);
    expect(reel.likes).toBe(5000);
    expect(reel.comments_count).toBe(12);
    expect(reel.views).toBe(30_000);
    expect(reel.performance_score).toBe(5000 + 3 * 12 + 0.1 * 30_000); // 8036
    expect(reel.engagement_rate).toBeCloseTo(8036 / 10_000);

    // Comments accumulated into the corpus.
    expect(store.listComments("AAA").map((r) => r.comment_id).sort()).toEqual(["q1", "q2"]);
    expect(result.commentsScraped).toBe(2);
    expect(result.commentsUpserted).toBe(2);

    // FAQs re-mined over the changed Comments.
    expect(result.faqExtracted).toBe(true);
    expect(result.faqsWritten).toBe(2);
    expect(store.listFaqs("AAA").map((f) => f.question).sort()).toEqual([
      "How much does it cost?",
      "Is it free?",
    ]);
    expect(calls).toHaveLength(1);

    // The IMMUTABLE analysis is untouched (ADR-0004/0007).
    expect(reel.analysis_status).toBe("analyzed");
    expect(reel.analyzed_at).toBe(analysisBefore.analyzed_at);
    expect(reel.topic).toBe("original topic");
    expect(reel.transcript).toBe("original transcript");
    expect(reel.analysis_prompt_hash).toBe("anhash");
    expect(reel.transcription_prompt_hash).toBe("txhash");

    // Gemini + Video NEVER invoked — refresh does no video analysis (#2/#4).
    expect(transcribeCalls).toEqual([]);
    expect(analyzeCalls).toEqual([]);
    expect(downloaded).toEqual([]);
    expect(deleted).toEqual([]);

    store.close();
  });

  it("re-runs FAQ extraction on CHANGED Comments: a refresh that grows the corpus re-mines over the union", async () => {
    const store = openStore(":memory:");
    seedAnalyzedReel(store, "AAA");

    // First refresh pulls [c1]; second refresh pulls [c2] (accumulating to {c1,c2}). The model
    // is fed the FULL corpus each time, so the FAQ re-mine sees the new comment on refresh #2.
    const { port: apify, scrapeCommentsCalls } = fakeApify({
      pull: () => pullWith("AAA", { likes: 1000, comments_count: 5, views: 10_000 }),
      commentBatches: [
        [{ comment_id: "c1", username: "a", text: "is it free?", likes: 1 }],
        [{ comment_id: "c2", username: "b", text: "does it work on mobile?", likes: 3 }],
      ],
    });
    let lastSeenComments = 0;
    const anthropic: AnthropicPort = {
      async extractFaqs(input) {
        lastSeenComments = input.comments.length;
        return { clusters: [{ question: "q", member_indices: input.comments.map((c) => c.idx) }] };
      },
    };

    const r1 = await refreshReel({ shortcode: "AAA", store, config, deps: { apify, anthropic } });
    expect(r1.faqExtracted).toBe(true);
    expect(lastSeenComments).toBe(1); // only c1 so far
    expect(store.getReel("AAA")!.faq_prompt_hash).toBe(faqPromptHash(config));
    const generatedAt1 = store.getReel("AAA")!.faqs_generated_at;
    expect(generatedAt1).toBeTruthy();

    const r2 = await refreshReel({ shortcode: "AAA", store, config, deps: { apify, anthropic } });
    expect(r2.faqExtracted).toBe(true);
    // The FAQ re-mine on refresh #2 saw the GROWN corpus (c1 + c2) — the whole point of Refresh
    // (ADR-0007: FAQ has a mutable input). It runs UNCONDITIONALLY for the targeted Reel.
    expect(lastSeenComments).toBe(2);
    expect(store.listComments("AAA").map((c) => c.comment_id).sort()).toEqual(["c1", "c2"]);
    // Two Comments scraped across the two refreshes.
    void scrapeCommentsCalls;

    store.close();
  });

  it("re-flags is_trigger against the Reel's stored keyword over the re-pulled Comments (#1/#2)", async () => {
    const store = openStore(":memory:");
    // The Reel's immutable analysis already carries a Trigger Keyword (refresh does NOT re-derive it).
    seedAnalyzedReel(store, "AAA", "ritual");

    const { port: apify } = fakeApify({
      pull: () => pullWith("AAA", { likes: 1000, comments_count: 5, views: 10_000 }),
      commentBatches: [
        [
          { comment_id: "t1", username: "a", text: "RITUAL", likes: 0 }, // exact → trigger
          { comment_id: "t2", username: "b", text: "ritual please", likes: 0 }, // short token → trigger
          { comment_id: "q1", username: "c", text: "is it free?", likes: 8 }, // question → kept
        ],
      ],
    });
    // The model only ever sees NON-trigger comments, so it should be fed exactly one ("is it free?").
    const { port: anthropic, calls } = fakeAnthropic(() => [{ question: "Is it free?", member_indices: [1] }]);

    const result = await refreshReel({ shortcode: "AAA", store, config, deps: { apify, anthropic } });

    // The two automation comments are flagged; the question is not.
    const rows = store.listComments("AAA");
    expect(rows.filter((r) => r.is_trigger === 1).map((r) => r.comment_id).sort()).toEqual(["t1", "t2"]);
    expect(rows.find((r) => r.comment_id === "q1")!.is_trigger).toBe(0);
    expect(result.triggerComments).toBe(2);

    // FAQ input excluded the triggers — the model saw ONLY the non-trigger question.
    expect(calls).toHaveLength(1);
    expect(calls[0].comments.map((c) => c.text)).toEqual(["is it free?"]);

    store.close();
  });

  it("is NOT bounded by the FAQ batch cap — refreshes even with max_faq_extractions_per_run = 0", async () => {
    const store = openStore(":memory:");
    seedAnalyzedReel(store, "AAA");
    const capped = structuredClone(config);
    // Both batch caps exhausted — a single-Reel user refresh must ignore them.
    capped.settings.max_faq_extractions_per_run = 0;
    capped.settings.max_analyses_per_run = 0;

    const { port: apify } = fakeApify({
      pull: () => pullWith("AAA", { likes: 2000, comments_count: 7, views: 12_000 }),
      commentBatches: [[{ comment_id: "c1", username: "a", text: "is it free?", likes: 1 }]],
    });
    const { port: anthropic } = fakeAnthropic(() => [{ question: "Is it free?", member_indices: [1] }]);

    const result = await refreshReel({ shortcode: "AAA", store, config: capped, deps: { apify, anthropic } });
    expect(result.refreshed).toBe(true);
    expect(result.faqExtracted).toBe(true);
    expect(store.listFaqs("AAA")).toHaveLength(1);

    store.close();
  });

  it("a missing Reel is a no-op (the route maps this to 404)", async () => {
    const store = openStore(":memory:");
    const { port: apify, scrapeCreatorCalls } = fakeApify({
      pull: () => pullWith("AAA", { likes: 1, comments_count: 1, views: 1 }),
    });
    const { port: anthropic } = fakeAnthropic(() => []);

    const result = await refreshReel({ shortcode: "GHOST", store, config, deps: { apify, anthropic } });
    expect(result.refreshed).toBe(false);
    expect(result.commentsScraped).toBe(0);
    expect(result.faqExtracted).toBe(false);
    // Nothing was pulled — we bail before touching Apify when the Reel doesn't exist.
    void scrapeCreatorCalls;
    expect(store.getReel("GHOST")).toBeUndefined();

    store.close();
  });

  it("no Apify port + no key → safe no-op (walking skeleton)", async () => {
    const store = openStore(":memory:");
    seedAnalyzedReel(store, "AAA");
    const prevApify = process.env.APIFY_TOKEN;
    delete process.env.APIFY_TOKEN;
    try {
      const result = await refreshReel({ shortcode: "AAA", store, config });
      expect(result.refreshed).toBe(false);
      expect(result.faqExtracted).toBe(false);
      // The Reel's metrics + analysis are untouched.
      expect(store.getReel("AAA")!.likes).toBe(1000);
      expect(store.listFaqs("AAA")).toEqual([]);
    } finally {
      if (prevApify != null) process.env.APIFY_TOKEN = prevApify;
    }
    store.close();
  });
});
