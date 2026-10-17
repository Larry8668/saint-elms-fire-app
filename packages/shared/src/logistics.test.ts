import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareLogistics,
  dueInstant,
  formatDue,
  LogisticsExtractionSchema,
  LogisticsRecordSchema,
  LogisticsWriteSchema,
  TimeZoneSchema,
  type LogisticsRecord,
} from './logistics';

const record: LogisticsRecord = {
  id: 'log-1',
  title: 'Semester fees — instalment 2',
  kind: 'deadline',
  state: 'confirmed',
  dueAt: '2026-03-14T11:30:00.000Z',
  allDay: false,
  timeZone: 'Asia/Kolkata',
  details: 'Pay through the student portal.',
  provenance: { kind: 'manual' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

test('a logistics record parses; a missing title or unknown state does not', () => {
  assert.equal(LogisticsRecordSchema.safeParse(record).success, true);
  assert.equal(LogisticsRecordSchema.safeParse({ ...record, title: '  ' }).success, false);
  assert.equal(LogisticsRecordSchema.safeParse({ ...record, state: 'maybe' }).success, false);
  assert.equal(LogisticsRecordSchema.safeParse({ ...record, id: 'has spaces' }).success, false);
});

test('no date is a first-class value, never filled in for the student', () => {
  assert.equal(LogisticsRecordSchema.safeParse({ ...record, dueAt: null, allDay: false, timeZone: null }).success, true);
  assert.equal(formatDue({ dueAt: null, allDay: false, timeZone: null }), 'no date recorded');
});

test('due accepts a bare calendar date or an ISO instant and rejects prose', () => {
  assert.equal(LogisticsWriteSchema.safeParse({ title: 'x', kind: 'deadline', dueAt: '2026-03-14', timeZone: null }).success, true);
  assert.equal(LogisticsWriteSchema.safeParse({ title: 'x', kind: 'deadline', dueAt: '2026-03-14T17:00:00+05:30', timeZone: 'Asia/Kolkata' }).success, true);
  assert.equal(LogisticsWriteSchema.safeParse({ title: 'x', kind: 'deadline', dueAt: 'next Friday', timeZone: null }).success, false);
});

test('time zones must be real IANA names — a bad one is refused, not corrected', () => {
  assert.equal(TimeZoneSchema.safeParse('Asia/Kolkata').success, true);
  assert.equal(TimeZoneSchema.safeParse('UTC').success, true);
  assert.equal(TimeZoneSchema.safeParse('Mars/Olympus').success, false);
});

test('formatDue renders the recorded zone and says so; missing zones stay honest', () => {
  const shown = formatDue(record);
  assert.match(shown, /Asia\/Kolkata/);
  assert.match(shown, /17:00/, 'the instant is rendered in the recorded zone, not UTC');
  assert.equal(formatDue({ dueAt: '2026-03-14', allDay: true, timeZone: 'Asia/Kolkata' }), 'due 2026-03-14 (Asia/Kolkata)');
  assert.match(formatDue({ dueAt: '2026-03-14T17:00:00.000Z', allDay: false, timeZone: null }), /time zone not recorded/);
});

test('extraction drafts are capped and carry no record lifecycle', () => {
  const draft = { title: 'Physics lab exam', kind: 'timetable', dueAt: '2026-03-14', allDay: true, timeZone: null, details: '' };
  const parsed = LogisticsExtractionSchema.safeParse({ records: [draft] });
  assert.equal(parsed.success, true);
  assert.equal(LogisticsExtractionSchema.safeParse({ records: [] }).success, true);
  assert.equal(
    LogisticsExtractionSchema.safeParse({ records: Array.from({ length: 13 }, () => draft) }).success,
    false,
    'the proposal cap is a contract, not a courtesy',
  );
  assert.equal(LogisticsExtractionSchema.safeParse({ records: [{ ...draft, state: 'confirmed' }] }).success, false);
});

test('compareLogistics puts dated records first, nearest out front', () => {
  const sooner = { ...record, id: 'a', dueAt: '2026-03-01', allDay: true };
  const later = { ...record, id: 'b', dueAt: '2026-04-01', allDay: true };
  const undated = { ...record, id: 'c', dueAt: null };
  const sorted = [undated, later, sooner].sort(compareLogistics).map((r) => r.id);
  assert.deepEqual(sorted, ['a', 'b', 'c']);
});

test('dueInstant reads wall clocks in the recorded zone and bare dates as end of day', () => {
  assert.equal(dueInstant({ dueAt: '2026-03-14T17:00', allDay: false, timeZone: 'Asia/Kolkata' }), Date.parse('2026-03-14T11:30:00Z'));
  assert.equal(dueInstant({ dueAt: '2026-03-14T17:00', allDay: false, timeZone: 'UTC' }), Date.parse('2026-03-14T17:00:00Z'));
  assert.equal(dueInstant({ dueAt: '2026-03-14', allDay: true, timeZone: 'Asia/Kolkata' }), Date.parse('2026-03-14T18:29:59Z'));
  assert.equal(dueInstant({ dueAt: '2026-03-14T17:00:00Z', allDay: false, timeZone: 'Asia/Kolkata' }), Date.parse('2026-03-14T17:00:00Z'), 'an explicit offset wins');
  assert.equal(dueInstant({ dueAt: null, allDay: false, timeZone: null }), null);
  assert.equal(dueInstant({ dueAt: '2026-03-14T17:00', allDay: false, timeZone: 'Not/AZone' }), null, 'an unusable zone is not guessed');
});
