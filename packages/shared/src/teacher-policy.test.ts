import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatMessageRequestSchema, ExplorationAnchorSchema, TeacherPolicySchema, TEACHER_POLICIES } from './teacher-policy';
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
