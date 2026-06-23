// Reel user-state route harness (MAIN-965 / ADR-0006) — exercises the PATCH handler
// directly. Mirrors app/api/content-pipeline/runs/route.test.ts: no network, no SDKs.
// The Store is mocked to a thin fake so the route never opens data/content.db; the
// assertions are purely on status codes + payload shape (a thin entry point's
// contract, ADR-0002) and that the route delegates the favorite write to the Store.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReelRow } from "../../../../lib/core/types.js";

// Mock the Store BEFORE importing the route so the route binds the stub. setFavorite /
// setArchived record their calls and return a row whose state mirrors the requested
// flag; a special "MISSING" shortcode returns undefined to drive the 404 path. close()
// is a no-op.
const { openStoreMock, setFavoriteMock, setArchivedMock } = vi.hoisted(() => {
  const setFavorite = vi.fn((shortcode: string, favorite: boolean): ReelRow | undefined => {
    if (shortcode === "MISSING") return undefined;
    return {
      shortcode,
      is_favorite: favorite ? 1 : 0,
      favorited_at: favorite ? "2026-06-22T00:00:00.000Z" : null,
      is_archived: 0,
      archived_at: null,
    } as ReelRow;
  });
  const setArchived = vi.fn((shortcode: string, archived: boolean): ReelRow | undefined => {
    if (shortcode === "MISSING") return undefined;
    return {
      shortcode,
      is_favorite: 0,
      favorited_at: null,
      is_archived: archived ? 1 : 0,
      archived_at: archived ? "2026-06-22T00:00:00.000Z" : null,
    } as ReelRow;
  });
  return {
    setFavoriteMock: setFavorite,
    setArchivedMock: setArchived,
    openStoreMock: vi.fn(() => ({ setFavorite, setArchived, close: vi.fn() })),
  };
});
vi.mock("../../../../lib/core/store.js", () => ({ openStore: openStoreMock }));

import { PATCH } from "./route.js";

function patch(shortcode: string, body: unknown): Promise<Response> {
  return PATCH(
    new Request(`http://localhost/api/reels/${shortcode}`, {
      method: "PATCH",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ shortcode }) },
  );
}

afterEach(() => {
  setFavoriteMock.mockClear();
  setArchivedMock.mockClear();
  openStoreMock.mockClear();
});

describe("PATCH /api/reels/{shortcode}", () => {
  it("sets is_favorite=true and returns the updated user-state", async () => {
    const res = await patch("ABC123", { is_favorite: true });
    expect(res.status).toBe(200);
    expect(setFavoriteMock).toHaveBeenCalledWith("ABC123", true);
    expect(await res.json()).toEqual({
      shortcode: "ABC123",
      is_favorite: true,
      favorited_at: "2026-06-22T00:00:00.000Z",
      is_archived: false,
      archived_at: null,
    });
  });

  it("clears is_favorite=false and nulls favorited_at", async () => {
    const res = await patch("ABC123", { is_favorite: false });
    expect(res.status).toBe(200);
    expect(setFavoriteMock).toHaveBeenCalledWith("ABC123", false);
    expect(await res.json()).toEqual({
      shortcode: "ABC123",
      is_favorite: false,
      favorited_at: null,
      is_archived: false,
      archived_at: null,
    });
  });

  it("sets is_archived=true and returns the updated user-state (slice 967)", async () => {
    const res = await patch("ABC123", { is_archived: true });
    expect(res.status).toBe(200);
    expect(setArchivedMock).toHaveBeenCalledWith("ABC123", true);
    expect(setFavoriteMock).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({
      shortcode: "ABC123",
      is_favorite: false,
      favorited_at: null,
      is_archived: true,
      archived_at: "2026-06-22T00:00:00.000Z",
    });
  });

  it("clears is_archived=false and nulls archived_at (slice 967)", async () => {
    const res = await patch("ABC123", { is_archived: false });
    expect(res.status).toBe(200);
    expect(setArchivedMock).toHaveBeenCalledWith("ABC123", false);
    expect(await res.json()).toEqual({
      shortcode: "ABC123",
      is_favorite: false,
      favorited_at: null,
      is_archived: false,
      archived_at: null,
    });
  });

  it("404s when the Reel doesn't exist", async () => {
    const res = await patch("MISSING", { is_favorite: true });
    expect(res.status).toBe(404);
  });

  it("404s an archive on a missing Reel (slice 967)", async () => {
    const res = await patch("MISSING", { is_archived: true });
    expect(res.status).toBe(404);
  });

  it("400s a non-boolean is_favorite", async () => {
    const res = await patch("ABC123", { is_favorite: "yes" });
    expect(res.status).toBe(400);
    expect(setFavoriteMock).not.toHaveBeenCalled();
  });

  it("400s a non-boolean is_archived (slice 967)", async () => {
    const res = await patch("ABC123", { is_archived: "yes" });
    expect(res.status).toBe(400);
    expect(setArchivedMock).not.toHaveBeenCalled();
  });

  it("400s a body with no recognized flag", async () => {
    const res = await patch("ABC123", { something_else: 1 });
    expect(res.status).toBe(400);
    expect(setFavoriteMock).not.toHaveBeenCalled();
    expect(setArchivedMock).not.toHaveBeenCalled();
  });

  it("400s invalid JSON", async () => {
    const res = await patch("ABC123", "{not json");
    expect(res.status).toBe(400);
  });

  it("400s an unsafe shortcode before touching the Store", async () => {
    const res = await patch("../etc/passwd", { is_favorite: true });
    expect(res.status).toBe(400);
    expect(openStoreMock).not.toHaveBeenCalled();
  });
});
