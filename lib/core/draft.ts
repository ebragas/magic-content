// draft — generate (or regenerate) a Reel's user-owned "your version" Draft (MAIN-971).
//
// The Draft is the feature's payoff (ADR-0008): an AI-seeded artifact the user edits and returns
// to. It is categorically USER-STATE (ADR-0006) — no pipeline run produces or clobbers it; it's
// written only through the standalone read-write route, never the run registry. ONE per Reel, no
// history (shortcode PK): regenerating is a DESTRUCTIVE full-replace of every generated field
// INCLUDING the caption (the caption is a generated field now, not a copy of the original).
//
// Generation is a LANGUAGE task owned by Claude (ADR-0008), expressed as the AnthropicPort
// (HARD INVARIANT #2): the real adapter engages only when ANTHROPIC_API_KEY is set; tests inject a
// fake. With no port and no key, this is a safe no-op (walking skeleton).
//
// We gather the Reel's IMMUTABLE analysis (transcript / beats / hook / why / topic / category) +
// its FAQs (HIGHEST STRENGTH FIRST, the same ranking the detail view shows) + the original caption,
// call the port, then VALIDATE the model's shape HARD before persisting:
//   - hooks are forced to EXACTLY 3 with EXACTLY ONE suggested (pad/trim, repair the flag);
//   - beat_scripts are RE-ALIGNED to the Reel's ANALYZED beat labels/order — empty when the Reel
//     has no analyzed beats — so a Draft can NEVER invent (or drop) beat structure the analysis
//     didn't find, regardless of what the model returns.
// So a malformed model response can never persist a wrong structure (mirrors faqs.ts validation).

import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { resolveAnthropic } from "./analyze.js";
import type {
  AnthropicPort,
  Beat,
  BeatLabel,
  Deps,
  Draft,
  DraftBeatScript,
  DraftHook,
  ReelRow,
  Store,
} from "./types.js";

export interface GenerateDraftArgs {
  /** The Reel to generate a Draft for. */
  reel: ReelRow;
  store: Store;
  config: AppConfig;
  /** Resolved Anthropic port; when undefined the call is a safe no-op. */
  anthropic: AnthropicPort | undefined;
}

export interface GenerateDraftResult {
  /** True when the leg actually ran the model + wrote a Draft (vs. a no-op). */
  ran: boolean;
  /** The persisted Draft (decoded), or undefined on a no-op. */
  draft?: Draft;
}

export interface GenerateDraftEntryArgs {
  /** The shortcode of the Reel to (re)generate a Draft for. */
  shortcode: string;
  store: Store;
  config?: AppConfig;
  deps?: Deps;
}

export type GenerateDraftEntryResult =
  | { found: false } // Reel not in the store — the route maps this to 404
  | { found: true; ran: false; draft: undefined } // no Anthropic port → safe no-op
  | { found: true; ran: true; draft: Draft };

/**
 * Thin-entry orchestration (ADR-0002): resolve config + the real Anthropic adapter (engaged only
 * when ANTHROPIC_API_KEY is set, else a fake is injected), look up the Reel (missing → found:false
 * for the route's 404), and (re)generate its Draft. Keeps the route a pure validate→delegate→shape
 * shell with ZERO business logic. Mirrors refreshReel's deps-injection + auto-engage seam.
 */
export async function generateDraft(
  args: GenerateDraftEntryArgs,
): Promise<GenerateDraftEntryResult> {
  const { shortcode, store } = args;
  const config = args.config ?? loadConfig();
  const reel = store.getReel(shortcode);
  if (!reel) return { found: false };
  const anthropic = await resolveAnthropic(args.deps, config);
  const result = await generateDraftForReel({ reel, store, config, anthropic });
  if (!result.ran) return { found: true, ran: false, draft: undefined };
  return { found: true, ran: true, draft: result.draft! };
}

/**
 * Generate (or regenerate) one Reel's Draft. Gathers the Reel's analysis + FAQs (strongest first) +
 * original caption, calls the port, validates/repairs the shape, and UPSERTs the single drafts row
 * (destructive full-replace on regenerate, generated_at preserved). Safe no-op (ran:false) when no
 * Anthropic port is available. The caller (route) owns the 404 for a missing Reel.
 */
export async function generateDraftForReel(
  args: GenerateDraftArgs,
): Promise<GenerateDraftResult> {
  const { reel, store, anthropic } = args;
  // Safe no-op when there's no port, or the port doesn't implement generateDraft (the optional
  // seam mirroring scrapeComments / prepareVideo) — exactly the walking-skeleton behavior.
  const generate = anthropic?.generateDraft?.bind(anthropic);
  if (!generate) return { ran: false };

  // The Reel's analyzed beats, in order — the SPINE beat_scripts must mirror. Empty (decoded as [])
  // when the Reel was never analyzed or has no beats; we NEVER invent structure from the model.
  const beats: Beat[] = decodeBeats(reel.beat_sequence);

  // FAQs ranked HIGHEST STRENGTH FIRST (listFaqs orders by strength_score DESC) — the demand the
  // remake should answer. We pass the snapshotted, REAL-link-derived counts (never an LLM number).
  const faqs = store.listFaqs(reel.shortcode).map((f) => ({
    question: f.question,
    support_count: f.support_count,
    support_likes: f.support_likes,
  }));

  const generated = await generate({
    analysis: {
      transcript: reel.transcript,
      beat_sequence: beats,
      hook_technique: reel.hook_technique,
      why_it_works: reel.why_it_works,
      topic: reel.topic,
      category: reel.category,
    },
    faqs,
    originalCaption: reel.caption,
  });

  // VALIDATE + REPAIR the shape so a malformed model response can never persist a wrong structure.
  const hooks = normalizeHooks(generated.hooks);
  const beat_scripts = alignBeatScripts(generated.beat_scripts, beats);

  const draft = store.upsertDraft({
    shortcode: reel.shortcode,
    hooks,
    beat_scripts,
    reasoning: (generated.reasoning ?? "").trim(),
    caption: (generated.caption ?? "").trim(),
  });

  return { ran: true, draft };
}

