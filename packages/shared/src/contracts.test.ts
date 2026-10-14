import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ContractErrorSchema,
  HttpUrlSchema,
  IdentifierListSchema,
  IdentifierSchema,
  IssuerUrlSchema,
  NonemptyIdentifiersSchema,
  RevisionSchema,
  Sha256Schema,
  TimestampSchema,
} from './contracts';
import {
  EnrolmentApplicationSchema,
  EnrolmentDecisionRequestSchema,
  EnrolmentSchema,
  StudentIdentitySchema,
  StudentProfileContextSchema,
} from './identity';
import { ProgrammeRowSchema, ProgrammeSchema } from './programme';
import { LearningEventSchema, SourceRecordSchema, WikiJobSchema, WikiPageSchema, WikiProposalSchema } from './wiki';
import { PublishedShareSchema, PublishShareRequestSchema, ShareCitationSchema } from './sharing';
import { ChatMessageRequestSchema } from './teacher-policy';
import { CourseSummarySchema } from './content';
import { makeContractFixtures } from './testing/fixtures';

type AnySchema = { safeParse: (v: unknown) => { success: boolean }; parse: (v: unknown) => unknown };

const rejects = (schema: AnySchema, value: unknown, message?: string) =>
  assert.equal(schema.safeParse(value).success, false, message);

test('identifier shape rejects paths, blanks and bad characters', () => {
  rejects(IdentifierSchema, '');
  rejects(IdentifierSchema, 'has/slash');
  rejects(IdentifierSchema, '..');
  rejects(IdentifierSchema, 'a/../b');
  rejects(IdentifierSchema, 'a..b');
  rejects(IdentifierSchema, 'has space');
  rejects(IdentifierSchema, '-leading-dash');
  rejects(IdentifierSchema, '_leading-underscore');
  rejects(IdentifierSchema, 'x'.repeat(129));
  assert.equal(IdentifierSchema.safeParse('student-a_X9').success, true);
});

test('timestamp, sha256 and revision formats are enforced', () => {
  rejects(TimestampSchema, 'not a date');
  rejects(TimestampSchema, '2025-01-15');
  assert.equal(TimestampSchema.safeParse('2025-01-15T09:00:00.000Z').success, true);

  rejects(Sha256Schema, 'z'.repeat(64));
  rejects(Sha256Schema, 'A'.repeat(64));
  rejects(Sha256Schema, 'a'.repeat(63));
  assert.equal(Sha256Schema.safeParse('a'.repeat(64)).success, true);

  rejects(RevisionSchema, ' rev-1');
  rejects(RevisionSchema, 'rev-1 ');
  assert.equal(RevisionSchema.safeParse('rev-1').success, true);
});

test('identifier lists reject duplicates', () => {
  rejects(IdentifierListSchema, ['a', 'a']);
  rejects(NonemptyIdentifiersSchema, []);
  rejects(NonemptyIdentifiersSchema, ['a', 'b', 'a']);
  assert.equal(IdentifierListSchema.safeParse([]).success, true);
  assert.equal(NonemptyIdentifiersSchema.safeParse(['a', 'b']).success, true);
});

test('contract error enum is closed', () => {
  rejects(ContractErrorSchema, { schemaVersion: 2, error: 'teapot', message: 'x' });
  assert.equal(
    ContractErrorSchema.safeParse({ schemaVersion: 2, error: 'incompatible_schema', message: 'upgrade required' })
      .success,
    true,
  );
});

test('every positive fixture payload round-trips through JSON and back through its schema', () => {
  const f = makeContractFixtures();
  const roundTrip = (schema: AnySchema, value: unknown) =>
    assert.deepEqual(schema.parse(JSON.parse(JSON.stringify(value))), value);

  roundTrip(ProgrammeSchema, f.programme);
  roundTrip(StudentIdentitySchema, f.students.a);
  roundTrip(StudentIdentitySchema, f.students.b);
  roundTrip(StudentIdentitySchema, f.students.c);
  roundTrip(EnrolmentSchema, f.enrolments.a);
  roundTrip(EnrolmentSchema, f.enrolments.b);
  roundTrip(EnrolmentSchema, f.enrolments.c);
  roundTrip(StudentProfileContextSchema, f.contextA);
  roundTrip(EnrolmentApplicationSchema, f.application);
  roundTrip(EnrolmentDecisionRequestSchema, f.decisionRequest);
  for (const record of Object.values(f.sources)) roundTrip(SourceRecordSchema, record);
  roundTrip(WikiPageSchema, f.wiki.mechanicsPage);
  roundTrip(WikiProposalSchema, f.wiki.proposal);
  for (const job of Object.values(f.jobs)) roundTrip(WikiJobSchema, job);
  roundTrip(LearningEventSchema, f.events.studentEvent);
  roundTrip(LearningEventSchema, f.events.modelEvent);
  roundTrip(PublishShareRequestSchema, f.sharing.shareRequest);
  roundTrip(PublishedShareSchema, f.sharing.publishedShare);
  roundTrip(ChatMessageRequestSchema, f.chat.chatMessageRequest);
  roundTrip(ChatMessageRequestSchema, f.chat.philosopherAnchorRequest);
  roundTrip(ChatMessageRequestSchema, f.chat.imageOnlyRequest);
  roundTrip(ContractErrorSchema, f.errors.forbiddenError);
});

