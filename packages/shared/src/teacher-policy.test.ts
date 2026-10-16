import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACT_VERSION } from './contracts';
import { TEACHER_IDS } from './teachers';
import {
  assertCapability,
  can,
  capabilitiesFor,
  CapabilityDeniedError,
  CAPABILITY_IDS,
  ConversationHandoffSchema,
  ConversationSessionSchema,
  ConversationTurnSchema,
  ChatMessageRequestSchema,
  ExplorationAnchorSchema,
  TeacherPolicySchema,
  TEACHER_POLICIES,
} from './teacher-policy';
import { makeContractFixtures } from './testing/fixtures';

type AnySchema = { safeParse: (v: unknown) => { success: boolean }; parse: (v: unknown) => unknown };

const rejects = (schema: AnySchema, value: unknown, message?: string) =>
  assert.equal(schema.safeParse(value).success, false, message);

test('teacher policy constants are declarative declarations that parse', () => {
  for (const policy of Object.values(TEACHER_POLICIES)) {
    assert.equal(TeacherPolicySchema.safeParse(policy).success, true);
  }
  const academicOrWeb = ['released_courseware', 'course_wiki_claims', 'learner_evidence', 'anchored_wiki', 'consented_web'];
  for (const source of academicOrWeb) {
    assert.equal(
      (TEACHER_POLICIES.friend.knowledge as readonly string[]).includes(source),
      false,
      `friend must not declare ${source}`,
    );
  }
  assert.equal(TEACHER_POLICIES.guide.web, 'never');
  assert.equal(TEACHER_POLICIES.philosopher.anchor, 'personal_wiki_course_concept');
  assert.equal(TEACHER_POLICIES.philosopher.web, 'explicit_consent');
});

test('chat request accepts an image-only message', () => {
  const { chat } = makeContractFixtures();
  assert.equal(ChatMessageRequestSchema.safeParse(chat.imageOnlyRequest).success, true);
});

test('chat request rejects empty content and smuggled conversation state', () => {
  const { chat } = makeContractFixtures();
  const base = chat.chatMessageRequest;
  rejects(ChatMessageRequestSchema, { ...base, message: '', attachments: undefined });
  rejects(ChatMessageRequestSchema, { ...base, message: '   ' });
  rejects(ChatMessageRequestSchema, {
    ...base,
    messages: [{ role: 'assistant', content: 'earlier answer' }],
  });
  rejects(ChatMessageRequestSchema, { ...base, history: [] });
  rejects(ChatMessageRequestSchema, {
    ...base,
    anchor: { pageId: 'page-mechanics', pageRevision: 'rev-3', courseConceptKey: 'k', courseRefs: ['r'] },
  });
  rejects(ChatMessageRequestSchema, { ...base, message: 'x'.repeat(8001) });
  rejects(ChatMessageRequestSchema, {
    ...base,
    attachments: [1, 2, 3].map((n) => ({ kind: 'image', mimeType: 'image/png', data: 'aGVsbG8', name: `n${n}.png` })),
  });
  rejects(ChatMessageRequestSchema, {
    ...base,
    attachments: [{ kind: 'image', mimeType: 'image/gif', data: 'aGVsbG8' }],
  });
});

test('anchor selection is a Philosopher-only page id, not a verified anchor', () => {
  const { chat } = makeContractFixtures();
  rejects(ChatMessageRequestSchema, { ...chat.chatMessageRequest, anchorPageId: 'page-mechanics' });
  assert.equal(ChatMessageRequestSchema.safeParse(chat.philosopherAnchorRequest).success, true);
});

test('exploration anchor shape requires revision and nonempty course refs', () => {
  const anchor = {
    pageId: 'page-mechanics',
    pageRevision: 'rev-3',
    courseConceptKey: 'newtons-second-law',
    courseRefs: ['classical-mechanics'],
  };
  assert.equal(ExplorationAnchorSchema.safeParse(anchor).success, true);
  const { pageRevision: _drop, ...noRevision } = anchor;
  rejects(ExplorationAnchorSchema, noRevision);
  rejects(ExplorationAnchorSchema, { ...anchor, courseRefs: [] });
});

