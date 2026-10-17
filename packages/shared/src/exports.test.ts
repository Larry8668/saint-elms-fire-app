import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as shared from './index';

test('root export stays browser-safe: no node-only helpers leak', () => {
  for (const name of [
    'hashPassword',
    'mintGatewayToken',
    'verifyGatewayToken',
    'verifyPassword',
    'signToken',
    'verifyToken',
    'TokenError',
    'loadCourseware',
    'loadProgrammeManifest',
    'ProgrammeManifestError',
    'resolveContentDir',
  ]) {
    assert.equal(name in shared, false, `${name} must stay behind @sef/shared/node`);
  }
});

test('root export keeps legacy and adds versioned contract schemas', () => {
  for (const name of [
    'CourseSummarySchema',
    'LoginRequestSchema',
    'EDGE_TYPES',
    'TEACHER_IDS',
    'ContractErrorSchema',
    'EnrolmentSchema',
    'ProgrammeSchema',
    'SourceRecordSchema',
    'WikiPageSchema',
    'PublishShareRequestSchema',
    'ChatMessageRequestSchema',
    'TEACHER_POLICIES',
    'CONTRACT_VERSION',
  ]) {
    assert.equal(name in shared, true, `${name} should be exported from the root`);
  }
});
