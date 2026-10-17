import type { TeacherId } from '@sef/shared';
import type { Seed } from './seeds';

/** Deterministic wording: offline, instant, and built only from the seed's own slots. */
export function templateText(seed: Seed, teacher: TeacherId): string {
  const s = seed.slots;
  switch (seed.kind) {
    case 'deadline':
      return `What do I need to get done for “${s.title}” before ${s.day}?`;
    case 'notice':
      return `What does the “${s.title}” notice mean for me?`;
    case 'weak_concept':
      return `Quiz me on ${s.concept}.`;
    case 'stale_concept':
      return `Can we revisit ${s.concept}? It has been a while.`;
    case 'unstarted_lesson':
      return `Walk me through “${s.title}” — I haven't started it yet.`;
    case 'open_question':
      return teacher === 'philosopher' ? `Let's explore my open question: ${s.title}` : `Help me work through my open question: ${s.title}`;
    case 'synthesis_link':
      return `I linked ${s.a} and ${s.b} — how does ${s.a} change when ${s.b} fails?`;
    case 'missing_connection':
      return `How are ${s.a} and ${s.b} connected?`;
    case 'feed_item':
      return `In the news — “${s.title}”. What's the bigger idea behind it?`;
    case 'plan_step':
      return planStepText(seed);
  }
}

function planStepText(seed: Seed): string {
  const subject = seed.slots.subject;
  switch (seed.variant) {
    case 'quiz':
      return `Quiz me on ${subject} — it's next on my plan.`;
    case 'read_lesson':
      return `Walk me through “${subject}” — it's next on my plan.`;
    case 'answer_question':
      return `Help me answer my open question: ${subject}`;
    default:
      return `Help me review ${subject} — it's next on my plan.`;
  }
}
