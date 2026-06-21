# Short-Form Vertical Video Performance Framework
## Observable Signals for AI-Driven Reel Analysis

**Version:** 1.0 | **Date:** June 2026

This framework defines the observable, machine-extractable signals that explain or predict the performance of short-form vertical videos (Instagram Reels, TikTok). It is grounded in 2024–2026 creator best-practice guides, platform algorithm documentation, and published data analyses. Enums are designed for use as controlled vocabularies in an LLM extraction schema.

> This document is the source of truth for what `prompts/video-analysis.md` asks Gemini to extract. **v1 captures only a deliberately lean core** — transcript, topic, category, hook technique, beat sequence, and why-it-works (see `prompts/video-analysis.md`). Everything else below is the backlog for widening the prompt once the pipeline is validated end-to-end. Some enums (e.g. audio trend tier, pattern-interrupt interval) may never be captured, because they are not reliably observable by a model from the video alone.

Each dimension includes: (a) what to observe, (b) a controlled vocabulary of variants, (c) why it matters for performance.

---

## 1. HOOK — First 1–3 Seconds

### (a) What to Observe
The hook is the opening gambit that determines whether a viewer scrolls past or commits to watching. Observe: the **technique type** used to open the video, whether the hook is **verbal** (spoken words), **visual** (imagery/action), or **textual** (on-screen text), and the **psychological trigger** it deploys. Also observe whether the hook **matches the actual payoff** of the video (mismatched hooks generate initial holds but tank watch time and long-term trust).

The 3-second hold rate is Instagram's and TikTok's earliest algorithmic signal. OpusClip's analysis of hundreds of accounts finds that Reels with a >60% 3-second hold outperform those with <40% hold by 5–10x in total reach. Losing viewers in the first 3 seconds is the single greatest reach-limiter.

A **strong hook** typically: opens mid-action or with a bold statement (no preamble), creates an information gap or challenges a belief, shows the creator's face with direct eye contact or deploys a striking visual, and has reinforcing on-screen text that restates or amplifies the verbal hook in large, bold type. A **weak hook** opens with: "Hey guys, welcome back," a slow pan of the setting, an introduction of the creator's name, or a generic statement that could apply to any video.

### (b) Controlled Vocabulary

**hook_technique** (pick primary):
- `contrarian` — Challenges conventional wisdom. "Everyone says X, but actually Y."
- `question` — Direct question that creates internal response. "Are you making this mistake?"
- `mistake` — Admits or warns of an error. "I lost $5K because of this."
- `numbered_list` — Promises structured value. "3 things that tripled my reach."
- `time_based` — Efficiency/result in compressed time. "What 30 days of daily posting taught me."
- `cold_open` — Drops into the most compelling moment first, then backtracks.
- `tension_visual` — Creates suspense or danger through imagery (rope, moving object, countdown).
- `pattern_interrupt` — Unexpected visual/audio that violates the expected opening frame.
- `social_proof` — Leads with a result, credential, or impressive number.
- `curiosity_gap` — Implies hidden knowledge. "The feature 90% of creators ignore."
- `trend_adoption` — Opens by participating in a recognized trending audio/format.
- `transformation` — Before/after promise or visual reveal stated immediately.

**hook_modality** (all that apply):
- `verbal_spoken` — Creator speaks the hook on camera
- `verbal_voiceover` — Hook delivered as narration over visuals
- `visual_only` — Hook is a striking image or action with no words needed
- `text_overlay` — Bold on-screen text reinforces or carries the hook
- `text_only` — Hook delivered entirely via on-screen text (silent watch-friendly)

**hook_psychological_trigger** (primary):
- `curiosity` — Information gap; viewer must watch to close
- `controversy` — Challenges a belief; creates cognitive dissonance
- `fomo` — Suggests exclusive or time-sensitive information
- `social_proof` — Authority, results, or popularity signal
- `immediate_value` — Promises a quick win or takeaway
- `fear_of_mistake` — Warns of a common error the viewer might be making
- `emotional_resonance` — Humor, nostalgia, or relatability trigger

**hook_quality_signal**:
- `strong` — Opens with specific value, action, or claim; no preamble; reinforced by text; direct eye contact or striking visual
- `weak` — Opens with introduction, greetings, or generic statement; slow build; no on-screen text; viewer must wait for the point

