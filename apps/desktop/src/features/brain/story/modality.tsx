import { Brain, Camera, FileText, Film, GraduationCap, Link2, MessagesSquare, Mic, NotebookPen, AudioLines, ShieldQuestion, Share2, FileType2, type LucideIcon } from 'lucide-react';
import type { Modality } from './story';

/** One icon per way material reaches the brain — the same marks in the feed, the chips and the disputes. */
export const MODALITY_ICON: Record<Modality, LucideIcon> = {
  photo: Camera,
  voice: Mic,
  recording: AudioLines,
  video: Film,
  pdf: FileType2,
  document: FileText,
  note: NotebookPen,
  chat: MessagesSquare,
  answer: ShieldQuestion,
  peer: Share2,
  quiz: GraduationCap,
  you: Link2,
  brain: Brain,
};

/** Multimodal reads glow aurora, typed material stays beacon-blue, everything else is quiet. */
export const MODALITY_TONE: Record<Modality, string> = {
  photo: 'text-aurora-300 border-aurora-400/30 bg-aurora-500/10',
  voice: 'text-aurora-300 border-aurora-400/30 bg-aurora-500/10',
  recording: 'text-aurora-300 border-aurora-400/30 bg-aurora-500/10',
  video: 'text-aurora-300 border-aurora-400/30 bg-aurora-500/10',
  pdf: 'text-beacon-200 border-beacon-400/30 bg-beacon-500/10',
  document: 'text-beacon-200 border-beacon-400/30 bg-beacon-500/10',
  note: 'text-beacon-200 border-beacon-400/30 bg-beacon-500/10',
  chat: 'text-beacon-200 border-beacon-400/30 bg-beacon-500/10',
  answer: 'text-gold-300 border-gold-400/30 bg-gold-400/10',
  peer: 'text-ember-300 border-ember-400/30 bg-ember-500/10',
  quiz: 'text-gold-300 border-gold-400/30 bg-gold-400/10',
  you: 'text-aurora-300 border-aurora-400/30 bg-aurora-500/10',
  brain: 'text-night-300 border-white/10 bg-white/[0.04]',
};

export function ModalityMark({ modality, className = 'size-7', iconClassName = 'size-3.5' }: { modality: Modality; className?: string; iconClassName?: string }) {
  const Icon = MODALITY_ICON[modality];
  return (
    <span className={`grid shrink-0 place-items-center rounded-full border ${MODALITY_TONE[modality]} ${className}`} aria-hidden>
      <Icon className={iconClassName} />
    </span>
  );
}
