// Pipeline-seam harness for the analyze leg (MAIN-960).
//
// HARD INVARIANT #2: these tests drive the REAL analyze()/pipeline() against a REAL
// in-memory SQLite Content Store with ONLY the external ports faked (Gemini + Video).
// They assert on resulting STORE STATE, never internals, and make NO live
// Apify/Gemini network calls. A fixture Gemini response drives each case.

import { afterEach, describe, expect, it, vi } from "vitest";
import { analysisPromptHash, loadConfig, transcriptionPromptHash } from "./config.js";
import { openStore } from "./store.js";
import { analyze, __setVideoUrlForTest, resetVideoUrlCache } from "./analyze.js";
import { pipeline } from "./pipeline.js";
import type {
  ApifyPort,
  Beat,
  GeminiAnalysisResult,
  GeminiPort,
  ScrapeResult,
  ScrapedReel,
  Store,
  VideoPort,
} from "./types.js";

const config = loadConfig();

// --- Fixtures -------------------------------------------------------------

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

const BEATS: Beat[] = [
  { label: "HOOK", start_pct: 0, end_pct: 10 },
  { label: "VALUE_1", start_pct: 10, end_pct: 60 },
  { label: "PAYOFF", start_pct: 60, end_pct: 90 },
  { label: "CTA", start_pct: 90, end_pct: 100 },
];

function analysisResult(overrides: Partial<GeminiAnalysisResult> = {}): GeminiAnalysisResult {
  return {
    transcript: "analysis-echoed transcript",
    topic: "using Claude to triage email",
    category: "tool_demo",
    hook_technique: "curiosity_gap",
    beat_sequence: BEATS,
    why_it_works: "Strong cold-open hook with a fast payoff and a clear CTA.",
    ...overrides,
  };
}

/** Fake Gemini port: verbatim transcript + a fixed (or per-shortcode) analysis. */
function fakeGemini(opts?: {
  transcript?: string;
  analysisFor?: (videoPath: string) => GeminiAnalysisResult;
  failTranscribeFor?: (videoPath: string) => boolean;
}): {
  port: GeminiPort;
  transcribeCalls: string[];
  analyzeCalls: { videoPath: string; transcript: string }[];
} {
  const transcribeCalls: string[] = [];
  const analyzeCalls: { videoPath: string; transcript: string }[] = [];
  const port: GeminiPort = {
    async transcribe({ videoPath }) {
      transcribeCalls.push(videoPath);
      if (opts?.failTranscribeFor?.(videoPath)) {
        throw new Error("gemini transcribe boom");
      }
      return { transcript: opts?.transcript ?? "verbatim spoken words" };
    },
    async analyzeVideo({ videoPath, transcript }) {
      analyzeCalls.push({ videoPath, transcript });
      return opts?.analysisFor?.(videoPath) ?? analysisResult();
    },
  };
  return { port, transcribeCalls, analyzeCalls };
}

