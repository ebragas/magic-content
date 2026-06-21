// Pipeline-seam harness for scrape → Content Store → derived metrics (MAIN-958).
//
// HARD INVARIANT #2: these tests drive the REAL pipeline (scrape/refresh/pipeline)
// against a REAL in-memory SQLite Content Store with ONLY the external ports faked
// (Apify + Video). They assert on resulting STORE STATE, never internals, and make
// NO live Apify/Gemini network calls. A fixture Apify payload drives each case.

import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { openStore } from "./store.js";
import { pipeline, refresh } from "./pipeline.js";
import { scrape } from "./scrape.js";
import type {
  ApifyPort,
  ScrapeResult,
  ScrapedReel,
  TopComment,
  VideoPort,
} from "./types.js";

const config = loadConfig();

// --- Fixtures -------------------------------------------------------------

const COMMENTS: TopComment[] = [
  { username: "fan1", text: "so helpful", likes: 12 },
  { username: "fan2", text: "saving this", likes: 3 },
];

/** ISO timestamp N days before now. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function reel(overrides: Partial<ScrapedReel> & { shortcode: string }): ScrapedReel {
  return {
    url: `https://www.instagram.com/reel/${overrides.shortcode}/`,
    caption: "a caption",
    posted_at: daysAgo(10),
    duration_sec: 30,
    likes: 1000,
    comments_count: 50,
    views: 20_000,
    shares: null,
    thumbnail_url: `https://cdn.example/${overrides.shortcode}.jpg`,
    video_url: `https://cdn.example/${overrides.shortcode}.mp4`,
    top_comments: COMMENTS,
    ...overrides,
  };
}

/** Build a fake Apify port returning a fixed payload, recording call args. */
function fakeApify(payload: ScrapeResult): {
  port: ApifyPort;
  calls: { username: string; windowDays: number; resultsLimit: number }[];
} {
  const calls: { username: string; windowDays: number; resultsLimit: number }[] = [];
  const port: ApifyPort = {
    async scrapeCreator(args) {
      calls.push(args);
      return structuredClone(payload);
    },
  };
  return { port, calls };
}

/** Fake VideoPort that "saves" a thumbnail to a deterministic path (no real I/O). */
function fakeVideo(): { port: VideoPort; downloaded: string[] } {
  const downloaded: string[] = [];
  const port: VideoPort = {
    async downloadVideo({ shortcode }) {
      return `/tmp/${shortcode}.mp4`;
    },
    async downloadThumbnail({ shortcode }) {
      downloaded.push(shortcode);
      return `data/thumbnails/${shortcode}.jpg`;
    },
    async deleteVideo() {
      /* no-op */
    },
  };
  return { port, downloaded };
}

// --- Tests ----------------------------------------------------------------

