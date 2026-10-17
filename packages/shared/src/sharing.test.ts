import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PublishShareRequestSchema,
  PublishedShareSchema,
  ShareCitationSchema,
  ShareDraftResponseSchema,
  ShareImportResultSchema,
  SharePayloadSchema,
  ShareScreeningSchema,
  SharedAttachmentSchema,
} from './sharing';
import { makeContractFixtures } from './testing/fixtures';

type AnySchema = { safeParse: (v: unknown) => { success: boolean }; parse: (v: unknown) => unknown };

const rejects = (schema: AnySchema, value: unknown, message?: string) =>
  assert.equal(schema.safeParse(value).success, false, message);

test('publish request is authored content only: no sender or cohort fields accepted', () => {
  const { sharing } = makeContractFixtures();
  for (const extra of [{ fromStudent: 'student-a' }, { senderId: 'student-a' }, { cohortId: 'cohort-a' }]) {
    rejects(PublishShareRequestSchema, { ...sharing.shareRequest, ...extra });
  }
});

test('payload carries no learner or quiz state', () => {
  const { sharing } = makeContractFixtures();
  for (const extra of [
    { learner: { status: 'solid' } },
    { quiz: { score: 4 } },
    { masteryScore: 0.9 },
    { wikiPage: {} },
  ]) {
    rejects(SharePayloadSchema, { ...sharing.shareRequest.payload, ...extra });
  }
});

test('citations name public titles only, never private source ids or paths', () => {
  const citation = { title: 'OpenStax University Physics', url: 'https://openstax.example.test/physics' };
  rejects(ShareCitationSchema, { ...citation, sourceId: 'source-external-doc' });
  rejects(ShareCitationSchema, { ...citation, path: '/vault/secret.md' });
  rejects(ShareCitationSchema, { ...citation, sha256: 'a'.repeat(64) });
  assert.equal(ShareCitationSchema.safeParse(citation).success, true);
});

test('attachment descriptors validate media and hashes while publication text is bounded', () => {
  const { sharing } = makeContractFixtures();
  const attachment = { id: 'att-1', name: 'notes.pdf', mediaType: 'application/pdf', sha256: 'b'.repeat(64), bytes: 1024 };
  rejects(SharedAttachmentSchema, { ...attachment, mediaType: 'image/gif' });
  rejects(SharedAttachmentSchema, { ...attachment, sha256: 'not-a-hash' });
  rejects(SharePayloadSchema, { ...sharing.shareRequest.payload, markdown: '' });
  rejects(SharePayloadSchema, { ...sharing.shareRequest.payload, markdown: 'x'.repeat(10001) });
  rejects(SharePayloadSchema, { ...sharing.shareRequest.payload, title: '   ' });
});

test('published share is a server-shaped record', () => {
  const { sharing } = makeContractFixtures();
  assert.equal(PublishedShareSchema.safeParse(sharing.publishedShare).success, true);
  rejects(PublishedShareSchema, { ...sharing.publishedShare, state: 'draft' });
});

test('screening is a closed set of honest statuses — it cannot invent a fourth', () => {
  assert.equal(ShareScreeningSchema.safeParse({ status: 'clean', categories: [], model: 'shieldgemma:2b' }).success, true);
  assert.equal(ShareScreeningSchema.safeParse({ status: 'flagged', categories: ['harassment'], model: 'm' }).success, true);
  assert.equal(ShareScreeningSchema.safeParse({ status: 'unavailable', categories: [], model: '' }).success, true);
  rejects(ShareScreeningSchema, { status: 'blocked', categories: [], model: 'm' });
  rejects(ShareScreeningSchema, { status: 'trusted', categories: [], model: 'm' }, 'no status may imply the content was vetted safe');
});

test('screening rides the draft and import shapes, and a replayed import may omit it', () => {
  const { sharing } = makeContractFixtures();
  const screening = { status: 'flagged', categories: ['dangerous'], model: 'shieldgemma:2b' };
  const draft = {
    schemaVersion: 2,
    request: sharing.shareRequest,
    cohortId: 'cohort-a',
    excluded: [],
    screening,
  };
  assert.equal(ShareDraftResponseSchema.parse(draft).screening?.status, 'flagged');
  const result = {
    schemaVersion: 2,
    shareId: 'share-1',
    sourceId: 'source-1',
    jobId: 'job-1',
    proposalId: null,
    stage: 'awaiting_review',
    reused: false,
    screening,
  };
  assert.equal(ShareImportResultSchema.parse(result).screening?.status, 'flagged');
  assert.equal(ShareImportResultSchema.parse({ ...result, reused: true, screening: undefined }).screening, undefined);
});
