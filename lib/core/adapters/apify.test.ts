// Unit tests for the pure Apify dataset → domain mappers (no network, HARD
// INVARIANT #2). The makeApifyPort network wrapper is exercised only via the
// pipeline-seam tests with a faked ApifyPort; here we lock the field mapping from
// apify/instagram-scraper's actual item shapes so a live scrape lands correctly.

import { describe, expect, it } from "vitest";
import { mapProfile, mapReel, mapReels, mapScrapedComment, mapScrapedComments } from "./apify.js";

describe("mapProfile (apify `details` item)", () => {
  it("maps identity + follower/following/posts counts", () => {
    const profile = mapProfile(
      {
        username: "itsmariahbrunner",
        fullName: "Mariah Brunner",
        biography: "AI content",
        verified: true,
        followersCount: 120_000,
        followsCount: 480,
        postsCount: 312,
      },
      "fallback",
    );
    expect(profile).toEqual({
      username: "itsmariahbrunner",
      full_name: "Mariah Brunner",
      biography: "AI content",
      is_verified: true,
      followers: 120_000,
      following: 480,
      posts_count: 312,
    });
  });

  it("falls back to a minimal profile when the details item is missing", () => {
    expect(mapProfile(undefined, "itsmariahbrunner")).toEqual({
      username: "itsmariahbrunner",
    });
  });

  it("nulls missing/ill-typed fields rather than fabricating them", () => {
    const profile = mapProfile({ username: "c", followersCount: "lots" }, "c");
    expect(profile.followers).toBeNull();
    expect(profile.full_name).toBeNull();
    expect(profile.is_verified).toBeNull();
  });
});

describe("mapReel (apify `posts` item)", () => {
  it("maps a Reel item to the canonical ScrapedReel shape", () => {
    const reel = mapReel({
      shortCode: "ABC123",
      type: "Video",
      productType: "clips",
      caption: "how I triage email with Claude",
      timestamp: "2026-05-01T12:00:00.000Z",
      videoDuration: 31.5,
      likesCount: 5400,
      commentsCount: 88,
      videoPlayCount: 210_000,
      videoUrl: "https://cdn.example/abc.mp4",
      displayUrl: "https://cdn.example/abc.jpg",
      latestComments: [
        { ownerUsername: "fan1", text: "so helpful", likesCount: 12 },
        { owner: { username: "fan2" }, text: "saving this", likesCount: 3 },
        { ownerUsername: "ghost", text: "", likesCount: 0 }, // dropped (no text)
      ],
    });
    expect(reel).toEqual({
      shortcode: "ABC123",
      url: "https://www.instagram.com/reel/ABC123/",
      caption: "how I triage email with Claude",
      posted_at: "2026-05-01T12:00:00.000Z",
      duration_sec: 31.5,
      likes: 5400,
      comments_count: 88,
      views: 210_000,
      shares: null,
      thumbnail_url: "https://cdn.example/abc.jpg",
      video_url: "https://cdn.example/abc.mp4",
      top_comments: [
        { username: "fan1", text: "so helpful", likes: 12 },
        { username: "fan2", text: "saving this", likes: 3 },
      ],
    });
  });

  it("passes the hidden-likes sentinel (-1) through untouched (core normalizes it)", () => {
    const reel = mapReel({ shortCode: "HID", videoUrl: "u", likesCount: -1 });
    expect(reel!.likes).toBe(-1); // NOT normalized here — scrape.ts does that
  });

  it("falls back from videoPlayCount to videoViewCount for views", () => {
    const reel = mapReel({ shortCode: "V", videoUrl: "u", videoViewCount: 9000 });
    expect(reel!.views).toBe(9000);
  });

  it("returns null when there is no shortcode", () => {
    expect(mapReel({ videoUrl: "u" })).toBeNull();
  });
});

describe("mapReels (apify `posts` dataset)", () => {
  it("keeps only Reels (video posts), dedupes, and drops non-video items", () => {
    const reels = mapReels([
      { shortCode: "VID1", type: "Video", videoUrl: "a" },
      { shortCode: "IMG1", type: "Image" }, // dropped — not a video
      { shortCode: "CLIP", productType: "clips", videoUrl: "b" },
      { shortCode: "VID1", type: "Video", videoUrl: "a-dup" }, // deduped
      { type: "Video", videoUrl: "c" }, // dropped — no shortcode
    ]);
    expect(reels.map((r) => r.shortcode)).toEqual(["VID1", "CLIP"]);
  });
});

describe("mapScrapedComment (apify `comments` item)", () => {
  it("maps id/username/text/likes/posted_at to the corpus shape", () => {
    expect(
      mapScrapedComment({
        id: "17900000000000000",
        ownerUsername: "fan1",
        text: "does this work on the free plan?",
        likesCount: 12,
        timestamp: "2026-06-01T00:00:00.000Z",
      }),
    ).toEqual({
      comment_id: "17900000000000000",
      username: "fan1",
      text: "does this work on the free plan?",
      likes: 12,
      posted_at: "2026-06-01T00:00:00.000Z",
    });
  });

  it("maps the native id robustly from id/pk/commentId, coercing a numeric pk to string", () => {
    expect(mapScrapedComment({ pk: 42, text: "hi" })!.comment_id).toBe("42");
    expect(mapScrapedComment({ commentId: "abc", text: "hi" })!.comment_id).toBe("abc");
    // owner.username fallback when ownerUsername is absent.
    expect(mapScrapedComment({ id: "x", owner: { username: "nested" }, text: "hi" })!.username).toBe("nested");
  });

  it("returns null when no comment id is present (can't be deduped)", () => {
    expect(mapScrapedComment({ text: "no id here" })).toBeNull();
  });
});

describe("mapScrapedComments (apify `comments` dataset)", () => {
  it("drops un-id'd items and dedupes by comment_id", () => {
    const comments = mapScrapedComments([
      { id: "c1", text: "one" },
      { text: "no id" }, // dropped
      { pk: 2, text: "two" },
      { id: "c1", text: "one-dup" }, // deduped
    ]);
    expect(comments.map((c) => c.comment_id)).toEqual(["c1", "2"]);
  });
});
