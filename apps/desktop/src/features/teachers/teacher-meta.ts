import type { TeacherId } from '@sef/shared';
import { Flame, Navigation, Telescope, type LucideIcon } from 'lucide-react';

/** Visual identity per teacher. Identity is carried by icon and accent, not by hue alone. */
export const TEACHER_LOOK: Record<TeacherId, { Icon: LucideIcon; accent: string; ring: string; glow: string; greeting: string }> = {
  friend: {
    Icon: Flame,
    accent: 'text-ember-300',
    ring: 'border-ember-400/40',
    glow: 'from-ember-500/25',
    greeting: 'The fire is banked for you. Fees, calendars, offices, campus life — ask away.',
  },
  guide: {
    Icon: Navigation,
    accent: 'text-beacon-300',
    ring: 'border-beacon-400/40',
    glow: 'from-beacon-500/25',
    greeting: 'The course is plotted. I teach from your released lessons — and I remember what you found hard.',
  },
  philosopher: {
    Icon: Telescope,
    accent: 'text-aurora-300',
    ring: 'border-aurora-400/40',
    glow: 'from-aurora-500/25',
    greeting: 'The horizon is wider than the chart. Every claim I make is tagged [course] or [web], and every answer ends at a trailhead.',
  },
};
