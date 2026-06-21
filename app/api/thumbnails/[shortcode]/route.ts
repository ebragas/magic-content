// Thumbnail streaming route (Slice 3, MAIN-959).
//
// data/ is gitignored and lives OUTSIDE public/, so Next can't serve thumbnails
// statically. This route reads data/thumbnails/<shortcode>.jpg off disk (server
// side, the only place better-sqlite3-adjacent file I/O is allowed) and streams it
// back. Missing or unsafe shortcodes return 404 — the table <img> degrades to its
// onError placeholder, never a broken run.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

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

  const path = resolve(ROOT, "data", "thumbnails", `${shortcode}.jpg`);
  try {
    const bytes = await readFile(path);
    // Copy into a fresh ArrayBuffer so the BodyInit type is exact across runtimes.
    const body = new Uint8Array(bytes);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
