// Thumbnail streaming route (Slice 3, MAIN-959).
//
// data/ is gitignored and lives OUTSIDE public/, so Next can't serve thumbnails
// statically. This route reads data/thumbnails/<shortcode>.<ext> off disk (server
// side, the only place better-sqlite3-adjacent file I/O is allowed) and streams it
// back with the REAL Content-Type. The writer (lib/core/adapters/video.ts) persists
// IG thumbnails under their true extension (often WebP/HEIC, not JPEG), so the route
// probes the known formats for this shortcode and serves the matching MIME — a
// hard-coded image/jpeg would render broken for non-JPEG bytes. Missing or unsafe
// shortcodes return 404 — the table <img> degrades to its onError placeholder,
// never a broken run.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { IMAGE_FORMATS, sniffImageFormat } from "@/lib/core/adapters/video";

export const dynamic = "force-dynamic";

// Project root. Next runs the server from the project root (next start / next dev),
// so process.cwd() points at <root> where data/ lives. Using cwd (not import.meta.url)
// keeps webpack from trying to statically resolve a relative path as a module asset.
const ROOT = process.cwd();

/** Instagram shortcodes are URL-safe base64-ish: letters, digits, -, _. Anything
 *  else is rejected before it can touch the filesystem (path-traversal guard). */
function isSafeShortcode(shortcode: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(shortcode);
}

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ shortcode: string }> },
): Promise<Response> {
  const { shortcode } = await ctx.params;

  if (!isSafeShortcode(shortcode)) {
    return new Response("Not found", { status: 404 });
  }

  // The on-disk extension depends on the source format, so probe the known
  // image extensions for this shortcode (JPEG first — the common case).
  for (const format of IMAGE_FORMATS) {
    const path = resolve(ROOT, "data", "thumbnails", `${shortcode}.${format.ext}`);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      continue; // not this extension — try the next
    }
    // Copy into a fresh ArrayBuffer so the BodyInit type is exact across runtimes.
    const body = new Uint8Array(bytes);
    // Trust the bytes over the filename: sniff the real format, falling back to
    // the extension we found it under, so the Content-Type is always honest.
    const mime = (sniffImageFormat(body) ?? format).mime;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": mime,
        // Thumbnails are immutable per shortcode — a fresh scrape that changes
        // the image writes a new file (possibly a new extension) rather than
        // mutating this one — so let the browser cache aggressively instead of
        // re-downloading all ~90 on every dashboard render / router.refresh().
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  return new Response("Not found", { status: 404 });
}
