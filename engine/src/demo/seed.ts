import { createHash } from 'node:crypto';
import { CONTRACT_VERSION, type BrainLogEntry, type ConceptPage, type DemoPersona, type Evidence, type ProfileIdentity, type SourceCitation, type WikiPageDraft, type WikiProposal } from '@sef/shared';
import type { CoursewareIndex } from '@sef/shared/node';
import { emptyPage } from '../brain/page-format';
import { writeProposalRecord } from '../brain/proposals';
import { log } from '../config';
import type { Workspace } from '../profiles/workspace';
import { PERSONA_SCRIPTS, semesterStartDaysAgo, type HeroPage, type PersonaScript } from './personas';

const DAY_MS = 86_400_000;

/** Deterministic 0..1 from a string, so every machine seeds the same brain. */
const rand = (seed: string) => createHash('sha1').update(seed).digest().readUInt32BE(0) / 0xffffffff;
const iso = (daysAgo: number, salt = '') => new Date(Date.now() - daysAgo * DAY_MS - Math.floor(rand(salt) * 8) * 3600_000).toISOString();

export interface SeedReport {
  courses: number;
  pages: number;
  links: number;
  sessions: number;
}

/** Installs the persona's released courses straight from the repo courseware (demo only, no network). */
async function preloadContent(ws: Workspace, persona: DemoPersona, courseware: CoursewareIndex): Promise<number> {
  const installed = await ws.content.installed();
  let count = 0;
  for (const course of courseware.courses.values()) {
    const { summary } = course;
    const inScope = summary.support || (summary.semesterNumber >= 1 && summary.semesterNumber <= persona.throughSemester);
    if (!inScope || installed[summary.id]) continue;
    await ws.content.install(summary, course.files);
    count += 1;
  }
  return count;
}

function quizEvidence(prefix: string, quizzes: Array<[number, number, number]>): Evidence[] {
  return quizzes.map(([score, outOf, daysAgo], i) => ({ kind: 'quiz', ref: `${prefix}-q${i}`, at: iso(daysAgo, `${prefix}${i}`), score, outOf }));
}

/** Generated page: status falls out of the evidence we attach, exactly like a real brain. */
function generatedPage(script: PersonaScript, personaId: string, key: string, concept: string, courseId: string, lesson: string, daysAgo: number): ConceptPage {
  const page = emptyPage(key, concept, [courseId], iso(daysAgo, key));
  page.sections.in_my_words = script.voice(concept, lesson);
  page.evidence.push({ kind: 'lesson', ref: `${courseId}`, at: iso(daysAgo, `${key}l`), note: lesson });
  const roll = rand(`${personaId}:status:${key}`);
  if (roll < script.shakyRate) {
    page.evidence.push(...quizEvidence(`seed-${key}`, [[1, 3, Math.max(0, daysAgo - 2)]]));
  } else if (roll < script.shakyRate + script.solidRate) {
    page.evidence.push(...quizEvidence(`seed-${key}`, [[3, 3, Math.max(0, daysAgo - 3)], [4, 4, Math.max(0, daysAgo - 14)]]));
  }
  return page;
}

function heroPage(base: ConceptPage, hero: HeroPage): ConceptPage {
  const page = structuredClone(base);
  page.updated = iso(hero.daysAgo, hero.key);
  page.sections = { in_my_words: hero.words, where_i_got_stuck: hero.stuck ?? '', connections: hero.connections ?? '' };
  page.evidence = [
    ...page.evidence.filter((e) => e.kind === 'lesson'),
    ...quizEvidence(`hero-${hero.key}`, hero.quizzes ?? []),
    ...(hero.sessions ?? []).map((ref): Evidence => ({ kind: 'session', ref, at: iso(hero.daysAgo, ref) })),
  ];
  page.misconceptions = (hero.misconceptions ?? []).map((m) => ({
    claim: m.claim,
    course: m.course,
    flagged: iso(m.daysAgo, m.claim),
    resolved: Boolean(m.resolved),
  }));
  return page;
}

