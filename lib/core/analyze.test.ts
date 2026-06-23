// Pipeline-seam harness for the analyze leg (MAIN-960).
//
// HARD INVARIANT #2: these tests drive the REAL analyze()/pipeline() against a REAL
// in-memory SQLite Content Store with ONLY the external ports faked (Gemini + Video).
// They assert on resulting STORE STATE, never internals, and make NO live
// Apify/Gemini network calls. A fixture Gemini response drives each case.

import { afterEach, describe, expect, it, vi } from "vitest";
import { analysisPromptHash, applyNoCap, loadConfig, transcriptionPromptHash } from "./config.js";
import { openStore } from "./store.js";
import { analyze, __setVideoUrlForTest, resetVideoUrlCache } from "./analyze.js";
import { pipeline } from "./pipeline.js";
import type {
  ApifyPort,
  Beat,
  GeminiAnalysisResult,
  GeminiPort,
  ScrapeResult,
  ScrapedComment,
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
  { label: "HOOK", start_pct: 0, end_pct: 10, text: "Claude just announced something I'm genuinely so excited about." },
  { label: "VALUE_1", start_pct: 10, end_pct: 60, text: "You can now turn anything into a live, interactive website." },
  { label: "PAYOFF", start_pct: 60, end_pct: 90, text: "And it just works, right inside the editor." },
  { label: "CTA", start_pct: 90, end_pct: 100, text: "Follow for more Claude tips." },
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

  it("an uncapped config (applyNoCap / Reprocess) analyzes ALL candidates in one run", async () => {
    const store = openStore(":memory:");
    // 5 reels with a base cap of 2 — capped this would analyze 2 and leave 3 over cap.
    seedReels(store, "c", ["n0", "n1", "n2", "n3", "n4"]);
    const capped = structuredClone(config);
    capped.settings.max_analyses_per_run = 2;
    const { port: gemini } = fakeGemini();
    const { port: video } = fakeVideo();

    // applyNoCap lifts the cap, so every drifted/pending candidate is processed at once.
    const summary = await analyze({
      creator: "c",
      store,
      config: applyNoCap(capped),
      deps: { gemini, video },
    });

    expect(summary.analyzed).toBe(5);
    expect(summary.remainingOverCap).toBe(0);
    for (const sc of ["n0", "n1", "n2", "n3", "n4"]) {
      expect(store.getReel(sc)!.analysis_status).toBe("analyzed");
    }

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
    // Source beats carried no `text`; sanitizeBeats defaults each to "".
    expect(beats.map((b) => b.text)).toEqual(["", ""]);

    store.close();
  });

  it("treats the silent-video sentinel as no transcript (stores null, keeps the rest of the analysis) (#6)", async () => {
    const store = openStore(":memory:");
    seedReels(store, "c", ["silent"]);
    // The transcription leg returns the exact sentinel from prompts/transcription.md;
    // the analysis echo also carries it. Neither should be stored as content.
    const { port: gemini } = fakeGemini({
      transcript: "[no speech]",
      analysisFor: () => analysisResult({ transcript: "[no speech]" }),
    });
    const { port: video } = fakeVideo();

    const summary = await analyze({ creator: "c", store, config, deps: { gemini, video } });
    expect(summary.analyzed).toBe(1);

    const reel = store.getReel("silent")!;
    // Sentinel normalized to null — not rendered as content, not counted as a transcript.
    expect(reel.transcript).toBeNull();
    // The rest of the analysis is intact.
    expect(reel.analysis_status).toBe("analyzed");
    expect(reel.topic).toBe("using Claude to triage email");
    expect(reel.category).toBe("tool_demo");
    expect(reel.why_it_works).toContain("hook");

    store.close();
  });

  it("uploads each Video to Gemini ONCE and reuses the handle for both calls (#13)", async () => {
    const store = openStore(":memory:");
    seedReels(store, "c", ["R1", "R2"]);

    // A fake that mints a distinct opaque handle per prepareVideo call and records
    // every method invocation, so we can assert one upload per Reel + handle reuse.
    const prepared: string[] = [];
    const released: string[] = [];
    const transcribeHandles: unknown[] = [];
    const analyzeHandles: unknown[] = [];
    let counter = 0;
    const gemini: GeminiPort = {
      async prepareVideo({ videoPath }) {
        counter += 1;
        const handle = { id: `${videoPath}#${counter}` };
        prepared.push(videoPath);
        return handle;
      },
      async releaseVideo(handle) {
        released.push((handle as { id: string }).id);
      },
      async transcribe({ video }) {
        transcribeHandles.push(video);
        return { transcript: "verbatim" };
      },
      async analyzeVideo({ video }) {
        analyzeHandles.push(video);
        return analysisResult();
      },
    };
    const { port: video } = fakeVideo();

    await analyze({ creator: "c", store, config, deps: { gemini, video } });

    // Exactly ONE upload per Reel (not two) — the crux of the fix.
    expect(prepared.sort()).toEqual(["/tmp/R1.mp4", "/tmp/R2.mp4"]);
    // Both generateContent calls per Reel received the SAME (defined) handle.
    expect(transcribeHandles).toHaveLength(2);
    expect(analyzeHandles).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      expect(transcribeHandles[i]).toBeDefined();
      expect(transcribeHandles[i]).toBe(analyzeHandles[i]);
    }
    // Each uploaded handle is released exactly once.
    expect(released).toHaveLength(2);

    store.close();
  });

  it("prioritizes never-analyzed Reels ahead of re-analysis candidates under the cap (#4)", async () => {
    const store = openStore(":memory:");
    // Newest-first: R0 (newest) .. R3 (oldest). The two NEWEST are already analyzed
    // but with a DRIFTED analysis hash → they are re-analysis candidates. The two
    // OLDEST were never analyzed (pending). Cap = 2.
    seedReels(store, "c", ["R0", "R1", "R2", "R3"]);
    store.updateReelAnalysis({
      shortcode: "R0",
      analysis_status: "analyzed",
      analyzed_at: "2026-01-01T00:00:00.000Z",
      transcript: "old R0",
      transcription_prompt_hash: transcriptionPromptHash(config),
      analysis_prompt_hash: "deadbeefcafe", // drifted → re-analysis candidate
    });
    store.updateReelAnalysis({
      shortcode: "R1",
      analysis_status: "analyzed",
      analyzed_at: "2026-01-01T00:00:00.000Z",
      transcript: "old R1",
      transcription_prompt_hash: transcriptionPromptHash(config),
      analysis_prompt_hash: "deadbeefcafe", // drifted → re-analysis candidate
    });

    const capped = structuredClone(config);
    capped.settings.max_analyses_per_run = 2;
    const { port: gemini } = fakeGemini();
    const { port: video } = fakeVideo();

    const summary = await analyze({ creator: "c", store, config: capped, deps: { gemini, video } });

    // The cap is spent on the two NEVER-analyzed Reels first — re-analyses starve, not
    // first-timers. 4 candidates, cap 2 → 2 over cap.
    expect(summary.analyzed).toBe(2);
    expect(summary.remainingOverCap).toBe(2);
    // The two oldest (never-analyzed) got analyzed.
    expect(store.getReel("R2")!.analysis_status).toBe("analyzed");
    expect(store.getReel("R3")!.analysis_status).toBe("analyzed");
    // The two newest (re-analysis candidates) were NOT redone — prior state intact.
    expect(store.getReel("R0")!.transcript).toBe("old R0");
    expect(store.getReel("R0")!.analysis_prompt_hash).toBe("deadbeefcafe");
    expect(store.getReel("R1")!.transcript).toBe("old R1");

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

  it("scrapes up to N Comments per analyzed Reel and persists them to the comments corpus (#1)", async () => {
    const store = openStore(":memory:");
    seedReels(store, "c", ["AAA"]);
    const captured: { args: { shortcode: string; url: string; limit: number } }[] = [];
    const apify: ApifyPort = {
      async scrapeCreator() {
        return { profile: { username: "c" }, reels: [] };
      },
      async scrapeComments(args) {
        captured.push({ args });
        return [
          { comment_id: "k1", username: "a", text: "does it work?", likes: 4 },
          { comment_id: "k2", username: "b", text: "love this", likes: 9 },
        ];
      },
    };
    const { port: gemini } = fakeGemini();
    const { port: video } = fakeVideo();

    // limit comes from settings.comments_per_reel (config fixture = 150).
    await analyze({ creator: "c", store, config, deps: { apify, gemini, video } });

    expect(captured).toHaveLength(1);
    expect(captured[0].args).toEqual({
      shortcode: "AAA",
      url: "https://www.instagram.com/reel/AAA/",
      limit: config.settings.comments_per_reel,
    });
    const rows = store.listComments("AAA");
    expect(rows.map((r) => r.comment_id).sort()).toEqual(["k1", "k2"]);
    expect(rows.find((r) => r.comment_id === "k2")!.text).toBe("love this");

    store.close();
  });

  it("re-scraping a Reel's Comments accumulates the union by comment id (#2/#4): [c1,c2] then [c2,c3] → {c1,c2,c3}", async () => {
    const store = openStore(":memory:");
    seedReels(store, "c", ["AAA"]);

    // The fake returns a DIFFERENT overlapping comment set on each scrapeComments call.
    let call = 0;
    const batches: ScrapedComment[][] = [
      [
        { comment_id: "c1", username: "a", text: "first batch one", likes: 2 },
        { comment_id: "c2", username: "b", text: "shared comment", likes: 5 },
      ],
      [
        { comment_id: "c2", username: "b", text: "shared comment", likes: 8 },
        { comment_id: "c3", username: "d", text: "second batch three", likes: 1 },
      ],
    ];
    const apify: ApifyPort = {
      async scrapeCreator() {
        return { profile: { username: "c" }, reels: [] };
      },
      async scrapeComments() {
        return batches[Math.min(call++, batches.length - 1)];
      },
    };
    const { port: gemini } = fakeGemini();
    const { port: video } = fakeVideo();

    // First analyze → pulls [c1, c2].
    await analyze({ creator: "c", store, config, deps: { apify, gemini, video } });
    expect(store.listComments("AAA").map((r) => r.comment_id).sort()).toEqual(["c1", "c2"]);

    // Force a re-analysis (drift the analysis hash) so analyze runs the Reel again and
    // pulls the SECOND overlapping batch [c2, c3]. The corpus must be the UNION.
    store.updateReelAnalysis({ shortcode: "AAA", analysis_prompt_hash: "deadbeefcafe" });

    await analyze({ creator: "c", store, config, deps: { apify, gemini, video } });

    const rows = store.listComments("AAA");
    expect(rows.map((r) => r.comment_id).sort()).toEqual(["c1", "c2", "c3"]);
    // c1 survived the second pull (not clobbered); c2's likes refreshed to the newest pull.
    expect(rows.find((r) => r.comment_id === "c2")!.likes).toBe(8);

    store.close();
  });

  it("a stale analysis-hash Reel (pre-trigger-keyword) is a re-analysis candidate and gains the keyword (#1)", async () => {
    const store = openStore(":memory:");
    seedReels(store, "c", ["AAA"]);
    // Simulate a Reel analyzed under the PRE-slice-968 prompt: status=analyzed, the
    // transcription hash is current, but the analysis hash predates the trigger_keyword
    // prompt edit (so it differs from the CURRENT analysisPromptHash) → drift.
    store.updateReelAnalysis({
      shortcode: "AAA",
      analysis_status: "analyzed",
      analyzed_at: "2026-01-01T00:00:00.000Z",
      transcript: "old transcript",
      trigger_keyword: null, // not detected pre-slice-968
      transcription_prompt_hash: transcriptionPromptHash(config),
      analysis_prompt_hash: "0000oldhash00", // stale → drifted from current
    });
    // Sanity: the current analysis hash is NOT the stale one (the prompt edit bumped it).
    expect(analysisPromptHash(config)).not.toBe("0000oldhash00");

    const { port: gemini, transcribeCalls } = fakeGemini({
      analysisFor: () => analysisResult({ trigger_keyword: "ritual" }),
    });
    const { port: video } = fakeVideo();

    const summary = await analyze({ creator: "c", store, config, deps: { gemini, video } });

    // The drifted Reel was re-analyzed (a candidate), not skipped.
    expect(summary.analyzed).toBe(1);
    expect(transcribeCalls).toEqual(["/tmp/AAA.mp4"]);
    const reel = store.getReel("AAA")!;
    expect(reel.trigger_keyword).toBe("ritual"); // keyword now populated
    expect(reel.analysis_prompt_hash).toBe(analysisPromptHash(config)); // re-stamped to current
    store.close();
  });

  it("emits a trigger_keyword, flags matching Comments is_trigger, and stores the keyword (#5)", async () => {
    const store = openStore(":memory:");
    seedReels(store, "c", ["AAA"]);
    const apify: ApifyPort = {
      async scrapeCreator() {
        return { profile: { username: "c" }, reels: [] };
      },
      async scrapeComments() {
        return [
          { comment_id: "t1", username: "a", text: "RITUAL", likes: 0 }, // exact → trigger
          { comment_id: "t2", username: "b", text: "ritual please", likes: 0 }, // short token → trigger
          { comment_id: "q1", username: "c", text: "does this work on the free plan?", likes: 12 }, // question, kept
          { comment_id: "n1", username: "d", text: "this ritual changed my whole routine", likes: 4 }, // long mention, kept
        ];
      },
    };
    // The fake Gemini emits the Trigger Keyword (un-normalized — the analyze leg lowercases/trims).
    const { port: gemini } = fakeGemini({ analysisFor: () => analysisResult({ trigger_keyword: "Ritual!" }) });
    const { port: video } = fakeVideo();

    const summary = await analyze({ creator: "c", store, config, deps: { apify, gemini, video } });
    expect(summary.analyzed).toBe(1);

    // The normalized keyword is stored on the Reel.
    expect(store.getReel("AAA")!.trigger_keyword).toBe("ritual");

    // The two automation Comments are flagged is_trigger; the question + the long mention are not.
    // (The dashboard's default view excludes is_trigger=1 and counts them — see
    // content-labels.test.ts commentRowsToVMs; here we assert the store-state seam.)
    const rows = store.listComments("AAA");
    const flagged = rows.filter((r) => r.is_trigger === 1).map((r) => r.comment_id).sort();
    expect(flagged).toEqual(["t1", "t2"]);
    const unflagged = rows.filter((r) => r.is_trigger !== 1).map((r) => r.comment_id).sort();
    expect(unflagged).toEqual(["n1", "q1"]);
    // The trigger-Comment count (the CTA-response signal surfaced in the detail view).
    expect(rows.reduce((n, r) => n + (r.is_trigger === 1 ? 1 : 0), 0)).toBe(2);

    store.close();
  });

  it("re-analysis with a CHANGED trigger_keyword recomputes is_trigger non-destructively (slice 968)", async () => {
    const store = openStore(":memory:");
    seedReels(store, "c", ["AAA"]);
    let keyword = "ritual";
    const apify: ApifyPort = {
      async scrapeCreator() {
        return { profile: { username: "c" }, reels: [] };
      },
      async scrapeComments() {
        return [
          { comment_id: "k1", username: "a", text: "ritual", likes: 0 },
          { comment_id: "k2", username: "b", text: "loop", likes: 0 },
        ];
      },
    };
    const { port: gemini } = fakeGemini({ analysisFor: () => analysisResult({ trigger_keyword: keyword }) });
    const { port: video } = fakeVideo();

    await analyze({ creator: "c", store, config, deps: { apify, gemini, video } });
    expect(store.listComments("AAA").find((r) => r.comment_id === "k1")!.is_trigger).toBe(1);
    expect(store.listComments("AAA").find((r) => r.comment_id === "k2")!.is_trigger).toBe(0);

    // Force a re-analysis with a DIFFERENT keyword; the flags must move, not double up.
    keyword = "loop";
    store.updateReelAnalysis({ shortcode: "AAA", analysis_prompt_hash: "deadbeefcafe" });
    await analyze({ creator: "c", store, config, deps: { apify, gemini, video } });

    const rows = store.listComments("AAA");
    expect(rows.find((r) => r.comment_id === "k1")!.is_trigger).toBe(0); // un-flagged
    expect(rows.find((r) => r.comment_id === "k2")!.is_trigger).toBe(1); // newly flagged
    expect(rows).toHaveLength(2); // nothing deleted
    expect(store.getReel("AAA")!.trigger_keyword).toBe("loop");

    store.close();
  });

  it("no scrapeComments-capable Apify port → analysis still succeeds, comment leg is a safe no-op", async () => {
    const store = openStore(":memory:");
    seedReels(store, "c", ["AAA"]);
    // An Apify port WITHOUT scrapeComments (existing fakes shape) — the optional method.
    const apify: ApifyPort = {
      async scrapeCreator() {
        return { profile: { username: "c" }, reels: [] };
      },
    };
    const { port: gemini } = fakeGemini();
    const { port: video } = fakeVideo();

    const summary = await analyze({ creator: "c", store, config, deps: { apify, gemini, video } });
    expect(summary.analyzed).toBe(1);
    expect(store.getReel("AAA")!.analysis_status).toBe("analyzed");
    // No comments written — corpus is empty, no throw.
    expect(store.listComments("AAA")).toEqual([]);

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
