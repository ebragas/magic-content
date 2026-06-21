# Incremental store: immutable analysis, refreshed metrics, keyed by shortcode

The Content Store is keyed by Reel shortcode and the pipeline is idempotent against it. Two classes of data are treated differently:

- **Analysis** (transcript, video analysis, topic, category) is computed **once and treated as immutable** — a Reel already analyzed is skipped on subsequent runs. It is recomputed only when the relevant prompt version changes (see ADR-0003).
- **Metrics** (likes, comments, views, follower count) **drift over time**, so every run re-scrapes them cheaply (no video download, no Gemini) and updates the record. `last_scraped_at` and the follower count used for the virality check are stored alongside.

We chose this split to honour two requirements at once: never re-scrape/re-analyze unnecessarily (Apify + Gemini cost, and the user's explicit caching ask), while keeping performance/virality flags current as engagement accrues. Treating everything as immutable would freeze stale metrics; refreshing everything would burn money re-analyzing unchanged videos.

Consequence: downloaded video files are transient (download → analyze → delete; only a small thumbnail is kept), since the durable value lives in the analysis record, not the media. Because the `.mp4` is deleted and Instagram CDN `videoUrl`s expire, recomputing analysis (when a prompt's content hash changes) requires re-scraping the Reel for a fresh video URL first — so `analyze` implicitly depends on a current scrape. See `docs/build-spec.md` for the prompt-hash mechanism and `docs/schema.md` for which columns are immutable vs refreshed.
