import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MetricsReportSchema, type MetricEvent } from '@sef/shared';
import { aggregate, rate } from './report';

const T0 = Date.parse('2026-10-17T10:00:00.000Z');
const e = (kind: MetricEvent['kind'], ref: string, offsetMs: number, tag?: string): MetricEvent => ({ kind, ref, at: new Date(T0 + offsetMs).toISOString(), ...(tag ? { tag } : {}) });
const NONE = { turns: { total: 0, refused: 0 }, proposals: { accepted: 0, rejected: 0 } };

test('an empty log reports null rates, not zeros that look like evidence', () => {
  const report = aggregate([], NONE, new Date(T0));
  MetricsReportSchema.parse(report);
  assert.equal(report.since, null);
  assert.equal(report.suggestionAcceptance.rate, null);
  assert.equal(report.falseAlerts.rate, null);
});

test('suggestion acceptance counts distinct items; repeated "shown" cannot dilute it', () => {
  const events = [
    ...Array.from({ length: 10 }, (_, i) => e('suggestion_shown', 's1', i * 1000)),
    e('suggestion_shown', 's2', 0),
    e('suggestion_sent', 's1', 20_000),
    e('suggestion_sent', 's1', 21_000),
    e('suggestion_sent', 'never-shown', 22_000),
  ];
  assert.deepEqual(aggregate(events, NONE, new Date(T0)).suggestionAcceptance, { numerator: 1, denominator: 2, rate: 0.5 });
});

test('a nudge dismissed within 5 s of first showing is a false alert; later, or unseen, is not', () => {
  const events = [
    e('nudge_shown', 'n-fast', 0, 'deadline'),
    e('nudge_shown', 'n-fast', 60_000, 'deadline'),
    e('nudge_dismissed', 'n-fast', 4_000),
    e('nudge_shown', 'n-slow', 0, 'notice'),
    e('nudge_dismissed', 'n-slow', 30_000),
    e('nudge_shown', 'n-edge', 0, 'notice'),
    e('nudge_dismissed', 'n-edge', 5_000),
    e('nudge_dismissed', 'n-unseen', 1_000),
    e('nudge_clicked', 'n-slow', 10_000),
  ];
  const report = aggregate(events, NONE, new Date(T0));
  assert.deepEqual(report.falseAlerts, { numerator: 2, denominator: 3, rate: 2 / 3 });
  assert.deepEqual(report.nudgeEngagement, { numerator: 1, denominator: 3, rate: 1 / 3 });
  assert.deepEqual(report.signalVolumes, { deadline: 1, notice: 2 });
});

test('plan completion, steps, refusals and proposal acceptance', () => {
  const events = [
    e('plan_approved', 'p1', 0),
    e('plan_approved', 'p2', 0),
    e('plan_completed', 'p1', 1000),
    e('plan_completed', 'p-not-approved', 1000),
    e('plan_step_completed', 'p1:st_1', 500, 'review_page'),
    e('plan_step_completed', 'p1:st_1', 600, 'review_page'),
    e('plan_step_completed', 'p1:st_2', 700, 'quiz'),
  ];
  const report = aggregate(events, { turns: { total: 20, refused: 3 }, proposals: { accepted: 6, rejected: 2 } }, new Date(T0));
  assert.deepEqual(report.planCompletion, { numerator: 1, denominator: 2, rate: 0.5 });
  assert.equal(report.planStepsCompleted, 2);
  assert.deepEqual(report.refusals, rate(3, 20));
  assert.deepEqual(report.proposalAcceptance, rate(6, 8));
  assert.equal(report.since, new Date(T0).toISOString());
  MetricsReportSchema.parse(report);
});
