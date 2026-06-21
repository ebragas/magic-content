// Run monitor page (/runs). A minimal server shell that renders the interactive
// RunMonitor client island. The run + results polling, per-step progress bars, and
// live results all live in RunMonitor; this just seeds the default creator from the
// query string (?creator=). When omitted, the run API resolves the config default.

import { RunMonitor } from "../RunMonitor.js";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ creator?: string }>;
}

export default async function RunsPage({ searchParams }: PageProps) {
  const { creator } = await searchParams;
  return <RunMonitor defaultCreator={creator?.trim() || ""} />;
}
