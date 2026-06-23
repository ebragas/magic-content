// Store round-trip harness — drives a REAL in-memory SQLite Content Store
// (HARD INVARIANT #2: tests assert on resulting store state, never internals,
// and make NO external Apify/Gemini calls). This is the pattern later slices extend.

import { describe, expect, it } from "vitest";
import { openStore } from "./store.js";
import type { ScrapedComment, TopComment } from "./types.js";

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
        { label: "HOOK", start_pct: 0, end_pct: 8, text: "hey here is" },
        { label: "VALUE_1", start_pct: 8, end_pct: 80, text: "how I triage email" },
        { label: "CTA", start_pct: 80, end_pct: 100, text: "" },
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

  it("comments corpus: upsertComments accumulates by comment_id, listComments reads it", () => {
    const store = openStore(":memory:");
    store.upsertCreator({ username: "c" });
    store.upsertReel({ shortcode: "R", url: "u", creator_username: "c" });

    // The `comments` table + its index exist (mirror docs/schema.md).
    const tables = store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain("comments");
    const indexes = store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index'`)
      .all()
      .map((r: any) => r.name);
    expect(indexes).toContain("idx_comments_shortcode");

    const first: ScrapedComment[] = [
      { comment_id: "c1", username: "a", text: "does this work?", likes: 3, posted_at: "2026-06-01T00:00:00.000Z" },
      { comment_id: "c2", username: "b", text: "so good", likes: 10 },
    ];
    expect(store.upsertComments("R", first)).toBe(2);

    let rows = store.listComments("R");
    expect(rows.map((r) => r.comment_id).sort()).toEqual(["c1", "c2"]);
    // listComments orders likes DESC.
    expect(rows.map((r) => r.comment_id)).toEqual(["c2", "c1"]);
    // first_seen_at stamped; is_trigger defaults to 0.
    const c1First = rows.find((r) => r.comment_id === "c1")!;
    expect(c1First.first_seen_at).toBeTruthy();
    expect(c1First.is_trigger).toBe(0);

    // A SECOND, overlapping pull: c2 again (with refreshed likes/text) + a NEW c3.
    // The corpus must ACCUMULATE the union — c1 is NOT lost.
    const firstSeenC1 = c1First.first_seen_at;
    const second: ScrapedComment[] = [
      { comment_id: "c2", username: "b", text: "so good (edited)", likes: 25 },
      { comment_id: "c3", username: "d", text: "saving this", likes: 1 },
    ];
    store.upsertComments("R", second);

    rows = store.listComments("R");
    expect(rows.map((r) => r.comment_id).sort()).toEqual(["c1", "c2", "c3"]);
    // c2's mutable fields refreshed to the newest pull.
    const c2 = rows.find((r) => r.comment_id === "c2")!;
    expect(c2.likes).toBe(25);
    expect(c2.text).toBe("so good (edited)");
    // c1 untouched, including its preserved first_seen_at.
    const c1 = rows.find((r) => r.comment_id === "c1")!;
    expect(c1.first_seen_at).toBe(firstSeenC1);
    expect(c1.text).toBe("does this work?");

    // A re-scrape NEVER resets is_trigger (slice 968 owns it) — flag c1, re-upsert, assert it sticks.
    store.db.prepare(`UPDATE comments SET is_trigger = 1 WHERE comment_id = 'c1'`).run();
    store.upsertComments("R", [{ comment_id: "c1", username: "a", text: "does this work?", likes: 4 }]);
    expect(store.listComments("R").find((r) => r.comment_id === "c1")!.is_trigger).toBe(1);

    // A comment with no id can't be deduped → dropped (never written).
    expect(store.upsertComments("R", [{ comment_id: "", text: "ghost" }])).toBe(0);

    // limit caps the read.
    expect(store.listComments("R", { limit: 1 })).toHaveLength(1);

    store.close();
  });

  it("trigger_keyword round-trips on the analysis write (slice 968)", () => {
    const store = openStore(":memory:");
    store.upsertCreator({ username: "c" });
    store.upsertReel({ shortcode: "R", url: "u", creator_username: "c" });
    // Fresh DB: the column exists from the DDL.
    const cols = store.db.prepare(`PRAGMA table_info(reels)`).all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("trigger_keyword");

    expect(store.getReel("R")!.trigger_keyword).toBeNull();
    store.updateReelAnalysis({ shortcode: "R", trigger_keyword: "ritual" });
    expect(store.getReel("R")!.trigger_keyword).toBe("ritual");
    // A later write can clear it back to null.
    store.updateReelAnalysis({ shortcode: "R", trigger_keyword: null });
    expect(store.getReel("R")!.trigger_keyword).toBeNull();
    store.close();
  });

  it("flagTriggerComments exact-matches the keyword and is recomputable (UPDATE, not delete)", () => {
    const store = openStore(":memory:");
    store.upsertCreator({ username: "c" });
    store.upsertReel({ shortcode: "R", url: "u", creator_username: "c" });

    // Comments arrive FIRST (the refresh-before-analyze case): the keyword is not yet known.
    store.upsertComments("R", [
      { comment_id: "k1", username: "a", text: "RITUAL", likes: 0 },
      { comment_id: "k2", username: "b", text: "ritual please", likes: 0 }, // short + token
      { comment_id: "k3", username: "c", text: "does this work on the free plan?", likes: 9 },
      { comment_id: "k4", username: "d", text: "this ritual changed my whole morning routine", likes: 3 },
    ]);
    // All default to 0 (no keyword applied yet).
    expect(store.listComments("R").every((r) => r.is_trigger === 0)).toBe(true);

    // Keyword arrives later → recompute. Exact arm + short-token arm both flag; a long
    // comment that merely mentions the word and a real question are NOT flagged.
    const flagged = store.flagTriggerComments("R", "Ritual!"); // normalized → "ritual"
    expect(flagged).toBe(2);
    const byId = (id: string) => store.listComments("R").find((r) => r.comment_id === id)!;
    expect(byId("k1").is_trigger).toBe(1);
    expect(byId("k2").is_trigger).toBe(1);
    expect(byId("k3").is_trigger).toBe(0);
    expect(byId("k4").is_trigger).toBe(0);
    // No rows were deleted — the corpus is intact (4 rows).
    expect(store.listComments("R")).toHaveLength(4);

    // Recompute with a DIFFERENT keyword: prior flags clear, new ones set (non-destructive).
    expect(store.flagTriggerComments("R", "loop")).toBe(0);
    expect(store.listComments("R").every((r) => r.is_trigger === 0)).toBe(true);
    expect(store.listComments("R")).toHaveLength(4);

    // A null keyword un-flags everything and returns 0.
    store.flagTriggerComments("R", "ritual");
    expect(store.listComments("R").filter((r) => r.is_trigger === 1)).toHaveLength(2);
    expect(store.flagTriggerComments("R", null)).toBe(0);
    expect(store.listComments("R").every((r) => r.is_trigger === 0)).toBe(true);

    store.close();
  });

  it("faqs: replaceFaqs computes counts from REAL links, ranks by strength, wholesale-replaces (slice 969)", () => {
    const store = openStore(":memory:");
    store.upsertCreator({ username: "c" });
    store.upsertReel({ shortcode: "R", url: "u", creator_username: "c" });

    // The faqs + faq_comments tables + their indexes exist (mirror docs/schema.md).
    const tables = store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all()
      .map((r: any) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["faqs", "faq_comments"]));
    const indexes = store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index'`)
      .all()
      .map((r: any) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(["idx_faqs_shortcode", "idx_faq_comments_faq_id"]));

    // Seed the comment corpus the FAQ links point at.
    store.upsertComments("R", [
      { comment_id: "c1", username: "a", text: "is it free?", likes: 10 },
      { comment_id: "c2", username: "b", text: "free plan?", likes: 5 },
      { comment_id: "c3", username: "d", text: "how do I start?", likes: null }, // NULL likes count 0
    ]);

    const n = store.replaceFaqs("R", [
      { question: "Is it free?", comment_ids: ["c1", "c2"] }, // 2 links, 15 likes
      { question: "How do I start?", comment_ids: ["c3"] }, // 1 link, 0 likes (NULL)
      { question: "Empty", comment_ids: [] }, // dropped — no links
    ]);
    expect(n).toBe(2); // the empty cluster was skipped

    const faqs = store.listFaqs("R");
    // Ranked by strength DESC: "Is it free?" (2 + ln16) outranks "How do I start?" (1 + ln1).
    expect(faqs.map((f) => f.question)).toEqual(["Is it free?", "How do I start?"]);
    const free = faqs[0];
    expect(free.support_count).toBe(2);
    expect(free.support_likes).toBe(15);
    expect(free.strength_score).toBeCloseTo(2 + Math.log1p(15), 10);
    // Example Comments live-queried from the join, likes DESC.
    expect(free.examples.map((c) => c.comment_id)).toEqual(["c1", "c2"]);
    // NULL-likes comment contributes 0 to support_likes.
    expect(faqs[1].support_likes).toBe(0);

    // listFaqExampleComments matches the join (no duplicated text on the FAQ row).
    expect(store.listFaqExampleComments(free.id).map((c) => c.text)).toEqual(["is it free?", "free plan?"]);

    // A SECOND replaceFaqs wholesale-replaces (delete + reinsert), never appends.
    store.replaceFaqs("R", [{ question: "Only one now", comment_ids: ["c3"] }]);
    expect(store.listFaqs("R").map((f) => f.question)).toEqual(["Only one now"]);
    // The old faq_comments rows were cleaned up (no orphans).
    const linkCount = store.db.prepare(`SELECT COUNT(*) AS n FROM faq_comments`).get() as { n: number };
    expect(linkCount.n).toBe(1);
    // The comments corpus is NEVER mutated by a FAQ run.
    expect(store.listComments("R").map((c) => c.comment_id).sort()).toEqual(["c1", "c2", "c3"]);

    store.close();
  });

  it("updateReelFaqProvenance stamps ONLY the FAQ columns, never the immutable analysis (slice 969)", () => {
    const store = openStore(":memory:");
    store.upsertCreator({ username: "c" });
    store.upsertReel({ shortcode: "R", url: "u", creator_username: "c" });
    // Fresh DB: the FAQ provenance columns exist from the DDL.
    const cols = (store.db.prepare(`PRAGMA table_info(reels)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["faq_prompt_hash", "faqs_generated_at"]));

    // Pre-seed an immutable analysis.
    store.updateReelAnalysis({
      shortcode: "R",
      analysis_status: "analyzed",
      topic: "topic",
      analysis_prompt_hash: "an12345",
    });
    store.updateReelFaqProvenance({
      shortcode: "R",
      faq_prompt_hash: "faq98765",
      faqs_generated_at: "2026-06-22T00:00:00.000Z",
    });
    const reel = store.getReel("R")!;
    expect(reel.faq_prompt_hash).toBe("faq98765");
    expect(reel.faqs_generated_at).toBe("2026-06-22T00:00:00.000Z");
    // The analysis columns were untouched by the FAQ-provenance write.
    expect(reel.analysis_status).toBe("analyzed");
    expect(reel.topic).toBe("topic");
    expect(reel.analysis_prompt_hash).toBe("an12345");

    store.close();
  });

  it("setFavorite sets/clears is_favorite (+ favorited_at) and favoritesOnly filters (slice 965)", () => {
    const store = openStore(":memory:");
    store.upsertCreator({ username: "c" });
    store.upsertReel({ shortcode: "R", url: "u", creator_username: "c" });
    store.upsertReel({ shortcode: "S", url: "u2", creator_username: "c" });

    // Fresh DB: the user-state columns exist from the DDL and default to not-favorited.
    const cols = (store.db.prepare(`PRAGMA table_info(reels)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["is_favorite", "favorited_at"]));
    expect(store.getReel("R")!.is_favorite).toBe(0);
    expect(store.getReel("R")!.favorited_at).toBeNull();

    // Favorite R: flag set to 1, favorited_at stamped, and the updated row returned.
    const fav = store.setFavorite("R", true);
    expect(fav!.is_favorite).toBe(1);
    expect(fav!.favorited_at).toBeTruthy();
    // Reflected in a fresh read (it persisted to the Store, not just the return value).
    expect(store.getReel("R")!.is_favorite).toBe(1);

    // favoritesOnly restricts the list to favorited Reels only.
    const favored = store.listReels({ creator: "c", favoritesOnly: true });
    expect(favored.map((r) => r.shortcode)).toEqual(["R"]);
    // Without the filter, both Reels are returned.
    expect(store.listReels({ creator: "c" }).map((r) => r.shortcode).sort()).toEqual(["R", "S"]);

    // Unfavorite R: flag cleared back to 0 and favorited_at cleared to NULL.
    const unfav = store.setFavorite("R", false);
    expect(unfav!.is_favorite).toBe(0);
    expect(unfav!.favorited_at).toBeNull();
    expect(store.listReels({ creator: "c", favoritesOnly: true })).toHaveLength(0);

    // Setting on a missing Reel returns undefined (the route maps that to a 404).
    expect(store.setFavorite("NOPE", true)).toBeUndefined();

    store.close();
  });

  it("setArchived hides by default, composes with favoritesOnly, and archive wins over favorite (slice 967)", () => {
    const store = openStore(":memory:");
    store.upsertCreator({ username: "c" });
    // R: plain. S: favorited. T: archived. U: archived AND favorited (archive must win).
    store.upsertReel({ shortcode: "R", url: "u1", creator_username: "c" });
    store.upsertReel({ shortcode: "S", url: "u2", creator_username: "c" });
    store.upsertReel({ shortcode: "T", url: "u3", creator_username: "c" });
    store.upsertReel({ shortcode: "U", url: "u4", creator_username: "c" });

    // Fresh DB: the archive columns exist from the DDL and default to not-archived.
    const cols = (store.db.prepare(`PRAGMA table_info(reels)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["is_archived", "archived_at"]));
    expect(store.getReel("R")!.is_archived).toBe(0);
    expect(store.getReel("R")!.archived_at).toBeNull();

    store.setFavorite("S", true);
    store.setFavorite("U", true);

    // Archive T and U: flag set to 1, archived_at stamped, updated row returned.
    const arch = store.setArchived("T", true);
    expect(arch!.is_archived).toBe(1);
    expect(arch!.archived_at).toBeTruthy();
    // The favorited Reel U can ALSO be archived (independent flags).
    const archU = store.setArchived("U", true);
    expect(archU!.is_archived).toBe(1);
    expect(archU!.is_favorite).toBe(1);
    // Persisted to the Store, not just the return value.
    expect(store.getReel("T")!.is_archived).toBe(1);

    // DEFAULT (no includeArchived): archived T + U are HIDDEN; only R + S remain.
    expect(store.listReels({ creator: "c" }).map((r) => r.shortcode).sort()).toEqual(["R", "S"]);

    // favoritesOnly composes WITHIN the visible (non-archived) scope: archived favorite
    // U stays hidden (ARCHIVE WINS OVER FAVORITE) — only the non-archived favorite S passes.
    expect(store.listReels({ creator: "c", favoritesOnly: true }).map((r) => r.shortcode)).toEqual(["S"]);

    // includeArchived: true brings archived Reels back into view (all four).
    expect(store.listReels({ creator: "c", includeArchived: true }).map((r) => r.shortcode).sort()).toEqual([
      "R",
      "S",
      "T",
      "U",
    ]);

    // includeArchived + favoritesOnly composes across the WHOLE set: both favorites
    // (S non-archived, U archived) now pass.
    expect(
      store.listReels({ creator: "c", includeArchived: true, favoritesOnly: true }).map((r) => r.shortcode).sort(),
    ).toEqual(["S", "U"]);

    // Unarchive U: flag cleared back to 0 and archived_at cleared to NULL; it returns to
    // the default view (and, being a favorite, to favoritesOnly too).
    const unarch = store.setArchived("U", false);
    expect(unarch!.is_archived).toBe(0);
    expect(unarch!.archived_at).toBeNull();
    expect(store.listReels({ creator: "c" }).map((r) => r.shortcode).sort()).toEqual(["R", "S", "U"]);
    expect(store.listReels({ creator: "c", favoritesOnly: true }).map((r) => r.shortcode).sort()).toEqual(["S", "U"]);

    // Setting on a missing Reel returns undefined (the route maps that to a 404).
    expect(store.setArchived("NOPE", true)).toBeUndefined();

    store.close();
  });

  it("listReels sorts category ascending (alphabetical, NULLs last)", () => {
    // The dashboard's Category sort drives direction='asc' so categories read
    // naturally (alphabetical), NOT reverse-alphabetically. NULL categories still
    // sort last regardless of direction.
    const store = openStore(":memory:");
    store.upsertCreator({ username: "c" });
    store.upsertReel({ shortcode: "tool", url: "u1", creator_username: "c" });
    store.upsertReel({ shortcode: "promo", url: "u2", creator_username: "c" });
    store.upsertReel({ shortcode: "story", url: "u3", creator_username: "c" });
    store.upsertReel({ shortcode: "none", url: "u4", creator_username: "c" });
    store.updateReelAnalysis({ shortcode: "tool", category: "tool_demo" });
    store.updateReelAnalysis({ shortcode: "promo", category: "promo_offer" });
    store.updateReelAnalysis({ shortcode: "story", category: "story_personal" });
    // "none" left with a NULL category.

    const asc = store.listReels({ creator: "c", orderBy: "category", direction: "asc" });
    expect(asc.map((r) => r.category)).toEqual([
      "promo_offer",
      "story_personal",
      "tool_demo",
      null, // NULL sorts last even ascending
    ]);

    // DESC reverses the non-null order but still keeps NULLs last.
    const desc = store.listReels({ creator: "c", orderBy: "category", direction: "desc" });
    expect(desc.map((r) => r.category)).toEqual([
      "tool_demo",
      "story_personal",
      "promo_offer",
      null,
    ]);
    store.close();
  });
});

describe("drafts — upsertDraft / getDraft (MAIN-971)", () => {
  function seed(store: ReturnType<typeof openStore>): void {
    store.upsertCreator({ username: "c" });
    store.upsertReel({ shortcode: "AAA", url: "u", creator_username: "c" });
  }

  it("creates the drafts table and round-trips a Draft (decoded JSON columns)", () => {
    const store = openStore(":memory:");
    const tables = store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain("drafts");

    seed(store);
    expect(store.getDraft("AAA")).toBeUndefined();

    const draft = store.upsertDraft({
      shortcode: "AAA",
      hooks: [
        { text: "A", suggested: false },
        { text: "B", suggested: true },
        { text: "C", suggested: false },
      ],
      beat_scripts: [{ label: "HOOK", script: "open" }],
      reasoning: "because FAQs",
      caption: "my caption",
    });
    // Returned + read-back Draft decode the JSON columns to objects.
    expect(draft.hooks.find((h) => h.suggested)!.text).toBe("B");
    expect(draft.beat_scripts).toEqual([{ label: "HOOK", script: "open" }]);
    const read = store.getDraft("AAA")!;
    expect(read.caption).toBe("my caption");
    expect(read.hooks).toHaveLength(3);
    expect(read.generated_at).toBe(read.updated_at); // first generation

    store.close();
  });

  it("a second upsert is a destructive full-replace; generated_at is preserved, updated_at bumped; one row only", () => {
    const store = openStore(":memory:");
    seed(store);
    const first = store.upsertDraft({
      shortcode: "AAA",
      hooks: [{ text: "first", suggested: true }],
      beat_scripts: [],
      reasoning: "first reasoning",
      caption: "FIRST",
    });
    const second = store.upsertDraft({
      shortcode: "AAA",
      hooks: [{ text: "second", suggested: true }],
      beat_scripts: [{ label: "CTA", script: "follow" }],
      reasoning: "second reasoning",
      caption: "SECOND",
    });

    expect(second.caption).toBe("SECOND");
    expect(second.beat_scripts).toEqual([{ label: "CTA", script: "follow" }]);
    expect(second.generated_at).toBe(first.generated_at); // preserved (first generation)
    expect(second.updated_at >= first.updated_at).toBe(true); // bumped
    const n = store.db.prepare(`SELECT COUNT(*) AS n FROM drafts`).get() as { n: number };
    expect(n.n).toBe(1); // one Draft per Reel, no history

    store.close();
  });
});

describe("drafts — saveDraft (hand-edit, MAIN-972)", () => {
  function seed(store: ReturnType<typeof openStore>): void {
    store.upsertCreator({ username: "c" });
    store.upsertReel({ shortcode: "AAA", url: "u", creator_username: "c" });
  }

  it("persists edited fields onto an existing Draft and reads them back; one row, no history", () => {
    const store = openStore(":memory:");
    seed(store);
    const generated = store.upsertDraft({
      shortcode: "AAA",
      hooks: [
        { text: "A", suggested: true },
        { text: "B", suggested: false },
        { text: "C", suggested: false },
      ],
      beat_scripts: [{ label: "HOOK", script: "open" }],
      reasoning: "seeded reasoning",
      caption: "seeded caption",
    });

    const saved = store.saveDraft({
      shortcode: "AAA",
      hooks: [
        { text: "edited hook A", suggested: false },
        { text: "edited hook B", suggested: true },
        { text: "edited hook C", suggested: false },
      ],
      beat_scripts: [{ label: "HOOK", script: "my edited open" }],
      reasoning: "my edited reasoning",
      caption: "my edited caption",
    })!;

    // Every edited field round-trips through a fresh Store read.
    expect(saved.hooks.find((h) => h.suggested)!.text).toBe("edited hook B");
    expect(saved.beat_scripts).toEqual([{ label: "HOOK", script: "my edited open" }]);
    expect(saved.reasoning).toBe("my edited reasoning");
    expect(saved.caption).toBe("my edited caption");
    const read = store.getDraft("AAA")!;
    expect(read.caption).toBe("my edited caption");
    expect(read.hooks.find((h) => h.suggested)!.text).toBe("edited hook B");
    // updated_at bumped, generated_at preserved (an edit is not a regeneration).
    expect(read.generated_at).toBe(generated.generated_at);
    expect(read.updated_at >= generated.updated_at).toBe(true);
    const n = store.db.prepare(`SELECT COUNT(*) AS n FROM drafts`).get() as { n: number };
    expect(n.n).toBe(1); // still one Draft per Reel, no history

    store.close();
  });

  it("returns undefined and writes nothing when no Draft exists (UPDATE-only, never inserts)", () => {
    const store = openStore(":memory:");
    seed(store);
    const result = store.saveDraft({
      shortcode: "AAA",
      hooks: [{ text: "x", suggested: true }],
      beat_scripts: [],
      reasoning: "r",
      caption: "c",
    });
    expect(result).toBeUndefined();
    const n = store.db.prepare(`SELECT COUNT(*) AS n FROM drafts`).get() as { n: number };
    expect(n.n).toBe(0); // a save never creates a Draft — there's nothing to edit
    store.close();
  });
});
