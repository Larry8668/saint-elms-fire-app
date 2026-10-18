import { PERSONAL_SKY_ID, type ConceptStatus, type EdgeOrigin, type GraphResponse, type PageRecordSummary, type WikiGraph } from '@sef/shared';

/**
 * The brain map's geometry: a radial dendrite grown from a single nucleus. Subjects are the
 * thick limbs, courses the branches, and every page a leaf at the frontier — placed by when it
 * last grew, so older understanding sits close to the branch and the newest is at the rim.
 * Pages outside any course (your own syntheses and questions) orbit the nucleus itself.
 *
 * Pure and deterministic: the same records and graph always give the same picture, so a growth
 * replay and a reload agree, and this file is testable without a canvas.
 *
 * World space is the unit disc: the nucleus at the origin, leaves out to radius 1.
 */

export type MapKind = PageRecordSummary['kind'];

export interface MapNode {
  id: string;
  title: string;
  summary: string;
  kind: MapKind;
  status: ConceptStatus | null;
  /** Whose work it is — 'peer' pages carry a violet rim. */
  peer: boolean;
  openMisconceptions: number;
  updatedAt: number;
  x: number;
  y: number;
  /** World radius of the bloom. */
  r: number;
  hex: string;
  /** Index into branches, or -1 for a page that orbits the nucleus. */
  branch: number;
  /** Index into subjects, or -1. */
  subject: number;
  claims: number;
  degree: number;
  sourceIds: string[];
}

export interface MapBranch {
  id: string;
  name: string;
  subject: number;
  semester: number;
  angle: number;
  /** Hub position, where the branch fans into leaves. */
  x: number;
  y: number;
  count: number;
  /** Earliest page time — when the branch first sprouted. */
  firstAt: number;
}

export interface MapSubject {
  id: string;
  name: string;
  angle: number;
  span: number;
  x: number;
  y: number;
  hex: string;
  count: number;
  firstAt: number;
}

export interface MapLink {
  a: number;
  b: number;
  origin: EdgeOrigin;
  type: string;
}

/** A kept source feeding a page: drawn as a seed orbiting it. `node` is a source-summary page, if one exists. */
export interface MapSeed {
  host: number;
  node: number | null;
  phase: number;
  orbit: number;
}

export interface BrainMapStats {
  pages: number;
  courses: number;
  subjects: number;
  studentLinks: number;
  peerLinks: number;
  suggestedLinks: number;
  openQuestions: number;
  syntheses: number;
  sources: number;
  solid: number;
  met: number;
  shaky: number;
  firstAt: number;
  lastAt: number;
}

export interface BrainMap {
  nodes: MapNode[];
  branches: MapBranch[];
  subjects: MapSubject[];
  links: MapLink[];
  seeds: MapSeed[];
  stats: BrainMapStats;
  /** Node indices ordered by updatedAt — the growth replay walks this. */
  timeline: number[];
}

export const MAP_HEX = {
  solid: '#ffe08a',
  met: '#7fb2ff',
  shaky: '#ffb057',
  unseen: '#5d6a8a',
  synthesis: '#6fe3c1',
  question: '#ff9fb0',
  source: '#d9d2ff',
  student: '#5ff0d0',
  peer: '#b8a1ff',
  suggested: '#9fb6e8',
  nucleus: '#cfe0ff',
} as const;

/** Limb tints: cool, distinct from the status colours the leaves carry. */
const SUBJECT_TINTS = ['#6f9dff', '#4fd1e6', '#8b8dff', '#71e0c0', '#9cc4ff', '#7aa7d9'];

const R_SUBJECT = 0.17;
const R_BRANCH = 0.4;
const R_LEAF_IN = 0.5;
const R_LEAF_OUT = 1;
const R_CORE = 0.1;
const SUBJECT_GAP = 0.07;
const BRANCH_GAP = 0.014;
const GOLDEN = 0.6180339887498949;

