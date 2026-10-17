import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRACT_VERSION, type MetricsReport } from '@sef/shared';
import { formatRate, metricRows, topSignals } from './teacher-metrics';

const r = (numerator: number, denominator: number) => ({ numerator, denominator, rate: denominator ? numerator / denominator : null });

const report = (patch: Partial<MetricsReport> = {}): MetricsReport => ({
  schemaVersion: CONTRACT_VERSION,
  generatedAt: '2026-10-17T10:00:00.000Z',
  since: null,
  events: 0,
  suggestionAcceptance: r(0, 0),
  falseAlerts: r(0, 0),
  nudgeEngagement: r(0, 0),
  planCompletion: r(0, 0),
  planStepsCompleted: 0,
  refusals: r(0, 0),
  proposalAcceptance: r(0, 0),
  signalVolumes: {},
  ...patch,
});

test('formatRate says there is no data when nothing was counted', () => {
  assert.equal(formatRate(r(0, 0)), 'No data yet');
});

test('formatRate shows counts without a percentage on small samples', () => {
  assert.equal(formatRate(r(1, 3)), '1 of 3 · too early to tell');
});

test('formatRate shows counts and a rounded percentage once there is enough data', () => {
  assert.equal(formatRate(r(3, 12)), '3 of 12 (25%)');
});

test('metricRows covers every rate in the report, in a stable order', () => {
  assert.deepEqual(
    metricRows(report()).map((row) => row.id),
    ['suggestionAcceptance', 'nudgeEngagement', 'falseAlerts', 'planCompletion', 'proposalAcceptance', 'refusals'],
  );
});

test('metricRows withholds the numeric rate below the sample floor', () => {
  const rows = metricRows(report({ falseAlerts: r(1, 2), refusals: r(1, 10) }));
  assert.equal(rows.find((row) => row.id === 'falseAlerts')?.rate, null);
  assert.equal(rows.find((row) => row.id === 'refusals')?.rate, 0.1);
});

test('metricRows marks false alerts and refusals as lower-is-better', () => {
  assert.deepEqual(
    metricRows(report())
      .filter((row) => row.better === 'lower')
      .map((row) => row.id),
    ['falseAlerts', 'refusals'],
  );
});

test('a report missing a rate field (older engine) renders "No data yet" instead of crashing', () => {
  const partial = { ...report() } as Partial<MetricsReport>;
  delete partial.refusals;
  delete partial.signalVolumes;
  const rows = metricRows(partial as MetricsReport);
  assert.equal(rows.find((row) => row.id === 'refusals')?.value, 'No data yet');
  assert.deepEqual(topSignals(partial as MetricsReport), []);
});

test('topSignals sorts by volume, breaks ties by name, drops zeros and caps the list', () => {
  const top = topSignals(report({ signalVolumes: { notice: 2, deadline: 5, share: 2, wiki_review: 0, release_update: 1 } }), 3);
  assert.deepEqual(top, [
    { kind: 'deadline', count: 5 },
    { kind: 'notice', count: 2 },
    { kind: 'share', count: 2 },
  ]);
});
