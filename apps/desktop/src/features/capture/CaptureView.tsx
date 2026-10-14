import { useMutation } from '@tanstack/react-query';
import { ArrowRight, Camera, Check, ImageUp, Loader2, ScanText, ShieldCheck, Sparkles, Waypoints } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Badge, Eyebrow, Input, PageHeader, Panel } from '@/components/ui/primitives';
import { BrainDiff } from '@/features/brain/BrainDiff';
import { api, fileToBase64 } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useNav } from '@/lib/nav';
import { useInvalidateBrain } from '@/lib/queries';

const STEPS = [
  { icon: ScanText, label: 'Gemma 4 reads your notes', hint: 'Vision model transcribes handwriting and formulas, on this device' },
  { icon: Waypoints, label: 'Matching to your lessons', hint: 'Deterministic search over released courseware' },
  { icon: Sparkles, label: 'Brain keeper proposes edits', hint: 'Schema-constrained output, concepts limited to your syllabus' },
  { icon: ShieldCheck, label: 'Validator checks and writes', hint: 'Unknown concepts, cycles and unsupported claims are refused' },
];
const STEP_MS = [9000, 1500, 14000];

/** Multimodal capture: a photo of the student's own notes becomes evidence in their brain. */
export function CaptureView() {
  const { go } = useNav();
  const [image, setImage] = useState<{ mimeType: string; data: string; preview: string } | null>(null);
  const [note, setNote] = useState('');
  const [step, setStep] = useState(0);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const invalidateBrain = useInvalidateBrain();

  const capture = useMutation({
    mutationFn: () => api.capture({ mimeType: image!.mimeType, data: image!.data }, note || undefined),
    onSuccess: () => invalidateBrain(),
    onError: (e) => toast.error((e as Error).message),
  });

  useEffect(() => {
    if (!capture.isPending) return;
    setStep(0);
    const timers: number[] = [];
    let at = 0;
    STEP_MS.forEach((ms, i) => {
      at += ms;
      timers.push(window.setTimeout(() => setStep(i + 1), at));
    });
    return () => timers.forEach(clearTimeout);
  }, [capture.isPending]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast.error('Please choose an image.');
    setImage(await fileToBase64(file));
    capture.reset();
  };

  const result = capture.data;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <PageHeader
          eyebrow="Multimodal · on-device"
          title="Capture your notes"
          description="Snap a page of handwritten notes, a whiteboard or a diagram. Gemma 4 reads it, finds the concepts from your courses, and flags anything that contradicts your lessons."
        />

        <div className="grid gap-6 lg:grid-cols-[1.05fr_1fr]">
          <div className="space-y-4">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void pick(e.dataTransfer.files[0]);
              }}
              onClick={() => input.current?.click()}
              className={cn(
                'glass relative grid aspect-[4/3] cursor-pointer place-items-center overflow-hidden rounded-3xl border-dashed transition',
                dragging ? 'border-beacon-400/70 bg-beacon-500/10' : 'hover:border-white/20',
              )}
            >
              {image ? (
                <img src={image.preview} alt="Your notes" className="h-full w-full object-contain p-3" />
              ) : (
                <div className="text-center">
                  <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-white/[0.05] text-beacon-300">
                    <ImageUp className="size-6" />
                  </div>
                  <div className="text-[15px] font-medium text-night-100">Drop a photo, or click to choose</div>
                  <div className="mt-1 text-[13px] text-night-500">PNG or JPG · the image never leaves this device when using Ollama</div>
                </div>
              )}
              {capture.isPending && (
                <motion.div className="pointer-events-none absolute inset-x-0 h-24 bg-gradient-to-b from-transparent via-beacon-400/25 to-transparent" animate={{ top: ['-20%', '100%'] }} transition={{ duration: 2.2, repeat: Infinity, ease: 'linear' }} />
              )}
            </div>
            <input ref={input} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional: what are these notes about? (e.g. “Tuesday's lecture on energy”)" />
            <div className="flex gap-2">
              <Button variant="primary" size="lg" className="flex-1" disabled={!image} loading={capture.isPending} onClick={() => capture.mutate()}>
                {!capture.isPending && <Camera />} {capture.isPending ? 'Reading…' : 'Add to my brain'}
              </Button>
              {image && !capture.isPending && (
                <Button size="lg" variant="ghost" onClick={() => { setImage(null); capture.reset(); }}>
                  Clear
                </Button>
              )}
            </div>
          </div>

          <div>
            {!result && (
              <Panel className="p-6">
                <Eyebrow className="mb-4">How it works</Eyebrow>
                <ol className="space-y-4">
                  {STEPS.map((s, i) => {
                    const done = capture.isPending && step > i;
                    const active = capture.isPending && step === i;
                    return (
                      <li key={s.label} className="flex gap-3.5">
                        <span
                          className={cn(
                            'grid size-9 shrink-0 place-items-center rounded-xl border transition',
                            done ? 'border-aurora-400/40 bg-aurora-500/15 text-aurora-300' : active ? 'border-beacon-400/50 bg-beacon-500/15 text-beacon-200' : 'border-white/[0.08] text-night-500',
                          )}
                        >
                          {done ? <Check className="size-4" /> : active ? <Loader2 className="size-4 animate-spin" /> : <s.icon className="size-4" />}
                        </span>
                        <div>
                          <div className={cn('text-[14px] font-medium', active || done ? 'text-night-100' : 'text-night-300')}>{s.label}</div>
                          <div className="text-[12.5px] text-night-500">{s.hint}</div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </Panel>
            )}

            {result && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
                <Panel className="p-5">
                  <Eyebrow className="mb-2">What Gemma read</Eyebrow>
                  <h3 className="font-display text-2xl text-night-100">{result.reading.topic}</h3>
                  <Markdown variant="chat" className="mt-2 max-h-56 overflow-y-auto rounded-xl bg-black/25 p-3.5 text-[13px] whitespace-pre-wrap">
                    {result.reading.transcription}
                  </Markdown>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {result.reading.concepts.slice(0, 10).map((c) => (
                      <Badge key={c}>{c}</Badge>
                    ))}
                  </div>
                </Panel>
                <Panel className="p-5">
                  <Eyebrow className="mb-3">What changed in your brain</Eyebrow>
                  <BrainDiff diff={result.diff} applied={result.applied} rejected={result.rejected} model={result.model} durationMs={result.durationMs} />
                </Panel>
                <Button variant="primary" onClick={() => go('sky')}>
                  See it in the sky <ArrowRight />
                </Button>
              </motion.div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
