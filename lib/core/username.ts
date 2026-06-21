// Creator-key canonicalization — the single source of truth for the creators /
// reels PRIMARY KEY contract (docs/schema.md: `username` is "Lowercased, no @").
//
// This rule is the join key across creators, creator_stats, and reels, and it is
// applied at EVERY store boundary plus the scrape/analyze/refresh/pipeline entry
// points and the run API. It MUST live in exactly one place: if the rule ever
// drifts and one call site is missed, the same creator silently splits across two
// keys. No external deps so it's importable everywhere (store, core, route).

/**
 * Canonicalize a creator handle to its store key: lowercase and strip a single
 * leading '@'. Idempotent. Keep semantics minimal — this is the primary-key
 * contract, so do not add trimming or other transforms here without updating
 * docs/schema.md and the store tests in lockstep.
 */
export function normalizeUsername(username: string): string {
  return username.toLowerCase().replace(/^@/, "");
}
