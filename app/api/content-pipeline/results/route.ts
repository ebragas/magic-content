// Live-results endpoint for the run monitor (read-only). The monitor page polls
// this while a run is in flight to show reels appearing as they're analyzed, plus
// running counts. Reuses the dashboard read adapter (getDashboardData) — no new
// query logic — and projects a COMPACT row (no transcript/beats) to keep the
// frequently-polled payload light. Server-side only (better-sqlite3, ADR-0005).

import { getDashboardData } from "../../../dashboard-data.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const creator = new URL(request.url).searchParams.get("creator")?.trim() || undefined;
  const data = getDashboardData({ creator });

  const rows = data.rows.map(({ reel }) => ({
    shortcode: reel.shortcode,
    url: reel.url,
    topic: reel.topic,
    category: reel.category,
    hook_technique: reel.hook_technique,
    analysis_status: reel.analysis_status,
    analyzed_at: reel.analyzed_at,
    performance_score: reel.performance_score,
    has_thumbnail: reel.thumbnail_path != null,
  }));

  const counts = {
    total: rows.length,
    analyzed: rows.filter((r) => r.analysis_status === "analyzed").length,
    pending: rows.filter((r) => r.analysis_status == null || r.analysis_status === "pending")
      .length,
    failed: rows.filter((r) => r.analysis_status === "failed").length,
  };

  return Response.json({ rows, counts }, { headers: { "Cache-Control": "no-store" } });
}