/** A stable 0..1 hash of a string — the jitter that makes leaves organic but reproducible. */
export function hash01(text: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export const prettySubject = (id: string): string => {
  const words = id.replace(/[-_]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : id;
};

export function nodeHex(kind: MapKind, status: ConceptStatus | null): string {
  if (kind === 'synthesis') return MAP_HEX.synthesis;
  if (kind === 'question') return MAP_HEX.question;
  if (kind === 'source_summary') return MAP_HEX.source;
  return MAP_HEX[status ?? 'met'];
}

const polar = (angle: number, radius: number) => ({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
const timeOf = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

export function buildBrainMap(records: PageRecordSummary[], graph?: GraphResponse | null, wiki?: WikiGraph | null): BrainMap {
  const wikiById = new Map((wiki?.nodes ?? []).map((n) => [n.id, n]));
  const courseByPage = new Map<string, { courseId: string; courseName: string; subjectId: string; semester: number }>();
  for (const n of graph?.nodes ?? []) {
    if (!n.pageId || n.courseId === PERSONAL_SKY_ID || n.kind === 'lesson' || courseByPage.has(n.pageId)) continue;
    courseByPage.set(n.pageId, { courseId: n.courseId, courseName: n.courseName, subjectId: n.subjectId, semester: n.semesterNumber });
  }

  // Degree from the links the wiki actually holds, for leaf size.
  const degree = new Map<string, number>();
  for (const e of wiki?.edges ?? []) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  // Group pages: subject → course → pages, plus the nucleus orbit.
  type Group = { courseId: string; courseName: string; subjectId: string; semester: number; pages: PageRecordSummary[] };
  const groups = new Map<string, Group>();
  const core: PageRecordSummary[] = [];
  for (const record of records) {
    const course = courseByPage.get(record.id);
    if (!course || record.kind === 'source_summary') {
      core.push(record);
      continue;
    }
    let g = groups.get(course.courseId);
    if (!g) groups.set(course.courseId, (g = { ...course, pages: [] }));
    g.pages.push(record);
  }

  const bySubject = new Map<string, Group[]>();
  for (const g of groups.values()) {
    const list = bySubject.get(g.subjectId) ?? [];
    list.push(g);
    bySubject.set(g.subjectId, list);
  }
  const subjectOrder = [...bySubject.entries()]
    .map(([id, list]) => ({ id, list, count: list.reduce((n, g) => n + g.pages.length, 0) }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  const totalCoursePages = subjectOrder.reduce((n, s) => n + s.count, 0);
  const courseCount = groups.size;
  const free = Math.max(0.5, Math.PI * 2 - subjectOrder.length * SUBJECT_GAP - Math.max(0, courseCount - subjectOrder.length) * BRANCH_GAP);
  const perPage = totalCoursePages ? free / totalCoursePages : 0;

  const nodes: MapNode[] = [];
  const branches: MapBranch[] = [];
  const subjects: MapSubject[] = [];
  const idIndex = new Map<string, number>();

  const makeNode = (record: PageRecordSummary, x: number, y: number, branch: number, subject: number): MapNode => {
    const w = wikiById.get(record.id);
    const claims = w?.claims ?? 0;
    const deg = degree.get(record.id) ?? 0;
    const sourceIds = w?.sourceIds ?? [];
    const status = record.kind === 'concept' ? (record.status ?? 'met') : null;
    const weight = claims + deg + sourceIds.length;
    const base = record.kind === 'source_summary' ? 0.006 : record.kind === 'concept' ? 0.0085 : 0.012;
    return {
      id: record.id,
      title: record.title || record.id,
      summary: record.summary ?? '',
      kind: record.kind,
      status,
      peer: record.origin === 'peer',
      openMisconceptions: record.openMisconceptions ?? 0,
      updatedAt: timeOf(record.updatedAt),
      x,
      y,
      r: base + 0.0045 * Math.sqrt(weight) + (status === 'solid' ? 0.0012 : 0),
      hex: nodeHex(record.kind, status),
      branch,
      subject,
      claims,
      degree: deg,
      sourceIds,
    };
  };

  let cursor = -Math.PI / 2 + SUBJECT_GAP / 2;
  subjectOrder.forEach((s, si) => {
    const courses = s.list.sort((a, b) => a.semester - b.semester || a.courseName.localeCompare(b.courseName));
    const span = s.count * perPage + Math.max(0, courses.length - 1) * BRANCH_GAP;
    const subjectAngle = cursor + span / 2;
    const hub = polar(subjectAngle, R_SUBJECT);
    const subjectIndex = subjects.length;
    subjects.push({ id: s.id, name: prettySubject(s.id), angle: subjectAngle, span, ...hub, hex: SUBJECT_TINTS[si % SUBJECT_TINTS.length]!, count: s.count, firstAt: Infinity });

    let a = cursor;
    for (const course of courses) {
      const width = course.pages.length * perPage;
      const a0 = a;
      const a1 = a + width;
      const mid = (a0 + a1) / 2;
      const branchIndex = branches.length;
      const pages = [...course.pages].sort((p, q) => timeOf(p.updatedAt) - timeOf(q.updatedAt) || p.id.localeCompare(q.id));
      const firstAt = pages.length ? timeOf(pages[0]!.updatedAt) : 0;
      // Hubs sit a little further out on wide branches so the fan has room to open.
      const hubR = R_BRANCH + Math.min(0.05, width * 0.08) * (hash01(course.courseId) - 0.5);
      branches.push({ id: course.courseId, name: course.courseName, subject: subjectIndex, semester: course.semester, angle: mid, ...polar(mid, hubR), count: pages.length, firstAt });
      subjects[subjectIndex]!.firstAt = Math.min(subjects[subjectIndex]!.firstAt, firstAt);

      const n = pages.length;
      const pad = Math.min(width * 0.12, 0.01);
      pages.forEach((page, i) => {
        // Equal-area radius so density stays even across the annulus; golden-ratio angles
        // scatter siblings without clumping. Oldest near the hub, newest at the rim.
        const t = (i + 0.5) / n;
        const rr = Math.sqrt(R_LEAF_IN ** 2 + t * (R_LEAF_OUT ** 2 - R_LEAF_IN ** 2));
        const jr = (hash01(page.id, 1) - 0.5) * 0.035;
        const u = (i * GOLDEN + hash01(page.id, 2) * 0.25) % 1;
        const ang = a0 + pad + u * Math.max(0.0001, width - pad * 2);
        const p = polar(ang, rr + jr);
        idIndex.set(page.id, nodes.length);
        nodes.push(makeNode(page, p.x, p.y, branchIndex, subjectIndex));
      });
      a = a1 + BRANCH_GAP;
    }
    cursor += span + SUBJECT_GAP;
  });

  // The nucleus orbit: your own pages, outside any course.
  const coreSorted = [...core].sort((p, q) => timeOf(p.updatedAt) - timeOf(q.updatedAt) || p.id.localeCompare(q.id));
  coreSorted.forEach((page, i) => {
    const ring = Math.floor(i / 14);
    const inRing = Math.min(14, coreSorted.length - ring * 14);
    const ang = -Math.PI / 2 + ((i % 14) / inRing) * Math.PI * 2 + ring * 0.37 + hash01(page.id) * 0.2;
    const p = polar(ang, R_CORE * (0.7 + ring * 0.35));
    idIndex.set(page.id, nodes.length);
    nodes.push(makeNode(page, p.x, p.y, -1, -1));
  });

  const links: MapLink[] = [];
  for (const e of wiki?.edges ?? []) {
    const a = idIndex.get(e.source);
    const b = idIndex.get(e.target);
    if (a === undefined || b === undefined || a === b || e.origin === 'course') continue;
    links.push({ a, b, origin: e.origin, type: e.type });
  }

  // Seeds: each kept source orbits the page it fed. A source-summary page that shares a
  // source with a page becomes that page's seed instead of sitting in the nucleus orbit.
  const summaryBySource = new Map<string, number>();
  nodes.forEach((n, i) => {
    if (n.kind === 'source_summary') for (const s of n.sourceIds) if (!summaryBySource.has(s)) summaryBySource.set(s, i);
  });
  const seeds: MapSeed[] = [];
  const sourceSet = new Set<string>();
  nodes.forEach((n, i) => {
    if (n.kind === 'source_summary') return;
    n.sourceIds.slice(0, 4).forEach((s, k) => {
      sourceSet.add(s);
      if (seeds.length >= 400) return;
      const summary = summaryBySource.get(s);
      seeds.push({ host: i, node: summary ?? null, phase: hash01(`${n.id}:${s}`) * Math.PI * 2, orbit: n.r * 2.2 + 0.006 + k * 0.004 });
    });
  });
  for (const n of nodes) if (n.kind === 'source_summary') for (const s of n.sourceIds) sourceSet.add(s);

  const timeline = nodes.map((_, i) => i).sort((p, q) => nodes[p]!.updatedAt - nodes[q]!.updatedAt || p - q);
  const times = nodes.map((n) => n.updatedAt).filter((t) => t > 0);

  return {
    nodes,
    branches,
    subjects,
    links,
    seeds,
    timeline,
    stats: {
      pages: nodes.length,
      courses: branches.length,
      subjects: subjects.length,
      studentLinks: links.filter((l) => l.origin === 'student').length,
      peerLinks: links.filter((l) => l.origin === 'peer').length,
      suggestedLinks: links.filter((l) => l.origin === 'suggested').length,
      openQuestions: nodes.filter((n) => n.kind === 'question').length,
      syntheses: nodes.filter((n) => n.kind === 'synthesis').length,
      sources: sourceSet.size,
      solid: nodes.filter((n) => n.status === 'solid').length,
      met: nodes.filter((n) => n.status === 'met').length,
      shaky: nodes.filter((n) => n.status === 'shaky').length,
      firstAt: times.length ? Math.min(...times) : 0,
      lastAt: times.length ? Math.max(...times) : 0,
    },
  };
}

/** One sentence for screen readers: what the picture shows, and that the list follows. */
export function describeBrainMap(map: BrainMap): string {
  const s = map.stats;
  const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
  const parts = [
    `Map of your second brain: ${plural(s.pages, 'page')} across ${plural(s.courses, 'course')} in ${plural(s.subjects, 'subject')}`,
    `${s.solid} solid, ${s.met} met, ${s.shaky} shaky`,
    `${plural(s.studentLinks, 'link')} you made${s.peerLinks ? `, ${s.peerLinks} from peers` : ''}`,
    plural(s.openQuestions, 'open question'),
  ];
  return `${parts.join('; ')}. Every page is also listed below.`;
}