/** Seeds a full second brain for one demo persona. Skips anything already present. */
export async function seedPersona(ws: Workspace, persona: DemoPersona, courseware: CoursewareIndex | null): Promise<SeedReport> {
  const started = Date.now();
  const script = PERSONA_SCRIPTS[persona.id];
  const courses = courseware ? await preloadContent(ws, persona, courseware) : 0;
  if (!(await ws.vault.isEmpty())) return { courses, pages: 0, links: 0, sessions: 0 };

  const graph = await ws.brain.courseGraph();
  const installed = await ws.content.installed();
  const pages = new Map<string, ConceptPage>();
  const logEntries: Array<Omit<BrainLogEntry, 'at'> & { at: string }> = [];

  const byCourse = new Map<string, Array<{ key: string; label: string; lesson: string; order: number }>>();
  for (const c of graph.concepts.values()) {
    const list = byCourse.get(c.introducedBy.courseId) ?? [];
    list.push({ key: c.key, label: c.label, lesson: c.introducedBy.title, order: c.introducedBy.order + list.length / 1000 });
    byCourse.set(c.introducedBy.courseId, list);
  }

  for (const [courseId, concepts] of byCourse) {
    const course = installed[courseId];
    if (!course || course.support) continue;
    const coverage = script.coverage(course);
    const take = Math.round(concepts.length * coverage);
    if (!take) continue;
    const ranked = concepts
      .sort((a, b) => a.order - b.order)
      .map((c, i) => ({ ...c, score: i / concepts.length + (rand(`${persona.id}:${c.key}`) - 0.5) * 0.25 }))
      .sort((a, b) => a.score - b.score)
      .slice(0, take);
    const semStart = semesterStartDaysAgo(script, course.semesterNumber);
    const span = Math.min(110, semStart);
    for (const c of ranked) {
      const daysAgo = Math.round(semStart - c.score * span);
      pages.set(c.key, generatedPage(script, persona.id, c.key, c.label, courseId, c.lesson, Math.max(0, daysAgo)));
    }
    logEntries.push({
      at: iso(semStart, courseId),
      kind: 'lesson',
      title: `Started ${course.title}`,
      detail: `${take} of ${concepts.length} concepts met so far.`,
    });
  }

  const missing: string[] = [];
  for (const hero of script.heroes) {
    const concept = graph.concepts.get(hero.key);
    if (!concept) {
      missing.push(hero.key);
      continue;
    }
    const base = pages.get(hero.key) ?? emptyPage(hero.key, concept.label, [concept.introducedBy.courseId], iso(hero.daysAgo));
    pages.set(hero.key, heroPage(base, hero));
    for (const [score, outOf, daysAgo] of hero.quizzes ?? []) {
      logEntries.push({ at: iso(daysAgo, `${hero.key}q`), kind: 'quiz', title: `Quiz on ${concept.label}`, detail: `Scored ${score}/${outOf}.` });
    }
    for (const m of hero.misconceptions ?? []) {
      logEntries.push({
        at: iso(m.daysAgo, m.claim),
        kind: 'session',
        title: `${m.resolved ? 'Resolved' : 'Flagged'} misconception on ${concept.label}`,
        detail: `"${m.claim}"`,
      });
    }
  }

  let links = 0;
  for (const link of script.links) {
    const from = graph.concepts.get(link.from);
    if (!from || !graph.concepts.has(link.to)) {
      missing.push(`${link.from}→${link.to}`);
      continue;
    }
    const page = pages.get(link.from) ?? emptyPage(link.from, from.label, [from.introducedBy.courseId], iso(5));
    page.links.push({ to: link.to, type: link.type, origin: link.origin, why: link.why });
    pages.set(link.from, page);
    links += 1;
  }

  for (const page of pages.values()) await ws.vault.writeSeeded(page);
  await ws.vault.writeIndex();
  const personal = await seedPersonal(ws, persona, script);

  for (const s of script.sessions) {
    const at = iso(s.daysAgo, s.id);
    await ws.sessions.put({
      id: s.id,
      teacher: s.teacher,
      startedAt: at,
      updatedAt: at,
      turns: s.turns.map(([role, content]) => ({ role, content, at })),
      lessonIds: [],
      sources: [],
      ingestedTurns: s.turns.length,
    });
    const first = s.turns.find(([role]) => role === 'user')?.[1] ?? 'conversation';
    logEntries.push({ at, kind: 'session', title: `${s.teacher[0]!.toUpperCase()}${s.teacher.slice(1)} session: ${first.slice(0, 60)}` });
  }

  logEntries.sort((a, b) => a.at.localeCompare(b.at));
  for (const { at, ...entry } of logEntries) await ws.vault.appendLog(entry, at);

  if (missing.length) log.warn('demo_seed_unknown_concepts', { profileId: persona.id, missing });
  const report = { courses, pages: pages.size + personal, links, sessions: script.sessions.length };
  log.info('demo_persona_seeded', { profileId: persona.id, ...report, personal, ms: Date.now() - started });
  return report;
}

