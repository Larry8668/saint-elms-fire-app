import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatRequest, ChatStreamEvent, WikiClaim } from '@sef/shared';
import type { StoredSettings } from '../settings/store';
import { runChatTurn, type HarnessDeps } from './harness';
import { ACADEMIC_REDIRECT, PRIVACY_REFUSAL } from './lanes';
import { UNTRUSTED_CONTENT_NOTE } from './prompts';
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
      allLessons: async () => lessons,
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

test('factual content is withheld until its checks pass — progress streams, text does not', async () => {
  const h = harness('unused');
  h.deps.makeAgent = ((_id: string, _prompt: string) => ({
    stream: async () => ({ textStream: (async function* () { yield 'one '; yield 'two '; yield 'three'; })() }),
  })) as unknown as HarnessDeps['makeAgent'];
  await runChatTurn(turn({ teacher: 'guide', messages: [{ role: 'user', content: 'explain resonance' }] }), h.deps, (e) => h.events.push(e));
  const deltas = h.events.filter((e) => e.type === 'delta').map((e) => (e.type === 'delta' ? e.text : ''));
  const finished = done(h.events);
  assert.deepEqual(deltas, [finished.text], 'one delta carries the verified answer, not streamed chunks');
  const deltaIndex = h.events.findIndex((e) => e.type === 'delta');
  const doneIndex = h.events.findIndex((e) => e.type === 'done');
  assert.ok(deltaIndex === doneIndex - 1, 'the only delta arrives after the evidence checks');
});

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

/** A PNG header carrying the given dimensions, as the client would base64 it. */
const pngData = (width: number, height: number): string => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13, 0);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), length, Buffer.from('IHDR'), ihdr, Buffer.alloc(4)]).toString('base64');
};

test('an image too large to read on this device is refused before any model is built', async () => {
  const h = harness('unused — the model must not be asked');
  await runChatTurn(
    turn({ teacher: 'guide', messages: [{ role: 'user', content: 'what does this diagram say?', attachments: [{ kind: 'image', mimeType: 'image/png', data: pngData(9000, 9000), name: 'huge.png' }] }] }),
    h.deps,
    (e) => h.events.push(e),
  );
  const finished = done(h.events);
  assert.equal(finished.verification.lane, 'refused');
  assert.match(finished.text, /9000×9000/);
  const check = finished.verification.checks.find((c) => c.id === 'image_size');
  assert.equal(check?.passed, true);
  assert.equal(check?.detail, 'image_too_large');
  assert.equal(h.agentCalls(), 0, 'no model was built');
});

