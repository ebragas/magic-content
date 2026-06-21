# Build Spec (v1)

Operational details a build needs that aren't decisions worth an ADR. Read alongside `schema.md` and the ADRs.

## Cost / volume guardrail (EBI R1 #4)

90 days of an active creator can be 50–100 Reels, and **each new Reel costs a video download + 2 Gemini calls**. To avoid surprise Apify/Gemini bills:

- `scrape` honors a per-account result cap (`results_limit`, default **50**, like the source) and the 90-day window.
- `analyze` processes **newest-first** and stops at `max_analyses_per_run` (default **25**). Already-analyzed Reels are skipped and don't count against the cap.
- `refresh` (reel metrics + a new `creator_stats` snapshot — no video, no Gemini) is **uncapped**; it's cheap.
- These live in a config block (e.g. `config/settings.yaml`) so they're tunable without code.
- The CLI / content-pipeline run logs how many Reels were skipped vs analyzed, and how many were left un-analyzed because the cap was hit (no silent truncation).

## Prompt versioning & re-analysis (EBI R1 #5, #7)

- A prompt's **version is the SHA-256 (first 12 hex chars) of its fully-rendered content** — for the analysis prompt, that means *after* `config/categories.yaml` has been injected, so changing a category definition correctly invalidates prior analysis.
- On `analyze`, for each Reel compare stored `*_prompt_hash` to the current hash. Equal → skip (immutable, ADR-0004). Different (or analysis missing) → (re)analyze and overwrite, stamping the new hash + `analyzed_at`.
- **Re-analysis implies a re-scrape.** Because the `.mp4` is deleted and Instagram CDN `videoUrl`s expire, recomputing analysis requires fetching a fresh video URL first. The pipeline treats `analyze` as depending on a current scrape of that Reel.

## Content-pipeline run contract (EBI R1 #6)

The dashboard "Run pipeline" button calls Next.js API route handlers (no separate backend — ADR-0005). The endpoint is named specifically (`content-pipeline`) so adding other processes later (e.g. topic synthesis) means a new namespace like `/synthesis/runs`, not renaming this one. A "run" is a resource (single-user, local → an in-memory run registry is fine):

```
POST /content-pipeline/runs           body: { action: "scrape" | "analyze" | "refresh" | "full", creator?: string }
                                       → 202 { run_id }

GET  /content-pipeline/runs/{run_id}   → { status: "queued" | "running" | "succeeded" | "failed",
                                           stage: "scrape" | "analyze" | "refresh" | null,
                                           progress: { done: number, total: number },
                                           started_at, finished_at, error? }
```

- The route handler launches the shared pipeline core (ADR-0002) as a fire-and-forget async task and returns immediately. Runs are tracked in a module-level in-memory registry in the Node server (requires a long-running `next start` / `next dev`, not serverless — ADR-0005).
- The frontend polls `GET /content-pipeline/runs/{run_id}` (~1–2s) to drive a progress bar, then refetches the store.
- One run at a time is acceptable for v1; reject a second `POST /content-pipeline/runs` with `409` while a run is active.

## v1 Definition of Done (EBI R1 #8)

v1 is "working" when, for `@itsmariahbrunner`:

1. `scrape` pulls last-90-day Reels into the store with metrics + thumbnails + top comments, and upserts the `creators` row + a `creator_stats` snapshot.
2. `analyze` fills transcript, topic, category, hook_technique, beat_sequence, why_it_works for up to `max_analyses_per_run` newest Reels, with provenance hashes.
3. `refresh` updates reel metrics + derived fields (performance/virality/outlier) and appends a `creator_stats` snapshot, without touching analysis.
4. The dashboard lists Reels, **sorts by performance / category / virality**, shows thumbnails, and every row links to the working original Reel URL.
5. The dashboard "Run pipeline" button triggers the same process and shows progress.
6. Re-running the whole pipeline re-scrapes metrics but **does not** re-download/re-analyze unchanged Reels (verify via logs + unchanged `analyzed_at`).

**Smoke test:** one creator, `results_limit` 10, `max_analyses_per_run` 3 → confirm 3 analyzed Reels appear, sortable, with live links, and a second run analyzes 0 new.

## Environment (EBI R1 #9)

Required keys (see `.env.example`):

- `APIFY_TOKEN` — Apify (Instagram scraping)
- `GEMINI_API_KEY` — Google AI Studio (transcription + video analysis)

## Category config clarification (EBI R1 wild card)

Two classification vocabularies exist and must not be confused:
- **`category`** (our 7-bucket enum in `config/categories.yaml`) — the *governed, sortable* axis the dashboard filters on.
- **`content_format`** (the richer enum in the framework reference §8) — an *optional* finer signal, part of the lean-core backlog, **not** captured in v1.

When `config/categories.yaml` is created, repeat this one-liner at its top.
