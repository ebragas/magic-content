// Dashboard entry point. A thin server component that reads the WHOLE Content Store
// (server-side only — better-sqlite3, ADR-0002) via getAppData and hands the
// serializable view-model to the AppShell client island, which renders the
// redesigned Library / Detail / Creators / Runs UI and does all filtering, sorting,
// search, and theming in the browser.
//
// Deep-link seeds: ?view=creators|runs|library picks the initial view; ?creator=
// pre-applies the creator filter (so "Run pipeline for @x" and creator links land
// in the right place). All further navigation is client-side.

import { getAppData } from "./dashboard-data.js";
import { AppShell } from "./AppShell.js";

export const dynamic = "force-dynamic";

type View = "library" | "creators" | "runs";

interface PageProps {
  searchParams: Promise<{ view?: string; creator?: string }>;
}

function parseView(raw: string | undefined): View {
  return raw === "creators" || raw === "runs" ? raw : "library";
}

export default async function HomePage({ searchParams }: PageProps) {
  const { view, creator } = await searchParams;
  const data = getAppData();
  return <AppShell data={data} initialView={parseView(view)} initialCreator={creator?.trim() || null} />;
}