### (c) Why It Matters
The 3-second hold is the primary early algorithmic signal on both TikTok and Instagram. TikTok's four-stage testing process (OpusClip/TikTok newsroom, 2025) shows that content is first tested with 200–500 non-follower viewers; only if hold and watch time exceed category benchmarks does the algorithm push to progressively larger audiences. An Instagram Insights study cited by OpusClip found that Reels with strong 3-second holds (>60%) outperform weak-hook Reels by 5–10x in total reach. Per Tech With Landon (Medium, 2024): "65% of viewers drop off within the first three seconds if they aren't immediately hooked."

---

## 2. BEAT STRUCTURE — The Video's Ordered Moments

### (a) What to Observe
A "beat" is a discrete structural moment in the video with a distinct purpose. Short-form videos that retain viewers tend to follow a recognizable arc, even in 15–60 seconds. Observe: the sequence of beats present, their approximate position (as % of total duration), and whether the video closes with a payoff that matches the hook's promise.

Multiple practitioner sources (Jemilla the Hyphenate, Jan 2026; OpusClip, 2025; Digital Applied, 2026) converge on a core arc: hook → value delivery → payoff → CTA/loop. The TikTok algorithm guide (OpusClip, 2025) recommends a "progressive value delivery" pattern where each segment delivers incrementally stronger value, keeping completion rate high by front-loading quality rather than back-loading it.

### (b) Controlled Vocabulary

**beat_sequence** — an ordered array of beat labels (each optionally with `start_pct`/`end_pct`). Canonical beats:

- `HOOK` — 0–10% of duration. The attention-capture moment.
- `CONTEXT` — 10–20% of duration. Brief setup: who this is for, what problem/situation it addresses.
- `VALUE_1` — First substantive piece of value, teaching, or story development.
- `VALUE_2` — Second beat of value, ideally stronger than VALUE_1.
- `VALUE_3` — Third beat (present in longer videos; optional in <30s).
- `TENSION` — A complication, twist, or obstacle that raises stakes mid-video.
- `PAYOFF` — The resolution, reveal, punchline, or result promised by the hook.
- `ESCALATION` — A "wait, there's more" beat that adds an unexpected layer after the payoff.
- `CTA` — Call to action: follow, comment, save, share, click link.
- `LOOP_BRIDGE` — A closing frame that connects back to the opening, enabling seamless replay.

**Example beat sequences by format:**
- Quick tip (15–30s): `HOOK → VALUE_1 → PAYOFF → CTA`
- Tutorial (30–60s): `HOOK → CONTEXT → VALUE_1 → VALUE_2 → PAYOFF → CTA`
- Story/personal (45–90s): `HOOK → CONTEXT → TENSION → VALUE_1 → PAYOFF → CTA`
- Listicle (30–60s): `HOOK → VALUE_1 → VALUE_2 → VALUE_3 → PAYOFF → CTA`
- Looping video: `HOOK → VALUE_1 → VALUE_2 → PAYOFF → LOOP_BRIDGE`

**beat_payoff_alignment**:
- `aligned` — Payoff clearly delivers what the hook promised
- `partial` — Payoff partially delivers; some hook promise unfulfilled
- `mismatched` — Hook promised something different from what was delivered

**beat_cta_present**: `true` / `false`

**beat_loop_present**: `true` / `false`

### (c) Why It Matters
Beat structure directly controls watch time and completion rate — the two metrics most weighted by both TikTok's algorithm (TikTok newsroom, cited in OpusClip 2025: "User Interactions account for ~70% of algorithmic weight, with watch time and completion rate as the strongest signals") and Instagram's. The TikTok algorithm documentation confirms that shares are weighted 3x higher than likes, and saves indicate future-reference intent — both of which require the viewer to reach the payoff or CTA beat. A video with strong hook but no payoff has high initial hold but low completion; a video with no hook but a great payoff never gets watched long enough to matter.

---

## 3. VISUAL THEMES & MOTIFS

### (a) What to Observe
Observe the **primary visual format** (how the creator appears), **setting/aesthetic**, **text overlay style**, **pattern interrupt frequency**, **color and lighting quality**, and the presence of **b-roll** vs. pure talking-head delivery. Also observe **caption style** (auto-captions vs. styled text, placement, font size) and **transition type**.