describe("scrape → Content Store (fixture Apify payload)", () => {
  it("upserts one creator, one creator_stats snapshot, and the reels rows", async () => {
    const store = openStore(":memory:");
    const { port: apify } = fakeApify({
      profile: {
        username: "itsmariahbrunner",
        full_name: "Mariah Brunner",
        biography: "AI content",
        is_verified: true,
        followers: 100_000,
        following: 500,
        posts_count: 3,
      },
      reels: [
        reel({ shortcode: "AAA", posted_at: daysAgo(5) }),
        reel({ shortcode: "BBB", posted_at: daysAgo(20) }),
        reel({ shortcode: "CCC", posted_at: daysAgo(40) }),
      ],
    });
    const { port: video, downloaded } = fakeVideo();

    const summary = await scrape({
      creator: "@ItsMariahBrunner",
      store,
      config,
      deps: { apify, video },
    });

    // creators: exactly one row, identity populated.
    const creators = store.db.prepare(`SELECT * FROM creators`).all();
    expect(creators).toHaveLength(1);
    const creator = store.getCreator("itsmariahbrunner");
    expect(creator!.username).toBe("itsmariahbrunner");
    expect(creator!.full_name).toBe("Mariah Brunner");
    expect(creator!.is_verified).toBe(1);
    expect(creator!.last_scraped_at).toBeTruthy();
    expect(creator!.profile_url).toBe("https://www.instagram.com/itsmariahbrunner/");

    // creator_stats: exactly one appended snapshot.
    const stats = store.listCreatorStats("itsmariahbrunner");
    expect(stats).toHaveLength(1);
    expect(stats[0].followers).toBe(100_000);
    expect(stats[0].following).toBe(500);
    expect(stats[0].posts_count).toBe(3);
    expect(summary.statsSnapshotId).toBe(stats[0].id);

    // reels: one row per scraped Reel within the window.
    const reels = store.listReels({ creator: "itsmariahbrunner" });
    expect(reels.map((r) => r.shortcode).sort()).toEqual(["AAA", "BBB", "CCC"]);
    expect(summary.reelsScraped).toBe(3);
    expect(summary.reelsUpserted).toBe(3);

    // canonical URL, metadata, capped top_comments JSON, saved thumbnail.
    const aaa = store.getReel("AAA")!;
    expect(aaa.url).toBe("https://www.instagram.com/reel/AAA/");
    expect(aaa.creator_username).toBe("itsmariahbrunner");
    expect(aaa.caption).toBe("a caption");
    expect(aaa.duration_sec).toBe(30);
    expect(aaa.thumbnail_path).toBe("data/thumbnails/AAA.jpg");
    expect(JSON.parse(aaa.top_comments!)).toEqual(COMMENTS);
    expect(downloaded.sort()).toEqual(["AAA", "BBB", "CCC"]);

    // raw metrics landed.
    expect(aaa.likes).toBe(1000);
    expect(aaa.comments_count).toBe(50);
    expect(aaa.views).toBe(20_000);

    store.close();
  });

  it("computes derived metrics against the latest snapshot (performance / engagement / viral)", async () => {
    const store = openStore(":memory:");
    const { port: apify } = fakeApify({
      profile: { username: "c", followers: 10_000, posts_count: 2 },
      reels: [
        reel({ shortcode: "norm", likes: 1000, comments_count: 100, views: 50_000 }),
        // likes >= 5 * followers (50_000) → viral.
        reel({ shortcode: "viral", likes: 60_000, comments_count: 0, views: 0 }),
      ],
    });

    await scrape({ creator: "c", store, config, deps: { apify } });

    const norm = store.getReel("norm")!;
    // performance = 1000 + 3*100 + 0.1*50000 = 6300
    expect(norm.performance_score).toBe(6300);
    expect(norm.engagement_rate).toBeCloseTo(6300 / 10_000);
    expect(norm.is_viral).toBe(0);

    const viral = store.getReel("viral")!;
    expect(viral.performance_score).toBe(60_000);
    expect(viral.is_viral).toBe(1); // 60_000 >= 5 * 10_000

    store.close();
  });

  it("normalizes hidden likes (-1) to NULL and nulls its derived metrics, excluding it from the outlier baseline", async () => {
    const store = openStore(":memory:");
    // 20 tight baseline reels + 1 extreme outlier + 1 hidden-likes reel.
    const reels: ScrapedReel[] = [];
    for (let i = 0; i < 20; i++) {
      reels.push(reel({ shortcode: `b${i}`, likes: 100, comments_count: 0, views: 0 }));
    }
    reels.push(reel({ shortcode: "outlier", likes: 100_000, comments_count: 0, views: 0 }));
    reels.push(reel({ shortcode: "hidden", likes: -1, comments_count: 10, views: 100 }));

    const { port: apify } = fakeApify({
      profile: { username: "c", followers: 1_000_000, posts_count: 22 },
      reels,
    });

    await scrape({ creator: "c", store, config, deps: { apify } });

    // Hidden likes never stored as -1; normalized to NULL.
    const hidden = store.getReel("hidden")!;
    expect(hidden.likes).toBeNull();
    expect(hidden.performance_score).toBeNull();
    expect(hidden.engagement_rate).toBeNull();
    expect(hidden.is_viral).toBeNull();
    // Excluded from the outlier baseline → its own outlier flag is NULL.
    expect(hidden.is_outlier).toBeNull();

    // The genuine outlier is flagged; tight-baseline reels are not.
    expect(store.getReel("outlier")!.is_outlier).toBe(1);
    expect(store.getReel("b0")!.is_outlier).toBe(0);

    store.close();
  });

  it("zero/missing followers → engagement_rate & is_viral NULL but performance_score still computed", async () => {
    const storeZero = openStore(":memory:");
    const { port: apifyZero } = fakeApify({
      profile: { username: "c", followers: 0, posts_count: 1 },
      reels: [reel({ shortcode: "z", likes: 100, comments_count: 0, views: 0 })],
    });
    await scrape({ creator: "c", store: storeZero, config, deps: { apify: apifyZero } });
    const z = storeZero.getReel("z")!;
    expect(z.performance_score).toBe(100);
    expect(z.engagement_rate).toBeNull();
    expect(z.is_viral).toBeNull();
    storeZero.close();

    const storeNull = openStore(":memory:");
    const { port: apifyNull } = fakeApify({
      profile: { username: "c", followers: null, posts_count: 1 },
      reels: [reel({ shortcode: "n", likes: 100, comments_count: 0, views: 0 })],
    });
    await scrape({ creator: "c", store: storeNull, config, deps: { apify: apifyNull } });
    const n = storeNull.getReel("n")!;
    expect(n.performance_score).toBe(100);
    expect(n.engagement_rate).toBeNull();
    expect(n.is_viral).toBeNull();
    storeNull.close();
  });

  it("honors results_limit (caps scraped reels)", async () => {
    const cappedConfig = structuredClone(config);
    cappedConfig.settings.results_limit = 2;

    const store = openStore(":memory:");
    const { port: apify } = fakeApify({
      profile: { username: "c", followers: 1000, posts_count: 5 },
      reels: [
        reel({ shortcode: "r1", posted_at: daysAgo(1) }),
        reel({ shortcode: "r2", posted_at: daysAgo(2) }),
        reel({ shortcode: "r3", posted_at: daysAgo(3) }),
        reel({ shortcode: "r4", posted_at: daysAgo(4) }),
      ],
    });

    const summary = await scrape({ creator: "c", store, config: cappedConfig, deps: { apify } });
    expect(summary.reelsUpserted).toBe(2);
    expect(store.listReels({ creator: "c" })).toHaveLength(2);
    store.close();
  });

  it("honors the 90-day window (drops reels older than the window)", async () => {
    const store = openStore(":memory:");
    const { port: apify } = fakeApify({
      profile: { username: "c", followers: 1000, posts_count: 3 },
      reels: [
        reel({ shortcode: "recent", posted_at: daysAgo(10) }),
        reel({ shortcode: "edge", posted_at: daysAgo(89) }),
        reel({ shortcode: "stale", posted_at: daysAgo(120) }), // outside 90d
      ],
    });

    await scrape({ creator: "c", store, config, deps: { apify } });
    const shortcodes = store.listReels({ creator: "c" }).map((r) => r.shortcode).sort();
    expect(shortcodes).toEqual(["edge", "recent"]);
    expect(store.getReel("stale")).toBeUndefined();
    store.close();
  });

  it("retries once on undercount and keeps the larger pull", async () => {
    const store = openStore(":memory:");
    const calls: number[] = [];
    const big = [
      reel({ shortcode: "p1" }),
      reel({ shortcode: "p2" }),
      reel({ shortcode: "p3" }),
    ];
    const apify: ApifyPort = {
      async scrapeCreator(args) {
        calls.push(args.resultsLimit);
        // First pull undercounts (1 of 3 posts); retry returns all 3.
        return calls.length === 1
          ? { profile: { username: "c", followers: 1000, posts_count: 3 }, reels: [reel({ shortcode: "p1" })] }
          : { profile: { username: "c", followers: 1000, posts_count: 3 }, reels: structuredClone(big) };
      },
    };

    const summary = await scrape({ creator: "c", store, config, deps: { apify } });
    expect(calls).toHaveLength(2); // retried once
    expect(calls[1]).toBeGreaterThan(calls[0]); // bumped limit
    expect(summary.reelsUpserted).toBe(3);
    expect(store.listReels({ creator: "c" })).toHaveLength(3);
    store.close();
  });

  it("survives a thumbnail download failure without aborting the run", async () => {
    const store = openStore(":memory:");
    const { port: apify } = fakeApify({
      profile: { username: "c", followers: 1000, posts_count: 1 },
      reels: [reel({ shortcode: "t1" })],
    });
    const video: VideoPort = {
      async downloadVideo() {
        return "/tmp/x.mp4";
      },
      async downloadThumbnail() {
        throw new Error("CDN 403");
      },
      async deleteVideo() {},
    };

    const summary = await scrape({ creator: "c", store, config, deps: { apify, video } });
    expect(summary.reelsUpserted).toBe(1);
    expect(store.getReel("t1")!.thumbnail_path).toBeNull();
    store.close();
  });

  it("is idempotent: re-scraping the same creator does not duplicate reels and appends a new snapshot", async () => {
    const store = openStore(":memory:");
    const payload: ScrapeResult = {
      profile: { username: "c", followers: 1000, posts_count: 1 },
      reels: [reel({ shortcode: "dup" })],
    };
    const { port: apify } = fakeApify(payload);

    await scrape({ creator: "c", store, config, deps: { apify } });
    // Force a distinct captured_at so the UNIQUE(creator,captured_at) holds.
    await new Promise((r) => setTimeout(r, 5));
    await scrape({ creator: "c", store, config, deps: { apify } });

    expect(store.listReels({ creator: "c" })).toHaveLength(1); // upsert, not insert
    expect(store.listCreatorStats("c").length).toBeGreaterThanOrEqual(2); // time-series
    store.close();
  });
});