export interface SaveDraftArgs {
  /** The shortcode of the Reel whose Draft is being hand-edited. */
  shortcode: string;
  store: Store;
  /** The user's edited Draft fields (decoded). */
  edits: {
    hooks: { text: string; suggested: boolean }[];
    beat_scripts: { label: BeatLabel; script: string }[];
    reasoning: string;
    caption: string;
  };
}

export type SaveDraftResult =
  | { found: false } // no Draft to edit — the route maps this to 404
  | { found: true; draft: Draft };

/**
 * SAVE a user's hand-edits to an EXISTING Draft (MAIN-972) — the hand-editing counterpart to
 * generate/regenerate. No model call: the edited fields come straight from the user. We still
 * VALIDATE + REPAIR the SAME WAY generation does so a hand-edit can never persist a wrong structure:
 *   - hooks forced to EXACTLY 3 with EXACTLY ONE suggested (normalizeHooks);
 *   - beat_scripts RE-ALIGNED to the Reel's ANALYZED beat labels/order (alignBeatScripts) — empty
 *     when the Reel has no analyzed beats — so an edit can't invent/drop/reorder beat structure.
 * Persists via the UPDATE-only Store.saveDraft (never creates a row): a missing Draft → found:false
 * for the route's 404 (there's nothing to edit). Thin-entry orchestration (ADR-0002): the route
 * stays a pure validate→delegate→shape shell. Categorically user-state — no pipeline run writes it.
 */
export function saveDraft(args: SaveDraftArgs): SaveDraftResult {
  const { shortcode, store, edits } = args;
  // Align edited beat_scripts to the Reel's ANALYZED beats (the spine the Draft must mirror). The
  // Reel may be gone or never analyzed → [] beats → empty beat_scripts (never invent structure).
  const reel = store.getReel(shortcode);
  const beats: Beat[] = decodeBeats(reel?.beat_sequence ?? null);

  const hooks = normalizeHooks(edits.hooks);
  const beat_scripts = alignBeatScripts(edits.beat_scripts, beats);

  const draft = store.saveDraft({
    shortcode,
    hooks,
    beat_scripts,
    reasoning: (edits.reasoning ?? "").trim(),
    caption: (edits.caption ?? "").trim(),
  });
  if (!draft) return { found: false }; // no existing Draft to edit
  return { found: true, draft };
}

/**
 * Force EXACTLY 3 hooks with EXACTLY ONE suggested. We keep the model's hooks in order, pad with
 * empty options or trim to 3, then ensure precisely one suggested:true — preferring the model's
 * first suggested choice, falling back to the first hook. Never throws on a malformed array.
 */
export function normalizeHooks(raw: { text: string; suggested: boolean }[] | undefined): DraftHook[] {
  const list = Array.isArray(raw) ? raw : [];
  // Take up to 3, coercing each entry to the {text, suggested} shape.
  const hooks: DraftHook[] = list.slice(0, 3).map((h) => ({
    text: typeof h?.text === "string" ? h.text.trim() : "",
    suggested: h?.suggested === true,
  }));
  // Pad to exactly 3 (a short response shouldn't drop the editable scaffold).
  while (hooks.length < 3) hooks.push({ text: "", suggested: false });
  // Exactly one suggested: pick the first the model flagged, else the first hook; clear the rest.
  const suggestedIdx = hooks.findIndex((h) => h.suggested);
  const winner = suggestedIdx === -1 ? 0 : suggestedIdx;
  return hooks.map((h, i) => ({ text: h.text, suggested: i === winner }));
}

/**
 * Re-align beat_scripts to the Reel's ANALYZED beat sequence: one entry per analyzed beat, in the
 * SAME ORDER, reusing the SAME labels — pulling each beat's script from the model's first matching
 * label (consumed once so duplicate labels map positionally), "" when the model didn't supply one.
 * EMPTY when the Reel has no analyzed beats. The model can NEVER add, drop, or reorder a beat.
 */
export function alignBeatScripts(
  raw: { label: BeatLabel; script: string }[] | undefined,
  beats: Beat[],
): DraftBeatScript[] {
  if (beats.length === 0) return []; // never invent structure
  const supplied = Array.isArray(raw) ? raw.slice() : [];
  const used = new Set<number>();
  return beats.map((b) => {
    // First UNUSED model entry whose label matches this analyzed beat (positional for dup labels).
    const idx = supplied.findIndex(
      (s, i) => !used.has(i) && s?.label === b.label,
    );
    if (idx !== -1) {
      used.add(idx);
      const script = typeof supplied[idx]?.script === "string" ? supplied[idx].script.trim() : "";
      return { label: b.label, script };
    }
    return { label: b.label, script: "" };
  });
}

/**
 * Decode the reels.beat_sequence JSON column → Beat[]. Bad/empty/non-array JSON → [] (so a Reel
 * with no analyzed beats yields an empty beat_scripts array, never an invented structure). Keeps
 * only entries with a string label; missing percents/text default harmlessly.
 */
export function decodeBeats(json: string | null): Beat[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return (parsed as Beat[])
    .filter((b) => b && typeof b.label === "string")
    .map((b) => ({
      label: b.label,
      start_pct: b.start_pct ?? 0,
      end_pct: b.end_pct ?? 0,
      text: typeof b.text === "string" ? b.text : "",
    }));
}
