// Per-post Draft generation route (MAIN-971 / ADR-0006/0008). URL: /api/reels/{shortcode}/draft.
//
//   POST → generate (or REGENERATE) the Reel's user-owned Draft and return it. STANDALONE +
//          SYNCHRONOUS: it writes ONLY the one drafts row, so it reuses the READ-WRITE mutation
//          seam from slice 965 (like PATCH /api/reels/{shortcode}) — NOT the run registry. There is
//          no single-writer lock and no 409: a Draft write touches no pipeline state and can't
//          interleave destructively with a batch run. Regenerate is the SAME call (destructive
//          full-replace, generated_at preserved); the confirm lives in the client.
//   PUT  → persist a user's HAND-EDITS to the EXISTING Draft (MAIN-972). Same standalone,
//          synchronous read-write seam — no registry, no lock, no 404 from the model leg (no model
//          call at all): the edited fields come straight from the request body. UPDATE-only — a
//          Draft that was never generated 404s (nothing to edit). Survives reloads + sessions.
//
// Thin entry point (ADR-0002): validate the shortcode + body, delegate to the shared lib/core
// generateDraft()/saveDraft(), shape the JSON. ZERO business logic — the gather/validate/upsert
// behavior (forcing 3 hooks with one suggested, aligning beat_scripts to the analyzed beats) lives
// in lib/core/draft.ts, never here.
//
// Import generateDraft/saveDraft + the Store from the SPECIFIC core modules (NOT the lib/core barrel)
// so the Apify/Gemini SDKs stay out of this route's server bundle (HARD INVARIANT #4); the real
// Anthropic adapter auto-engages inside generateDraft() when ANTHROPIC_API_KEY is set (PUT calls no
// model). runtime "nodejs" + force-dynamic: better-sqlite3 is server-only and the write must never be cached.

import { generateDraft, saveDraft } from "../../../../../lib/core/draft.js";
import { openStore } from "../../../../../lib/core/store.js";
import type { BeatLabel, Draft } from "../../../../../lib/core/types.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Instagram shortcodes are URL-safe base64-ish: letters, digits, -, _. Reject anything
 *  else before it can touch the Store / pipeline (path-traversal / injection guard). */
function isSafeShortcode(shortcode: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(shortcode);
}

/** Project the decoded Draft to the JSON the client consumes (camelCase, decoded arrays). */
function draftPayload(draft: Draft) {
  return {
    shortcode: draft.shortcode,
    hooks: draft.hooks,
    beat_scripts: draft.beat_scripts,
    reasoning: draft.reasoning,
    caption: draft.caption,
    generated_at: draft.generated_at,
    updated_at: draft.updated_at,
  };
}

export async function POST(
  _request: Request,
  ctx: { params: Promise<{ shortcode: string }> },
): Promise<Response> {
  const { shortcode } = await ctx.params;
  if (!isSafeShortcode(shortcode)) {
    return Response.json({ error: "invalid shortcode" }, { status: 400 });
  }

  const store = openStore();
  try {
    // deps:{} lets generateDraft() auto-engage the real Anthropic adapter when ANTHROPIC_API_KEY
    // is set; with no key and no injected port the Draft leg is a safe no-op (503 — nothing to
    // generate with), distinct from a missing Reel (404).
    const result = await generateDraft({ shortcode, store });
    if (!result.found) {
      return Response.json({ error: "reel not found" }, { status: 404 });
    }
    if (!result.ran) {
      return Response.json(
        { error: "draft generation unavailable (ANTHROPIC_API_KEY not set)" },
        { status: 503 },
      );
    }
    return Response.json(draftPayload(result.draft), { status: 200 });
  } finally {
    store.close();
  }
}

/** The PUT body: a user's edited Draft fields. Validated to a precise shape before the Store sees it. */
interface PutBody {
  hooks?: unknown;
  beat_scripts?: unknown;
  reasoning?: unknown;
  caption?: unknown;
}

/** Validate + coerce the edited fields to the lib/core saveDraft shape. Returns null when malformed. */
function parseEdits(body: PutBody):
  | {
      hooks: { text: string; suggested: boolean }[];
      beat_scripts: { label: BeatLabel; script: string }[];
      reasoning: string;
      caption: string;
    }
  | null {
  if (!Array.isArray(body.hooks) || !Array.isArray(body.beat_scripts)) return null;
  if (typeof body.reasoning !== "string" || typeof body.caption !== "string") return null;
  // Coerce each hook/beat to the typed shape; lib/core re-validates structure (3 hooks/one
  // suggested, beats re-aligned to the analyzed beats), so this is a shallow guard, not the source
  // of truth. A non-object entry is dropped to a safe default rather than rejected.
  const hooks = body.hooks.map((h) => ({
    text: typeof (h as { text?: unknown })?.text === "string" ? (h as { text: string }).text : "",
    suggested: (h as { suggested?: unknown })?.suggested === true,
  }));
  const beat_scripts = body.beat_scripts.map((b) => ({
    label: (b as { label?: unknown })?.label as BeatLabel,
    script: typeof (b as { script?: unknown })?.script === "string" ? (b as { script: string }).script : "",
  }));
  return { hooks, beat_scripts, reasoning: body.reasoning, caption: body.caption };
}

export async function PUT(
  request: Request,
  ctx: { params: Promise<{ shortcode: string }> },
): Promise<Response> {
  const { shortcode } = await ctx.params;
  if (!isSafeShortcode(shortcode)) {
    return Response.json({ error: "invalid shortcode" }, { status: 400 });
  }

  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const edits = parseEdits(body);
  if (!edits) {
    return Response.json(
      { error: "body must carry hooks[], beat_scripts[], reasoning, caption" },
      { status: 400 },
    );
  }

  const store = openStore();
  try {
    // No model call — saveDraft is synchronous + UPDATE-only (the edited fields come from the body).
    // A Draft that was never generated → found:false → 404 (nothing to edit), distinct from a 200 save.
    const result = saveDraft({ shortcode, store, edits });
    if (!result.found) {
      return Response.json({ error: "draft not found" }, { status: 404 });
    }
    return Response.json(draftPayload(result.draft), { status: 200 });
  } finally {
    store.close();
  }
}
