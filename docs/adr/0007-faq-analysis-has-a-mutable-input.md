# FAQ analysis has a mutable input

ADR-0004 establishes that analysis is **immutable** — it re-runs only when the rendered prompt's SHA-256 changes, because its input (the Video) is fixed forever. FAQ extraction deliberately breaks this rule: its input is the Reel's **Comments**, which *accumulate over time*. FAQs therefore re-run when any of three conditions hold — FAQs absent, `faq_prompt_hash` drift, **or comments were re-pulled since the last FAQ run** — the third of which has no analogue in video analysis.

## Why this is a deliberate deviation, not an oversight

A future reader will see the immutable-analysis invariant everywhere (prompt-hash idempotency, "a 2nd run analyzes 0 new") and reasonably assume FAQ analysis works the same way. It does not, and *cannot*: a post scraped minutes after going live has thin, unrepresentative comments, so its FAQs must be recomputed once real comments arrive. This is the entire motivation for the per-post Refresh button (metrics + comments + FAQ).

## Consequences

- `faq_prompt_hash` + `faqs_generated_at` live on the `reels` row; the comment corpus carries enough state (count / newest) to detect "comments changed since last FAQ run."
- Trigger comments are stored but flagged (`comments.is_trigger`), so the FAQ input can be recomputed precisely once the Trigger Keyword is known — a destructive write-time filter could not be re-derived.
- This ADR **complements** ADR-0004: immutable analysis still governs everything seeded from the Video; FAQ analysis is the carved-out exception for the one mutable input.
