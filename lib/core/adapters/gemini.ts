// Real GeminiPort adapter (ADR-0005: @google/genai). Lazily instantiated by
// analyze() ONLY when no port is injected, so tests (which always inject a fake
// port) never load the SDK and never make a network call (HARD INVARIANT #2).
//
// The shared-upload lifecycle (upload -> poll until ACTIVE -> use for BOTH the
// transcription and the analysis call -> delete) lives in analyze.ts; this adapter
// is the thin per-call seam. Each call uploads its own file because the GeminiPort
// contract is per-call and file-handle-free — keeping the port simple and fakeable.
// The transient .mp4 on disk is still downloaded once and deleted once by analyze.

import { readFileSync } from "node:fs";
import {
  GoogleGenAI,
  FileState,
  Type,
  createPartFromUri,
  createUserContent,
  type File as GeminiFile,
  type Schema,
} from "@google/genai";
import type {
  GeminiAnalysisResult,
  GeminiPort,
  GeminiTranscriptResult,
} from "../types.js";

const VIDEO_MIME = "video/mp4";
const UPLOAD_POLL_INTERVAL_MS = 1500;
const UPLOAD_POLL_TIMEOUT_MS = 5 * 60 * 1000;

/** Structured-output schema for the lean-core analysis (ADR-0003 lean core). */
const ANALYSIS_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    transcript: { type: Type.STRING },
    topic: { type: Type.STRING },
    category: { type: Type.STRING },
    hook_technique: { type: Type.STRING },
    beat_sequence: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING },
          start_pct: { type: Type.NUMBER },
          end_pct: { type: Type.NUMBER },
        },
        required: ["label", "start_pct", "end_pct"],
      },
    },
    why_it_works: { type: Type.STRING },
  },
  required: [
    "transcript",
    "topic",
    "category",
    "hook_technique",
    "beat_sequence",
    "why_it_works",
  ],
};

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY is not set — required for the real Gemini adapter (see build-spec.md env).",
    );
  }
  return key;
}

/** Upload a local video, poll until ACTIVE, return the ready File handle. */
async function uploadAndWait(ai: GoogleGenAI, videoPath: string): Promise<GeminiFile> {
  let file = await ai.files.upload({
    file: videoPath,
    config: { mimeType: VIDEO_MIME },
  });
  const deadline = Date.now() + UPLOAD_POLL_TIMEOUT_MS;
  while (file.state === FileState.PROCESSING) {
    if (Date.now() > deadline) {
      throw new Error(`Gemini file upload did not become ACTIVE in time: ${file.name}`);
    }
    await new Promise((r) => setTimeout(r, UPLOAD_POLL_INTERVAL_MS));
    if (!file.name) throw new Error("Gemini upload returned no file name");
    file = await ai.files.get({ name: file.name });
  }
  if (file.state !== FileState.ACTIVE) {
    throw new Error(`Gemini file failed to process (state=${file.state}): ${file.name}`);
  }
  return file;
}

async function deleteFile(ai: GoogleGenAI, file: GeminiFile): Promise<void> {
  if (!file.name) return;
  try {
    await ai.files.delete({ name: file.name });
  } catch {
    // Remote file cleanup is best-effort; files expire on their own (~48h).
  }
}

function fileToPart(file: GeminiFile) {
  if (!file.uri || !file.mimeType) {
    throw new Error("Gemini file missing uri/mimeType after upload");
  }
  return createPartFromUri(file.uri, file.mimeType);
}

/** Build the real GeminiPort. Reads GEMINI_API_KEY at construction time. */
export function makeGeminiPort(): GeminiPort {
  const ai = new GoogleGenAI({ apiKey: getApiKey() });

  return {
    async transcribe({ videoPath, prompt, model }): Promise<GeminiTranscriptResult> {
      const file = await uploadAndWait(ai, videoPath);
      try {
        const response = await ai.models.generateContent({
          model,
          contents: createUserContent([fileToPart(file), prompt]),
        });
        return { transcript: (response.text ?? "").trim() };
      } finally {
        await deleteFile(ai, file);
      }
    },

    async analyzeVideo({ videoPath, prompt, model, transcript }): Promise<GeminiAnalysisResult> {
      const file = await uploadAndWait(ai, videoPath);
      try {
        const response = await ai.models.generateContent({
          model,
          contents: createUserContent([
            fileToPart(file),
            `${prompt}\n\n## Verbatim transcript (for reference)\n${transcript}`,
          ]),
          config: {
            responseMimeType: "application/json",
            responseSchema: ANALYSIS_SCHEMA,
          },
        });
        const raw = (response.text ?? "").trim();
        const parsed = JSON.parse(raw) as GeminiAnalysisResult;
        return parsed;
      } finally {
        await deleteFile(ai, file);
      }
    },
  };
}

/** Read a local file's bytes (used by callers that want raw bytes). */
export function readVideoBytes(path: string): Buffer {
  return readFileSync(path);
}
