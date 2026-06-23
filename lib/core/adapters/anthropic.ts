// Real AnthropicPort adapter (ADR-0008: @anthropic-ai/sdk). Lazily instantiated by the FAQ
// leg ONLY when no port is injected AND ANTHROPIC_API_KEY is set, so tests (which always
// inject a fake port) never load the SDK and never make a network call (HARD INVARIANT #2).
// Mirrors the GEMINI_API_KEY / APIFY_TOKEN auto-engagement elsewhere.
//
// Claude owns the LANGUAGE tasks (ADR-0008): here, clustering a Reel's non-trigger Comments
// into canonical FAQs. The prompt is the externalized template from prompts/faq-extraction.md
// with the per-Reel comments + context injected; the model returns clusters of {question,
// member_indices} over the compact 1..N indices the caller tagged the Comments with. Index
// VALIDATION (dropping out-of-range members) is the caller's job (faqs.ts) — this adapter
// only renders the prompt, calls Claude, and parses the JSON shape.

import Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "../config.js";
import type { AnthropicPort, Beat, BeatLabel, FaqCluster } from "../types.js";

const TOPIC_TOKEN = "{{TOPIC}}";
const TRANSCRIPT_TOKEN = "{{TRANSCRIPT}}";
const COMMENTS_TOKEN = "{{COMMENTS}}";
const CATEGORY_TOKEN = "{{CATEGORY}}";
const HOOK_TECHNIQUE_TOKEN = "{{HOOK_TECHNIQUE}}";
const WHY_IT_WORKS_TOKEN = "{{WHY_IT_WORKS}}";
const BEATS_TOKEN = "{{BEATS}}";
const FAQS_TOKEN = "{{FAQS}}";
const ORIGINAL_CAPTION_TOKEN = "{{ORIGINAL_CAPTION}}";

/** JSON Schema constraining the model to the {clusters:[{question, member_indices}]} shape. */
const FAQ_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    clusters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          question: { type: "string" },
          member_indices: { type: "array", items: { type: "integer" } },
        },
        required: ["question", "member_indices"],
      },
    },
  },
  required: ["clusters"],
};

/**
 * JSON Schema constraining the Draft to the {hooks, beat_scripts, reasoning, caption} shape.
 * The shape is FORCED again in draft.ts (exactly 3 hooks / one suggested / beats re-aligned),
 * so this schema is the model's first guardrail, not the only one.
 */
const DRAFT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    hooks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          suggested: { type: "boolean" },
        },
        required: ["text", "suggested"],
      },
    },
    beat_scripts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          script: { type: "string" },
        },
        required: ["label", "script"],
      },
    },
    reasoning: { type: "string" },
    caption: { type: "string" },
  },
  required: ["hooks", "beat_scripts", "reasoning", "caption"],
};

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — required for the real Anthropic adapter (see .env.example).",
    );
  }
  return key;
}

/**
 * Render the FAQ-extraction prompt: inject the Reel's topic + transcript context and the
 * numbered comment list into the externalized template. The numbering MUST match the `idx`
 * the caller tagged each comment with (1..N), so member_indices map back unambiguously.
 */
function renderFaqPrompt(
  template: string,
  comments: { idx: number; text: string; likes: number }[],
  context: { topic: string | null; transcript: string | null } | undefined,
): string {
  const commentBlock = comments
    .map((c) => `#${c.idx} (${c.likes} likes): ${c.text}`)
    .join("\n");
  return template
    .replace(TOPIC_TOKEN, context?.topic?.trim() || "(unknown)")
    .replace(TRANSCRIPT_TOKEN, context?.transcript?.trim() || "(none)")
    .replace(COMMENTS_TOKEN, commentBlock);
}

/**
 * Render the Draft-generation prompt: inject the Reel's analysis (topic/category/hook/why/
 * transcript + its beat labels in order), its FAQs (strongest first), and the original caption
 * into the externalized template. The beat block lists ONLY the analyzed labels in order so the
 * model mirrors them; an empty beat list renders "(none)" and draft.ts enforces an empty
 * beat_scripts array regardless of what the model returns.
 */