test('a right-sized image passes the size gate and reaches the model', async () => {
  const h = harness('I can read that diagram.');
  await runChatTurn(
    turn({ teacher: 'guide', messages: [{ role: 'user', content: 'what does this diagram say?', attachments: [{ kind: 'image', mimeType: 'image/png', data: pngData(800, 600), name: 'diagram.png' }] }] }),
    h.deps,
    (e) => h.events.push(e),
  );
  assert.equal(h.agentCalls(), 1, 'the turn went ahead');
  assert.equal(done(h.events).verification.lane, 'answered');
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

const candidate = (over: Record<string, unknown> = {}) =>
  ({
    pageId: 'damping',
    pageRevision: 'rev-1',
    courseConceptKey: 'damping',
    courseRefs: ['mech'],
    title: 'Damping, in my words',
    summary: 'What damping says in one line.',
    status: 'met',
    courseName: 'Mechanics',
    conceptLabel: 'damping',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as import('@sef/shared').AnchorCandidate;

/** A resolver that proves whatever the seam decided, so the harness side is what is tested. */
const resolving = (captured: { claimedRevision?: string } = {}) => ({
  resolve: async (request: { claimedRevision?: string }) => {
    captured.claimedRevision = request.claimedRevision;
    return { ok: true as const, anchor: { pageId: 'damping', pageRevision: 'rev-1', courseConceptKey: 'damping', courseRefs: ['mech'] }, courseRefs: ['mech'], candidate: candidate() };
  },
});

test('an anchored Philosopher turn searches the concept, never the student’s words', async () => {
  const h = harness('Damping drains amplitude. [lesson: damped]');
  h.deps.anchors = resolving() as never;
  const queries: string[] = [];
  h.deps.searchWeb = (async (_url: string, q: string) => {
    queries.push(q);
    return [{ title: 'T', url: 'https://x.test', snippet: 'S' }];
  }) as never;
  await runChatTurn(
    turn({ teacher: 'philosopher', messages: [{ role: 'user', content: 'tell my roommate Priya that damping is like her loud neighbour' }], anchorPageId: 'damping', consent: { web: true } }),
    h.deps,
    (e) => h.events.push(e),
  );
  assert.deepEqual(queries, ['damping'], 'the topic-only query — chat text never leaves the device');
  assert.match(h.instructions(), /WEB RESULTS/);
  assert.ok(h.instructions().includes(UNTRUSTED_CONTENT_NOTE), 'the web results are marked as untrusted data');
  const finished = done(h.events);
  assert.equal(finished.verification.toolCalls.find((t) => t.tool === 'web_search')?.summary?.includes('Priya'), false, 'the tool record names the query, not the message');
});

test('compiled wiki pages reach the prompt marked as untrusted data', async () => {
  const h = harness('Damping drains amplitude. [lesson: damped]');
  h.deps.wiki = {
    listPages: async () => [
      {
        id: 'page-1',
        kind: 'synthesis',
        state: 'ok',
        revision: 'r1',
        metadata: { title: 'Damping synthesis', summary: 'Damping, drawn together.', claims: [], links: [], updatedAt: '2026-01-01T00:00:00.000Z' },
        body: 'Damping, drawn together.',
      },
    ],
    readPage: async () => null,
    listSources: async () => ({}),
    readSource: async () => null,
  } as never;
  await runChatTurn(turn({ teacher: 'guide', messages: [{ role: 'user', content: 'explain damping' }] }), h.deps, (e) => h.events.push(e));
  const block = h.instructions();
  assert.match(block, /WIKI PAGES THAT ALREADY COVER THIS/);
  assert.ok(block.includes(UNTRUSTED_CONTENT_NOTE), 'the wiki pages block carries the untrusted-content line');
});

test('the anchor reaches the prompt as context and the answer as provenance', async () => {
  const h = harness('Damping drains amplitude. [lesson: damped]');
  const captured: { claimedRevision?: string } = {};
  h.deps.anchors = resolving(captured) as never;
  await runChatTurn(
    turn({ teacher: 'philosopher', messages: [{ role: 'user', content: 'where else does damping show up?' }], anchorPageId: 'damping', anchorRevision: 'rev-1' }),
    h.deps,
    (e) => h.events.push(e),
  );
  assert.equal(captured.claimedRevision, 'rev-1', 'the client’s claimed revision is the seam’s input');
  const block = h.instructions();
  assert.match(block, /EXPLORATION ANCHOR/, 'the model opens from the student’s own page');
  assert.match(block, /Damping, in my words/);
  const finished = done(h.events);
  assert.equal(finished.verification.anchor?.pageId, 'damping', 'the served answer records what it was explored under');
  const anchorCheck = finished.verification.checks.find((c) => c.id === 'anchor');
  assert.equal(anchorCheck?.passed, true);
  assert.match(anchorCheck?.detail ?? '', /Damping, in my words @ rev-1/);
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

test('a forged lesson citation fails before display and is reported, never re-labelled', async () => {
  const h = harness('A damped oscillator loses amplitude over time as friction drains its energy. [lesson: torsion-pendulum]');
  await runChatTurn(turn({ teacher: 'guide', messages: [{ role: 'user', content: 'explain damping' }] }), h.deps, (e) => h.events.push(e));
  const finished = done(h.events);
  assert.doesNotMatch(finished.text, /torsion-pendulum|\[lesson:/, 'the forged marker is never display text');
  const citations = finished.verification.checks.find((c) => c.id === 'citations');
  assert.equal(citations?.passed, false);
  assert.match(citations?.detail ?? '', /does not exist|outside this teacher’s evidence/);
});

test('a statement the permitted evidence cannot back is withheld, not streamed then repaired', async () => {
  const h = harness('A damped oscillator loses amplitude over time as friction drains its energy. The moon is made of green cheese.');
  await runChatTurn(turn({ teacher: 'guide', messages: [{ role: 'user', content: 'explain damping' }] }), h.deps, (e) => h.events.push(e));
  const finished = done(h.events);
  assert.match(finished.text, /damped oscillator/);
  assert.doesNotMatch(finished.text, /green cheese/);
  const deltas = h.events.filter((e) => e.type === 'delta').map((e) => (e.type === 'delta' ? e.text : ''));
  assert.ok(deltas.every((d) => !d.includes('green cheese')), 'the unsupported statement was never streamed');
  assert.equal(finished.verification.withheld, 1);
  assert.equal(finished.verification.checks.find((c) => c.id === 'evidence')?.passed, false);
});

test('missing evidence produces honest uncertainty, not a manufactured answer', async () => {
  const h = harness('Quantum gravity unifies all four forces. It predicts graviton oscillations weekly.');
  await runChatTurn(turn({ teacher: 'guide', messages: [{ role: 'user', content: 'explain quantum gravity' }] }), h.deps, (e) => h.events.push(e));
  const finished = done(h.events);
  assert.match(finished.text, /don’t back that|won’t invent/);
  assert.equal(finished.verification.lane, 'answered');
});

test('a citation naming a real lesson outside the Friend’s pool is wrong-owner', async () => {
  const h = harness('The lesson on Damped Oscillations covers fees [lesson: damped].');
  await runChatTurn(turn({ teacher: 'friend', messages: [{ role: 'user', content: 'what about my fees?' }] }), h.deps, (e) => h.events.push(e));
  const finished = done(h.events);
  assert.doesNotMatch(finished.text, /\[lesson:/);
  assert.match(finished.verification.checks.find((c) => c.id === 'citations')?.detail ?? '', /outside this teacher’s evidence/);
});

test('the served answer carries its evidence map and the provider is disclosed', async () => {
  const h = harness('A damped oscillator loses amplitude over time as friction drains its energy. [lesson: damped]');
  await runChatTurn(turn({ teacher: 'guide', messages: [{ role: 'user', content: 'explain damping' }] }), h.deps, (e) => h.events.push(e));
  const finished = done(h.events);
  assert.ok(finished.verification.segments?.length, 'segments are part of the response contract');
  assert.equal(finished.verification.providerKind, 'ollama');
  const provider = finished.verification.checks.find((c) => c.id === 'provider');
  assert.equal(provider?.label, 'Answered by a model on this device');
  const fact = finished.verification.segments?.find((s) => s.kind === 'fact');
  assert.equal(fact?.support, 'supported');
  assert.deepEqual(fact?.sources, ['damped']);
});

const confirmedRecord = {
  id: 'log-fees',
  title: 'Semester fees — instalment 2',
  kind: 'deadline' as const,
  state: 'confirmed' as const,
  dueAt: '2026-03-14',
  allDay: true,
  timeZone: 'Asia/Kolkata',
  details: 'Pay through the student portal.',
  provenance: { kind: 'manual' as const },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const proposedRecord = { ...confirmedRecord, id: 'log-draft', title: 'Exam timetable draft', state: 'proposed' as const, dueAt: null, details: '', provenance: { kind: 'friend_extraction' as const } };

const logisticsStub = (records = [confirmedRecord], proposed = [proposedRecord]) => ({
  confirmed: async () => records,
  proposed: async () => proposed,
  propose: async () => proposed,
});

test('the Friend is shown confirmed logistics as citable, and proposals as unconfirmable', async () => {
  const h = harness('Your semester fees instalment is due on 2026-03-14 in Asia/Kolkata [logistics: log-fees].');
  h.deps.logistics = logisticsStub() as never;
  await runChatTurn(turn({ teacher: 'friend', messages: [{ role: 'user', content: 'when are my fees due?' }] }), h.deps, (e) => h.events.push(e));
  const block = h.instructions();
  assert.match(block, /YOUR LOGISTICS/);
  assert.match(block, /Semester fees — instalment 2.*due 2026-03-14 \(Asia\/Kolkata\)/);
  assert.match(block, /UNCONFIRMED LOGISTICS/);
  const finished = done(h.events);
  assert.match(finished.text, /due on 2026-03-14/, 'a confirmed record backed the statement');
  const fact = finished.verification.segments?.find((s) => s.kind === 'fact');
  assert.deepEqual(fact?.sources, ['log-fees']);
});

test('an answer asserting an unconfirmed extraction has its statement withheld', async () => {
  const h = harness('The exam timetable says your physics paper is on the 14th. [logistics: log-draft]');
  h.deps.logistics = logisticsStub() as never;
  await runChatTurn(turn({ teacher: 'friend', messages: [{ role: 'user', content: 'what is my exam date?' }] }), h.deps, (e) => h.events.push(e));
  const finished = done(h.events);
  assert.doesNotMatch(finished.text, /physics paper is on the 14th/, 'unconfirmed contents cannot be served as fact');
  assert.equal(finished.verification.withheld, 1);
});

test('Guide and Philosopher never see the logistics ledger even when it is wired in', async () => {
  const { committedPageAnchors } = await import('./anchor');
  for (const teacher of ['guide', 'philosopher'] as const) {
    const h = harness('unused');
    h.deps.logistics = logisticsStub() as never;
    if (teacher === 'philosopher') {
      h.deps.anchors = committedPageAnchors;
      h.deps.committedAnchors = new Map([['page-1', { pageId: 'page-1', revision: 'r1', courseConceptKey: 'damping', courseRefs: ['mech'] }]]);
    }
    const request =
      teacher === 'philosopher'
        ? turn({ teacher, messages: [{ role: 'user', content: 'fees?' }], anchorPageId: 'page-1' })
        : turn({ teacher, messages: [{ role: 'user', content: 'fees?' }] });
    await runChatTurn(request, h.deps, (e) => h.events.push(e));
    assert.equal(h.agentCalls(), 1, `${teacher} reached the model — the boundary held by policy, not by absence`);
    assert.doesNotMatch(h.instructions(), /YOUR LOGISTICS|Semester fees/, `${teacher} must not read the student's logistics`);
  }
});

test('a Friend image turn proposes an extraction that lands behind confirmation', async () => {
  const filed: string[] = [];
  const h = harness('I read the notice for you.');
  h.deps.logistics = logisticsStub() as never;
  h.deps.extractImage = (async (_image: unknown, _model: unknown, store: { propose: (d: unknown[]) => Promise<unknown> }) => {
    const proposed = await store.propose([{ title: 'Exam timetable draft' }]);
    filed.push('done');
    return { ok: true, proposed };
  }) as never;
  await runChatTurn(
    turn({ teacher: 'friend', messages: [{ role: 'user', content: 'what does this notice say?', attachments: [{ kind: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', name: 'notice.png' }] }] }),
    h.deps,
    (e) => h.events.push(e),
  );
  const finished = done(h.events);
  assert.deepEqual(filed, ['done'], 'the extraction ran alongside the answer');
  assert.equal(finished.verification.toolCalls.some((t) => t.tool === 'logistics_extract'), true);
  const check = finished.verification.checks.find((c) => c.id === 'logistics');
  assert.match(check?.detail ?? '', /proposal.*confirm/i);
  assert.equal(check?.passed, true);
});

test('a privacy verdict on the extraction files nothing and says so', async () => {
  const h = harness('I read the notice for you.');
  h.deps.logistics = logisticsStub() as never;
  h.deps.extractImage = (async () => ({ ok: false, reason: 'privacy', message: 'personal details' })) as never;
  await runChatTurn(
    turn({ teacher: 'friend', messages: [{ role: 'user', content: 'what is in this?', attachments: [{ kind: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', name: 'notice.png' }] }] }),
    h.deps,
    (e) => h.events.push(e),
  );
  const check = done(h.events).verification.checks.find((c) => c.id === 'logistics');
  assert.match(check?.detail ?? '', /privacy rule.*nothing filed/i);
});

test('a text-only Friend turn never reaches for the extraction seam', async () => {
  let calls = 0;
  const h = harness('Fees are due in week 6.');
  h.deps.logistics = logisticsStub() as never;
  h.deps.extractImage = (async () => {
    calls += 1;
    return { ok: true, proposed: [] };
  }) as never;
  await runChatTurn(turn({ teacher: 'friend', messages: [{ role: 'user', content: 'when are fees due?' }] }), h.deps, (e) => h.events.push(e));
  assert.equal(calls, 0, 'no image, no extraction');
});