Tech With Landon (Medium, 2024) cites data that "videos with frequent scene changes see a 32% increase in retention compared to static-shot videos." OpusClip and Digital Applied (2026) note that behind-the-scenes, raw, and authentic talking-head content sees 31% higher engagement than heavily produced content on TikTok. Instagram Reels, by contrast, rewards higher visual polish and aesthetic consistency.

### (b) Controlled Vocabulary

**primary_visual_format**:
- `talking_head` — Creator faces camera and speaks; single static shot
- `talking_head_broll` — Talking head with intercut b-roll visuals
- `screen_record` — Screen capture (tool demos, tutorials)
- `voiceover_broll` — No on-camera creator; narration over footage
- `text_only_slideshow` — No creator visible; sequential text/graphic slides
- `duet_stitch` — Creator responds to or builds on another creator's video
- `pov` — Point-of-view shot; viewer experiences from creator's perspective
- `behind_scenes` — Raw, unpolished "fly on the wall" footage
- `product_demo` — Product or tool shown in use (with or without creator)
- `trend_format` — Follows a recognized trend template (specific audio + visual structure)

**setting_aesthetic**:
- `home_casual` — Bedroom, living room, kitchen; informal
- `home_studio` — Dedicated filming setup at home; cleaner background
- `outdoor_natural` — Parks, streets, nature; natural light
- `professional_office` — Desk, corporate or branded environment
- `on_location` — Venue, event, or specific location relevant to content
- `graphic_only` — No real-world footage; animated or designed visuals

**text_overlay_style**:
- `auto_captions_minimal` — System-generated subtitles, small, at bottom
- `styled_captions` — Custom-styled captions (large font, color, animation)
- `keyword_callouts` — Key phrases highlighted/animated mid-screen
- `title_cards` — Full-screen text beats between visual moments
- `none` — No text overlay

**pattern_interrupt_frequency**:
- `none` — Single static scene throughout
- `low` — 1–2 scene or visual changes (cuts every 10–15s)
- `medium` — Cuts every 3–7 seconds; some b-roll or angle changes
- `high` — Cuts every 1–3 seconds; frequent b-roll, zoom, angle switches

**transition_type**:
- `jump_cut` — Direct cut; no transition effect
- `match_cut` — Action or shape in one shot continues into next
- `whip_pan` — Fast lateral camera swing used as transition
- `effect_transition` — App-based effect (swipe, zoom, spin, morphcut)
- `none` — Single continuous shot

**caption_presence**: `true` / `false`

**visual_quality**:
- `high` — Well-lit, stable, 1080p+, intentional framing
- `medium` — Acceptable light and stability; some imperfections
- `low` — Poor lighting, shaky camera, or low resolution

### (c) Why It Matters
Visual variety is a direct retention lever: the algorithm interprets drop-offs at specific timestamps as a signal to stop promoting the video. TikTok's algorithm explicitly analyzes "visual elements, filters, and effects" as part of its Video Information ranking category (TikTok official documentation, cited in OpusClip 2025). Captions matter because, per multiple practitioner sources, approximately 80% of viewers watch without audio; captions make hook text visible in the silent scroll. On Instagram, visual quality and aesthetic consistency directly correlate with saves and shares (Digital Applied, 2026: "Instagram's algorithm considers visual quality and production value"). On TikTok, raw/authentic visuals outperform polished production — a platform-specific difference practitioners note consistently.

---

## 4. PACING & EDITING

### (a) What to Observe
Observe the **average cut frequency** (cuts per minute), the **overall energy** of the edit, whether **pacing matches content type** (high-energy cuts for entertainment; steadier pace for education), and whether the editor uses **audio-sync editing** (cuts aligned to beat drops or rhythmic audio cues). Also observe for **jump cuts** to remove pauses and **slow-motion** for emphasis.

Tech With Landon (Medium, 2024): "Videos with frequent scene changes see a 32% increase in retention." TikTok algorithm data (OpusClip 2025) recommends a "Pattern Interrupt Strategy every 10–15 seconds" to prevent viewer drop-off — visual changes, topic shifts, text overlays, or audio changes at regular intervals.

### (b) Controlled Vocabulary

