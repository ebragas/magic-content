// Thin CLI over lib/core (ADR-0002). NO business logic here — parse argv, call
// pipeline(), print the result. Run via `npm run cli -- <action> [creator] [--no-cap]`.

import { applyNoCap, loadConfig } from "../lib/core/config.js";
import { pipeline } from "../lib/core/pipeline.js";
import type { PipelineAction } from "../lib/core/types.js";

const ACTIONS: readonly PipelineAction[] = ["scrape", "analyze", "refresh", "full"];

/** The only flag the CLI accepts: a deliberate Reprocess (CONTEXT.md) that lifts the per-run
 *  PROCESSING caps (analysis + FAQ) so every tracked drifted Reel is re-analyzed in one pass.
 *  It does NOT widen coverage (results_limit/window stay put). Meaningful for `analyze`/`full`;
 *  a harmless no-op for the others. */
const KNOWN_FLAGS = new Set(["--no-cap"]);

function isAction(v: string | undefined): v is PipelineAction {
  return v != null && (ACTIONS as readonly string[]).includes(v);
}

const USAGE =
  `usage: cli <${ACTIONS.join("|")}> [creator] [--no-cap]\n` +
  `  e.g. npm run cli -- scrape itsmariahbrunner\n` +
  `       npm run cli -- full itsmariahbrunner --no-cap   # reprocess every tracked Reel (lifts analysis/FAQ caps)\n`;

async function main(): Promise<void> {
  // Order-independent: split --flags from positionals so `full creator --no-cap` and
  // `full --no-cap creator` both work. Reject unknown flags so a typo (--nocap) fails
  // loud instead of silently doing nothing.
  const argv = process.argv.slice(2);
  const flags = argv.filter((a) => a.startsWith("--"));
  const [action, creator] = argv.filter((a) => !a.startsWith("--"));

  const unknown = flags.filter((f) => !KNOWN_FLAGS.has(f));
  if (unknown.length > 0) {
    process.stderr.write(`unknown flag(s): ${unknown.join(", ")}\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  const noCap = flags.includes("--no-cap");

  if (!isAction(action)) {
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }

  // --no-cap hands pipeline() a config with the per-run processing caps lifted; lib/core
  // is untouched (it already reads the caps straight from config — ADR-0002).
  const config = noCap ? applyNoCap(loadConfig()) : undefined;

  const result = await pipeline({
    action,
    creator: creator || undefined,
    config,
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
    // FAQ leg rides the analyze run but caps independently (MAIN-969 / ADR-0007).
    process.stderr.write(
      `[faq] ${a.faqExtracted} Reels (re)extracted, ${a.faqRemainingOverCap} left ` +
        `un-extracted (FAQ cap hit)\n`,
    );
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
