import { z } from 'zod';

export const TEACHER_IDS = ['friend', 'guide', 'philosopher'] as const;
export type TeacherId = (typeof TEACHER_IDS)[number];
/** The one place a teacher id is shaped, so schemas cannot drift on a member list. */
export const TeacherIdSchema = z.enum(TEACHER_IDS);

export interface TeacherProfile {
  id: TeacherId;
  name: string;
  voice: string;
  role: string;
  /** What this teacher may draw on. Shown to the student, enforced by the harness. */
  scope: string;
  needsNetwork: boolean;
  samplePrompts: string[];
}

export const TEACHERS: Record<TeacherId, TeacherProfile> = {
  friend: {
    id: 'friend',
    name: 'Friend',
    voice: 'Socrates my Friend',
    role: 'Campus life, fees, calendars and offices',
    scope: 'University support notes only. Academic questions go to the Guide.',
    needsNetwork: false,
    samplePrompts: ['When are semester fees due?', 'How do I reach the student support office?', 'What is the attendance rule?'],
  },
  guide: {
    id: 'guide',
    name: 'Guide',
    voice: 'Socrates my Guide',
    role: 'Teaches strictly from your released lessons',
    scope: 'Released courseware and your own brain. Never beyond the syllabus.',
    needsNetwork: false,
    samplePrompts: [
      'Why is the damped frequency lower than the natural frequency?',
      'Quiz me on my weakest concept.',
      'Explain conservative forces with an example.',
    ],
  },
  philosopher: {
    id: 'philosopher',
    name: 'Philosopher',
    voice: 'Socratest my Philosopher',
    role: 'Takes ideas beyond the syllabus, onto the web',
    scope: 'Courseware plus the web. Every claim is tagged [course] or [web].',
    needsNetwork: true,
    samplePrompts: [
      'Where does resonance show up outside physics?',
      'Who first described conservation of energy?',
      'How is Fourier analysis used in astronomy today?',
    ],
  },
};
