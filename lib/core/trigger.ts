// Trigger Keyword matching (slice 968) — the EXACT, server-side predicate that
// decides whether a Comment is an automation (ManyChat) reply firing a DM flow.
//
// This deliberately replaces the fuzzy read-time ManyChat heuristic (caption parsing
// + repetition fingerprinting in app/content-labels.ts). Here the keyword is KNOWN —
// derived during video analysis and stored on the Reel — so flagging can be tight and
// exact: a Comment is a trigger when its normalized text EXACTLY equals the keyword,
// or it's a short (≤3-word) comment whose tokens include the keyword. No guessing.
//
// Server-side, dependency-free; lives in lib/core so the Store (store.ts) and tests
// share ONE matching definition (NodeNext: explicit .js specifiers even from .ts).

/** Max words a comment may have and still count as a trigger via token inclusion. */
const MAX_TRIGGER_WORDS = 3;

/**
 * Min keyword length for PREFIX (stem) matching. Below this, only exact-token
 * equality counts — a 1–2 char keyword ("go") is too short to prefix-match safely
 * ("gold", "google"). At >=3 chars the prefix arm is enabled.
 */
const MIN_PREFIX_KEYWORD_LEN = 3;

/**
 * Normalize a Comment/keyword for exact comparison: lowercase, drop punctuation/emoji,
 * collapse whitespace. "RITUAL" / "ritual!!" / "🔁 ritual" all → "ritual". Mirrors the
 * isomorphic normalizeCommentText in app/content-labels.ts so both sides agree; kept
 * here so lib/core stays free of app/ imports.
 */
export function normalizeTriggerText(text: string | null | undefined): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Coerce a model-emitted Trigger Keyword to its stored form: normalized (lowercase,
 * punctuation/emoji stripped, whitespace collapsed), with empty → null. So `null`,
 * `""`, `"  "`, and emoji-only inputs all coerce to null (no keyword), and `"RITUAL!"`
 * → `"ritual"`. This is exactly what gets written to reels.trigger_keyword.
 */
export function normalizeTriggerKeyword(raw: string | null | undefined): string | null {
  const norm = normalizeTriggerText(raw);
  return norm === "" ? null : norm;
}

/**
 * Is this Comment text a trigger for the given keyword? Tight, not fuzzy:
 *   - the normalized comment EXACTLY equals the normalized keyword ("ritual"), OR
 *   - the comment is short (≤3 words) and one of its tokens EQUALS the keyword
 *     ("ritual please", "drop ritual"), OR
 *   - the comment is short (≤3 words) and one of its tokens STARTS WITH the keyword
 *     (keyword ≥3 chars): "Loops", "loopppp", "Loop….thx" all fire on "loop".
 * A keyword that is itself multi-word matches only by the exact-equality arm. An
 * empty/whitespace keyword never matches. Bounded word count so a real comment that
 * merely mentions the word ("this ritual changed my morning routine") is never flagged.
 *
 * The prefix (stem) arm deliberately over-matches words that merely START with the
 * keyword ("loophole" on "loop"). That's the cheap error direction: a false-positive
 * trigger is excluded from FAQ mining + the default view but its COUNT survives as a
 * CTA-response signal, whereas a false-negative leaks automation spam into the FAQs.
 */
export function isTriggerComment(
  text: string | null | undefined,
  keyword: string | null | undefined,
): boolean {
  const kw = normalizeTriggerKeyword(keyword);
  if (!kw) return false;
  const norm = normalizeTriggerText(text);
  if (norm === "") return false;
  if (norm === kw) return true;
  const tokens = norm.split(" ");
  if (tokens.length > MAX_TRIGGER_WORDS) return false;
  // Token matching only makes sense for a single-word keyword; a multi-word keyword
  // ("free guide") is matched solely by exact equality above.
  if (kw.includes(" ")) return false;
  const prefixOk = kw.length >= MIN_PREFIX_KEYWORD_LEN;
  return tokens.some((t) => t === kw || (prefixOk && t.startsWith(kw)));
}
