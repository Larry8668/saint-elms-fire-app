import type { SyncStatus } from '@sef/shared';

/** One course row as the engine reports it for the signed-in profile's cohort. */
export type ProgrammeCourse = SyncStatus['courses'][number];

export type BadgeTone = 'neutral' | 'beacon' | 'ember' | 'aurora' | 'gold' | 'rose';

/**
 * What a released row may honestly say about its install state. The released view carries an
 * install state, a release version and whether the signed metadata was covered by the signature;
 * it carries no credits, hours or academic status, and this view never substitutes a guess.
 */
export const INSTALL_STATES: Record<ProgrammeCourse['state'], { label: string; tone: BadgeTone }> = {
  installed: { label: 'Verified on this device', tone: 'aurora' },
  update: { label: 'Newer release available', tone: 'ember' },
  available: { label: 'Released, not yet installed', tone: 'beacon' },
  'local-only': { label: 'On this device only', tone: 'neutral' },
};

/**
 * The state crosses the network from the engine, so a version skew can supply one this build
 * predates. An unrecognised state is reported as unknown rather than crashing the view, and it
 * is never rendered as if it meant "installed".
 */
const UNKNOWN_STATE: { label: string; tone: BadgeTone } = { label: 'State not recognised by this app', tone: 'rose' };

export const installStateOf = (course: ProgrammeCourse): { label: string; tone: BadgeTone } =>
  INSTALL_STATES[course.state] ?? UNKNOWN_STATE;

/**
 * A course whose installed package predates signed academic metadata has had its files
 * verified but not its credits. Saying so beats presenting stale numbers as current.
 */
export const metadataCaveat = (course: ProgrammeCourse): string | null =>
  course.signedMetadata === false ? 'Signed academic metadata missing from this install — re-sync to pick it up.' : null;
