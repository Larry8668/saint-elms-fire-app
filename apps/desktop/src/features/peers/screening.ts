import type { ShareScreening } from '@sef/shared';

export type ScreeningTone = 'aurora' | 'ember' | 'neutral';

/**
 * How a screening result reads in the UI. Advisory by contract: nothing here ever
 * blocks — `flagged` names its categories, `unavailable` says so rather than
 * silently skipping, `clean` reassures that a check ran on this device.
 */
export function screeningBadge(screening: ShareScreening): { tone: ScreeningTone; label: string } {
  switch (screening.status) {
    case 'flagged':
      return {
        tone: 'ember',
        label: screening.categories.length
          ? `Flagged on-device: ${screening.categories.join(', ')}`
          : 'Flagged by on-device screening',
      };
    case 'clean':
      return { tone: 'aurora', label: 'Screened on-device — nothing flagged' };
    case 'unavailable':
      return { tone: 'neutral', label: 'Screening unavailable — no check ran' };
  }
}
