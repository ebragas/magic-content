# Magic Content

A content-intelligence system that scrapes a creator's short-form videos, analyzes them with AI (transcription + visual analysis), and surfaces — per Reel — what it was about and why it worked, so we can model the creator's approach on our own brands. The system is a durable library, not a one-shot report generator. (Cross-Reel topic synthesis is a deliberate future addition, out of scope for this version.)

## Language

**Content Store**:
The durable, canonical store holding one record per analyzed piece of content. The single source of truth that the pipeline writes to and the dashboard reads from.
_Avoid_: database, cache, run folder

**Reel**:
The atomic unit of the system — one Instagram Reel, identified by its shortcode. Holds metrics, transcript, analysis, and a link back to the original.
_Avoid_: post, clip

**Video**:
The media file (the downloaded `.mp4`) for a Reel. Transient — fetched to feed AI analysis, then discarded. Distinct from the Reel record, which is durable.

**Comment**:
A viewer's text reply on a Reel — `{username, text, likes}` plus Instagram's native comment id. Scraped into its own Content Store table and accumulated across refreshes (upserted by comment id, never clobbered). The corpus from which FAQs are mined. Distinct from `comments_count`, the raw metric.
_Avoid_: reply, remark

**Trigger Keyword**:
The word a Creator tells viewers to comment in order to fire a DM automation (commonly a ManyChat flow) — e.g. "comment RITUAL and I'll send you the link." Derived during video analysis and stored on the Reel. Comments matching it are flagged so they're excluded from FAQ mining and the default comments view, while their count survives as a CTA-response signal.
_Avoid_: ManyChat keyword, automation word

**FAQ**:
A representative question mined from a Reel's Comments — many phrasings of the same ask (explicit or implied) clustered into one canonical question and linked to its supporting Comments. Carries `support_count`, `support_likes`, and a `strength_score` derived from those links (demand made countable, never an LLM-claimed number). The signal for what a remake should answer.
_Avoid_: question, theme

**Shortcode**:
Instagram's native unique identifier for a Reel (the segment in `instagram.com/reel/<shortcode>/`). Used as the Content Store's primary key and the basis for traceability back to the original.

**Creator**:
A tracked Instagram account whose content we model (initially `@itsmariahbrunner`). The subject of analysis, not the brand we publish under.
_Avoid_: account, competitor, source

**Creator Snapshot**:
A point-in-time capture of a Creator's stats (followers, following, post count), appended to a time-series each pipeline run so follower growth can be tracked over time. A Reel's Virality and engagement are evaluated against the Creator's latest snapshot.
_Avoid_: profile, stats row

**Category**:
A coarse, single-label classification of a Reel's type (Tool Demo, Concept Teaching, Story/Personal, Commentary/Opinion, Promo/Offer, News, Other). The set and the definition of each bucket live in a YAML config so they can evolve as we iterate; the analysis prompt is parameterized from that config. Gemini assigns exactly one per Reel. A coarse sort axis — distinct from Topic.
_Avoid_: type, genre, tag

**Topic**:
A free-form short phrase naming what a Reel is specifically about (e.g. "using Claude to triage email"). Gemini-emitted, unconstrained. The per-Reel signal you browse in the dashboard. (A future pass may cluster Topics across a bank of Reels into video ideas; that synthesis is out of scope now.) Distinct from Category (fixed enum).
_Avoid_: subject, tag, theme

**Performance**:
A Reel's weighted engagement score (`likes + 3·comments + 0.1·views`), surfaced both raw and as an engagement-rate (score ÷ followers). The primary ranking axis in the dashboard.

**Virality**:
A boolean flag on a Reel, true when `likes ≥ 5 × followers` measured at scrape time. A deliberately strict, creator-relative definition — distinct from Performance (a continuous rank) and Outlier (a statistical flag).

**Outlier**:
A Reel whose engagement-rate exceeds this Creator's own mean + 2σ — i.e. it overperformed the creator's own baseline. Creator-relative, not absolute.

**Draft**:
The user-owned "your version" of a Reel: an on-demand Claude generation — 3 editable hook options, per-beat talking-points scripts mirroring the Reel's analyzed beats, a FAQ-aware reasoning section, and a caption — seeded from the Reel's analysis and FAQs, then hand-edited and saved. One per Reel (1:1); regenerating is a destructive full-replace (no history). The richest of the user-authored, mutable artifacts (see Favorite), distinct from the immutable analysis it's seeded from.
_Avoid_: your version, remix, remake

**Favorite**:
A user's boolean star on a Reel — mutable, user-authored state (ADR-0006), set/cleared from the dashboard and persisted to the Reel (`is_favorite` + `favorited_at`). No pipeline run produces or clobbers it. Drives the library's "Favorites only" filter. The simplest user-state flag, alongside the Draft and the Archive flag.
_Avoid_: star, like, bookmark, save

**Archive**:
A user's boolean "set aside" flag on a Reel — mutable, user-authored state (ADR-0006), set/cleared from the dashboard and persisted to the Reel (`is_archived` + `archived_at`). No pipeline run produces or clobbers it. **Hidden by default everywhere in the library** — a "Show archived" toggle reveals archived Reels and composes with "Favorites only". **Archive wins over Favorite**: an archived Favorite stays hidden unless "Show archived" is on. The second user-state flag, alongside the Favorite and the Draft.
_Avoid_: delete, hide, trash, remove

**Refresh**:
The cheap, analysis-preserving per-Reel update fired from the dashboard: re-pull engagement metrics + Comments, re-flag triggers, and re-mine FAQs. It NEVER downloads the Video or calls Gemini — the immutable analysis (transcript/topic/category/beats/why/keyword) is left untouched (ADR-0004/0007). Re-deriving the analysis after a prompt change is NOT Refresh's job; that is a Reprocess.
_Avoid_: update, re-pull, sync

**Reprocess**:
A deliberate re-derivation of the immutable analysis after a video-analysis prompt or schema change — mechanically a `full` pipeline run with the per-run **processing** caps lifted (CLI `--no-cap` → `max_analyses_per_run` + `max_faq_extractions_per_run`), so every drifted Reel (ADR-0003/0004 hash drift) in the tracked working set is re-analyzed in one pass rather than the newest `max_analyses_per_run`. A rare maintenance operation, not a per-Reel button: a prompt edit drifts the rendered hash for ALL Reels at once, so the natural unit is the backlog, not one Reel. Reprocess re-analyzes **what's already tracked** (bounded by `results_limit` + the 90-day window) — it does not widen coverage; pulling more of the window is a separate, deliberate `results_limit` change.
_Avoid_: re-analyze, deep refresh, regenerate