test('schemaVersion 1, 3 and missing are rejected on every versioned root', () => {
  const f = makeContractFixtures();
  const roots: Array<[AnySchema, Record<string, unknown>]> = [
    [ContractErrorSchema, f.errors.forbiddenError],
    [StudentIdentitySchema, f.students.a],
    [EnrolmentSchema, f.enrolments.a],
    [EnrolmentApplicationSchema, f.application],
    [EnrolmentDecisionRequestSchema, f.decisionRequest],
    [StudentProfileContextSchema, f.contextA],
    [ProgrammeRowSchema, f.programme.rows[1]!],
    [ProgrammeSchema, f.programme],
    [SourceRecordSchema, f.sources.studentNote],
    [WikiPageSchema, f.wiki.mechanicsPage],
    [WikiProposalSchema, f.wiki.proposal],
    [WikiJobSchema, f.jobs.queued],
    [LearningEventSchema, f.events.studentEvent],
    [PublishShareRequestSchema, f.sharing.shareRequest],
    [PublishedShareSchema, f.sharing.publishedShare],
    [ChatMessageRequestSchema, f.chat.chatMessageRequest],
  ];
  for (const [schema, valid] of roots) {
    rejects(schema, { ...valid, schemaVersion: 1 });
    rejects(schema, { ...valid, schemaVersion: 3 });
    const { schemaVersion: _removed, ...without } = valid;
    rejects(schema, without);
  }
});

test('unknown discriminants fail instead of falling through', () => {
  const f = makeContractFixtures();
  rejects(SourceRecordSchema, { ...f.sources.studentNote, kind: 'video' });
  rejects(WikiPageSchema, {
    ...f.wiki.mechanicsPage,
    page: { ...f.wiki.mechanicsDraft, kind: 'mastery' },
  });
});

test('strict roots reject unexpected keys rather than stripping them', () => {
  const f = makeContractFixtures();
  rejects(StudentIdentitySchema, { ...f.students.a, password: 'not-a-real-password' });
  rejects(StudentIdentitySchema, { ...f.students.a, passwordHash: 'scrypt$xyz' });
  rejects(PublishedShareSchema, { ...f.sharing.publishedShare, uniToken: 'sef1.abc' });
  rejects(WikiPageSchema, { ...f.wiki.mechanicsPage, masteryScore: 0.9 });
});

test('legacy CourseSummary keeps parsing with unchanged old fields', () => {
  const legacy = {
    id: 'classical-mechanics',
    title: 'Classical Mechanics',
    subjectId: 'physics',
    semesterNumber: 1,
    code: 'PHY-110',
    lessonCount: 12,
    version: 'v3',
  };
  const parsed = CourseSummarySchema.parse(legacy);
  assert.equal(parsed.id, 'classical-mechanics');
  assert.equal(parsed.version, 'v3');
  assert.equal(parsed.support, false);
});

test('fixture factory returns independent objects on every call', () => {
  const a = makeContractFixtures();
  const b = makeContractFixtures();
  assert.notEqual(a.programme, b.programme);
  a.programme.rows.length = 0;
  a.wiki.mechanicsDraft.claims.length = 0;
  assert.equal(b.programme.rows.length, 7);
  assert.equal(b.wiki.mechanicsDraft.claims.length, 4);
});

test('http URLs reject non-web schemes and embedded credentials', () => {
  for (const bad of [
    'javascript:alert(1)',
    'data:text/plain,hello',
    'file:///tmp/wiki.md',
    'https://user:secret@example.test/path',
    'not a url',
  ]) {
    rejects(HttpUrlSchema, bad);
  }
  assert.equal(HttpUrlSchema.safeParse('https://example.test/paper#section').success, true);
  assert.equal(HttpUrlSchema.safeParse('http://localhost:4100').success, true);
});

test('issuer URLs additionally reject query and fragment', () => {
  for (const bad of [
    'javascript:alert(1)',
    'data:text/plain,hello',
    'file:///tmp/wiki.md',
    'https://user:secret@example.test/path',
    'https://uni.example.test/?q=1',
    'https://uni.example.test/#frag',
    'not a url',
  ]) {
    rejects(IssuerUrlSchema, bad);
  }
  assert.equal(IssuerUrlSchema.safeParse('http://127.0.0.1:4200').success, true);
  assert.equal(IssuerUrlSchema.safeParse('https://uni.example.test').success, true);
});

test('URL rules apply wherever DTOs carry URLs', () => {
  const f = makeContractFixtures();
  rejects(StudentProfileContextSchema, {
    ...f.contextA,
    identity: { ...f.contextA.identity, issuer: 'https://user:secret@example.test' },
  });
  rejects(StudentProfileContextSchema, {
    ...f.contextA,
    identity: { ...f.contextA.identity, issuer: 'https://uni.example.test/?x=1' },
  });
  rejects(SourceRecordSchema, { ...f.sources.externalDocument, attribution: { url: 'file:///tmp/wiki.md' } });
  rejects(SourceRecordSchema, { ...f.sources.externalDocument, attribution: { url: 'javascript:alert(1)' } });
  rejects(ShareCitationSchema, { title: 'x', url: 'data:text/plain,hello' });
  assert.equal(ShareCitationSchema.safeParse({ title: 'x', url: 'https://example.test/paper#section' }).success, true);
});
