// Reel user-state mutation route (ADR-0006 / MAIN-965). URL: /api/reels/{shortcode}.
//
//   PATCH → set/clear a Reel's user-authored flags and return the updated state.
//           Handles { is_favorite?: boolean } (slice 965) AND { is_archived?: boolean }
//           (slice 967) on the SAME route — either or both may be present.
//           Generation/refresh do NOT belong here — those flow through the pipeline run API.
//
// Thin entry point (ADR-0002): validate the shortcode + body, call the Store write
// method(s), shape the JSON. ZERO business logic — the flag behavior (stamping
// favorited_at / archived_at, returning the row) lives in the Store, not here.
//
// Import the Store from the SPECIFIC core module (NOT the lib/core barrel) so the
// Apify/Gemini SDKs stay out of this route's server bundle (S5 contract / HARD
// INVARIANT #4). runtime "nodejs" + force-dynamic: better-sqlite3 is server-only and
// the write must never be cached.

import { openStore } from "../../../../lib/core/store.js";
import type { ReelRow } from "../../../../lib/core/types.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Instagram shortcodes are URL-safe base64-ish: letters, digits, -, _. Reject
 *  anything else before it can touch the Store (path-traversal / injection guard). */
function isSafeShortcode(shortcode: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(shortcode);
}

interface PatchBody {
  is_favorite?: unknown;
  is_archived?: unknown;
}

/** Project the updated ReelRow down to the user-state the optimistic client needs. */
function userState(reel: ReelRow) {
  return {
    shortcode: reel.shortcode,
    is_favorite: reel.is_favorite === 1,
    favorited_at: reel.favorited_at,
    is_archived: reel.is_archived === 1,
    archived_at: reel.archived_at,
  };
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ shortcode: string }> },
): Promise<Response> {
  const { shortcode } = await ctx.params;
  if (!isSafeShortcode(shortcode)) {
    return Response.json({ error: "invalid shortcode" }, { status: 400 });
  }

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // is_favorite (965) and is_archived (967) are both honored; each must be a boolean
  // when present. A body carrying no recognized flag is a no-op request → 400.
  if (body.is_favorite !== undefined && typeof body.is_favorite !== "boolean") {
    return Response.json({ error: "is_favorite must be a boolean" }, { status: 400 });
  }
  if (body.is_archived !== undefined && typeof body.is_archived !== "boolean") {
    return Response.json({ error: "is_archived must be a boolean" }, { status: 400 });
  }
  if (body.is_favorite === undefined && body.is_archived === undefined) {
    return Response.json({ error: "no recognized flag in body" }, { status: 400 });
  }

  const store = openStore();
  try {
    // Apply each present flag in turn; the last write's row carries the full, updated
    // state (each Store write returns the freshly-read row). A missing Reel surfaces as
    // an undefined return → 404, before any further write.
    let updated: ReelRow | undefined;
    if (body.is_favorite !== undefined) {
      updated = store.setFavorite(shortcode, body.is_favorite);
      if (!updated) {
        return Response.json({ error: "reel not found" }, { status: 404 });
      }
    }
    if (body.is_archived !== undefined) {
      updated = store.setArchived(shortcode, body.is_archived);
      if (!updated) {
        return Response.json({ error: "reel not found" }, { status: 404 });
      }
    }
    return Response.json(userState(updated!), { status: 200 });
  } finally {
    store.close();
  }
}