/** Fake VideoPort that records downloads and deletions (no real I/O). */
function fakeVideo(): {
  port: VideoPort;
  downloaded: string[];
  deleted: string[];
} {
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

/** Seed a creator + N pending reels (newest-first by index 0) directly into the Store. */
function seedReels(store: Store, username: string, shortcodes: string[]): void {
  store.upsertCreator({ username });
  store.appendCreatorStats({
    creator_username: username,
    captured_at: new Date().toISOString(),
    followers: 10_000,
  });
  shortcodes.forEach((sc, i) => {
    store.upsertReel({
      shortcode: sc,
      url: `https://www.instagram.com/reel/${sc}/`,
      creator_username: username,
      posted_at: daysAgo(i + 1), // index 0 is newest
      duration_sec: 30,
    });
    // Stash a transient video URL for analyze (mirrors what scrape does in `full`).
    __setVideoUrlForTest(sc, `https://cdn.example/${sc}.mp4`);
  });
}

afterEach(() => {
  resetVideoUrlCache();
});

// --- Tests ----------------------------------------------------------------

describe("analyze → Content Store (faked Gemini + Video)", () => {
  it("fills the lean-core fields and stamps both prompt hashes + analyzed_at", async () => {
    const store = openStore(":memory:");
    seedReels(store, "c", ["AAA"]);
    const { port: gemini, transcribeCalls, analyzeCalls } = fakeGemini({
      transcript: "verbatim hello world",
    });
    const { port: video } = fakeVideo();

    const summary = await analyze({ creator: "c", store, config, deps: { gemini, video } });

    expect(summary.analyzed).toBe(1);
    expect(summary.failed).toBe(0);

    const reel = store.getReel("AAA")!;
    expect(reel.analysis_status).toBe("analyzed");
    expect(reel.transcript).toBe("verbatim hello world");
    expect(reel.topic).toBe("using Claude to triage email");
    expect(reel.category).toBe("tool_demo");
    expect(reel.hook_technique).toBe("curiosity_gap");
    expect(reel.why_it_works).toContain("hook");
    expect(JSON.parse(reel.beat_sequence!)).toEqual(BEATS);

    // Provenance: fully-rendered prompt hashes (analysis = after category injection).
    expect(reel.transcription_prompt_hash).toBe(transcriptionPromptHash(config));
    expect(reel.analysis_prompt_hash).toBe(analysisPromptHash(config));
    expect(reel.analysis_prompt_hash).toMatch(/^[0-9a-f]{12}$/);
    expect(reel.analyzed_at).toBeTruthy();
    expect(reel.analysis_error).toBeNull();

    // The analysis call received the verbatim transcript from the transcription leg.
    expect(transcribeCalls).toHaveLength(1);
    expect(analyzeCalls).toHaveLength(1);
    expect(analyzeCalls[0].transcript).toBe("verbatim hello world");

    store.close();
  });

  it("respects max_analyses_per_run newest-first and reports the over-cap remainder", async () => {
    const store = openStore(":memory:");
    // 5 reels, newest-first: n0 (newest) .. n4 (oldest). Cap = 3.
    seedReels(store, "c", ["n0", "n1", "n2", "n3", "n4"]);
    const capped = structuredClone(config);
    capped.settings.max_analyses_per_run = 3;
    const { port: gemini } = fakeGemini();
    const { port: video } = fakeVideo();

    const summary = await analyze({ creator: "c", store, config: capped, deps: { gemini, video } });

    expect(summary.analyzed).toBe(3);
    expect(summary.remainingOverCap).toBe(2);

    // Exactly the 3 NEWEST analyzed; the 2 oldest left un-analyzed.
    const analyzed = (sc: string) => store.getReel(sc)!.analysis_status === "analyzed";
    expect([analyzed("n0"), analyzed("n1"), analyzed("n2")]).toEqual([true, true, true]);
    expect(store.getReel("n3")!.analysis_status).toBe("pending");
    expect(store.getReel("n4")!.analysis_status).toBe("pending");

    store.close();
  });

  it("downloads each Video transiently and DELETES it after analysis (only the thumbnail remains)", async () => {
    const store = openStore(":memory:");
    seedReels(store, "c", ["v1", "v2"]);
    const { port: gemini } = fakeGemini();
    const { port: video, downloaded, deleted } = fakeVideo();

    await analyze({ creator: "c", store, config, deps: { gemini, video } });

    expect(downloaded.sort()).toEqual(["/tmp/v1.mp4", "/tmp/v2.mp4"]);
    // Every downloaded Video is deleted — none kept on disk.
    expect(deleted.sort()).toEqual(downloaded.sort());

    store.close();
  });

  it("validates category against the config enum; an out-of-enum slug → failed (run continues)", async () => {
    const store = openStore(":memory:");
    seedReels(store, "c", ["good", "bad"]);
    const { port: gemini } = fakeGemini({
      analysisFor: (videoPath) =>
        videoPath.includes("bad")
          ? analysisResult({ category: "not_a_real_category" })
          : analysisResult({ category: "concept_teaching" }),
    });
    const { port: video, deleted } = fakeVideo();

    const summary = await analyze({ creator: "c", store, config, deps: { gemini, video } });

    expect(summary.analyzed).toBe(1);
    expect(summary.failed).toBe(1);

    expect(store.getReel("good")!.category).toBe("concept_teaching");
    expect(store.getReel("good")!.analysis_status).toBe("analyzed");

    const bad = store.getReel("bad")!;
    expect(bad.analysis_status).toBe("failed");
    expect(bad.category).toBeNull();
    expect(bad.analysis_error).toContain("not_a_real_category");

    // The Video is still deleted even on the failed Reel.
    expect(deleted).toContain("/tmp/bad.mp4");

    store.close();
  });

  it("skips already-analyzed Reels (they don't count against the cap) and reports skipped", async () => {
    const store = openStore(":memory:");
    seedReels(store, "c", ["already", "fresh"]);
    // Mark one as already analyzed, stamping the CURRENT prompt hashes — i.e. exactly
    // what a real prior analyze run writes. Under the Slice-5 incrementality contract
    // (MAIN-961) a Reel is only skipped when its stored *_prompt_hash matches the
    // current hash; an analyzed Reel with absent/drifted hashes is a re-analysis
    // candidate, so the "already analyzed" fixture must carry up-to-date provenance.
    store.updateReelAnalysis({
      shortcode: "already",
      analysis_status: "analyzed",
      analyzed_at: "2026-01-01T00:00:00.000Z",
      transcript: "old transcript",
      transcription_prompt_hash: transcriptionPromptHash(config),
      analysis_prompt_hash: analysisPromptHash(config),
    });
    const { port: gemini, transcribeCalls } = fakeGemini();
    const { port: video } = fakeVideo();

    const summary = await analyze({ creator: "c", store, config, deps: { gemini, video } });

    expect(summary.analyzed).toBe(1);
    expect(summary.skipped).toBe(1);
    // Only the fresh Reel was sent to Gemini.
    expect(transcribeCalls).toEqual(["/tmp/fresh.mp4"]);
    // The already-analyzed Reel is untouched (immutable, ADR-0004).
    expect(store.getReel("already")!.transcript).toBe("old transcript");
    expect(store.getReel("already")!.analyzed_at).toBe("2026-01-01T00:00:00.000Z");

    store.close();
  });

  it("records a per-Reel transcription failure and continues with the rest", async () => {
    const store = openStore(":memory:");
    seedReels(store, "c", ["ok1", "boom", "ok2"]);
    const { port: gemini } = fakeGemini({
      failTranscribeFor: (videoPath) => videoPath.includes("boom"),
    });
    const { port: video, deleted } = fakeVideo();

    const summary = await analyze({ creator: "c", store, config, deps: { gemini, video } });

    expect(summary.analyzed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(store.getReel("ok1")!.analysis_status).toBe("analyzed");
    expect(store.getReel("ok2")!.analysis_status).toBe("analyzed");
    const boom = store.getReel("boom")!;
    expect(boom.analysis_status).toBe("failed");
    expect(boom.analysis_error).toContain("boom");
    // Transient Video still cleaned up on failure.
    expect(deleted).toContain("/tmp/boom.mp4");

    store.close();
  });

  it("drops beats whose label is not in the framework vocabulary", async () => {
    const store = openStore(":memory:");
    seedReels(store, "c", ["beats"]);
    const dirtyBeats = [
      { label: "HOOK", start_pct: 0, end_pct: 10 },
      { label: "NONSENSE", start_pct: 10, end_pct: 50 },
      { label: "PAYOFF", start_pct: 50, end_pct: 100 },
    ] as unknown as Beat[];
    const { port: gemini } = fakeGemini({
      analysisFor: () => analysisResult({ beat_sequence: dirtyBeats }),
    });
    const { port: video } = fakeVideo();

    await analyze({ creator: "c", store, config, deps: { gemini, video } });

    const beats = JSON.parse(store.getReel("beats")!.beat_sequence!) as Beat[];
    expect(beats.map((b) => b.label)).toEqual(["HOOK", "PAYOFF"]);

    store.close();
  });

  it("no Gemini port + no API key → safe no-op that still reports the over-cap remainder", async () => {
    const store = openStore(":memory:");
    seedReels(store, "c", ["x0", "x1", "x2"]);
    const noKey = structuredClone(config);
    noKey.settings.max_analyses_per_run = 2;
    const prev = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const summary = await analyze({ creator: "c", store, config: noKey });
      expect(summary.analyzed).toBe(0);
      expect(summary.remainingOverCap).toBe(1); // 3 candidates, cap 2
      expect(store.getReel("x0")!.analysis_status).toBe("pending");
    } finally {
      if (prev != null) process.env.GEMINI_API_KEY = prev;
    }
    store.close();
  });
});

describe("pipeline 'full' wires scrape → analyze through the in-run video URL cache", () => {
  it("scrape stashes video URLs and analyze fills the lean-core fields", async () => {
    const store = openStore(":memory:");

    const reels: ScrapedReel[] = [
      {
        shortcode: "FULL1",
        url: "https://www.instagram.com/reel/FULL1/",
        posted_at: daysAgo(2),
        duration_sec: 30,
        likes: 1000,
        comments_count: 10,
        views: 5000,
        thumbnail_url: "https://cdn.example/FULL1.jpg",
        video_url: "https://cdn.example/FULL1.mp4",
      },
    ];
    const payload: ScrapeResult = {
      profile: { username: "c", followers: 10_000, posts_count: 1 },
      reels,
    };
    const apify: ApifyPort = {
      async scrapeCreator() {
        return structuredClone(payload);
      },
    };
    const { port: gemini } = fakeGemini({ transcript: "full run transcript" });
    const { port: video, downloaded, deleted } = fakeVideo();

    const result = await pipeline({
      action: "full",
      creator: "c",
      store,
      config,
      deps: { apify, gemini, video },
    });

    expect(result.scrape!.reelsUpserted).toBe(1);
    expect(result.analyze!.analyzed).toBe(1);

    const reel = store.getReel("FULL1")!;
    expect(reel.analysis_status).toBe("analyzed");
    expect(reel.transcript).toBe("full run transcript");
    expect(reel.category).toBe("tool_demo");
    // Transient Video was downloaded and deleted; thumbnail path persisted.
    expect(downloaded).toContain("/tmp/FULL1.mp4");
    expect(deleted).toContain("/tmp/FULL1.mp4");
    expect(reel.thumbnail_path).toBe("data/thumbnails/FULL1.jpg");

    store.close();
  });
});
