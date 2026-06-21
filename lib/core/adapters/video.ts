// Real VideoPort adapter — transient Video (.mp4) download + thumbnail persistence
// + Video deletion (CONTEXT.md: the Video is transient; only the thumbnail is kept).
//
// Lazily instantiated by scrape()/analyze() ONLY when no port is injected, so tests
// (which always inject a fake VideoPort) never touch the network or the real
// filesystem (HARD INVARIANT #2). Downloads land under data/ which is gitignored.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { VideoPort } from "../types.js";

// Next/CLI/tests run from the project root, so cwd points at <root> where data/ lives.
const ROOT = process.cwd();
const THUMBNAIL_DIR = resolve(ROOT, "data", "thumbnails");

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download failed (${res.status}) for ${url}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/** Build the real VideoPort backed by fetch + the local filesystem. */
export function makeVideoPort(): VideoPort {
  return {
    async downloadVideo({ url, shortcode }): Promise<string> {
      // Videos are TRANSIENT: write to the OS temp dir, not data/, so a crash never
      // leaves an .mp4 behind in the durable store directory.
      const path = join(tmpdir(), `magic-content-${shortcode}.mp4`);
      const bytes = await fetchBytes(url);
      await writeFile(path, bytes);
      return path;
    },

    async downloadThumbnail({ url, shortcode }): Promise<string> {
      const relPath = join("data", "thumbnails", `${shortcode}.jpg`);
      const absPath = resolve(ROOT, relPath);
      await mkdir(dirname(absPath), { recursive: true });
      const bytes = await fetchBytes(url);
      await writeFile(absPath, bytes);
      // Store the repo-relative path (matches docs/schema.md thumbnail_path shape).
      return relPath;
    },

    async deleteVideo(path: string): Promise<void> {
      // Best-effort: a missing file is fine (already cleaned up).
      await rm(path, { force: true });
    },
  };
}

export { THUMBNAIL_DIR };
