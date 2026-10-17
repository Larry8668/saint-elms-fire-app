import { ContractErrorSchema, CONTRACT_VERSION } from '../contracts';
import {
  EnrolmentApplicationSchema,
  EnrolmentDecisionRequestSchema,
  EnrolmentSchema,
  StudentIdentitySchema,
  StudentProfileContextSchema,
} from '../identity';
import { ProgrammeSchema } from '../programme';
import {
  LearningEventSchema,
  SourceCitationSchema,
  SourceRecordSchema,
  WikiClaimSchema,
  WikiJobSchema,
  WikiPageDraftSchema,
  WikiPageSchema,
  WikiProposalSchema,
  type WikiPageDraft,
} from '../wiki';
import { PublishedShareSchema, PublishShareRequestSchema } from '../sharing';
import { ChatMessageRequestSchema } from '../teacher-policy';

const ISSUER = 'https://uni.example.test';
const PROGRAMME_ID = 'bsc-physics-mathematics-astrophysics';
const T0 = '2025-01-15T09:00:00.000Z';
const T1 = '2025-02-01T09:00:00.000Z';
const T2 = '2025-03-10T09:00:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

const profile = (studentId: string) => ({ issuer: ISSUER, studentId, programmeId: PROGRAMME_ID });

type ConceptDraft = Extract<WikiPageDraft, { kind: 'concept' }>;
type SourcedDraft = Extract<WikiPageDraft, { kind: 'source_summary' | 'synthesis' | 'question' }>;

const student = (id: string, name: string, email: string) =>
  StudentIdentitySchema.parse({
    schemaVersion: CONTRACT_VERSION,
    id,
    email,
    name,
    emailVerified: true,
    status: 'active',
    roles: ['student'],
    createdAt: T0,
  });

const enrolment = (id: string, studentId: string, cohortId: string) =>
  EnrolmentSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    id,
    studentId,
    programmeId: PROGRAMME_ID,
    curriculumVersion: 'curriculum-2024-r3',
    status: 'approved',
    cohortId,
    version: 2,
    requestedAt: T0,
    updatedAt: T1,
    decision: { actorId: 'registrar-1', at: T1, reason: 'Meets admission criteria' },
  });

const sourceBase = (id: string, revision: string, title: string, sha256: string, mediaType: string) => ({
  schemaVersion: CONTRACT_VERSION,
  id,
  profile: profile('student-a'),
  revision,
  title,
  createdAt: T1,
  mediaType,
  sha256,
  bytes: 2048,
  attribution: {},
  extractions: [{ revision, method: 'text' as const, sha256, createdAt: T1 }],
});