function renderDraftPrompt(
  template: string,
  input: {
    analysis: {
      transcript: string | null;
      beat_sequence: Beat[];
      hook_technique: string | null;
      why_it_works: string | null;
      topic: string | null;
      category: string | null;
    };
    faqs: { question: string; support_count: number; support_likes: number }[];
    originalCaption: string | null;
  },
): string {
  const { analysis, faqs, originalCaption } = input;
  const beatBlock =
    analysis.beat_sequence.length > 0
      ? analysis.beat_sequence.map((b, i) => `${i + 1}. ${b.label}`).join("\n")
      : "(none)";
  const faqBlock =
    faqs.length > 0
      ? faqs
          .map(
            (f) => `- "${f.question}" (${f.support_count} asking, ${f.support_likes} likes)`,
          )
          .join("\n")
      : "(none)";
  return template
    .replace(TOPIC_TOKEN, analysis.topic?.trim() || "(unknown)")
    .replace(CATEGORY_TOKEN, analysis.category?.trim() || "(unknown)")
    .replace(HOOK_TECHNIQUE_TOKEN, analysis.hook_technique?.trim() || "(unknown)")
    .replace(WHY_IT_WORKS_TOKEN, analysis.why_it_works?.trim() || "(none)")
    .replace(TRANSCRIPT_TOKEN, analysis.transcript?.trim() || "(none)")
    .replace(BEATS_TOKEN, beatBlock)
    .replace(FAQS_TOKEN, faqBlock)
    .replace(ORIGINAL_CAPTION_TOKEN, originalCaption?.trim() || "(none)");
}

/**
 * Build the real AnthropicPort. Reads ANTHROPIC_API_KEY at construction time and the FAQ
 * prompt template + faq_model from the loaded config (so the prompt stays externalized and
 * the model stays config-tunable, mirroring gemini_model).
 */
export function makeAnthropicPort(config: AppConfig): AnthropicPort {
  const client = new Anthropic({ apiKey: getApiKey() });
  const faqTemplate = config.prompts.faqExtractionTemplate;
  const faqModel = config.settings.faq_model;
  const draftTemplate = config.prompts.draftGenerationTemplate;
  const draftModel = config.settings.draft_model;

  return {
    async extractFaqs({ comments, context }): Promise<{ clusters: FaqCluster[] }> {
      const prompt = renderFaqPrompt(faqTemplate, comments, context);
      const response = await client.messages.create({
        model: faqModel,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
        output_config: { format: { type: "json_schema", schema: FAQ_SCHEMA } },
      });
      // Concatenate the text blocks (structured output arrives as JSON text) and parse.
      const raw = response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("")
        .trim();
      const parsed = JSON.parse(raw) as { clusters?: FaqCluster[] };
      return { clusters: Array.isArray(parsed.clusters) ? parsed.clusters : [] };
    },

    async generateDraft(input): Promise<{
      hooks: { text: string; suggested: boolean }[];
      beat_scripts: { label: BeatLabel; script: string }[];
      reasoning: string;
      caption: string;
    }> {
      // The Draft runs on the stronger Sonnet (draft_model) — it's the feature's payoff (ADR-0008).
      // The adapter only renders + calls + parses the JSON shape; draft.ts owns the hard guarantees
      // (exactly 3 hooks / one suggested / beat_scripts re-aligned to the real analyzed beats).
      const prompt = renderDraftPrompt(draftTemplate, input);
      const response = await client.messages.create({
        model: draftModel,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
        output_config: { format: { type: "json_schema", schema: DRAFT_SCHEMA } },
      });
      const raw = response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("")
        .trim();
      const parsed = JSON.parse(raw) as {
        hooks?: { text: string; suggested: boolean }[];
        beat_scripts?: { label: BeatLabel; script: string }[];
        reasoning?: string;
        caption?: string;
      };
      return {
        hooks: Array.isArray(parsed.hooks) ? parsed.hooks : [],
        beat_scripts: Array.isArray(parsed.beat_scripts) ? parsed.beat_scripts : [],
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
        caption: typeof parsed.caption === "string" ? parsed.caption : "",
      };
    },
  };
}
