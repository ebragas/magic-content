// faqs — mine a Reel's non-trigger Comments into ranked FAQs grounded in REAL counts
// (MAIN-969 / ADR-0007 / ADR-0008).
//
// FAQ extraction deliberately breaks the immutable-analysis rule (ADR-0004): its input is
// the Reel's Comments, which ACCUMULATE over time. So it re-runs when FAQs are absent, or
// the FAQ prompt hash drifted, or Comments were re-pulled since the last FAQ run — and skips
// otherwise (ADR-0007). It is a SEPARATE leg from video analysis: a FAQ backfill on an
// already-video-analyzed Reel does ONLY the FAQ work and never re-invokes Gemini/Video.
//
// The clustering itself is a LANGUAGE task owned by Claude (ADR-0008), expressed as the
// AnthropicPort (HARD INVARIANT #2): the real adapter engages only when ANTHROPIC_API_KEY is
// set; tests inject a fake. With no port and no key, this is a safe no-op (walking skeleton).
//
// The model returns clusters of {question, member_indices} over the compact 1..N indices we
// tagged the input Comments with. We VALIDATE those indices — DROP out-of-range ones (no
// hallucinated links), drop a cluster with zero valid members — then map the survivors back
// to real comment_ids and let the Store compute support_count/support_likes/strength_score
// FROM THE REAL links. Demand is made countable; the model never supplies a number.

import type { AppConfig } from "./config.js";
import { faqPromptHash } from "./config.js";
import type { AnthropicPort, CommentRow, FaqClusterWithLinks, ReelRow, Store } from "./types.js";

export interface ExtractFaqsArgs {
  /** The Reel whose Comments to mine. */
  reel: ReelRow;
  store: Store;
  config: AppConfig;
  /** Resolved Anthropic port; when undefined the call is a safe no-op. */
  anthropic: AnthropicPort | undefined;
}

export interface ExtractFaqsResult {
  /** True when the leg actually ran the model + wrote FAQs (vs. a no-op / nothing to do). */
  ran: boolean;
  /** Number of FAQs persisted (clusters with ≥1 valid comment link). */
  faqsWritten: number;
}

/**
 * Does this Reel need a FAQ (re)extraction? (ADR-0007.) Re-run when ANY of:
 *   (a) FAQs are absent — no faqs_generated_at yet;
 *   (b) faq_prompt_hash drift — the stored hash differs from the current FAQ prompt hash;
 *   (c) Comments re-pulled since the last FAQ run — the newest comments.first_seen_at for
 *       this Reel is strictly newer than faqs_generated_at (the mutable-input signal that has
 *       no analogue in immutable video analysis).
 * Otherwise SKIP. A Reel with no comment corpus at all still counts as (a) until its first
 * successful run stamps faqs_generated_at; once stamped, an empty corpus won't re-trigger (b)/(c).
 */
export function needsFaqExtraction(reel: ReelRow, store: Store, currentFaqHash: string): boolean {
  if (!reel.faqs_generated_at) return true; // (a) never run
  if (reel.faq_prompt_hash !== currentFaqHash) return true; // (b) prompt drift
  return commentsRePulledSince(store, reel.shortcode, reel.faqs_generated_at); // (c)
}

/**
 * True when this Reel's Comment corpus has grown/refreshed since the given FAQ-run timestamp:
 * the maximum comments.first_seen_at for the Reel is strictly newer than `since`. first_seen_at
 * is set once on first insert and never clobbered (the corpus's accumulation anchor), so a newer
 * max means a Comment we hadn't seen at the last FAQ run has since landed.
 */
function commentsRePulledSince(store: Store, shortcode: string, since: string): boolean {
  const row = store.db
    .prepare(`SELECT MAX(first_seen_at) AS newest FROM comments WHERE shortcode = ?`)
    .get(shortcode) as { newest: string | null } | undefined;
  const newest = row?.newest ?? null;
  return newest != null && newest > since;
}

/**
 * Extract (or re-extract) FAQs for one Reel. Always stamps the FAQ provenance on a successful
 * run (even when the model returns zero clusters) so the re-run predicate settles — the next
 * run skips until the prompt hash drifts or Comments are re-pulled again. Safe no-op (ran:false)
 * when no Anthropic port is available. Caller decides whether this Reel needs work + cap budget.
 */
export async function extractFaqsForReel(args: ExtractFaqsArgs): Promise<ExtractFaqsResult> {
  const { reel, store, config, anthropic } = args;
  if (!anthropic) return { ran: false, faqsWritten: 0 };

  // Feed NON-trigger Comments (is_trigger = 0), tagged with compact 1..N indices. We read the
  // whole corpus and filter in JS so the index↔comment_id map is built from the exact rows we send.
  const corpus = store.listComments(reel.shortcode);
  const nonTrigger = corpus.filter((c) => c.is_trigger !== 1 && hasText(c));

  // Tag each with a 1-based index; remember which comment_id each index maps to. The model only
  // ever sees these indices, never the ids — so a hallucinated index can't forge a real link.
  const indexToId = new Map<number, string>();
  const tagged = nonTrigger.map((c, i) => {
    const idx = i + 1;
    indexToId.set(idx, c.comment_id);
    return { idx, text: (c.text ?? "").trim(), likes: c.likes ?? 0 };
  });

  // No mineable Comments: still a real run — wholesale-clear any stale FAQs and stamp provenance
  // so the predicate settles (otherwise a Reel with no comments re-runs the model every pass).
  if (tagged.length === 0) {
    store.replaceFaqs(reel.shortcode, []);
    stampProvenance(store, reel.shortcode, config);
    return { ran: true, faqsWritten: 0 };
  }

  const { clusters } = await anthropic.extractFaqs({
    comments: tagged,
    context: { topic: reel.topic, transcript: reel.transcript },
  });

  // VALIDATE indices: keep only in-range members, map to real comment_ids, dedupe; drop a
  // cluster with zero valid members (no hallucinated links survive to the store).
  const withLinks: FaqClusterWithLinks[] = [];
  for (const cluster of clusters ?? []) {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const memberIdx of cluster.member_indices ?? []) {
      const id = indexToId.get(memberIdx); // undefined when out-of-range → DROPPED
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    const question = (cluster.question ?? "").trim();
    if (question && ids.length > 0) withLinks.push({ question, comment_ids: ids });
  }

  const faqsWritten = store.replaceFaqs(reel.shortcode, withLinks);
  stampProvenance(store, reel.shortcode, config);
  return { ran: true, faqsWritten };
}

function hasText(c: CommentRow): boolean {
  return typeof c.text === "string" && c.text.trim().length > 0;
}

/** Stamp faq_prompt_hash + faqs_generated_at so the re-run predicate settles (ADR-0007). */
function stampProvenance(store: Store, shortcode: string, config: AppConfig): void {
  store.updateReelFaqProvenance({
    shortcode,
    faq_prompt_hash: faqPromptHash(config),
    faqs_generated_at: new Date().toISOString(),
  });
}
