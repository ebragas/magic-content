// Draft-generation route harness (MAIN-971) — exercises the POST handler directly. Mirrors
// app/api/reels/[shortcode]/route.test.ts: no network, no SDKs. The Store and the lib/core
// generateDraft() are mocked so the route never opens data/content.db and never calls Claude; the
// assertions are purely on status codes + payload shape (a thin entry point's contract, ADR-0002)
// and that the route delegates to the shared core. The route reuses the READ-WRITE seam — NO
// registry lock, NO 409.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Draft } from "../../../../../lib/core/types.js";

// Mock the Store + generateDraft BEFORE importing the route so it binds the stubs. generateDraft
// records its calls and returns a shaped result keyed by shortcode: "MISSING" → found:false (404),
// "NOPORT" → found:true/ran:false (503), else a generated Draft. openStore returns a thin fake whose
// close() is a no-op.
const { openStoreMock, generateDraftMock, saveDraftMock } = vi.hoisted(() => {
  const generateDraft = vi.fn(async ({ shortcode }: { shortcode: string }) => {
    if (shortcode === "MISSING") return { found: false as const };
    if (shortcode === "NOPORT") return { found: true as const, ran: false as const, draft: undefined };
    const draft: Draft = {
      shortcode,
      hooks: [
        { text: "Hook A", suggested: false },
        { text: "Hook B", suggested: true },
        { text: "Hook C", suggested: false },
      ],
      beat_scripts: [{ label: "HOOK", script: "open" }],
      reasoning: "Baked in the top FAQ.",
      caption: "generated caption",
      generated_at: "2026-06-22T00:00:00.000Z",
      updated_at: "2026-06-22T00:00:00.000Z",
    };
    return { found: true as const, ran: true as const, draft };
  });
  // saveDraft (PUT, MAIN-972) is SYNCHRONOUS (no model). "MISSING" → found:false (404 — no Draft to
  // edit); else it echoes the edited fields back as the persisted Draft (generated_at preserved).
  const saveDraft = vi.fn(
    ({
      shortcode,
      edits,
    }: {
      shortcode: string;
      edits: {
        hooks: { text: string; suggested: boolean }[];
        beat_scripts: { label: string; script: string }[];
        reasoning: string;
        caption: string;
      };
    }) => {
      if (shortcode === "MISSING") return { found: false as const };
      const draft: Draft = {
        shortcode,
        hooks: edits.hooks as Draft["hooks"],
        beat_scripts: edits.beat_scripts as Draft["beat_scripts"],
        reasoning: edits.reasoning,
        caption: edits.caption,
        generated_at: "2026-06-22T00:00:00.000Z",
        updated_at: "2026-06-22T09:00:00.000Z",
      };
      return { found: true as const, draft };
    },
  );
  return {
    generateDraftMock: generateDraft,
    saveDraftMock: saveDraft,
    openStoreMock: vi.fn(() => ({ close: vi.fn() })),
  };
});
vi.mock("../../../../../lib/core/store.js", () => ({ openStore: openStoreMock }));
vi.mock("../../../../../lib/core/draft.js", () => ({
  generateDraft: generateDraftMock,
  saveDraft: saveDraftMock,
}));

import { POST, PUT } from "./route.js";

function post(shortcode: string): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/reels/${shortcode}/draft`, { method: "POST" }),
    { params: Promise.resolve({ shortcode }) },
  );
}

function put(shortcode: string, body: unknown): Promise<Response> {
  return PUT(
    new Request(`http://localhost/api/reels/${shortcode}/draft`, {
      method: "PUT",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ shortcode }) },
  );
}

const VALID_EDITS = {
  hooks: [
    { text: "edited A", suggested: false },
    { text: "edited B", suggested: true },
    { text: "edited C", suggested: false },
  ],
  beat_scripts: [{ label: "HOOK", script: "my open" }],
  reasoning: "my reasoning",
  caption: "my caption",
};

afterEach(() => {
  generateDraftMock.mockClear();
  saveDraftMock.mockClear();
  openStoreMock.mockClear();
});

describe("POST /api/reels/{shortcode}/draft", () => {
  it("generates a Draft and returns it (200) with the expected payload shape", async () => {
    const res = await post("ABC123");
    expect(res.status).toBe(200);
    expect(generateDraftMock).toHaveBeenCalledWith(expect.objectContaining({ shortcode: "ABC123" }));
    expect(await res.json()).toEqual({
      shortcode: "ABC123",
      hooks: [
        { text: "Hook A", suggested: false },
        { text: "Hook B", suggested: true },
        { text: "Hook C", suggested: false },
      ],
      beat_scripts: [{ label: "HOOK", script: "open" }],
      reasoning: "Baked in the top FAQ.",
      caption: "generated caption",
      generated_at: "2026-06-22T00:00:00.000Z",
      updated_at: "2026-06-22T00:00:00.000Z",
    });
  });

  it("404s when the Reel doesn't exist", async () => {
    const res = await post("MISSING");
    expect(res.status).toBe(404);
  });

  it("503s when draft generation is unavailable (no Anthropic port / key)", async () => {
    const res = await post("NOPORT");
    expect(res.status).toBe(503);
  });

  it("400s an unsafe shortcode before touching the Store / core", async () => {
    const res = await post("../etc/passwd");
    expect(res.status).toBe(400);
    expect(openStoreMock).not.toHaveBeenCalled();
    expect(generateDraftMock).not.toHaveBeenCalled();
  });
});

describe("PUT /api/reels/{shortcode}/draft (hand-edit save, MAIN-972)", () => {
  it("saves edited fields and returns the persisted Draft (200), delegating to lib/core saveDraft", async () => {
    const res = await put("ABC123", VALID_EDITS);
    expect(res.status).toBe(200);
    expect(saveDraftMock).toHaveBeenCalledWith(
      expect.objectContaining({ shortcode: "ABC123", edits: expect.objectContaining({ caption: "my caption" }) }),
    );
    expect(generateDraftMock).not.toHaveBeenCalled(); // a save never calls the model leg
    expect(await res.json()).toEqual({
      shortcode: "ABC123",
      hooks: [
        { text: "edited A", suggested: false },
        { text: "edited B", suggested: true },
        { text: "edited C", suggested: false },
      ],
      beat_scripts: [{ label: "HOOK", script: "my open" }],
      reasoning: "my reasoning",
      caption: "my caption",
      generated_at: "2026-06-22T00:00:00.000Z",
      updated_at: "2026-06-22T09:00:00.000Z",
    });
  });

  it("404s when no Draft exists to edit", async () => {
    const res = await put("MISSING", VALID_EDITS);
    expect(res.status).toBe(404);
  });

  it("400s a body missing required fields before touching the Store / core", async () => {
    const res = await put("ABC123", { hooks: [], reasoning: "x" }); // no beat_scripts / caption
    expect(res.status).toBe(400);
    expect(openStoreMock).not.toHaveBeenCalled();
    expect(saveDraftMock).not.toHaveBeenCalled();
  });

  it("400s invalid JSON", async () => {
    const res = await put("ABC123", "{not json");
    expect(res.status).toBe(400);
    expect(saveDraftMock).not.toHaveBeenCalled();
  });

  it("400s an unsafe shortcode before touching the Store / core", async () => {
    const res = await put("../etc/passwd", VALID_EDITS);
    expect(res.status).toBe(400);
    expect(openStoreMock).not.toHaveBeenCalled();
    expect(saveDraftMock).not.toHaveBeenCalled();
  });
});
