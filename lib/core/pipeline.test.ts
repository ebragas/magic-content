// Pipeline-seam harness — drives pipeline()/scrape()/analyze()/refresh() against a
// REAL in-memory Content Store with externals faked (Slice 1: no externals → the
// stub no-op path). Asserts on resulting STORE STATE, never internals, and makes
// NO live Apify/Gemini calls (HARD INVARIANT #2). Later slices inject fake ports
// here and assert richer state.

import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { openStore } from "./store.js";
import { pipeline } from "./pipeline.js";

const config = loadConfig();

describe("pipeline seam (walking skeleton)", () => {
  it("scrape runs against a real store without error and ensures the creator row", async () => {
    const store = openStore(":memory:");
    const result = await pipeline({
      action: "scrape",
      creator: "itsmariahbrunner",
      store,
      config,
    });
    expect(result.action).toBe("scrape");
    expect(result.creator).toBe("itsmariahbrunner");
    expect(result.scrape).toBeDefined();
    // No external port → no-op stub, but the creator row is written.
    expect(store.getCreator("itsmariahbrunner")).toBeDefined();
    store.close();
  });

  it("full dispatches scrape -> analyze -> refresh and writes the store", async () => {
    const store = openStore(":memory:");
    const result = await pipeline({
      action: "full",
      creator: "itsmariahbrunner",
      store,
      config,
    });
    expect(result.scrape).toBeDefined();
    expect(result.analyze).toBeDefined();
    expect(result.refresh).toBeDefined();
    expect(store.getCreator("itsmariahbrunner")).toBeDefined();
    store.close();
  });

  it("defaults creator from config when none passed", async () => {
    const store = openStore(":memory:");
    const result = await pipeline({ action: "scrape", store, config });
    expect(result.creator).toBe(config.creators.creators[0].username.toLowerCase());
    store.close();
  });

  it("invokes the onProgress hook", async () => {
    const store = openStore(":memory:");
    const stages: string[] = [];
    await pipeline({
      action: "full",
      creator: "itsmariahbrunner",
      store,
      config,
      onProgress: (stage) => stages.push(stage),
    });
    expect(stages).toEqual(expect.arrayContaining(["scrape", "analyze", "refresh"]));
    store.close();
  });
});
