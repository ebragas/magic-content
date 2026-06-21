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
