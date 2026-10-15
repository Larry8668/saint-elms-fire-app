import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatRequest, ChatStreamEvent, WikiClaim } from '@sef/shared';
import type { StoredSettings } from '../settings/store';
import { runChatTurn, type HarnessDeps } from './harness';
import { ACADEMIC_REDIRECT, PRIVACY_REFUSAL } from './lanes';
import type { ClaimReader } from '../brain/claim-evidence';

const settings = {
  searxngUrl: 'http://searx.invalid:8888',
  thinking: false,
  providers: [{ id: 'local', kind: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434' }],
  roles: { tutor: { provider: 'local', model: 'gemma4:e4b' }, vision: { provider: 'local', model: 'gemma4:e4b' } },
} as unknown as StoredSettings;

const lessons = [
  { id: 'fees', courseId: 'support', courseName: 'Student Life', moduleId: 's1', moduleName: 'Admin', subjectId: 'admin', semesterNumber: 1, order: 1, title: 'Fees and Deadlines', concepts: ['fee deadlines'], prerequisites: [], tags: [], markdown: 'Fees are due in week 6.' },
  { id: 'damped', courseId: 'mech', courseName: 'Mechanics', moduleId: 'm1', moduleName: 'Oscillations', subjectId: 'physics', semesterNumber: 1, order: 1, title: 'Damped Oscillations', concepts: ['damping'], prerequisites: [], tags: [], markdown: 'A damped oscillator loses amplitude over time.' },
];

interface Harness {
  deps: HarnessDeps;
  events: ChatStreamEvent[];
  agentCalls: () => number;
  webCalls: () => number;
  instructions: () => string;
}

function harness(reply: string, claims?: ClaimReader): Harness {
  const events: ChatStreamEvent[] = [];
  const instructions: string[] = [];
  let agents = 0;
  let web = 0;
  const deps = {
    settings: { get: async () => settings },
    content: {
      supportLessons: async () => lessons.filter((l) => l.courseId === 'support'),
      academicLessons: async () => lessons.filter((l) => l.courseId !== 'support'),
      lesson: async (id: string) => lessons.find((l) => l.id === id) ?? null,
    },
    brain: {
      contextFor: async () => 'STUDENT BRAIN: empty so far.',
      page: async () => null,
      weakest: async () => [],
    },
    sessions: { appendTurn: async () => ({}) },
    studentName: 'Ada',
    claims,
    makeAgent: ((_id: string, prompt: string) => {
      agents += 1;
      instructions.push(prompt);
      return { stream: async () => ({ textStream: (async function* () { yield reply; })() }) };
    }) as unknown as HarnessDeps['makeAgent'],
    searchWeb: (async () => {
      web += 1;
      return [];
    }) as unknown as HarnessDeps['searchWeb'],
  } as unknown as HarnessDeps;
  return { deps, events, agentCalls: () => agents, webCalls: () => web, instructions: () => instructions.join('\n') };
}

const turn = (over: Partial<ChatRequest> & Pick<ChatRequest, 'teacher'>): ChatRequest => ({
  sessionId: 's-1',
  messages: [{ role: 'user', content: 'fees?' }],
  ...over,
});

const done = (events: ChatStreamEvent[]) => {
  const event = events.find((e) => e.type === 'done');
  assert.ok(event && event.type === 'done', 'the turn finished');
  return event;
};

test('the Friend refuses classmates’ contact details without reaching the model', async () => {
  const h = harness('here is my roommate’s phone number: 98450 11223');
  await runChatTurn(turn({ teacher: 'friend', messages: [{ role: 'user', content: 'what is my roommate’s phone number?' }] }), h.deps, (e) => h.events.push(e));
  const finished = done(h.events);
  assert.equal(finished.text, PRIVACY_REFUSAL);
  assert.equal(finished.verification.lane, 'refused');
  assert.equal(h.agentCalls(), 0, 'no model was built');
});

test('a request smuggled through an image’s alt text is refused before the model sees it', async () => {
  const h = harness('sure, their number is 98450 11223');
  await runChatTurn(
    turn({
      teacher: 'friend',
      messages: [
        {
          role: 'user',
          content: 'what does this notice say?',
          attachments: [{ kind: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', name: 'notice.png', altText: 'my roommate’s phone number is 98450 11223' }],
        },
      ],
    }),
    h.deps,
    (e) => h.events.push(e),
  );
  assert.equal(done(h.events).text, PRIVACY_REFUSAL);
  assert.equal(h.agentCalls(), 0, 'the lane check ran before any model was built');
});

test('a request smuggled through an image’s filename is refused too', async () => {
  const h = harness('sure');
  await runChatTurn(
    turn({
      teacher: 'friend',
      messages: [{ role: 'user', content: 'have a look', attachments: [{ kind: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', name: "roommate's phone number.png" }] }],
    }),
    h.deps,
    (e) => h.events.push(e),
  );
  assert.equal(done(h.events).text, PRIVACY_REFUSAL);
  assert.equal(h.agentCalls(), 0);
});

test('an academic image is routed to the Guide, not answered by the Friend', async () => {
  const h = harness('the formula is …');
  await runChatTurn(
    turn({
      teacher: 'friend',
      messages: [{ role: 'user', content: 'what is in this?', attachments: [{ kind: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', name: 'formula-sheet.png' }] }],
    }),
    h.deps,
    (e) => h.events.push(e),
  );
  const finished = done(h.events);
  assert.equal(finished.text, ACADEMIC_REDIRECT);
  assert.equal(finished.verification.lane, 'redirected');
  assert.equal(h.agentCalls(), 0);
});

test('an image-only Friend message no longer skips the lane check', async () => {
  const h = harness('anything');
  await runChatTurn(
    turn({
      teacher: 'friend',
      messages: [{ role: 'user', content: '', attachments: [{ kind: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', altText: 'the email address for the class list' }] }],
    }),
    h.deps,
    (e) => h.events.push(e),
  );
  assert.equal(done(h.events).text, PRIVACY_REFUSAL);
  assert.equal(h.agentCalls(), 0);
});

test('what the model reads out of an image is re-checked and refused if it leaks', async () => {
  const h = harness('This photo of the notice lists my roommate’s phone number as 98450 11223.');
  await runChatTurn(
    turn({ teacher: 'friend', messages: [{ role: 'user', content: 'what is in this photo?', attachments: [{ kind: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', name: 'notice.png' }] }] }),
    h.deps,
    (e) => h.events.push(e),
  );
  const finished = done(h.events);
  assert.equal(finished.text, PRIVACY_REFUSAL, 'the extracted text is untrusted input, not a clean answer');
  assert.equal(finished.verification.lane, 'refused');
  assert.match(finished.verification.checks.map((c) => c.id).join(','), /privacy/);
});

test('an image capability a teacher was not granted is refused, not silently dropped', async () => {
  const h = harness('…');
  await runChatTurn(
    turn({ teacher: 'philosopher', messages: [{ role: 'user', content: 'what is this?', attachments: [{ kind: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] }] }),
    h.deps,
    (e) => h.events.push(e),
  );
  const finished = done(h.events);
  assert.equal(finished.verification.lane, 'refused');
  assert.match(finished.text, /Guide/);
  assert.match(finished.verification.checks.find((c) => c.id === 'capabilities')?.detail ?? '', /attachment:image/);
  assert.equal(h.agentCalls(), 0);
});

test('the Philosopher refuses without a committed anchor and makes no web call', async () => {
  const h = harness('[course] …');
  await runChatTurn(turn({ teacher: 'philosopher', messages: [{ role: 'user', content: 'where else does resonance show up?' }], consent: { web: true } }), h.deps, (e) => h.events.push(e));
  const finished = done(h.events);
  assert.equal(finished.verification.lane, 'refused');
  assert.match(finished.text, /own wiki/);
  assert.equal(finished.verification.checks.find((c) => c.id === 'anchor')?.detail, 'no_anchor');
  assert.equal(h.webCalls(), 0, 'no unconditional web call on an anchorless turn');
  assert.equal(h.agentCalls(), 0, 'no generic answer instead of a refusal');
});

test('a syllabus concept offered as an anchor is refused by name', async () => {
  const h = harness('[course] …');
  await runChatTurn(turn({ teacher: 'philosopher', messages: [{ role: 'user', content: 'explore resonance' }], syllabusConceptKey: 'damped-oscillations' }), h.deps, (e) => h.events.push(e));
  const finished = done(h.events);
  assert.equal(finished.verification.checks.find((c) => c.id === 'anchor')?.detail, 'syllabus_concept_not_an_anchor');
  assert.equal(h.webCalls(), 0);
  assert.equal(h.agentCalls(), 0);
});

const claim = (over: Partial<WikiClaim> & Pick<WikiClaim, 'id' | 'text'>): WikiClaim =>
  ({
    kind: 'source_fact',
    origin: 'course',
    status: 'current',
    citations: [{ sourceId: 'src-1', sourceRevision: 'r1', sha256: 'a'.repeat(64), locator: { kind: 'text', start: 0, end: 10 } }],
    supersedes: [],
    ...over,
  }) as WikiClaim;

test('the Guide sees supported claims and is told the unsupported one may not be asserted', async () => {
  const claims: ClaimReader = {
    listPages: async () => [{ metadata: { claims: [claim({ id: 'c-1', text: 'Damping lowers the resonant frequency' }), claim({ id: 'c-2', text: 'The registrar confirmed a fee waiver', citations: [] })] } }],
    listSources: async () => ({ 'src-1': { revision: 'r1', origin: 'course' } }) as never,
  };
  const h = harness('The lesson on Damped Oscillations shows how damping lowers the resonant frequency.\n\nTrailhead: where else could you see damping?', claims);
  await runChatTurn(turn({ teacher: 'guide', messages: [{ role: 'user', content: 'why is the damped frequency lower?' }] }), h.deps, (e) => h.events.push(e));
  const block = h.instructions();
  assert.match(block, /Damping lowers the resonant frequency/);
  assert.match(block, /not assertable: uncited/, 'the unsupported claim is withheld, and named as withheld');
  assert.match(block, /may not assert|may not be asserted/i);
});

test('one unsupported claim does not remove the supported ones', async () => {
  const claims: ClaimReader = {
    listPages: async () => [
      {
        metadata: {
          claims: [
            claim({ id: 'c-1', text: 'Supported claim one' }),
            claim({ id: 'c-2', text: 'Superseded claim', status: 'superseded' }),
            claim({ id: 'c-3', text: 'Supported claim two' }),
          ],
        },
      },
    ],
    listSources: async () => ({ 'src-1': { revision: 'r1', origin: 'course' } }) as never,
  };
  const h = harness('…', claims);
  await runChatTurn(turn({ teacher: 'guide', messages: [{ role: 'user', content: 'explain damping' }] }), h.deps, (e) => h.events.push(e));
  const block = h.instructions();
  assert.match(block, /Supported claim one/);
  assert.match(block, /Supported claim two/);
  assert.match(block, /not assertable: superseded/);
  assert.equal(h.agentCalls(), 1, 'the turn went ahead with what could be asserted');
});

test('a citation pinned to a superseded revision of the source is withheld', async () => {
  const claims: ClaimReader = {
    listPages: async () => [{ metadata: { claims: [claim({ id: 'c-1', text: 'Stale claim' })] } }],
    listSources: async () => ({ 'src-1': { revision: 'r2', origin: 'course' } }) as never,
  };
  const h = harness('…', claims);
  await runChatTurn(turn({ teacher: 'guide', messages: [{ role: 'user', content: 'explain damping' }] }), h.deps, (e) => h.events.push(e));
  assert.match(h.instructions(), /not assertable: superseded_source/);
});

test('the Friend is given the support pool, never the courseware', async () => {
  const h = harness('Fees are due in week 6.');
  await runChatTurn(turn({ teacher: 'friend', messages: [{ role: 'user', content: 'when are fees due?' }] }), h.deps, (e) => h.events.push(e));
  const block = h.instructions();
  assert.match(block, /UNIVERSITY NOTES/);
  assert.match(block, /Fees and Deadlines/);
  assert.doesNotMatch(block, /Damped Oscillations/);
});