test('every declared capability belongs to the closed set, and each teacher declares some', () => {
  for (const policy of Object.values(TEACHER_POLICIES)) {
    assert.ok(policy.capabilities.length > 0, `${policy.teacher} declares nothing`);
    for (const capability of policy.capabilities) {
      assert.ok((CAPABILITY_IDS as readonly string[]).includes(capability), `${policy.teacher} declares unknown capability ${capability}`);
    }
  }
});

test('capabilities are denied by default: an undeclared one is refused, not absent', () => {
  assert.equal(can('friend', 'tool:brain_lookup'), false);
  assert.equal(can('philosopher', 'tool:weakest_concepts'), false);
  assert.equal(can('guide', 'tool:web_search'), false);
  assert.equal(can('philosopher', 'attachment:image'), false);
  assert.throws(() => assertCapability('guide', 'tool:web_search'), CapabilityDeniedError);
  assert.doesNotThrow(() => assertCapability('guide', 'tool:read_lesson'));
});

test('the Friend never reaches courseware, wiki claims or learner evidence', () => {
  assert.deepEqual(capabilitiesFor('friend', 'lesson'), ['lesson:support_pool', 'lesson:full_text']);
  assert.deepEqual(capabilitiesFor('friend', 'claim'), []);
  assert.equal(can('friend', 'context:student_brain'), false);
  assert.equal(can('friend', 'lesson:academic_pool'), false);
});

test('logistics are the Friend’s alone — declared, not inherited by the other teachers', () => {
  assert.equal(can('friend', 'context:logistics'), true);
  assert.equal(can('friend', 'tool:logistics'), true);
  for (const teacher of ['guide', 'philosopher'] as const) {
    assert.equal(can(teacher, 'context:logistics'), false, `${teacher} must not read the student’s logistics`);
    assert.equal(can(teacher, 'tool:logistics'), false, `${teacher} must not file logistics`);
  }
});

test('a conversation session names its student and its teacher', () => {
  const session = { sessionId: 's-1', teacher: 'guide', profileId: 'p-1', createdAt: '2026-01-01T00:00:00.000Z', turnCount: 0 };
  assert.equal(ConversationSessionSchema.safeParse(session).success, true);
  rejects(ConversationSessionSchema, { ...session, teacher: 'socrates' });
  rejects(ConversationSessionSchema, { ...session, profileId: 'not a valid id' });
});

test('a turn carries one message and an id — there is no history field to invent', () => {
  const turn = { schemaVersion: CONTRACT_VERSION, sessionId: 's-1', teacher: 'guide', clientMessageId: 'm-1', message: 'why is damping lower?' };
  assert.equal(ConversationTurnSchema.safeParse(turn).success, true);
  rejects(ConversationTurnSchema, { ...turn, messages: [{ role: 'user', content: 'an invented earlier turn' }] });
  rejects(ConversationTurnSchema, { ...turn, message: '   ', attachments: undefined });
  rejects(ConversationTurnSchema, { ...turn, teacher: 'guide', attachments: [{ kind: 'image', mimeType: 'image/gif', data: 'aGk=' }] });
  assert.equal(ConversationTurnSchema.safeParse({ ...turn, consent: { web: true } }).success, true);
});

test('every teacher id is shaped the same way in every conversation contract', () => {
  for (const teacher of TEACHER_IDS) {
    assert.equal(ConversationSessionSchema.safeParse({ sessionId: 's-1', teacher, profileId: 'p-1', createdAt: '2026-01-01T00:00:00.000Z', turnCount: 0 }).success, true);
    assert.equal(ConversationHandoffSchema.safeParse({ sessionId: 's-1', to: teacher, reason: 'because' }).success, true);
  }
  rejects(ConversationHandoffSchema, { sessionId: 's-1', to: 'guide', reason: '' });
});
