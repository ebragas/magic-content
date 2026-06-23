// Pipeline-seam harness for the reusable Comment-corpus leg (MAIN-966).
//
// HARD INVARIANT #2: drives the REAL scrapeAndStoreComments helper + a REAL in-memory
// Content Store with ONLY the Apify port faked, asserting on resulting STORE STATE.
// No live network. This is the direct accumulation test the spec calls for (a small
// testable core function), separate from the analyze-leg integration in analyze.test.ts.

import { describe, expect, it } from "vitest";
import { openStore } from "./store.js";
import { scrapeAndStoreComments } from "./comments.js";
import type { ApifyPort, ScrapedComment, Store } from "./types.js";

function seedReel(store: Store): void {
  store.upsertCreator({ username: "c" });
  store.upsertReel({ shortcode: "R", url: "https://www.instagram.com/reel/R/", creator_username: "c" });
}

/** Fake Apify whose scrapeComments returns a programmed batch and records its args. */
function fakeApify(batch: ScrapedComment[]): { port: ApifyPort; calls: { shortcode: string; url: string; limit: number }[] } {
  const calls: { shortcode: string; url: string; limit: number }[] = [];
  const port: ApifyPort = {
    async scrapeCreator() {
      return { profile: { username: "c" }, reels: [] };
    },
    async scrapeComments(args) {
      calls.push(args);
      return batch;
    },
  };
  return { port, calls };
}

describe("scrapeAndStoreComments → Content Store (faked Apify)", () => {
  it("scrapes and upserts a Reel's Comments, passing the per-Reel limit through", async () => {
    const store = openStore(":memory:");
    seedReel(store);
    const { port, calls } = fakeApify([
      { comment_id: "c1", username: "a", text: "q?", likes: 3 },
      { comment_id: "c2", username: "b", text: "nice", likes: 7 },
    ]);

    const result = await scrapeAndStoreComments({
      shortcode: "R",
      url: "https://www.instagram.com/reel/R/",
      limit: 150,
      store,
      apify: port,
    });

    expect(result).toEqual({ scraped: 2, upserted: 2 });
    expect(calls).toEqual([{ shortcode: "R", url: "https://www.instagram.com/reel/R/", limit: 150 }]);
    expect(store.listComments("R").map((r) => r.comment_id).sort()).toEqual(["c1", "c2"]);

    store.close();
  });

  it("accumulates the union across overlapping pulls: [c1,c2] then [c2,c3] → {c1,c2,c3}", async () => {
    const store = openStore(":memory:");
    seedReel(store);

    await scrapeAndStoreComments({
      shortcode: "R",
      url: "https://www.instagram.com/reel/R/",
      limit: 150,
      store,
      apify: fakeApify([
        { comment_id: "c1", text: "one", likes: 1 },
        { comment_id: "c2", text: "two", likes: 2 },
      ]).port,
    });
    await scrapeAndStoreComments({
      shortcode: "R",
      url: "https://www.instagram.com/reel/R/",
      limit: 150,
      store,
      apify: fakeApify([
        { comment_id: "c2", text: "two-updated", likes: 9 },
        { comment_id: "c3", text: "three", likes: 3 },
      ]).port,
    });

    const rows = store.listComments("R");
    expect(rows.map((r) => r.comment_id).sort()).toEqual(["c1", "c2", "c3"]);
    expect(rows.find((r) => r.comment_id === "c2")!.likes).toBe(9);

    store.close();
  });

  it("is a safe no-op when the Apify port lacks scrapeComments", async () => {
    const store = openStore(":memory:");
    seedReel(store);
    const apify: ApifyPort = {
      async scrapeCreator() {
        return { profile: { username: "c" }, reels: [] };
      },
    };
    const result = await scrapeAndStoreComments({
      shortcode: "R",
      url: "https://www.instagram.com/reel/R/",
      limit: 150,
      store,
      apify,
    });
    expect(result).toEqual({ scraped: 0, upserted: 0 });
    expect(store.listComments("R")).toEqual([]);
    store.close();
  });

  it("is a safe no-op when no Apify port is available", async () => {
    const store = openStore(":memory:");
    seedReel(store);
    const result = await scrapeAndStoreComments({
      shortcode: "R",
      url: "https://www.instagram.com/reel/R/",
      limit: 150,
      store,
      apify: undefined,
    });
    expect(result).toEqual({ scraped: 0, upserted: 0 });
    expect(store.listComments("R")).toEqual([]);
    store.close();
  });

  it("swallows a scrape error (best-effort) without throwing", async () => {
    const store = openStore(":memory:");
    seedReel(store);
    const apify: ApifyPort = {
      async scrapeCreator() {
        return { profile: { username: "c" }, reels: [] };
      },
      async scrapeComments() {
        throw new Error("apify boom");
      },
    };
    const result = await scrapeAndStoreComments({
      shortcode: "R",
      url: "https://www.instagram.com/reel/R/",
      limit: 150,
      store,
      apify,
    });
    expect(result).toEqual({ scraped: 0, upserted: 0 });
    expect(store.listComments("R")).toEqual([]);
    store.close();
  });
});
