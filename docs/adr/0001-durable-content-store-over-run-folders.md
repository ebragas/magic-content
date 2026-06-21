# Durable content store as the spine, not ephemeral run folders

The source project (`sandbox/content-strategist`) is built around ephemeral research runs: each run writes a fresh timestamped folder (`raw.json` → `outliers.json` → `report.md`) and re-scrapes/re-analyzes from scratch. We are instead making a durable, keyed **Content Store** (one record per Reel, keyed by shortcode) the source of truth.

We chose this because all three of our headline requirements — a dashboard that sorts/manipulates data, a cache that avoids re-scraping and re-analyzing (Apify + Gemini cost), and per-item traceability back to the original URL — depend on durable, queryable, deduplicated records. The run-folder model would force dedup, caching, and traceability to be bolted on awkwardly.

Trade-off: we diverge significantly from the source's structure, so the source's fetch/score/analyze logic is ported to TypeScript (see ADR-0005) and made incremental and idempotent rather than reused as-is. Raw scrape JSON may still be written to disk transiently for debugging, but it is not the source of truth.
