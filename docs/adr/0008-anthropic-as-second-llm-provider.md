# Anthropic (Claude) as a second LLM provider alongside Gemini

We add a fourth dependency port, `AnthropicPort`, for the two new *language* tasks — FAQ clustering (`extractFaqs`, Claude Haiku 4.5) and Draft generation (`generateDraft`, Claude Sonnet 4.6) — rather than reusing the already-wired Gemini for them. The system now depends on two LLM vendors.

## Considered options

- **Reuse Gemini** for FAQ + Draft. Rejected: it adds no new vendor but conflates two genuinely different jobs, and the Draft (the feature's payoff) is where instruction-following and writing quality matter most.
- **Add Anthropic** (chosen). Clean separation: Gemini owns *video* (transcription + visual analysis of an immutable artifact); Claude owns *language* (clustering questions, writing hooks/scripts/reasoning).

## Consequences

- A second SDK, API key (`ANTHROPIC_API_KEY`), and adapter — engaged via the same DI seam (HARD INVARIANT #2): dynamic `import()` only when the key is set, so the SDK never loads in tests and the pipeline stays a safe no-op without it.
- Model choices are externalized in `settings.yaml` (mirroring `gemini_model`): cheap Haiku for high-volume mechanical FAQ work, stronger Sonnet for the user-facing Draft.
- Cost is bounded structurally: FAQ extraction rides the batch caps (`max_faq_extractions_per_run`), Draft generation is on-demand only.
