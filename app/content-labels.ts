// Shared, pure presentation helpers for the dashboard — label maps, number/format
// helpers, and small derivations over analysis fields. NO server (better-sqlite3)
// and NO client ("use client") concerns: this module is imported by BOTH the
// server read adapter (dashboard-data.ts, which builds view-models) AND the client
// shell (AppShell.tsx, which formats live run results), so it must stay isomorphic.
//
// The label maps mirror config/categories.yaml's spirit and the analysis prompt's
// vocabulary (hook techniques, beat labels). Category display names come from
// config at read time; these maps cover the analysis enums config doesn't own.

import type { Beat, BeatLabel } from "../lib/core/types.js";

/** Hook-technique slug → human label. Falls back to title-case for unknown slugs. */
export const HOOK_LABELS: Record<string, string> = {
  contrarian: "Contrarian",
  question: "Question",
  mistake: "Mistake",
  numbered_list: "Numbered list",
  time_based: "Time-based",
  cold_open: "Cold open",
  tension_visual: "Tension visual",
  pattern_interrupt: "Pattern interrupt",
  social_proof: "Social proof",
  curiosity_gap: "Curiosity gap",
  trend_adoption: "Trend adoption",
  transformation: "Transformation",
};

/** One-line "why this hook earns the watch" copy, keyed by hook slug. */
export const HOOK_DESCRIPTIONS: Record<string, string> = {
  contrarian: "Challenges the conventional take, so the viewer stays to argue or agree.",
  curiosity_gap: "Implies hidden knowledge the viewer does not want to miss.",
  social_proof: "Leads with a result or number that earns instant credibility.",
  numbered_list: "Promises a finite, structured payoff worth staying for.",
  mistake: "Warns of an error the viewer is afraid they are making.",
  time_based: "Compresses a result into a timeframe that feels attainable.",
  question: "Opens a loop the viewer answers in their own head.",
  transformation: "States a before and after the viewer wants for themselves.",
  cold_open: "Drops the viewer mid-action so they stay to find the context.",
  tension_visual: "Leads with an unresolved image that demands resolution.",
  pattern_interrupt: "Breaks the expected scroll rhythm to reclaim attention.",
  trend_adoption: "Rides a familiar format so the idea feels instantly legible.",
};

/** Beat label → accent color (design-system CSS variable). */
export const BEAT_COLORS: Record<BeatLabel, string> = {
  HOOK: "var(--accent)",
  CONTEXT: "var(--fg-faint)",
  VALUE_1: "var(--sage-muted)",
  VALUE_2: "var(--sage)",
  VALUE_3: "#9db98a",
  TENSION: "var(--rose-muted)",
  PAYOFF: "var(--accent-hover)",
  ESCALATION: "var(--rose)",
  CTA: "var(--info-fg)",
  LOOP_BRIDGE: "var(--sand-deep)",
};

/** Beat label → short, human "what this beat does" note. */
export const BEAT_NOTES: Record<BeatLabel, string> = {
  HOOK: "Attention capture",
  CONTEXT: "Who this is for",
  VALUE_1: "First teaching beat",
  VALUE_2: "Second, stronger beat",
  VALUE_3: "Third beat",
  TENSION: "Raises the stakes",
  PAYOFF: "Delivers the promise",
  ESCALATION: "Wait, there is more",
  CTA: "Follow, save, share",
  LOOP_BRIDGE: "Connects back to the open",
};

/** Compact label for the beat bar (fits a thin segment). */
export function beatShort(label: string): string {
  return label
    .replace("VALUE_", "V")
    .replace("LOOP_BRIDGE", "LOOP")
    .replace("ESCALATION", "ESC")
    .replace("CONTEXT", "CTX")
    .replace("TENSION", "TENS");
}

export function hookLabel(slug: string | null | undefined): string {
  if (!slug) return "—";
  return HOOK_LABELS[slug] ?? titleCase(slug);
}

export function hookDescription(slug: string | null | undefined): string {
  if (!slug) return "Opening technique for the first seconds.";
  return HOOK_DESCRIPTIONS[slug] ?? "Opening technique for the first seconds.";
}

/** Title-case a snake_case slug → "Tool Demo". Used as a label fallback. */
export function titleCase(slug: string): string {
  return slug
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Human-compact number: 2.9M, 142K, 880. NULL/undefined → em-dash (the NULL rule —
 * a missing metric is never dressed up as 0).
 */
export function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "") + "K";
  return String(Math.round(n));
}

/** duration_sec → ":34" or "1:05". NULL → "". */
export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "";
  const total = Math.round(sec);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return mm > 0 ? `${mm}:${ss.toString().padStart(2, "0")}` : `:${ss.toString().padStart(2, "0")}`;
}

