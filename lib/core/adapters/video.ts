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

/** Image format we can persist a thumbnail as. `ext` is the on-disk filename
 *  extension; `mime` is the Content-Type the thumbnail route must serve so the
 *  browser decodes it correctly (IG `displayUrl` is often WebP/HEIC, not JPEG). */
export interface ImageFormat {
  ext: "jpg" | "png" | "webp" | "heic" | "gif";
  mime: string;
}

const JPEG: ImageFormat = { ext: "jpg", mime: "image/jpeg" };

/** Every image format the thumbnail pipeline knows how to serve. Filename
 *  extensions here are what the reader route probes for a given shortcode, so
 *  the writer and reader stay in lockstep. */
export const IMAGE_FORMATS: readonly ImageFormat[] = [
  JPEG,
  { ext: "png", mime: "image/png" },
  { ext: "webp", mime: "image/webp" },
  { ext: "heic", mime: "image/heic" },
  { ext: "gif", mime: "image/gif" },
];

/** Map a (possibly parameterized) HTTP Content-Type to a known ImageFormat,
 *  or undefined if it isn't an image type we serve. Pure. */
export function formatFromContentType(contentType: string | null | undefined): ImageFormat | undefined {
  if (!contentType) return undefined;
  const mime = contentType.split(";", 1)[0]!.trim().toLowerCase();
  return IMAGE_FORMATS.find((f) => f.mime === mime);
}

/** Sniff the image format from leading magic bytes, or undefined if unknown.
 *  Pure (no I/O) so it's unit-testable without touching the network. Covers the
 *  formats IG thumbnails actually arrive as: JPEG, PNG, WebP (RIFF…WEBP), HEIC
 *  (ISO-BMFF `ftyp` with a heic/heif/mif1 brand), and GIF. */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | undefined {
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return JPEG;
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { ext: "png", mime: "image/png" };
  }
  // GIF: "GIF8"
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { ext: "gif", mime: "image/gif" };
  }
  // WebP: "RIFF" ???? "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  // HEIC/HEIF: ISO-BMFF "ftyp" box (bytes 4..7) with a heic/heif/mif1 brand.
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && // f
    bytes[5] === 0x74 && // t
    bytes[6] === 0x79 && // y
    bytes[7] === 0x70 // p
  ) {
    const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    if (["heic", "heix", "heif", "hevc", "mif1", "msf1"].includes(brand)) {
      return { ext: "heic", mime: "image/heic" };
    }
  }
  return undefined;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download failed (${res.status}) for ${url}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/** Fetch an image and resolve its real format. Magic bytes win over the HTTP
 *  Content-Type (CDNs occasionally mislabel), falling back to the header, then
 *  to JPEG as a last resort so we always persist something serveable. */
async function fetchImage(url: string): Promise<{ bytes: Uint8Array; format: ImageFormat }> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download failed (${res.status}) for ${url}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const format = sniffImageFormat(bytes) ?? formatFromContentType(res.headers.get("content-type")) ?? JPEG;
  return { bytes, format };
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
      // IG `displayUrl` is frequently WebP/HEIC, not JPEG — persist under the
      // REAL extension (sniffed from bytes / Content-Type) so the file is honest
      // and the thumbnail route can serve a matching Content-Type.
      const { bytes, format } = await fetchImage(url);
      const relPath = join("data", "thumbnails", `${shortcode}.${format.ext}`);
      const absPath = resolve(ROOT, relPath);
      await mkdir(dirname(absPath), { recursive: true });
      // Keep exactly ONE thumbnail per shortcode: drop any sibling left over from
      // a prior run that detected a different format, so the reader route probes
      // deterministically and the immutable cache header stays honest.
      await Promise.all(
        IMAGE_FORMATS.filter((f) => f.ext !== format.ext).map((f) =>
          rm(resolve(ROOT, "data", "thumbnails", `${shortcode}.${f.ext}`), { force: true }),
        ),
      );
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