describe("refresh → metrics re-pull + new snapshot (analysis untouched)", () => {
  it("updates drifting metrics, appends a snapshot, recomputes derived, and leaves analysis alone", async () => {
    const store = openStore(":memory:");
    // Initial scrape.
    const { port: apify1 } = fakeApify({
      profile: { username: "c", followers: 10_000, posts_count: 1 },
      reels: [reel({ shortcode: "R", likes: 1000, comments_count: 0, views: 0 })],
    });
    await scrape({ creator: "c", store, config, deps: { apify: apify1 } });

    // Stamp analysis on the reel so we can prove refresh leaves it untouched.
    store.updateReelAnalysis({
      shortcode: "R",
      transcript: "verbatim words",
      topic: "a topic",
      category: "tool_demo",
      analysis_status: "analyzed",
      analyzed_at: "2026-06-21T00:00:00.000Z",
      analysis_prompt_hash: "deadbeef0000",
    });

    await new Promise((r) => setTimeout(r, 5));

    // Refresh with drifted metrics + grown followers.
    const { port: apify2 } = fakeApify({
      profile: { username: "c", followers: 20_000, posts_count: 1 },
      reels: [reel({ shortcode: "R", likes: 5000, comments_count: 10, views: 1000 })],
    });
    const summary = await refresh({ creator: "c", store, config, deps: { apify: apify2 } });

    const r = store.getReel("R")!;
    // Metrics drifted.
    expect(r.likes).toBe(5000);
    expect(r.comments_count).toBe(10);
    expect(r.views).toBe(1000);
    // Derived recomputed against NEW follower snapshot (20_000).
    expect(r.performance_score).toBe(5000 + 3 * 10 + 0.1 * 1000); // 5130
    expect(r.engagement_rate).toBeCloseTo(5130 / 20_000);
    // Analysis untouched (immutable, ADR-0004).
    expect(r.transcript).toBe("verbatim words");
    expect(r.category).toBe("tool_demo");
    expect(r.analysis_status).toBe("analyzed");
    expect(r.analyzed_at).toBe("2026-06-21T00:00:00.000Z");
    expect(r.analysis_prompt_hash).toBe("deadbeef0000");

    // A second snapshot appended.
    expect(store.listCreatorStats("c").length).toBeGreaterThanOrEqual(2);
    expect(store.getLatestStats("c")!.followers).toBe(20_000);
    expect(summary.reelsRefreshed).toBe(1);

    store.close();
  });

  it("refresh does not create identity rows for reels it has never scraped", async () => {
    const store = openStore(":memory:");
    store.upsertCreator({ username: "c" });
    const { port: apify } = fakeApify({
      profile: { username: "c", followers: 1000, posts_count: 1 },
      reels: [reel({ shortcode: "unknown" })],
    });
    const summary = await refresh({ creator: "c", store, config, deps: { apify } });
    expect(summary.reelsRefreshed).toBe(0);
    expect(store.getReel("unknown")).toBeUndefined();
    store.close();
  });
});

