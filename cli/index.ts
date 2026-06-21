// Thin CLI over lib/core (ADR-0002). NO business logic here — parse argv, call
// pipeline(), print the result. Run via `npm run cli -- <action> [creator]`.

import { pipeline } from "../lib/core/pipeline.js";
import type { PipelineAction } from "../lib/core/types.js";

const ACTIONS: readonly PipelineAction[] = ["scrape", "analyze", "refresh", "full"];

function isAction(v: string | undefined): v is PipelineAction {
  return v != null && (ACTIONS as readonly string[]).includes(v);
}

async function main(): Promise<void> {
  const [action, creator] = process.argv.slice(2);

  if (!isAction(action)) {
    process.stderr.write(
      `usage: cli <${ACTIONS.join("|")}> [creator]\n` +
        `  e.g. npm run cli -- scrape itsmariahbrunner\n`,
    );
    process.exitCode = 1;
    return;
  }

  const result = await pipeline({
    action,
    creator: creator || undefined,
    onProgress: (stage, done, total) => {
      process.stderr.write(`[${stage}] ${done}/${total}\n`);
    },
  });

  // Per build-spec.md: a run logs Reel counts with no silent truncation —
  // for scrape, how many the actor returned vs were dropped by the window / cap.
  if (result.scrape) {
    const s = result.scrape;
    process.stderr.write(
      `[scrape] ${s.reelsReturned} returned, ${s.reelsUpserted} upserted, ` +
        `${s.droppedOutOfWindow} dropped (out of window), ` +
        `${s.droppedOverCap} dropped (over results_limit)\n`,
    );
  }

  // Per build-spec.md: a run logs how many Reels were analyzed vs skipped vs left
  // un-analyzed because the cap was hit (no silent truncation).
  if (result.analyze) {
    const a = result.analyze;
    process.stderr.write(
      `[analyze] ${a.analyzed} analyzed, ${a.skipped} skipped (already analyzed, ` +
        `unchanged prompt hash), ${a.failed} failed, ${a.remainingOverCap} left ` +
        `un-analyzed (cap hit)\n`,
    );
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
