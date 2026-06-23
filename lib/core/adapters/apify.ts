// Real ApifyPort adapter (ADR-0005: apify-client + apify/instagram-scraper).
//
// Lazily instantiated by scrape()/refresh() ONLY when no port is injected AND
// APIFY_TOKEN is set, so tests (which always inject a fake ApifyPort) never load
// the SDK and never make a network call (HARD INVARIANT #2). Mirrors the
// GEMINI_API_KEY auto-engagement in analyze.ts/adapters.
//
// Two actor runs per scrape: a cheap `details` run for the profile (followers /
// following / posts_count + identity) and a `posts` run for the recent Reels
// (raw metrics + inline latestComments + the transient CDN videoUrl + thumbnail).
// The `posts` run is windowed (onlyPostsNewerThan) and capped (resultsLimit);
// scrape.ts re-applies both defensively. The pure mappers below are exported so
// the field mapping is unit-tested against a fixture dataset without any network.

import { ApifyClient } from "apify-client";
import type {
  ApifyPort,
  ScrapeResult,
  ScrapedComment,
  ScrapedCreatorProfile,
  ScrapedReel,
  TopComment,
} from "../types.js";

const ACTOR_ID = "apify/instagram-scraper";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Dataset items from the actor are untyped JSON; access fields defensively. */
type Item = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function profileUrl(username: string): string {
  return `https://www.instagram.com/${username}/`;
}

/** Map an Apify `details` profile item → ScrapedCreatorProfile. Pure (testable). */
export function mapProfile(
  item: Item | undefined,
  fallbackUsername: string,
): ScrapedCreatorProfile {
  if (!item) return { username: fallbackUsername };
  return {
    username: str(item.username) ?? fallbackUsername,
    full_name: str(item.fullName),
    biography: str(item.biography),
    is_verified: bool(item.verified),
    followers: num(item.followersCount),
    following: num(item.followsCount),
    posts_count: num(item.postsCount),
  };
}

function mapComments(v: unknown): TopComment[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: TopComment[] = [];
  for (const raw of v as Item[]) {
    const owner = raw.owner as Item | undefined;
    const username = str(raw.ownerUsername) ?? str(owner?.username) ?? "";
    const text = str(raw.text) ?? "";
    const likes = num(raw.likesCount) ?? 0;
    if (text) out.push({ username, text, likes });
  }
  return out.length ? out : null;
}

/**
 * Map Instagram's native comment id robustly. The actor surfaces it under varying
 * keys across dataset shapes (`id`, `pk`, `commentId`); coerce numbers to strings so
 * a numeric pk still dedupes. Returns null when no id is present (the comment can't
 * be deduped into the corpus and is dropped).
 */
function commentId(raw: Item): string | null {
  const candidates = [raw.id, raw.pk, raw.commentId];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
    if (typeof c === "number" && Number.isFinite(c)) return String(c);
  }
  return null;
}

/** Map a single Apify `comments` item → ScrapedComment. Pure (testable). Null when un-id'd. */
export function mapScrapedComment(raw: Item): ScrapedComment | null {
  const id = commentId(raw);
  if (!id) return null;
  const owner = raw.owner as Item | undefined;
  return {
    comment_id: id,
    username: str(raw.ownerUsername) ?? str(owner?.username),
    text: str(raw.text),
    likes: num(raw.likesCount),
    posted_at: str(raw.timestamp),
  };
}

/** Map an Apify `comments` dataset → ScrapedComment[], dropping un-id'd items, deduped. Pure. */
export function mapScrapedComments(items: Item[]): ScrapedComment[] {
  const out: ScrapedComment[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const c = mapScrapedComment(item);
    if (!c || seen.has(c.comment_id)) continue;
    seen.add(c.comment_id);
    out.push(c);
  }
  return out;
}

/**
 * A Reel is a video post: apify/instagram-scraper tags them productType "clips"
 * or type "Video"; fall back to the presence of a downloadable videoUrl.
 */