**pacing_energy**:
- `slow` — <5 cuts per minute; long takes; deliberate, calm
- `moderate` — 5–15 cuts per minute; steady rhythm
- `fast` — 15–30 cuts per minute; energetic
- `very_fast` — 30+ cuts per minute; rapid-fire; high stimulation

**audio_sync_editing**: `true` / `false` — Cuts timed to musical beat or audio cue

**jump_cuts_used**: `true` / `false` — Visible cuts that remove pauses mid-sentence or mid-action

**slow_motion_used**: `true` / `false`

**pacing_appropriateness** (evaluative signal):
- `matched` — Pacing fits content type (e.g., fast for trend/entertainment; moderate for tutorial)
- `too_slow` — Pacing drags relative to content type expectations
- `too_fast` — Cuts so rapid that content is difficult to follow

**pattern_interrupt_interval_seconds** — Numeric: approximate seconds between significant visual or topic changes (e.g., 8, 12, 15)

### (c) Why It Matters
Pacing is the primary driver of moment-to-moment retention. The TikTok algorithm tracks "high drop-off rates at specific timestamps" as a negative signal (OpusClip/TikTok documentation, 2025). Fast, rhythmic editing maintains the "low-attention state" scroll pattern by providing constant visual novelty. However, pacing must match content type: a complex tutorial with 2-second cuts confuses rather than retains. Jemilla the Hyphenate (Jan 2026): "If your video drags, people leave. So use jump cuts to speed up slow parts and keep the energy high."

---

## 5. AUDIO

### (a) What to Observe
Observe the **audio type** (trending sound, original audio, voiceover, sync sound), the **presence of music** behind spoken content, **audio quality**, and whether the creator is using **early-trend audio** (rising, not yet saturated) or **saturated-trend audio** (used by hundreds of thousands). Also note if the video is **silent-watch-friendly** (hook and value comprehensible without audio via text/captions).

Adobe (May 2025): "Reels featuring trending audio can have 29% greater reach and 42% more engagement compared to content without audio." OpusClip (TikTok 2026 algorithm): "In 2026, content quality and completion rates now matter more than posting frequency or trending audio alone" — a notable hedge that audio advantage has diminished from its 2022–2024 peak, but remains meaningful.

### (b) Controlled Vocabulary

**audio_type**:
- `trending_sound` — Platform-trending audio (music or clip); currently rising
- `trending_sound_saturated` — Previously trending audio; now used by many
- `original_audio` — Creator's own original sound or voice
- `licensed_music` — Background music that is not a platform trend
- `voiceover_only` — Creator narration over silent or music-backed visuals
- `sync_sound` — Audio captured live with the video footage
- `sound_effects` — Punctuation sounds (notification dings, transitions) added in edit
- `no_audio` — Silent; relies entirely on text

**audio_trend_tier** (often not observable from video alone — requires platform data):
- `early_adopter` — Sound used by <10K videos; rising
- `peak_trend` — Sound at maximum use; 10K–500K uses
- `saturated` — Sound used by 500K+ videos; past peak
- `original_or_non_trend` — Not a platform trend

**music_present_under_speech**: `true` / `false`

**audio_quality**:
- `high` — Clear voice, minimal background noise, professional or lav mic
- `medium` — Audible but some ambient noise or room reverb
- `low` — Muffled, noisy, or hard to understand

**silent_watch_friendly**: `true` / `false` — Can the video be understood without audio?

### (c) Why It Matters
Trending audio functions as a discovery channel on both platforms — content using a trending sound is surfaced to users browsing that sound. Adobe (2025) cites 29% greater reach and 42% more engagement for Reels with trending audio vs. none. However, early adoption of a trend outperforms late adoption: OpusClip's "Trending Audio Hierarchy" notes that early authentic adoption yields the strongest distribution boost, while forced trend-jacking underperforms. Original audio can make a creator recognizable and has its own algorithmic benefit if it goes trending. Audio quality directly affects retention; per Jemilla the Hyphenate (Jan 2026): "People will tolerate a bad video, but they will absolutely just scroll past bad audio."

---

## 6. RETENTION & RE-WATCH DEVICES

