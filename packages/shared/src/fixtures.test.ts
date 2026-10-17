import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceRecordSchema } from './wiki';
import { makeContractFixtures } from './testing/fixtures';

test('fixture sources cover every kind, including the course document', () => {
  const { sources } = makeContractFixtures();
  const records = Object.values(sources);
  const kinds = [...new Set(records.map((s) => s.kind))].sort();
  assert.deepEqual(kinds, ['answer', 'audio', 'document', 'image', 'note', 'peer', 'session']);
  assert.equal(records.length, 8);
  for (const record of records) {
    assert.equal(SourceRecordSchema.safeParse(record).success, true);
  }
});

test('peer share provenance matches the published snapshot within one cohort', () => {
  const { sources, sharing, students, enrolments } = makeContractFixtures();
  const peer = sources.peer;
  if (peer.kind !== 'peer') assert.fail('peer source fixture must have kind peer');
  assert.equal(peer.share.senderId, students.c.id);
  assert.equal(enrolments.c.studentId, peer.share.senderId);
  assert.equal(enrolments.c.cohortId, peer.share.cohortId);
  assert.equal(peer.share.id, sharing.publishedShare.id);
  assert.equal(peer.share.revision, sharing.publishedShare.revision);
  assert.equal(peer.share.senderId, sharing.publishedShare.senderId);
  assert.equal(peer.share.cohortId, sharing.publishedShare.cohortId);
  assert.equal(sharing.publishedShare.senderName, students.c.name);
});

test('positive claims cite existing fixture sources of matching origin', () => {
  const { wiki, sources } = makeContractFixtures();
  const byId = new Map(Object.values(sources).map((s) => [s.id, s]));
  const claims = [...wiki.mechanicsDraft.claims, wiki.contradictedClaims.course, wiki.contradictedClaims.student];
  for (const claim of claims) {
    for (const citation of claim.citations) {
      const source = byId.get(citation.sourceId);
      assert.ok(source, `${claim.id} cites missing source ${citation.sourceId}`);
      assert.equal(source.revision, citation.sourceRevision, `${claim.id} revision must match its source`);
      assert.equal(source.sha256, citation.sha256, `${claim.id} hash must match its source`);
      if (claim.origin === 'course' || claim.origin === 'external' || claim.origin === 'student') {
        assert.equal(source.origin, claim.origin, `${claim.id} must cite a ${claim.origin} source`);
      }
    }
  }
});

test('every positive direct citation resolves id, revision and hash to a fixture source', () => {
  const { citations, sources } = makeContractFixtures();
  const byId = new Map(Object.values(sources).map((s) => [s.id, s]));
  for (const [name, citation] of Object.entries(citations)) {
    if (name === 'runtimeUnresolvedSourceCitation') continue;
    const source = byId.get(citation.sourceId);
    assert.ok(source, `${name} must cite a fixture source`);
    assert.equal(source.revision, citation.sourceRevision);
    assert.equal(source.sha256, citation.sha256);
  }
  assert.equal(byId.has(citations.runtimeUnresolvedSourceCitation.sourceId), false);
});
