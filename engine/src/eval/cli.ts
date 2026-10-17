import { modelPlanner } from '../plans/planner';
import { SettingsStore } from '../settings/store';
import { FAKE_PLANNER, formatTable, runScenarios, type EvalMode } from './scenarios';

/**
 * `pnpm eval` — the deterministic scenario table, fully offline with a fake model and clock.
 * `pnpm eval --live` swaps in the configured `brain` model for the planner scenario; it is
 * labelled LIVE in the output and is never needed for CI. Exits non-zero on any failure.
 */
async function main() {
  // Engine log lines are diagnostics: send them to stderr so stdout is just the table.
  console.log = (...args: unknown[]) => console.error(...args);
  const mode: EvalMode = process.argv.includes('--live') ? 'live' : 'offline';
  const planner = mode === 'live' ? modelPlanner(() => new SettingsStore().get()) : FAKE_PLANNER;
  const rows = await runScenarios(mode, planner);
  process.stdout.write(`${formatTable(rows, mode)}\n`);
  process.exitCode = rows.every((r) => r.pass) ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`eval failed: ${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
});
