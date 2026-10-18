import { createHash } from 'node:crypto';
import { DEMO_PERSONAS, demoPersona, normalizeEmail, type DemoPersona, type TokenClaims } from '@sef/shared';
import type { Pool } from 'pg';
import { withTransaction } from './db';
import { log } from './logger';

/**
 * Admission rows for the SEED_DEMO personas, so their legacy password tokens can use the
 * session-gated cohort features (Peers). The profiles are deliberately *not* linked to a
 * better-auth user (`account_user_id` stays NULL): nobody can sign in to them through the
 * account stack, and a real account can never resolve to one. The only key is a
 * deterministic profile id derived from the persona id.
 */
export const DEMO_DECISION_ACTOR = 'demo-seed';

/** Stable RFC 4122-shaped (v5-style) uuid for a persona; same on every boot and every deployment. */
export function demoProfileId(personaId: string): string {
  const hex = createHash('sha1').update(`sef-demo-persona:${personaId}`).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * The engine has no programme id for password-path profiles and falls back to the cohort
 * id (engine/src/profiles/workspace.ts `identity`), so the demo enrolment's programme code
 * is the cohort id: the publish route's programme check then holds unchanged.
 */
const demoProgrammeCode = (persona: DemoPersona) => persona.cohortId;

/**
 * Idempotent: inserts a profile and an approved enrolment per persona if absent. Existing
 * rows are left alone, so a staff suspension of a demo persona survives restarts.
 */
export async function seedDemoAdmission(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    for (const persona of DEMO_PERSONAS) {
      const profileId = demoProfileId(persona.id);
      await client.query(
        `INSERT INTO student_profiles (id, account_user_id, legal_name, preferred_name)
         VALUES ($1, NULL, $2, $2) ON CONFLICT (id) DO NOTHING`,
        [profileId, persona.name],
      );
      await client.query(
        `INSERT INTO enrolments (student_profile_id, programme_code, curriculum_version, cohort_code, status,
           decision_actor_subject, decision_at, decision_reason)
         VALUES ($1, $2, 'demo', $3, 'approved', $4, now(), 'Demo persona seeded by SEED_DEMO')
         ON CONFLICT (student_profile_id, programme_code) DO NOTHING`,
        [profileId, demoProgrammeCode(persona), persona.cohortId, DEMO_DECISION_ACTOR],
      );
    }
  });
  log.info('demo_admission_seeded', { personas: DEMO_PERSONAS.length });
}

/**
 * Maps a verified legacy token to its demo persona, or null. Only a *student* token whose
 * subject and email both match a seeded persona qualifies — a legacy admin token, an
 * admin-created student, or a token for a re-addressed account never does. `accountActive`
 * re-checks the live account store so disabling a demo account cuts Peers off at once.
 */
export function demoPersonaForClaims(
  claims: TokenClaims,
  accountActive: (id: string, email: string) => boolean,
): DemoPersona | null {
  if (claims.role !== 'student') return null;
  const persona = demoPersona(claims.sub);
  if (!persona || normalizeEmail(persona.email) !== normalizeEmail(claims.email ?? '')) return null;
  return accountActive(persona.id, persona.email) ? persona : null;
}