### (a) What to Observe
Observe intentional mechanics designed to (a) keep viewers watching past the hook, (b) trigger a replay, or (c) create an open loop that holds attention until the payoff. Key devices: **seamless loop endings**, **open loops** (questions or tensions introduced but not immediately resolved), **curiosity gap escalation** (teasing what's coming), **mid-video pattern interrupts**, and **payoff placement** (withholding the key reveal until near the end).

Tech With Landon (Medium, 2024) explicitly cites loops as a key metric: "Videos that seamlessly loop encourage replays, further boosting retention." TikTok's algorithm documentation (via OpusClip 2025) confirms that "re-watches and loops" are among the strongest positive signals. The open-loop technique is widely cited by practitioners: introducing a question or tension the viewer must watch to resolve.

### (b) Controlled Vocabulary

**seamless_loop**: `true` / `false` — The video's final frame connects back to the first frame; ending does not signal closure (no "thanks for watching," no outro)

**open_loops_present**: `true` / `false` — An unresolved question or tension is introduced in the hook or early beats and paid off later in the video

**open_loop_count**: numeric (0–5) — How many distinct open loops are seeded

**curiosity_gap_escalation**: `true` / `false` — Viewer is given incremental hints ("and the best part is...," "but wait") that promise a coming payoff, delaying full resolution

**payoff_placement**:
- `early` — Main reveal or value comes before the 50% mark
- `mid` — Main reveal comes between 50–75% of the video
- `late` — Main reveal comes in the final 25% of the video
- `after_cta` — Payoff or punchline comes after the CTA, rewarding viewers who watched through

**pattern_interrupt_type** (all that apply):
- `visual_cut` — Scene change, angle switch, zoom
- `topic_pivot` — "But here's what nobody tells you..."
- `text_pop` — On-screen text appearing mid-video to highlight a point
- `audio_change` — Music drop, sound effect, or voice shift
- `physical_action` — Creator moves, turns, gestures dramatically

**mid_roll_retention_hook**: `true` / `false` — A secondary hook mid-video that re-engages viewers who may be drifting (e.g., "stick around because the last point is the most important")

### (c) Why It Matters
Re-watches and loops are among the highest-weight positive signals in TikTok's algorithm (listed alongside shares and saves as "strongest signals" in TikTok's official documentation, cited in OpusClip 2025). A seamlessly looping video artificially boosts completion rate (the video restarts before the viewer actively stops it) and increases replay count. Open loops work via the Zeigarnik Effect — the brain is compelled to resolve incomplete tasks — which keeps viewers watching through to the payoff. Tech With Landon (2024) cites 85% retention rate as the threshold at which videos are "nearly twice as likely to go viral." Withholding the payoff until late in the video is the single most reliable mechanical lever for high completion rate.

---

## 7. CTA & ENGAGEMENT BAIT

### (a) What to Observe
Observe: **whether a CTA is present**, **what action is requested**, **placement** within the video (verbal, in caption, or both), and whether the CTA is **specific and low-friction** (e.g., "comment your answer below") vs. **high-friction** (e.g., "go to the link in my bio and sign up"). Also observe **engagement bait mechanics** — prompts designed to generate comments, saves, or shares that boost algorithmic distribution.

Alex Cattoni (CopyPosse, 2022, still widely cited 2024–2025): distinguishes three CTA categories: Trust (engagement/comment prompts), Lead (DM or email capture), and Sale (purchase/conversion). For algorithmic performance, comment and save CTAs outperform like CTAs. Brock Johnson (May 2025): "Shares are the best form of engagement on Instagram if you want more views."

### (b) Controlled Vocabulary

**cta_present**: `true` / `false`

**cta_action_type** (primary):
- `comment_prompt` — "Comment below," "drop an emoji," "tell me in the comments"
- `save_prompt` — "Save this for later," "bookmark this"
- `share_prompt` — "Send this to someone who needs it," "share to your story"
- `follow_ask` — "Follow for more," "don't miss the next one"
- `dm_ask` — "DM me [word] for [resource]"
- `link_in_bio` — Directs to external resource
- `duet_stitch_invite` — "Duet this," "stitch your version"
- `tag_someone` — "Tag a friend who does this"
- `none` — No explicit CTA

**cta_placement**:
- `verbal_in_video` — Spoken by creator
- `text_overlay` — On-screen text CTA
- `caption_only` — CTA lives in the caption below the video
- `verbal_and_caption` — Both
- `end_card` — Appears as a closing slide or frame