/**
 * Personal-sky pages go through the real pipeline: the note or the peer share is filed as a
 * kept source, then a proposal the validator would accept lands the page — so the growth
 * ledger records honest encounter/connection/application events for them, and a peer-imported
 * page arrives already marked collected, never the student's own mastery.
 */
async function seedPersonal(ws: Workspace, persona: DemoPersona, script: PersonaScript): Promise<number> {
  const personal = script.personal ?? [];
  if (!personal.length) return 0;
  const { uniServerUrl } = await ws.settings.get();
  const identity: ProfileIdentity = {
    issuer: uniServerUrl,
    studentId: ws.profile.id,
    programmeId: ws.profile.programmeId ?? ws.profile.cohortId,
  };
  const conventionRevision = (await ws.wiki.readConventions()).conventions.revision;
  let written = 0;
  for (const seed of personal) {
    const text = seed.source.text;
    const ingested = await ws.sources.ingest({
      kind: seed.source.kind,
      title: seed.source.title,
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode(text),
      ...(seed.source.kind === 'peer' && seed.sender
        ? {
            share: { id: `share-seed-${persona.id}-${seed.id}`, revision: `rev-${seed.id}`, senderId: seed.sender.id, cohortId: ws.profile.cohortId },
            attribution: { creator: seed.sender.name },
          }
        : {}),
      extraction: { method: 'text', text },
    });
    const source = await ws.wiki.readSource(ingested.source.id);
    if (!source) {
      log.warn('demo_seed_source_missing', { profileId: persona.id, page: seed.id });
      continue;
    }
    const cite = (quote?: string): SourceCitation[] => {
      const start = quote ? text.indexOf(quote) : -1;
      return start >= 0 && quote
        ? [{ sourceId: source.id, sourceRevision: source.revision, sha256: source.sha256, locator: { kind: 'text' as const, start, end: start + quote.length } }]
        : [];
    };
    const claims = (seed.claims ?? []).flatMap((claim, i) => {
      const citations = cite(claim.quote);
      if ((claim.kind === 'source_fact' || claim.kind === 'student_belief') && !citations.length) {
        log.warn('demo_seed_claim_dropped', { profileId: persona.id, page: seed.id, claim: claim.text.slice(0, 60) });
        return [];
      }
      return [{ id: `cl-${seed.id}-${i}`, text: claim.text, kind: claim.kind, origin: claim.origin, status: 'current' as const, citations, supersedes: [] }];
    });
    const links = (seed.links ?? []).flatMap((link) => {
      const citations = cite(link.quote);
      if (link.origin === 'student' && !citations.length) {
        log.warn('demo_seed_link_dropped', { profileId: persona.id, page: seed.id, to: link.to });
        return [];
      }
      return [{ toPageId: link.to, type: link.type, origin: link.origin, why: link.why, citations }];
    });
    const base = { id: seed.id, title: seed.title, summary: seed.summary, markdown: seed.markdown, courseRefs: [], claims, links };
    const page: WikiPageDraft =
      seed.kind === 'concept'
        ? {
            ...base,
            kind: 'concept',
            learner: { inMyWords: seed.learner?.inMyWords ?? '', stuck: seed.learner?.stuck ?? '', connections: seed.learner?.connections ?? '', evidenceIds: [] },
          }
        : { ...base, kind: seed.kind, sourceIds: [source.id] };
    const proposal: WikiProposal = {
      schemaVersion: CONTRACT_VERSION,
      id: `prop-seed-${persona.id}-${seed.id}`,
      profile: identity,
      sourceIds: [source.id],
      conventionRevision,
      createdAt: iso(seed.daysAgo, seed.id),
      baseRevisions: { [seed.id]: null },
      operations: [{ op: 'upsert_page', page }],
    };
    try {
      const report = await ws.wiki.applyProposal(proposal);
      await writeProposalRecord(ws.wiki.root, { schemaVersion: CONTRACT_VERSION, proposal, jobId: null, state: 'accepted', decidedAt: iso(seed.daysAgo, seed.id), decidedBy: 'system' });
      if (report.committed) written += 1;
    } catch (error) {
      // Seeding must never take a whole demo profile down with it.
      log.warn('demo_seed_personal_failed', { profileId: persona.id, page: seed.id, error: String(error) });
    }
  }
  return written;
}
