/** Demo identities shared by the uni server (accounts) and the engine (seeded second brains). */
export interface DemoPersona {
  id: 'ananya' | 'brinda' | 'chetna';
  name: string;
  email: string;
  cohortId: string;
  /** Semesters fully released to this persona's cohort. */
  throughSemester: number;
  stage: string;
  persona: string;
}

export const DEMO_PASSWORD_DEFAULT = 'harbor-lantern';

export const DEMO_ADMIN = { id: 'admin', name: 'Registrar', email: 'admin@saintelms.local' } as const;

export const DEMO_PERSONAS: readonly DemoPersona[] = [
  {
    id: 'ananya',
    name: 'Ananya',
    email: 'ananya@saintelms.local',
    cohortId: 'bsc-pma-2026',
    throughSemester: 1,
    stage: 'Semester 1, week 6',
    persona: 'Visual thinker, still untangling force vs. momentum. Asks the Guide a lot of "why".',
  },
  {
    id: 'brinda',
    name: 'Brinda',
    email: 'brinda@saintelms.local',
    cohortId: 'bsc-pma-2025',
    throughSemester: 3,
    stage: 'End of Semester 3',
    persona: 'Methodical and maths-first. Links every physics idea back to the calculus underneath.',
  },
  {
    id: 'chetna',
    name: 'Chetna',
    email: 'chetna@saintelms.local',
    cohortId: 'bsc-pma-2024',
    throughSemester: 5,
    stage: 'Semester 5, thesis prep',
    persona: 'Researcher in the making. Reads papers with the Philosopher and shares notes with juniors.',
  },
];

export const demoPersona = (id: string) => DEMO_PERSONAS.find((p) => p.id === id);