**cta_friction**:
- `low` — One-step action (comment, like, save)
- `medium` — Two-step action (DM + receive resource)
- `high` — Multi-step action requiring leaving the app

**engagement_bait_mechanic** (all that apply):
- `opinion_poll` — Asks viewers to pick a side or vote ("agree or disagree?")
- `completion_reward` — Implies there's a payoff for those who watch the whole video
- `keyword_cta` — "Comment [word] and I'll send you [thing]" (automates DM delivery)
- `divisive_statement` — Makes a claim designed to provoke disagreement and comments
- `tag_mechanic` — Asks viewers to tag a specific type of person
- `series_tease` — "Part 2 coming tomorrow"; creates return-viewer obligation

### (c) Why It Matters
Engagement signals (comments, saves, shares) are medium-to-strong signals in TikTok's algorithm (OpusClip/TikTok documentation 2025: comments — especially longer threaded comments — and saves are medium signals; shares are strong, weighted 3x likes). On Instagram, saves signal high-value content. The keyword CTA mechanic (comment a word → receive DM) generates both comment count and DM engagement. Brock Johnson (May 2025) explicitly states shares outperform all other engagement types for reach on Instagram.

---

## 8. CONTENT CATEGORY / FORMAT

### (a) What to Observe
The high-level genre of the video — what the video fundamentally *is* and *does* for the viewer. This is the most coarse-grained classification. A single video may blend formats (e.g., a tool demo told as a personal story), but one format is usually dominant.

> **Project note:** the durable, sortable **Category** the dashboard uses is our own coarse YAML-configured enum (Tool Demo, Concept Teaching, Story/Personal, Commentary/Opinion, Promo/Offer, News, Other) — see `config/categories.yaml`. The finer `content_format` vocabulary below is a richer signal Gemini can also emit; the two are related but the Category enum is the one we govern.

### (b) Controlled Vocabulary

**content_format** (primary):
- `quick_tip` — A single actionable tip or hack delivered efficiently (<30s)
- `listicle` — Numbered list structure ("5 ways to...," "3 mistakes...")
- `tutorial_howto` — Step-by-step instructional content
- `concept_explainer` — Explains an idea, framework, or mental model; not step-by-step
- `myth_busting` — Challenges a common misconception
- `tool_demo` — Demonstrates a product, app, or tool in use
- `before_after` — Transformation reveal; result shown before/after context
- `storytime` — Personal narrative or experience told as a story
- `opinion_hot_take` — Creator's point of view or controversial stance on a topic
- `commentary` — Reacting to or analyzing external content, events, or trends
- `day_in_life` — POV slice-of-life content showing routine or experience
- `trend_participation` — Joins a platform-specific audio or format trend
- `challenge` — Participates in or issues a challenge
- `collab_duet_stitch` — Reactive content built on another creator's video
- `promotional` — Paid sponsorship or organic product/service promotion
- `entertainment_comedy` — Primarily humorous or entertaining with no educational angle
- `series_episode` — Part of an ongoing numbered or themed series

**content_format_blend**: `true` / `false` — Primary format blends meaningfully with a secondary format

**content_format_secondary** (if blend = true): same enum as above

**niche_specificity**:
- `broad` — Appeals to general audience; no specific niche required
- `niche` — Clearly targets a specific community or interest category
- `hyper_niche` — Extremely specific; narrow but highly engaged potential audience

### (c) Why It Matters
Format determines viewer intent and therefore the engagement signals available. Educational formats (quick_tip, tutorial, concept_explainer) generate saves — viewers bookmark for future reference. Entertaining formats (entertainment_comedy, challenge, trend_participation) generate shares. Personal formats (storytime, day_in_life, opinion_hot_take) generate comments. Promotional content sees lower organic reach unless the entertainment or value ratio is high. Myth-busting and hot-take formats tend to generate divisive comments, which increases algorithmic velocity. Digital Applied (2026) notes that YouTube Shorts favors how-to, TikTok favors entertainment, and Instagram favors shareable and visually polished formats — so format-platform fit matters.

---

## SIGNALS MOST ASSOCIATED WITH VIRALITY

The following signals are the most consistently cited across sources as correlating with outsized performance. **Caveat:** all of these are correlational, not causal. They reflect what high-performing videos tend to share, not what guarantees any given video will go viral. Effectiveness is creator/niche/timing-dependent and varies across platforms.

