---
name: magic-content
description: Run the Magic Content pipeline — scrape a creator's last-90-day Instagram Reels, analyze each Reel with Gemini, refresh engagement metrics, or do a full run. Use when the user wants to run the content pipeline, scrape reels, analyze a creator, refresh metrics, or kick off a content-intelligence run for an Instagram creator.
---

# Magic Content pipeline

A thin conversational wrapper over the Magic Content **CLI**. You do not implement
any pipeline logic here — you only shell out to the CLI, which calls the one shared
pipeline core (`lib/core`). The CLI, this skill, and the dashboard "Run pipeline"
button all invoke the *exact same* core functions and the *same* SQLite Content
Store (ADR-0002), so a run started here produces an identical Content Store result
to the equivalent direct CLI invocation — it *is* the same process, just launched
conversationally.

## When to use

Use this when the user wants to:
- scrape a creator's recent Instagram Reels into the Content Store,
- analyze scraped Reels (transcript + topic/category/hook/beats/why-it-works),
- refresh engagement metrics without re-analyzing, or
- run the whole pipeline end to end.

## Prerequisites (check before running)

1. Run from the repo root: `/Users/eric/dev/magic-and-co/magic-content`.
2. Dependencies installed: if `node_modules` is missing, run `npm install` first.
3. `.env` exists with the required keys (copy from `.env.example` if absent):
   - `APIFY_TOKEN` — Instagram scraping. **Without it, `scrape` and `refresh`
     no-op** (no Apify adapter is wired, so no Reels are pulled).
   - `GEMINI_API_KEY` — transcription + video analysis. **Without it, `analyze`
     no-ops** (the real Gemini + video-download adapters only engage when the key
     is present).
   If a key the requested action needs is missing, tell the user before running —
   don't pretend a no-op run did real work.

## How to run

The single invocation surface is:

```
npm run cli -- <action> [creator]
```

- `<action>` is one of `scrape | analyze | refresh | full` (required).
- `[creator]` is an optional Instagram username (a leading `@` is fine). If
  omitted, the CLI defaults to the first creator in `config/creators.yaml`
  (currently `itsmariahbrunner`).

Pick the action from what the user asked for, then run exactly one of:

```
npm run cli -- scrape  <creator>     # pull last-90-day Reels + metrics + top comments + a follower snapshot
npm run cli -- analyze <creator>     # transcribe + analyze scraped Reels with Gemini (newest-first, capped)
npm run cli -- refresh <creator>     # re-pull cheap metrics + append a new stats snapshot (no video, no Gemini)
npm run cli -- full    <creator>     # scrape -> analyze -> refresh, in that order
```

Examples:

```
npm run cli -- full itsmariahbrunner
npm run cli -- scrape @somecreator
npm run cli -- analyze            # defaults to the first configured creator
```

## What each action does (so you can explain it)

- **scrape** — Apify pulls the creator's Reels from the last 90 days (capped by
  `results_limit`, default 50), upserts the `creators` row + each Reel's metrics +
  top comments, and appends a `creator_stats` follower snapshot.
- **analyze** — for each Reel, Gemini produces a verbatim transcript plus the
  lean-core analysis (topic, category, hook technique, beat sequence, why it
  works). Runs **newest-first** and stops after `max_analyses_per_run` NEW
  analyses (default 25).
- **refresh** — re-pulls only the cheap, drifting metrics (likes / comments /
  views / shares) and appends a fresh follower snapshot, then recomputes derived
  fields. **Uncapped** (it's cheap); never touches analysis.
- **full** — runs scrape, then analyze, then refresh, in order.

## Guardrails & idempotency (mention when relevant)

- **Cost caps:** `scrape` is capped by `results_limit` + the 90-day window;
  `analyze` is capped at `max_analyses_per_run` new analyses per run. Both live in
  `config/settings.yaml` and are tunable without code changes.
- **No silent truncation:** if the analyze cap is hit, the run reports how many
  Reels were left un-analyzed (`remainingOverCap`) — surface this to the user.
- **Idempotent analysis:** already-analyzed Reels whose prompt hash hasn't changed
  are **skipped** (they don't count against the cap). Re-analysis only happens when
  a prompt or category definition changed (its hash changed). So re-running `full`
  re-scrapes metrics but does **not** re-download/re-analyze unchanged Reels.

## Reading the result

The CLI streams progress + a run-log to **stderr** and writes the full
`PipelineResult` as pretty JSON to **stdout**, exiting `0` on success / non-zero on
failure. After running:

1. Key off the **exit code** for success vs failure.
2. Surface the **stdout JSON** — the `PipelineResult`:
   `{ action, creator, scrape?{ creator, reelsScraped, reelsUpserted, statsSnapshotId },
   analyze?{ creator, analyzed, skipped, failed, remainingOverCap },
   refresh?{ creator, reelsRefreshed, statsSnapshotId } }`.
3. Relay the **stderr run-log** — especially the analyze line
   (`analyzed / skipped / failed / left un-analyzed (cap hit)`) — so the user sees
   exactly what happened.

To browse the resulting Content Store, point the user at the dashboard
(`npm run dev`, then the "Run pipeline" button / table) — same store, same core.
