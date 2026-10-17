import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMetricsReporter, type ClientMetricEvent } from './metrics-reporter';

function setup() {
  const sent: ClientMetricEvent[][] = [];
  const pending: Array<() => void> = [];
  const reporter = createMetricsReporter({
    send: async (events) => {
      sent.push(events);
    },
    schedule: (fn) => pending.push(fn),
    cancel: () => undefined,
  });
  return { reporter, sent, pending };
}

test('batches events and sends them on flush', async () => {
  const { reporter, sent } = setup();
  reporter.report('nudge_clicked', 'deadline:a', 'deadline');
  reporter.report('suggestion_sent', 'sq_1', 'guide');
  await reporter.flush();
  assert.deepEqual(sent, [
    [
      { kind: 'nudge_clicked', ref: 'deadline:a', tag: 'deadline' },
      { kind: 'suggestion_sent', ref: 'sq_1', tag: 'guide' },
    ],
  ]);
});

test('schedules a single flush per batch', () => {
  const { reporter, pending } = setup();
  reporter.report('nudge_clicked', 'a');
  reporter.report('nudge_clicked', 'b');
  assert.equal(pending.length, 1);
});

test('reports "shown" once per item, but clicks every time', async () => {
  const { reporter, sent } = setup();
  reporter.report('nudge_shown', 'a');
  reporter.report('nudge_shown', 'a');
  reporter.report('nudge_clicked', 'a');
  reporter.report('nudge_clicked', 'a');
  await reporter.flush();
  assert.deepEqual(
    sent[0]?.map((e) => e.kind),
    ['nudge_shown', 'nudge_clicked', 'nudge_clicked'],
  );
});

test('splits large queues into capped batches', async () => {
  const { reporter, sent } = setup();
  for (let i = 0; i < 120; i++) reporter.report('suggestion_shown', `sq_${i}`);
  await reporter.flush();
  assert.deepEqual(
    sent.map((batch) => batch.length),
    [50, 50, 20],
  );
});

test('drops malformed tags instead of poisoning the batch', async () => {
  const { reporter, sent } = setup();
  reporter.report('nudge_clicked', 'a', 'Not-A-Tag');
  await reporter.flush();
  assert.deepEqual(sent[0], [{ kind: 'nudge_clicked', ref: 'a' }]);
});

test('ignores empty refs and clamps long ones', async () => {
  const { reporter, sent } = setup();
  reporter.report('nudge_clicked', '');
  reporter.report('nudge_clicked', 'x'.repeat(300));
  await reporter.flush();
  assert.equal(sent[0]?.length, 1);
  assert.equal(sent[0]?.[0]?.ref.length, 200);
});

test('swallows send failures and reports what was dropped', async () => {
  const errors: number[] = [];
  const reporter = createMetricsReporter({
    send: async () => Promise.reject(new Error('offline')),
    onError: (_error, dropped) => errors.push(dropped),
    schedule: () => 0,
    cancel: () => undefined,
  });
  reporter.report('nudge_clicked', 'a');
  await reporter.flush();
  assert.deepEqual(errors, [1]);
});

test('reset drops the queue and the shown memory, so nothing crosses profiles', async () => {
  const { reporter, sent } = setup();
  reporter.report('nudge_shown', 'a');
  reporter.reset();
  await reporter.flush();
  assert.equal(sent.length, 0);
  reporter.report('nudge_shown', 'a');
  await reporter.flush();
  assert.equal(sent.length, 1);
});
