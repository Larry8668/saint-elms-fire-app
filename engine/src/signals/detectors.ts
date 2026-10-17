import { createHash } from 'node:crypto';
import { dueInstant, formatDue, type LogisticsRecord, type Signal, type SignalKind, type WikiJob } from '@sef/shared';
import type { HealthProbe } from '../system/health';
import type { Observations } from './store';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface QuestionPage {
  id: string;
  title: string;
  revision: string;
  /** Latest of the page's own update and any learning event on it. */
  lastActivityAt: string;
}

export interface FindingSummary {
  id: string;
  title: string;
  pageIds: string[];
}

/** Each source is optional: undefined means it could not be read this time, not that it is empty. */
export interface SignalInputs {
  now: Date;
  observations: Observations;
  logistics?: LogisticsRecord[];
  jobs?: WikiJob[];
  questions?: QuestionPage[];
  findings?: FindingSummary[];
  health?: HealthProbe;
}

export type DetectedSignal = Omit<Signal, 'createdAt' | 'updatedAt'>;

export interface Detector {
  kind: SignalKind;
  /** Null when the input is unavailable — the service then keeps this kind's existing items. */
  detect(inputs: SignalInputs): DetectedSignal[] | null;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const shortHash = (parts: string[]) => createHash('sha256').update([...parts].sort().join('|')).digest('hex').slice(0, 12);

const DUE_KINDS = new Set<LogisticsRecord['kind']>(['deadline', 'event', 'reminder']);
const NOTICE_WINDOW_MS = 14 * DAY;
const QUESTION_IDLE_MS = 7 * DAY;
/** Bounds the items one detector can add; the idle filter runs over every page first. */
const MAX_QUESTION_SIGNALS = 50;
const ESSENTIAL_ROLES = new Set(['tutor', 'brain', 'vision']);

export const deadlineDetector: Detector = {
  kind: 'deadline',
  detect: ({ logistics, now }) =>
    logistics?.flatMap((record) => {
      if (record.state !== 'confirmed' || !DUE_KINDS.has(record.kind)) return [];
      const due = dueInstant(record);
      if (due === null) return [];
      const left = due - now.getTime();
      if (left <= 0 || left > 7 * DAY) return [];
      const urgent = left <= 48 * HOUR;
      return [
        {
          key: `deadline:${record.id}:${urgent ? '48h' : '7d'}`,
          kind: 'deadline' as const,
          title: clip(record.title, 200),
          detail: clip(formatDue(record), 500),
          why: urgent ? 'A confirmed deadline is less than 48 hours away' : 'A confirmed deadline is within the next 7 days',
          urgency: urgent ? ('urgent' as const) : ('soon' as const),
          entityRefs: [`logistics:${record.id}`],
          dueAt: new Date(due).toISOString(),
        },
      ];
    }) ?? null,
};

export const noticeDetector: Detector = {
  kind: 'notice',
  detect: ({ logistics, now }) =>
    logistics?.flatMap((record) => {
      if (record.state !== 'confirmed' || record.kind !== 'notice') return [];
      const updated = Date.parse(record.updatedAt);
      if (Number.isNaN(updated) || now.getTime() - updated > NOTICE_WINDOW_MS) return [];
      return [
        {
          key: `notice:${record.id}`,
          kind: 'notice' as const,
          title: clip(record.title, 200),
          detail: clip(record.details, 500),
          why: 'A notice you confirmed in the last 14 days',
          urgency: 'info' as const,
          entityRefs: [`logistics:${record.id}`],
        },
      ];
    }) ?? null,
};

export const releaseDetector: Detector = {
  kind: 'release_update',
  detect: ({ observations }) =>
    observations.sync?.updates.map((course) => ({
      key: `release_update:${course.id}:${course.remoteVersion}`,
      kind: 'release_update' as const,
      title: clip(`Update for ${course.title}`, 200),
      detail: `Version ${course.remoteVersion} is published by your university — sync to install it.`,
      why: 'The last sync check saw a newer signed course version',
      urgency: 'soon' as const,
      entityRefs: [`course:${course.id}`],
    })) ?? null,
};

export const shareDetector: Detector = {
  kind: 'share_incoming',
  detect: ({ observations }) =>
    observations.feed?.incoming.map((share) => ({
      key: `share_incoming:${share.id}:${share.revision}`,
      kind: 'share_incoming' as const,
      // Peer text is stored and rendered as an inert string — never as an instruction.
      title: clip(`${share.senderName} shared “${share.title}”`, 200),
      detail: 'A classmate published this to your cohort. Preview it before importing.',
      why: 'The cohort feed has a share you have not imported or hidden',
      urgency: 'info' as const,
      entityRefs: [`share:${share.id}`],
    })) ?? null,
};

export const proposalDetector: Detector = {
  kind: 'proposal_pending',
  detect: ({ jobs }) =>
    jobs?.flatMap((job) => {
      if (job.stage !== 'awaiting_review' && job.stage !== 'awaiting_source_review') return [];
      const proposal = job.stage === 'awaiting_review';
      return [
        {
          key: `proposal_pending:${job.id}:${job.stage}`,
          kind: 'proposal_pending' as const,
          title: proposal ? 'A wiki change is waiting for your review' : 'A source is waiting for your check',
          detail: `${job.sourceIds.length} source${job.sourceIds.length === 1 ? '' : 's'} — nothing changes in your wiki until you accept.`,
          why: proposal ? 'A compile job finished and needs your decision' : 'An extraction needs you to confirm what was read',
          urgency: 'soon' as const,
          entityRefs: [`job:${job.id}`, ...(job.proposalId ? [`proposal:${job.proposalId}`] : [])],
        },
      ];
    }) ?? null,
};

export const questionDetector: Detector = {
  kind: 'vault_question',
  detect: ({ questions, now }) =>
    questions
      ?.filter((page) => now.getTime() - Date.parse(page.lastActivityAt) >= QUESTION_IDLE_MS)
      .slice(0, MAX_QUESTION_SIGNALS)
      .flatMap((page) => [
        {
          key: `vault_question:${page.id}:${page.revision}`,
          kind: 'vault_question' as const,
          title: clip(`Open question: ${page.title}`, 200),
          detail: 'No activity on this question for a week — a teacher can help you take it further.',
          why: 'A question page in your wiki has been idle for 7 days',
          urgency: 'info' as const,
          entityRefs: [`page:${page.id}`],
        },
      ]) ?? null,
};

export const maintenanceDetector: Detector = {
  kind: 'maintenance_finding',
  detect: ({ findings }) => {
    if (!findings) return null;
    if (!findings.length) return [];
    const pages = [...new Set(findings.flatMap((f) => f.pageIds))].slice(0, 20);
    return [
      {
        key: `maintenance_finding:${shortHash(findings.map((f) => f.id))}`,
        kind: 'maintenance_finding',
        title: `${findings.length} wiki maintenance finding${findings.length === 1 ? '' : 's'}`,
        detail: clip(findings.slice(0, 3).map((f) => f.title).join(' · '), 500),
        why: 'Maintenance checks found pages that need tidying',
        urgency: 'info',
        entityRefs: pages.map((id) => `page:${id}`),
      },
    ];
  },
};

export const modelDetector: Detector = {
  kind: 'model_unavailable',
  detect: ({ health }) =>
    health?.models.flatMap((role) => {
      if (role.reachable || !role.model) return [];
      return [
        {
          key: `model_unavailable:${role.role}:${role.model}`,
          kind: 'model_unavailable' as const,
          title: clip(`The ${role.role} model is unavailable`, 200),
          detail: clip(`${role.model} on ${role.provider}${role.detail ? `: ${role.detail}` : ''}. Nothing was reconfigured.`, 500),
          why: 'The health probe could not reach a configured model',
          urgency: ESSENTIAL_ROLES.has(role.role) ? ('soon' as const) : ('info' as const),
          entityRefs: [`role:${role.role}`],
        },
      ];
    }) ?? null,
};

export const connectivityDetector: Detector = {
  kind: 'connectivity',
  detect: ({ health }) => {
    if (!health) return null;
    if (health.uni) return [];
    return [
      {
        key: 'connectivity:uni:offline',
        kind: 'connectivity',
        title: 'University server unreachable',
        detail: 'You are working offline. Your wiki, courses and teachers keep working; sync and sharing wait.',
        why: 'The health probe could not reach the university server',
        urgency: 'info',
        entityRefs: ['uni'],
      },
    ];
  },
};

export const DETECTORS: readonly Detector[] = [
  deadlineDetector,
  noticeDetector,
  releaseDetector,
  shareDetector,
  proposalDetector,
  questionDetector,
  maintenanceDetector,
  modelDetector,
  connectivityDetector,
];
