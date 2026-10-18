import { TEACHERS, type AnchorCandidate, type TeacherId } from '@sef/shared';
import { ArrowUpRight } from 'lucide-react';
import { motion } from 'motion/react';
import { Eyebrow } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { useSessions } from '@/lib/queries';
import { AnchorPicker } from './AnchorBar';
import { SessionList } from './ConversationHistory';
import { TEACHER_LOOK } from './teacher-meta';

/** Empty-thread state: who this teacher is and three ways to start. */
export function TeacherIntro({ teacher, onPick, anchor, onAnchor }: { teacher: TeacherId; onPick: (prompt: string) => void; anchor?: AnchorCandidate | null; onAnchor?: (a: AnchorCandidate) => void }) {
  const look = TEACHER_LOOK[teacher];
  const profile = TEACHERS[teacher];
  return (
    <motion.div key={teacher} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="relative pt-10 text-center">
      <div className={cn('pointer-events-none absolute inset-x-0 -top-10 mx-auto h-56 w-56 rounded-full bg-gradient-to-b to-transparent blur-3xl', look.glow)} />
      <div className={cn('relative mx-auto mb-5 grid size-16 place-items-center rounded-2xl border bg-white/[0.04]', look.ring, look.accent)}>
        <look.Icon className="size-7" />
      </div>
      <h2 className="relative font-display text-4xl text-night-100">{profile.voice}</h2>
      <p className="relative mx-auto mt-3 max-w-lg text-[15px] leading-7 text-night-400">{look.greeting}</p>
      {teacher === 'philosopher' && onAnchor && (
        <div className="relative mx-auto mt-8 max-w-lg text-left">
          <Eyebrow className="mb-2.5">Explore from a page in your wiki</Eyebrow>
          <AnchorPicker selected={anchor?.pageId ?? null} onPick={onAnchor} />
        </div>
      )}
      <Eyebrow className="relative mt-8 mb-2.5">Ways to start with this teacher</Eyebrow>
      <div className="relative grid gap-2 sm:grid-cols-3">
        {profile.samplePrompts.map((p, i) => (
          <motion.button
            key={p}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08 + i * 0.05 }}
            onClick={() => onPick(p)}
            className="glass group flex cursor-pointer flex-col justify-between gap-3 rounded-xl p-3.5 text-left text-[13px] leading-5 text-night-300 transition hover:border-white/[0.14] hover:text-night-100"
          >
            {p}
            <ArrowUpRight className="size-3.5 self-end text-night-600 transition group-hover:text-night-300" />
          </motion.button>
        ))}
      </div>
      <RecentConversations teacher={teacher} />
    </motion.div>
  );
}

function RecentConversations({ teacher }: { teacher: TeacherId }) {
  const sessions = useSessions(teacher);
  if (!sessions.data?.length) return null;
  return (
    <div className="relative mt-10 text-left">
      <Eyebrow className="mb-2.5">Pick up where you left off</Eyebrow>
      <SessionList teacher={teacher} limit={3} />
    </div>
  );
}