/** Initials from a display name: "Mariah Brunner" → "MB". */
export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

/**
 * Split why_it_works into a serif pull-quote (first sentence) and the remaining
 * body. A single-sentence rationale yields just the pull-quote (empty body).
 */
export function splitWhy(why: string | null): { pull: string; body: string } {
  if (!why || !why.trim()) return { pull: "", body: "" };
  const flat = why.trim();
  const m = flat.match(/^(.+?[.!?])\s+(.*)$/s);
  if (!m) return { pull: flat, body: "" };
  return { pull: m[1].trim(), body: m[2].trim() };
}

/** A view-model beat (decoded + presentation-enriched) the detail view renders. */
export interface BeatVM {
  label: BeatLabel;
  short: string;
  start: number;
  end: number;
  note: string;
  color: string;
  /** Verbatim transcript spoken during this beat; "" for speechless or pre-backfill rows. */
  text: string;
}

/** Decode the beat_sequence JSON column → enriched beat VMs. Bad/empty JSON → []. */
export function decodeBeats(json: string | null): BeatVM[] {
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
      short: beatShort(b.label),
      start: b.start_pct ?? 0,
      end: b.end_pct ?? 0,
      note: BEAT_NOTES[b.label] ?? "",
      color: BEAT_COLORS[b.label] ?? "var(--fg-faint)",
      // Rows analyzed before per-beat text was added have no `text` key → "".
      text: typeof b.text === "string" ? b.text : "",
    }));
}

/** A comment surfaced in the detail "Questions from comments" block. */
export interface CommentVM {
  username: string;
  text: string;
  likes: number;
  isQuestion: boolean;
}

/** Normalize a comment/keyword for comparison: lowercase, drop punctuation/emoji,
 *  collapse whitespace. "Loop" / "loop!!" / "🔁 Loop" all → "loop". */
export function normalizeCommentText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Common words that follow a CTA verb but are NOT ManyChat trigger keywords
// ("comment below", "comment your favorite"), so they must never be filtered.
const CTA_STOPWORDS = new Set([
  "below", "your", "this", "that", "if", "and", "the", "what", "how", "with", "for",
  "me", "us", "down", "now", "here", "my", "a", "an", "to", "i", "you", "it", "is",
  "of", "on", "or", "yes", "no", "please", "link", "word", "words", "code", "comment",
  "comments", "dm", "below", "favorite", "favourite", "thoughts",
]);