**Prioritized shortlist (roughly in descending cross-source consensus):**

1. **Strong hook with >60% 3-second hold rate.** The single most cited variable across all sources. OpusClip data: Reels with >60% 3-second hold outperform <40% by 5–10x. Without this, nothing else matters.
2. **High completion rate / late payoff placement.** TikTok's algorithm weights completion rate as the heaviest user interaction signal. Videos that withhold the core reveal until the final 25% mechanically force higher completion. Tech With Landon (2024): videos with 85% retention are "nearly twice as likely to go viral."
3. **Shares (DMs and story shares).** Brock Johnson (May 2025): "Shares are the best form of engagement on Instagram if you want more views." TikTok documentation (via OpusClip 2025): shares weighted 3x more than likes.
4. **Seamless loop or re-watch trigger.** Loop and re-watch behavior is explicitly listed as a strongest positive signal in TikTok's algorithm documentation.
5. **Saves (bookmarks).** Saves indicate future-reference intent — a strong quality signal. Strongest for educational and listicle formats.
6. **Early-trend audio adoption.** Early authentic adoption (sound used by <10K videos) yields the strongest distribution boost. Adobe (2025): trending audio correlates with 29% greater reach and 42% more engagement. *Caveat:* this advantage has decreased in relative importance vs. 2022–2023.
7. **Niche content consistency.** OpusClip 2025: creators posting across 3+ unrelated topics see 45% lower reach than topic-consistent creators. *Note: a channel-level, not video-level, signal.*
8. **Specific + unexpected hook claim.** Extreme specificity (a concrete number, result, or named error) combined with a mildly surprising claim is the hook pattern that most reliably stops scroll. Vague hooks ("this changed everything") are a common failure mode.

**What the sources do NOT agree on:**
- Optimal video length is contested and platform-dependent (TikTok favors 60–180s for watch-time reasons; Instagram Reels reportedly peaks at 7–30s). Do not treat length as a reliable virality predictor independent of completion rate.
- Posting frequency: cited by some as important for growth, but OpusClip (2026) states "one highly engaging video per week outperforms seven mediocre daily posts."
- Hashtags: Adam Mosseri (Instagram head) and multiple sources state hashtags "do not reliably increase reach" on Instagram as of 2025; their TikTok importance has "declined significantly since 2023."

---

## Sources

1. [Instagram Reels Hook Formulas That Drive 3-Second Holds — OpusClip](https://www.opus.pro/blog/instagram-reels-hook-formulas) (2025)
2. [TikTok's New Algorithm 2026 — OpusClip](https://www.opus.pro/blog/tiktoks-new-algorithm-2026) (2025–2026)
3. [Why Audio Is So Important in Social Media — Adobe Express](https://www.adobe.com/express/learn/blog/trending-audio-social-media-content) (May 2025)
4. [Short-Form Video Strategy: Shorts vs TikTok vs Reels — Digital Applied](https://www.digitalapplied.com/blog/short-form-video-strategy-shorts-tiktok-reels-2026) (2026)
5. [Want Over 70% Retention on Your Short-Form Videos? — Tech With Landon, Medium](https://medium.com/@techwithlandon/want-over-70-retention-on-your-short-form-videos-heres-how-to-do-it-5ce7bae94a43) (December 2024)
6. [5 EASY Instagram Reels to Go Viral in 2025 — Brock Johnson / Build Your Tribe](https://www.youtube.com/watch?v=uBHMPr8xjMc) (May 2025)
7. [How to Create Viral Short-Form Videos That Actually Get Views — Jemilla the Hyphenate](https://www.youtube.com/watch?v=82Ha_fLy5No) (January 2026)
8. [24 Social Media CTAs That Will Boost Traffic, Engagement & Sales — Alex Cattoni / CopyPosse](https://www.youtube.com/watch?v=vYXhUPMd_JM) (2022; principles widely cited 2024–2025)
9. [How TikTok Recommends Videos For You — TikTok Newsroom](https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you) (official documentation)
10. [We Analyzed Over 1,000,000 Short-Form Videos — r/SocialMediaMarketing](https://www.reddit.com/r/SocialMediaMarketing/comments/1p0qb2m/we_analyzed_over_1000000_shortform_videos_heres/) (2025)
