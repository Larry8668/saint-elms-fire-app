import { DEMO_PERSONAS } from '@sef/shared';

const YEAR_LABEL = ['First-year', 'Second-year', 'Third-year'];

/** Demo accounts described by where they are in the programme, not by who they are. */
export const DEMO_ACCOUNTS = DEMO_PERSONAS.map((p) => ({
  id: p.id,
  email: p.email,
  label: `${YEAR_LABEL[Math.max(0, Math.ceil(p.throughSemester / 2) - 1)] ?? 'Final-year'} student`,
  detail: p.stage,
}));
export type DemoAccount = (typeof DEMO_ACCOUNTS)[number];