function isReelItem(item: Item): boolean {
  return (
    str(item.productType) === "clips" ||
    str(item.type) === "Video" ||
    str(item.videoUrl) != null
  );
}

/** Map a single Apify `posts` item → ScrapedReel. Pure (testable). */
export function mapReel(item: Item): ScrapedReel | null {
  const shortcode = str(item.shortCode) ?? str(item.shortcode) ?? str(item.code);
  if (!shortcode) return null;
  const images = item.images as unknown[] | undefined;
  return {
    shortcode,
    // Canonical Reel URL for traceability (docs/schema.md), built from shortcode.
    url: `https://www.instagram.com/reel/${shortcode}/`,
    caption: str(item.caption),
    posted_at: str(item.timestamp),
    duration_sec: num(item.videoDuration),
    // likesCount may be -1 (hidden); pass the raw value through — the core
    // (scrape.ts) normalizes -1 → NULL. Never normalize here.
    likes: num(item.likesCount) ?? num(item.likes),
    comments_count: num(item.commentsCount),
    views: num(item.videoPlayCount) ?? num(item.videoViewCount),
    shares: null, // not exposed by the actor; best-effort/nullable (schema.md)
    thumbnail_url: str(item.displayUrl) ?? str(images?.[0]),
    video_url: str(item.videoUrl),
    top_comments: mapComments(item.latestComments),
  };
}

/** Map an Apify `posts` dataset → ScrapedReel[], keeping only Reels, deduped. Pure. */
export function mapReels(items: Item[]): ScrapedReel[] {
  const reels: ScrapedReel[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isReelItem(item)) continue;
    const reel = mapReel(item);
    if (!reel || seen.has(reel.shortcode)) continue;
    seen.add(reel.shortcode);
    reels.push(reel);
  }
  return reels;
}

function getApifyToken(): string {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    throw new Error(
      "APIFY_TOKEN is not set — required for the real Apify adapter (see build-spec.md env).",
    );
  }
  return token;
}

/** Build the real ApifyPort backed by apify-client + apify/instagram-scraper. */
export function makeApifyPort(): ApifyPort {
  const client = new ApifyClient({ token: getApifyToken() });

  async function runActor(input: Record<string, unknown>): Promise<Item[]> {
    const run = await client.actor(ACTOR_ID).call(input);
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    return items as Item[];
  }

  return {
    async scrapeCreator({ username, windowDays, resultsLimit }): Promise<ScrapeResult> {
      const url = profileUrl(username);
      const newerThan = new Date(Date.now() - windowDays * DAY_MS)
        .toISOString()
        .slice(0, 10);

      // 1) Profile details (cheap) — followers/following/posts + identity.
      // Best-effort: if it fails, fall back to a minimal profile (the null rule
      // then handles missing followers gracefully).
      let profile: ScrapedCreatorProfile = { username };
      try {
        const detailItems = await runActor({
          directUrls: [url],
          resultsType: "details",
          resultsLimit: 1,
        });
        profile = mapProfile(detailItems[0], username);
      } catch {
        // keep the minimal profile
      }

      // 2) Recent Reels (windowed + capped): raw metrics + comments + videoUrl.
      const postItems = await runActor({
        directUrls: [url],
        resultsType: "posts",
        resultsLimit,
        onlyPostsNewerThan: newerThan,
        addParentData: false,
      });

      return { profile, reels: mapReels(postItems) };
    },

    async scrapeComments({ shortcode, url, limit }): Promise<ScrapedComment[]> {
      // A dedicated `comments` run against the Reel's canonical post URL. The actor
      // returns up to `resultsLimit` comments (newest + top-liked); we re-cap the
      // mapped result defensively. shortcode is accepted for symmetry/logging — the
      // actor keys off the post URL.
      void shortcode;
      const items = await runActor({
        directUrls: [url],
        resultsType: "comments",
        resultsLimit: limit,
      });
      return mapScrapedComments(items).slice(0, limit);
    },
  };
}