export function makeContractFixtures() {
  const programme = ProgrammeSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    id: PROGRAMME_ID,
    name: 'B.Sc. Physics, Mathematics and Astrophysics',
    institution: 'Example University',
    manifestVersion: 'manifest-2024-r3',
    sourceDocuments: ['curriculum-handbook-2024.pdf'],
    rows: [
      {
        schemaVersion: CONTRACT_VERSION,
        rowId: 'row-bridge-maths',
        courseId: 'bridge-maths',
        courseCode: 'BRD-101',
        courseName: 'Bridge Mathematics',
        subjectId: 'mathematics',
        semesterNumber: 1,
        courseType: 'Bridge Course',
        hoursPerWeek: 2,
        credits: 0,
        optionGroup: null,
        deliveryMode: 'authored-courseware',
        prerequisites: [],
        status: 'released',
      },
      {
        schemaVersion: CONTRACT_VERSION,
        rowId: 'row-mechanics',
        courseId: 'classical-mechanics',
        courseCode: 'PHY-110',
        courseName: 'Classical Mechanics',
        subjectId: 'physics',
        semesterNumber: 1,
        courseType: 'Major Core',
        hoursPerWeek: 4,
        credits: 4,
        optionGroup: null,
        deliveryMode: 'authored-courseware',
        prerequisites: ['bridge-maths'],
        status: 'released',
      },
      {
        schemaVersion: CONTRACT_VERSION,
        rowId: 'row-english',
        courseId: 'academic-english',
        courseCode: 'AEC-120',
        courseName: 'Academic English',
        subjectId: 'english',
        semesterNumber: 1,
        courseType: 'AEC',
        hoursPerWeek: 2,
        credits: 2,
        optionGroup: null,
        deliveryMode: 'external',
        prerequisites: [],
        status: 'external',
      },
      {
        schemaVersion: CONTRACT_VERSION,
        rowId: 'row-internship',
        courseId: 'summer-internship',
        courseCode: 'INT-400',
        courseName: 'Research Internship',
        subjectId: 'physics',
        semesterNumber: 4,
        courseType: 'Internship',
        hoursPerWeek: null,
        credits: 8,
        optionGroup: null,
        deliveryMode: 'internship-workflow',
        prerequisites: ['classical-mechanics'],
        status: 'pending',
      },
      {
        schemaVersion: CONTRACT_VERSION,
        rowId: 'row-support',
        courseId: 'university-support',
        courseCode: 'SUP-000',
        courseName: 'University Support Services',
        subjectId: 'administration',
        semesterNumber: 0,
        courseType: 'Administrative Support',
        hoursPerWeek: 0,
        credits: 0,
        optionGroup: null,
        deliveryMode: 'external',
        prerequisites: [],
        status: 'out_of_scope',
      },
      {
        schemaVersion: CONTRACT_VERSION,
        rowId: 'row-astro-theory',
        courseId: 'astro-theory',
        courseCode: 'AST-510',
        courseName: 'Stellar Structure',
        subjectId: 'astrophysics',
        semesterNumber: 5,
        courseType: 'Major Elective',
        hoursPerWeek: 3,
        credits: 3,
        optionGroup: 'elective-sem5',
        deliveryMode: 'authored-courseware',
        prerequisites: ['classical-mechanics'],
        status: 'planned',
      },
      {
        schemaVersion: CONTRACT_VERSION,
        rowId: 'row-astro-lab',
        courseId: 'astro-lab',
        courseCode: 'AST-511',
        courseName: 'Stellar Structure Lab',
        subjectId: 'astrophysics',
        semesterNumber: 5,
        courseType: 'Computational Lab',
        hoursPerWeek: 2,
        credits: 1,
        optionGroup: 'elective-sem5',
        deliveryMode: 'authored-courseware',
        prerequisites: [],
        status: 'planned',
      },
    ],
    optionGroups: [
      { id: 'elective-sem5', select: 1, bundles: [{ id: 'bundle-astro-theory-lab', rowIds: ['row-astro-theory', 'row-astro-lab'] }] },
    ],
  });

  const studentA = student('student-a', 'Ada Example', 'ada@example.test');
  const studentB = student('student-b', 'Bryn Example', 'bryn@example.test');
  const studentC = student('student-c', 'Cleo Example', 'cleo@example.test');
  const enrolmentA = enrolment('enrolment-a', 'student-a', 'cohort-a');
  const enrolmentB = enrolment('enrolment-b', 'student-b', 'cohort-b');
  const enrolmentC = enrolment('enrolment-c', 'student-c', 'cohort-a');
  const contextA = StudentProfileContextSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    identity: profile('student-a'),
    enrolmentId: 'enrolment-a',
    cohortId: 'cohort-a',
  });
  const application = EnrolmentApplicationSchema.parse({ schemaVersion: CONTRACT_VERSION, programmeId: PROGRAMME_ID });
  const decisionRequest = EnrolmentDecisionRequestSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    expectedVersion: 2,
    action: 'assign_cohort',
    reason: 'Cohort balancing',
    cohortId: 'cohort-b',
  });

  const studentNote = SourceRecordSchema.parse({
    ...sourceBase('source-student-note', 'rev-1', 'Notebook photo transcription', HASH_A, 'text/markdown'),
    kind: 'note',
    origin: 'student',
  });
  const courseDocument = SourceRecordSchema.parse({
    ...sourceBase('source-course-doc', 'rev-1', 'Released mechanics lesson', HASH_C, 'text/markdown'),
    kind: 'document',
    origin: 'course',
  });
  const externalDocument = SourceRecordSchema.parse({
    ...sourceBase('source-external-doc', 'rev-2', 'OpenStax University Physics Vol. 1', HASH_B, 'application/pdf'),
    kind: 'document',
    origin: 'external',
    attribution: { creator: 'OpenStax', url: 'https://openstax.example.test/physics' },
    extractions: [{ revision: 'rev-2', method: 'pdf' as const, sha256: HASH_B, createdAt: T1 }],
  });
  const studentImage = SourceRecordSchema.parse({
    ...sourceBase('source-student-image', 'rev-1', 'Whiteboard photo', HASH_C, 'image/jpeg'),
    kind: 'image',
    origin: 'student',
    extractions: [{ revision: 'rev-1', method: 'vision' as const, sha256: HASH_C, createdAt: T1 }],
  });
  const audioSource = SourceRecordSchema.parse({
    ...sourceBase('source-lecture-audio', 'rev-1', 'Lecture voice memo', HASH_A, 'audio/wav'),
    kind: 'audio',
    origin: 'student',
    extractions: [{ revision: 'rev-1', method: 'audio' as const, sha256: HASH_A, createdAt: T1 }],
  });
  const sessionSource = SourceRecordSchema.parse({
    ...sourceBase('source-session', 'rev-1', 'Guide session on oscillations', HASH_A, 'application/x-sef-session'),
    kind: 'session',
    origin: 'student',
    session: { sessionId: 'session-1', teacher: 'guide', firstTurn: 0, lastTurn: 3 },
  });
  const answerSource = SourceRecordSchema.parse({
    ...sourceBase('source-answer', 'rev-1', 'Guide answer on damping', HASH_B, 'text/markdown'),
    kind: 'answer',
    origin: 'model',
    session: { sessionId: 'session-1', teacher: 'guide', firstTurn: 2, lastTurn: 2 },
  });
  const peerSource = SourceRecordSchema.parse({
    ...sourceBase('source-peer', 'rev-1', 'Shared note from Cleo', HASH_C, 'text/markdown'),
    kind: 'peer',
    origin: 'peer',
    share: { id: 'share-1', revision: 'rev-1', senderId: 'student-c', cohortId: 'cohort-a' },
  });

  const courseCitation = SourceCitationSchema.parse({
    sourceId: 'source-course-doc',
    sourceRevision: 'rev-1',
    sha256: HASH_C,
    locator: { kind: 'text', start: 0, end: 80 },
  });
  const docCitation = SourceCitationSchema.parse({
    sourceId: 'source-external-doc',
    sourceRevision: 'rev-2',
    sha256: HASH_B,
    locator: { kind: 'pdf', page: 42, excerpt: 'A net force is required to change velocity.' },
  });
  const noteCitation = SourceCitationSchema.parse({
    sourceId: 'source-student-note',
    sourceRevision: 'rev-1',
    sha256: HASH_A,
    locator: { kind: 'text', start: 10, end: 88 },
  });
  const noteCitationAlt = SourceCitationSchema.parse({
    sourceId: 'source-student-note',
    sourceRevision: 'rev-1',
    sha256: HASH_A,
    locator: { kind: 'text', start: 120, end: 200 },
  });
  const sessionCitation = SourceCitationSchema.parse({
    sourceId: 'source-session',
    sourceRevision: 'rev-1',
    sha256: HASH_A,
    locator: { kind: 'session', firstTurn: 1, lastTurn: 2 },
  });
  const runtimeUnresolvedSourceCitation = SourceCitationSchema.parse({
    sourceId: 'source-missing',
    sourceRevision: 'rev-9',
    sha256: HASH_C,
    locator: { kind: 'text', start: 0, end: 12 },
  });

  const mechanicsDraft = WikiPageDraftSchema.parse({
    kind: 'concept',
    id: 'page-mechanics',
    title: 'Newton\u2019s second law',
    summary: 'Force as the rate of change of momentum.',
    markdown: 'F = dp/dt. A net force changes momentum; it is not needed to keep motion going.',
    courseRefs: [
      { programmeId: PROGRAMME_ID, courseId: 'classical-mechanics', conceptKey: 'newtons-second-law', lessonId: 'lesson-momentum' },
    ],
    claims: [
      {
        id: 'claim-fact-course',
        text: 'A net external force equals the rate of change of momentum.',
        kind: 'source_fact',
        origin: 'course',
        status: 'current',
        citations: [courseCitation],
        supersedes: [],
      },
      {
        id: 'claim-belief-student',
        text: 'I used to think a moving object needs a force to keep moving.',
        kind: 'student_belief',
        origin: 'student',
        status: 'current',
        citations: [noteCitation],
        supersedes: [],
      },
      {
        id: 'claim-disputed-belief',
        text: 'Friction always acts opposite to the direction of motion.',
        kind: 'student_belief',
        origin: 'student',
        status: 'disputed',
        citations: [noteCitationAlt],
        supersedes: [],
      },
      {
        id: 'claim-external-reading',
        text: 'The external reading discusses orbital motion.',
        kind: 'source_fact',
        origin: 'external',
        status: 'current',
        citations: [docCitation],
        supersedes: [],
      },
    ],
    links: [
      {
        toPageId: 'page-momentum',
        type: 'builds_upon',
        origin: 'student',
        why: 'Momentum conservation follows from the second law.',
        citations: [noteCitation],
      },
    ],
    learner: {
      inMyWords: 'Force changes momentum, it does not maintain speed.',
      stuck: 'Why a satellite keeps moving without thrust.',
      connections: 'Links impulse to collisions in the lab.',
      evidenceIds: ['source-student-note'],
    },
  }) as ConceptDraft;
  const mechanicsPage = WikiPageSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    profile: profile('student-a'),
    revision: 'rev-3',
    state: 'committed',
    updatedAt: T2,
    page: mechanicsDraft,
  });
  const sourceSummaryDraft = WikiPageDraftSchema.parse({
    kind: 'source_summary',
    id: 'page-openstax-summary',
    title: 'OpenStax chapter 4 summary',
    summary: 'Newton\u2019s laws and applications.',
    markdown: 'Chapter 4 derives F = ma from momentum.',
    courseRefs: [],
    claims: [],
    links: [],
    sourceIds: ['source-external-doc'],
  }) as SourcedDraft;
  const synthesisDraft = WikiPageDraftSchema.parse({
    kind: 'synthesis',
    id: 'page-force-synthesis',
    title: 'What force really does',
    summary: 'Combining the textbook and my notes.',
    markdown: 'Both the textbook and my session agree: force changes momentum.',
    courseRefs: [],
    claims: [],
    links: [],
    sourceIds: ['source-external-doc', 'source-student-note'],
  }) as SourcedDraft;
  const questionDraft = WikiPageDraftSchema.parse({
    kind: 'question',
    id: 'page-open-question',
    title: 'Why does a satellite not need thrust?',
    summary: 'Open question about orbital motion.',
    markdown: 'If force is not needed for motion, what keeps changing the satellite\u2019s direction?',
    courseRefs: [],
    claims: [],
    links: [],
    sourceIds: [],
  }) as SourcedDraft;

  const proposal = WikiProposalSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    id: 'proposal-1',
    profile: profile('student-a'),
    sourceIds: ['source-course-doc', 'source-external-doc', 'source-student-note'],
    conventionRevision: 'conv-1',
    createdAt: T2,
    baseRevisions: { 'page-mechanics': 'rev-3', 'page-force-synthesis': null },
    operations: [
      { op: 'upsert_page', page: mechanicsDraft },
      { op: 'upsert_page', page: synthesisDraft },
      {
        op: 'add_link',
        fromPageId: 'page-mechanics',
        link: {
          toPageId: 'page-force-synthesis',
          type: 'related_to',
          origin: 'suggested',
          why: 'Both pages discuss momentum change.',
          citations: [],
        },
      },
    ],
  });

  const jobBase = {
    schemaVersion: CONTRACT_VERSION,
    profile: profile('student-a'),
    sourceIds: ['source-external-doc'],
    createdAt: T2,
    updatedAt: T2,
    progress: { completed: 1, total: 2 },
    proposalId: null,
    error: null,
  };
  const jobs = {
    queued: WikiJobSchema.parse({ ...jobBase, id: 'job-queued', stage: 'queued', progress: { completed: 0, total: 2 } }),
    failed: WikiJobSchema.parse({ ...jobBase, id: 'job-failed', stage: 'failed', error: 'Extraction produced no text' }),
    awaitingReview: WikiJobSchema.parse({
      ...jobBase,
      id: 'job-review',
      stage: 'awaiting_review',
      progress: { completed: 2, total: 2 },
      proposalId: 'proposal-1',
    }),
    committed: WikiJobSchema.parse({
      ...jobBase,
      id: 'job-committed',
      stage: 'committed',
      progress: { completed: 2, total: 2 },
      proposalId: 'proposal-1',
    }),
  };

  const studentEvent = LearningEventSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    id: 'event-1',
    profile: profile('student-a'),
    pageId: 'page-mechanics',
    at: T2,
    kind: 'correction',
    actor: 'student',
    evidence: [noteCitation],
    knowledgeOnly: false,
  });
  const modelEvent = LearningEventSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    id: 'event-2',
    profile: profile('student-a'),
    pageId: 'page-mechanics',
    at: T2,
    kind: 'explanation',
    actor: 'model',
    evidence: [sessionCitation],
    knowledgeOnly: true,
  });

  const contradictedClaims = {
    course: WikiClaimSchema.parse({
      id: 'claim-course-friction',
      text: 'Static friction can act in the direction of motion.',
      kind: 'source_fact',
      origin: 'course',
      status: 'current',
      citations: [courseCitation],
      supersedes: [],
    }),
    student: WikiClaimSchema.parse({
      id: 'claim-student-friction',
      text: 'Friction always acts opposite to the direction of motion.',
      kind: 'student_belief',
      origin: 'student',
      status: 'current',
      citations: [noteCitationAlt],
      supersedes: [],
    }),
  };

  const shareRequest = PublishShareRequestSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    programmeId: PROGRAMME_ID,
    idempotencyKey: 'share-req-1',
    payload: {
      title: 'How I finally got Newton\u2019s second law',
      markdown: 'Force changes momentum. My earlier idea that motion needs force was wrong.',
      citations: [{ title: 'OpenStax University Physics Vol. 1', url: 'https://openstax.example.test/physics', locator: 'Chapter 4' }],
      attachments: [],
    },
  });
  const publishedShare = PublishedShareSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    id: 'share-1',
    revision: 'rev-1',
    senderId: 'student-c',
    senderName: 'Cleo Example',
    programmeId: PROGRAMME_ID,
    cohortId: 'cohort-a',
    createdAt: T2,
    state: 'published',
    payload: structuredClone(shareRequest.payload),
  });

  const chatMessageRequest = ChatMessageRequestSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    teacher: 'guide',
    clientMessageId: 'msg-1',
    message: 'Why does a damping force reduce the frequency?',
  });
  const philosopherAnchorRequest = ChatMessageRequestSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    teacher: 'philosopher',
    clientMessageId: 'msg-2',
    message: 'Where else does this idea show up?',
    anchorPageId: 'page-mechanics',
  });
  const imageOnlyRequest = ChatMessageRequestSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    teacher: 'guide',
    clientMessageId: 'msg-3',
    message: '',
    attachments: [{ kind: 'image', mimeType: 'image/png', data: 'aGVsbG8', name: 'working.png' }],
  });

  const forbiddenError = ContractErrorSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    error: 'forbidden',
    message: 'Not enrolled in this cohort',
  });

  return {
    programme,
    students: { a: studentA, b: studentB, c: studentC },
    enrolments: { a: enrolmentA, b: enrolmentB, c: enrolmentC },
    contextA,
    application,
    decisionRequest,
    sources: {
      studentNote,
      courseDocument,
      externalDocument,
      studentImage,
      audio: audioSource,
      session: sessionSource,
      answer: answerSource,
      peer: peerSource,
    },
    citations: { courseCitation, docCitation, noteCitation, noteCitationAlt, sessionCitation, runtimeUnresolvedSourceCitation },
    wiki: { mechanicsDraft, mechanicsPage, sourceSummaryDraft, synthesisDraft, questionDraft, proposal, contradictedClaims },
    jobs,
    events: { studentEvent, modelEvent },
    sharing: { shareRequest, publishedShare },
    chat: { chatMessageRequest, philosopherAnchorRequest, imageOnlyRequest },
    errors: { forbiddenError },
  };
}
