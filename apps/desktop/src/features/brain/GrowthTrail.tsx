import type { LearningEvent } from '@sef/shared';
import { Eyebrow } from '@/components/ui/primitives';
import { timeAgo } from '@/lib/time';

/** What a growth event looks like in a trail — kind first, then who did it. */
export const EVENT_LABEL: Record<LearningEvent['kind'], string> = {
  encounter: 'First met',
  explanation: 'In your own words',
  struggle: 'Got stuck',
  correction: 'Corrected',
  connection: 'Made a link',
  application: 'Applied it',
  review: 'Reviewed',
};

export const ACTOR_LABEL: Record<LearningEvent['actor'], string> = { student: 'you', peer: 'a peer', model: 'the engine' };

/**
 * The trail one page carries: attributable growth events, newest first. Events that only
 * record collected material wear the cool dot — demonstrated growth wears teal.
 */
export function GrowthTrail({ events }: { events: LearningEvent[] }) {
  if (!events.length) return null;
  return (
    <section>
      <Eyebrow className="mb-2">Growth trail</Eyebrow>
      <ol className="space-y-1.5">
        {[...events].reverse().map((event) => (
          <li key={event.id} className="flex items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-sm">
            <span className="mt-2 size-1.5 shrink-0 rounded-full" style={{ background: event.knowledgeOnly ? '#9fb6e8' : '#5ff0d0' }} />
            <span className="min-w-0 flex-1">
              <span className="text-night-200">{EVENT_LABEL[event.kind]}</span>
              {event.note && (
                <span className="block truncate text-[11.5px] text-night-500" title={event.note}>
                  {event.note}
                </span>
              )}
            </span>
            <span className="shrink-0 text-right text-[11px] leading-4 text-night-500">
              {event.actor === 'student' ? ACTOR_LABEL[event.actor] : `${ACTOR_LABEL[event.actor]} · collected`}
              <br />
              {timeAgo(event.at)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
