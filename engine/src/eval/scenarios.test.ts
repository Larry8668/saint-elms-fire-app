import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FAKE_PLANNER, formatTable, runScenarios, SCENARIOS, type Scenario } from './scenarios';

test('every offline scenario passes with the fake model and clock', async () => {
  const rows = await runScenarios('offline', FAKE_PLANNER);
  assert.equal(rows.length, SCENARIOS.length);
  for (const row of rows) assert.ok(row.pass, `${row.name}: expected "${row.expected}", got "${row.actual}"${row.error ? ` (${row.error})` : ''}`);
});

test('the runner is deterministic: two offline runs give identical tables', async () => {
  const a = formatTable(await runScenarios('offline', FAKE_PLANNER), 'offline');
  const b = formatTable(await runScenarios('offline', FAKE_PLANNER), 'offline');
  assert.equal(a, b);
  assert.match(a, /mode: offline \(fake model, fake clock\)/);
  assert.match(a, new RegExp(`${SCENARIOS.length}/${SCENARIOS.length} passed`));
});

test('a throwing scenario is a failed row, not a crashed run; live runs are labelled', async () => {
  const boom: Scenario = {
    name: 'explodes',
    run: async () => {
      throw new Error('kaboom');
    },
  };
  const rows = await runScenarios('live', FAKE_PLANNER, [boom]);
  assert.deepEqual(rows.map((r) => [r.name, r.pass, r.error]), [['explodes', false, 'kaboom']]);
  const table = formatTable(rows, 'live');
  assert.match(table, /LIVE \(real model — results vary\)/);
  assert.match(table, /FAIL │ explodes/);
  assert.match(table, /0\/1 passed/);
});
