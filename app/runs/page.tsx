// /runs — the Runs view of the dashboard. Renders the same AppShell client island
// as the home page, but with the initial view set to "runs" and the creator seeded
// from ?creator= (so "Run pipeline for @x" links land on a pre-filled form). The
// run + results polling, per-step progress, and live results live in AppShell's
// RunsView, talking to the same run API the CLI core writes through (ADR-0002).

import { getAppData } from "../dashboard-data.js";
import { AppShell } from "../AppShell.js";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ creator?: string }>;
}

export default async function RunsPage({ searchParams }: PageProps) {
  const { creator } = await searchParams;
  const data = getAppData();
  return <AppShell data={data} initialView="runs" initialCreator={creator?.trim() || null} />;
}
