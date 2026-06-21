// Store round-trip harness — drives a REAL in-memory SQLite Content Store
// (HARD INVARIANT #2: tests assert on resulting store state, never internals,
// and make NO external Apify/Gemini calls). This is the pattern later slices extend.

import { describe, expect, it } from "vitest";
import { openStore } from "./store.js";
import type { TopComment } from "./types.js";

describe("Content Store schema round-trip", () => {
  it("creates creators / creator_stats / reels (+ indexes) and round-trips them", () => {
    const store = openStore(":memory:");

    // The three tables exist exactly per docs/schema.md.
    const tables = store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r: any) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining(["creators", "creator_stats", "reels"]),
    );

    // The dashboard sort/filter indexes exist.
    const indexes = store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index'`)
      .all()
      .map((r: any) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_reels_creator_username",
        "idx_reels_posted_at",
        "idx_reels_performance_score",
        "idx_reels_is_viral",
        "idx_creator_stats_username_captured",
      ]),
    );

    // --- creators identity round-trip ---
    store.upsertCreator({
      username: "ItsMariahBrunner",
      full_name: "Mariah Brunner",
      biography: "AI content",
      is_verified: true,
      last_scraped_at: "2026-06-21T00:00:00.000Z",
    });
    const creator = store.getCreator("itsmariahbrunner");
    expect(creator).toBeDefined();
    expect(creator!.username).toBe("itsmariahbrunner"); // lowercased, no @
    expect(creator!.full_name).toBe("Mariah Brunner");
    expect(creator!.is_verified).toBe(1);
    expect(creator!.profile_url).toBe("https://www.instagram.com/itsmariahbrunner/");
    expect(creator!.first_seen_at).toBeTruthy();

    // --- creator_stats time-series ---
    const s1 = store.appendCreatorStats({
      creator_username: "itsmariahbrunner",
      captured_at: "2026-06-20T00:00:00.000Z",
      followers: 100_000,
      following: 500,
      posts_count: 800,
    });
    const s2 = store.appendCreatorStats({
      creator_username: "itsmariahbrunner",
      captured_at: "2026-06-21T00:00:00.000Z",
      followers: 101_000,
      following: 505,
      posts_count: 805,
    });
    expect(s2.id).toBeGreaterThan(s1.id);
    const latest = store.getLatestStats("itsmariahbrunner");
    expect(latest!.captured_at).toBe("2026-06-21T00:00:00.000Z");
    expect(latest!.followers).toBe(101_000);
    expect(store.listCreatorStats("itsmariahbrunner")).toHaveLength(2);

    // UNIQUE(creator_username, captured_at) is enforced.
    expect(() =>
      store.appendCreatorStats({
        creator_username: "itsmariahbrunner",
        captured_at: "2026-06-21T00:00:00.000Z",
        followers: 999,
      }),
    ).toThrow();

    // --- reels: identity + metadata + JSON columns ---
    const comments: TopComment[] = [
      { username: "fan1", text: "so helpful", likes: 12 },
    ];
    store.upsertReel({
      shortcode: "ABC123",
      url: "https://www.instagram.com/reel/ABC123/",
      creator_username: "itsmariahbrunner",
      caption: "how I triage email",
      posted_at: "2026-06-15T00:00:00.000Z",
      duration_sec: 42.5,
      top_comments: comments,
    });
    const reel = store.getReel("ABC123");
    expect(reel).toBeDefined();
    expect(reel!.url).toBe("https://www.instagram.com/reel/ABC123/");
    expect(reel!.creator_username).toBe("itsmariahbrunner");
    expect(reel!.duration_sec).toBe(42.5);
    expect(reel!.analysis_status).toBe("pending");
    expect(JSON.parse(reel!.top_comments!)).toEqual(comments);

    // --- metric write incl. hidden-likes normalization (handled by callers; here
    //     we confirm the column round-trips NULL and numbers) ---
    store.updateReelMetrics({
      shortcode: "ABC123",
      likes: 5000,
      comments_count: 120,
      views: 90_000,
      shares: null,
      last_scraped_at: "2026-06-21T00:00:00.000Z",
      performance_score: 5000 + 3 * 120 + 0.1 * 90_000,
      engagement_rate: 0.143,
      is_viral: 0,
      is_outlier: 0,
    });
    const refreshed = store.getReel("ABC123");
    expect(refreshed!.likes).toBe(5000);
    expect(refreshed!.shares).toBeNull();
    expect(refreshed!.performance_score).toBe(14360);

    // --- analysis write incl. beat_sequence JSON + provenance ---
    store.updateReelAnalysis({
      shortcode: "ABC123",
      transcript: "hey here is how I triage email",
      topic: "using Claude to triage email",
      category: "tool_demo",
      hook_technique: "curiosity_gap",
      beat_sequence: [
        { label: "HOOK", start_pct: 0, end_pct: 8 },
        { label: "VALUE_1", start_pct: 8, end_pct: 80 },
        { label: "CTA", start_pct: 80, end_pct: 100 },
      ],
      why_it_works: "Specific, fast payoff.",
      analysis_status: "analyzed",
      analyzed_at: "2026-06-21T01:00:00.000Z",
      transcription_prompt_hash: "abc123def456",
      analysis_prompt_hash: "deadbeef0000",
    });
    const analyzed = store.getReel("ABC123");
    expect(analyzed!.analysis_status).toBe("analyzed");
    expect(analyzed!.category).toBe("tool_demo");
    expect(analyzed!.analysis_prompt_hash).toBe("deadbeef0000");
    expect(JSON.parse(analyzed!.beat_sequence!)).toHaveLength(3);

    store.close();
  });

  it("opening a fresh DB is idempotent (DDL safe to re-run)", () => {
    const store1 = openStore(":memory:");
    store1.upsertCreator({ username: "x" });
    expect(() => store1.db.exec("SELECT 1")).not.toThrow();
    // Re-open a NEW in-memory store; re-running DDL must not throw.
    const store2 = openStore(":memory:");
    expect(store2.getCreator("x")).toBeUndefined(); // separate db
    store1.close();
    store2.close();
  });

  it("listReels orders newest-first by default and sorts NULLs last", () => {
    const store = openStore(":memory:");
    store.upsertCreator({ username: "c" });
    store.upsertReel({ shortcode: "old", url: "u1", creator_username: "c", posted_at: "2026-01-01T00:00:00.000Z" });
    store.upsertReel({ shortcode: "new", url: "u2", creator_username: "c", posted_at: "2026-06-01T00:00:00.000Z" });
    store.upsertReel({ shortcode: "noDate", url: "u3", creator_username: "c", posted_at: null });
    const reels = store.listReels({ creator: "c" });
    expect(reels.map((r) => r.shortcode)).toEqual(["new", "old", "noDate"]);
    store.close();
  });
});