describe("pipeline dispatch (scrape / full) wires the real path", () => {
  it("pipeline 'scrape' runs the full scrape path through the injected ports", async () => {
    const store = openStore(":memory:");
    const { port: apify } = fakeApify({
      profile: { username: "itsmariahbrunner", followers: 10_000, posts_count: 1 },
      reels: [reel({ shortcode: "P1" })],
    });
    const { port: video } = fakeVideo();

    const result = await pipeline({
      action: "scrape",
      creator: "itsmariahbrunner",
      store,
      config,
      deps: { apify, video },
    });
    expect(result.scrape!.reelsUpserted).toBe(1);
    expect(store.getReel("P1")).toBeDefined();
    expect(store.getReel("P1")!.performance_score).not.toBeNull();
    store.close();
  });

  it("pipeline 'full' scrapes then refreshes; reports progress for each stage", async () => {
    const store = openStore(":memory:");
    const { port: apify } = fakeApify({
      profile: { username: "c", followers: 10_000, posts_count: 1 },
      reels: [reel({ shortcode: "F1" })],
    });
    const onProgress = vi.fn();
    const result = await pipeline({
      action: "full",
      creator: "c",
      store,
      config,
      deps: { apify },
      onProgress,
    });
    expect(result.scrape).toBeDefined();
    expect(result.analyze).toBeDefined(); // analyze stub (no gemini) → zeros
    expect(result.refresh).toBeDefined();
    expect(result.refresh!.reelsRefreshed).toBe(1);
    const stages = onProgress.mock.calls.map((c) => c[0]);
    expect(stages).toEqual(expect.arrayContaining(["scrape", "refresh"]));
    store.close();
  });
});
