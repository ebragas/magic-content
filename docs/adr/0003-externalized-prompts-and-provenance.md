# Externalized, versioned prompts; config-driven taxonomy; per-record provenance

Every call to an external LLM references a prompt stored as its own markdown file under `prompts/` (e.g. `prompts/transcription.md`, `prompts/video-analysis.md`) — prompts are never inlined in code. The content-category taxonomy and the definition of each bucket live in `config/categories.yaml`, and the analysis prompt is parameterized from it. Each stored analysis records its **provenance**: which prompt file + version produced it, plus the Reel's canonical source URL.

The source project (`content-strategist`) inlines its Gemini prompt inside `analyze_videos.py`. We deliberately deviate: externalizing prompts lets us iterate on them without code changes, version them, and trace exactly which prompt produced any stored result. Config-driven categories let the taxonomy evolve without touching the prompt or code. Storing the source URL on every record satisfies the hard requirement that all analysis be traceable back to the original content.

This pairs with ADR-0004: because each record knows the prompt version that produced it, analysis can be cached as immutable and only recomputed when the prompt version changes.