// "comment LOOP", 'dm "tracker"', "type the word manus", "drop a STACK" — capture the
// trigger word after a call-to-action verb (quotes optional, curly or straight).
const CTA_KEYWORD_RE =
  /\b(?:comment|comments|dm|type|drop|reply|replies|send|say|write|tag)\b[\s:,-]*(?:with\s+|me\s+|a\s+|the\s+word\s+|the\s+code\s+|below\s+)?["'“”‘’]?([a-z][a-z0-9'-]{0,24})["'“”‘’]?/giu;

/**
 * Extract the ManyChat trigger keyword(s) a caption asks viewers to comment, e.g.
 * `comment "loop" and I'll send you…` → {"loop"}. Creators use these automations,
 * which flood top_comments with dozens of identical one-word replies; the keyword
 * differs per post, so we read it from the caption's own call-to-action rather than
 * guessing. Returns a set of normalized keywords (function words filtered out).
 */
export function extractManychatKeywords(caption: string | null | undefined): Set<string> {
  const keywords = new Set<string>();
  if (!caption) return keywords;
  for (const m of caption.matchAll(CTA_KEYWORD_RE)) {
    const norm = normalizeCommentText(m[1]);
    if (norm && !CTA_STOPWORDS.has(norm)) keywords.add(norm);
  }
  return keywords;
}

/** A raw comment as the ManyChat read-time heuristic consumes it (source-agnostic). */
export interface RawComment {
  username?: string | null;
  text?: string | null;
  likes?: number | null;
}

/**
 * DEPRECATED (slice 968): the legacy read-time ManyChat filter + ranking. It guessed
 * which Comments were automation triggers by parsing the caption's CTA and finding
 * repeated short tokens — a fuzzy heuristic. Slice 968 RETIRES that guess in favor of
 * the stored, EXACT `comments.is_trigger` flag (set by flagTriggerComments against the
 * Reel's analyzed trigger_keyword): the corpus display path (commentRowsToVMs) now
 * filters on is_trigger, not on this heuristic.
 *
 * This pure helper is retained ONLY for the inline top_comments snapshot path
 * (decodeComments) — that JSON has no is_trigger flag, so the snapshot still leans on
 * the caption parse — and for its existing unit tests. It is NO LONGER on the dashboard's
 * corpus read path. Returns VMs with questions first, then by likes; non-destructive.
 */
export function rankComments(
  comments: RawComment[],
  opts: { caption?: string | null; creatorUsername?: string | null } = {},
): CommentVM[] {
  const raw = comments
    .filter((c) => c && typeof c.text === "string" && c.text.trim())
    .map((c) => {
      const text = c.text!.trim();
      return {
        username: c.username ?? "",
        text,
        likes: c.likes ?? 0,
        isQuestion: text.includes("?"),
        norm: normalizeCommentText(text),
      };
    });

  const keywords = extractManychatKeywords(opts.caption);
  const creator = opts.creatorUsername ? opts.creatorUsername.toLowerCase().replace(/^@/, "") : null;

  // Count normalized-text repeats — a short token recurring across the sample is the
  // automation's fingerprint even when the caption parse misses it.
  const counts = new Map<string, number>();
  for (const c of raw) counts.set(c.norm, (counts.get(c.norm) ?? 0) + 1);

  const hasCTA = keywords.size > 0;
  const isManychatNoise = (c: (typeof raw)[number]): boolean => {
    if (!c.norm) return true; // emoji/punctuation-only
    if (c.isQuestion) return false; // a question is always meaningful — keep it
    const tokens = c.norm.split(" ");
    const wordCount = tokens.length;
    // The trigger keyword as a token of a SHORT comment ("loop", "loop pls",
    // "tracker please"). Bounded to ≤3 words so a real comment that merely mentions
    // the word ("this will work great for my team") is never dropped.
    if (wordCount <= 3 && tokens.some((t) => keywords.has(t))) return true;
    // A short token recurring across the sample is the automation's fingerprint even
    // when the caption parse misses the exact keyword.
    if ((counts.get(c.norm) ?? 0) >= 2 && wordCount <= 3 && c.norm.length <= 24) return true;
    // On a reel with a clear ManyChat CTA, an unliked ≤2-word non-question comment is
    // overwhelmingly a trigger variant/typo ("Sauta", "Live please", "agentic") — not
    // strategy signal. A liked comment is spared (it may genuinely matter).
    if (hasCTA && wordCount <= 2 && c.norm.length <= 14 && c.likes === 0) return true;
    return false;
  };

  return raw
    .filter((c) => {
      if (creator && c.username.toLowerCase().replace(/^@/, "") === creator) return false;
      return !isManychatNoise(c);
    })
    .map(({ username, text, likes, isQuestion }) => ({ username, text, likes, isQuestion }))
    .sort((a, b) => {
      if (a.isQuestion !== b.isQuestion) return a.isQuestion ? -1 : 1;
      return b.likes - a.likes;
    });
}

/**
 * Decode top_comments JSON → comment VMs via the shared ManyChat heuristic. Retained
 * for the inline snapshot path + its existing tests; the detail view now reads the
 * dedicated `comments` corpus instead (commentRowsToVMs). Bad/empty JSON → [].
 */
export function decodeComments(
  json: string | null,
  opts: { caption?: string | null; creatorUsername?: string | null } = {},
): CommentVM[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return rankComments(parsed as RawComment[], opts);
}

/** A `comments` corpus row as the corpus display path consumes it (carries the flag). */
export interface CorpusCommentRow {
  username: string | null;
  text: string | null;
  likes: number | null;
  /** 1 when flagged a Trigger-Keyword (ManyChat) comment by flagTriggerComments. */
  is_trigger?: number | null;
}

/**
 * Decode the dedicated `comments` corpus rows → comment VMs (MAIN-966) for the detail
 * view. Slice 968 RETIRES the fuzzy read-time ManyChat heuristic here: the default view
 * EXCLUDES Comments flagged is_trigger = 1 (set precisely by flagTriggerComments against
 * the Reel's analyzed trigger_keyword) — no caption guessing, no repetition fingerprint.
 * Questions-first ordering is preserved (then by likes); the underlying store rows are
 * untouched (non-destructive), so the count of excluded triggers survives as a signal.
 */
export function commentRowsToVMs(rows: CorpusCommentRow[]): CommentVM[] {
  return rows
    .filter((c) => c && c.is_trigger !== 1 && typeof c.text === "string" && c.text.trim())
    .map((c) => {
      const text = c.text!.trim();
      return {
        username: c.username ?? "",
        text,
        likes: c.likes ?? 0,
        isQuestion: text.includes("?"),
      };
    })
    .sort((a, b) => {
      if (a.isQuestion !== b.isQuestion) return a.isQuestion ? -1 : 1;
      return b.likes - a.likes;
    });
}
