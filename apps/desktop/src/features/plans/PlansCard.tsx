import type { PlanStep, StudyPlan } from '@sef/shared';
import { AlertTriangle, ArrowRight, Check, ChevronDown, Circle, ListChecks, Plus } from 'lucide-react';
import { motion } from 'motion/react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Tooltip } from '@/components/ui/overlays';
import { Badge, Input } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { useNav } from '@/lib/nav';
import { usePlanActions, usePlans } from '@/lib/queries';
import { countdown, deadlineFromDate, progressOf, refLabel, stepAction, visiblePlans } from './plans';

/**
 * Study plans on the sky. A plan is a checklist the student follows: each step is a link to
 * where the work happens, and ticks appear only when the engine sees the evidence.
 */
export function PlansCard() {
  const plans = usePlans();
  const [composing, setComposing] = useState(false);
  if (plans.isPending || plans.isError) return null;
  const visible = visiblePlans(plans.data.plans);

  return (
    <motion.section
      aria-label="Study plans"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.25 }}
      className="glass pointer-events-auto max-h-[46vh] overflow-y-auto rounded-2xl p-2"
    >
      <div className="flex items-center justify-between px-2.5 pt-1.5 pb-1">
        <span className="text-[10.5px] font-semibold tracking-[0.18em] text-night-500 uppercase">Plans</span>
        {!composing && (
          <button onClick={() => setComposing(true)} className="flex cursor-pointer items-center gap-1 text-[11.5px] text-night-400 transition hover:text-night-100">
            <Plus className="size-3.5" /> New plan
          </button>
        )}
      </div>
      {composing && <GoalForm onClose={() => setComposing(false)} />}
      {!composing && visible.length === 0 && (
        <p className="px-2.5 pb-2 text-[12px] leading-5 text-night-500">
          Tell me a goal — “revise thermodynamics before Thursday” — and I’ll propose a short checklist from your own pages and lessons.
        </p>
      )}
      {visible.map((plan, i) => (plan.status === 'proposed' ? <ProposalPreview key={plan.id} plan={plan} /> : <PlanRow key={plan.id} plan={plan} startOpen={i === 0} />))}
    </motion.section>
  );
}

function GoalForm({ onClose }: { onClose: () => void }) {
  const { propose } = usePlanActions();
  const [goal, setGoal] = useState('');
  const [date, setDate] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = goal.trim();
    if (trimmed.length < 3) return;
    propose.mutate({ goal: trimmed, deadlineAt: deadlineFromDate(date) }, { onSuccess: onClose });
  };

  return (
    <form onSubmit={submit} className="space-y-2 px-2.5 pb-2.5">
      <Input autoFocus value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={300} placeholder="What do you want to get done?" aria-label="Plan goal" className="h-9 text-[13px]" />
      <label className="flex items-center gap-2 text-[11.5px] text-night-400">
        By
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Deadline (optional)" className="h-8 flex-1 text-[12px]" />
      </label>
      {propose.isError && (
        <p role="alert" className="text-[11.5px] leading-4 text-ember-300">
          {(propose.error as Error).message}
        </p>
      )}
      <div className="flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" loading={propose.isPending} disabled={goal.trim().length < 3}>
          {propose.isPending ? 'Planning…' : 'Propose'}
        </Button>
      </div>
    </form>
  );
}

function Deadline({ plan }: { plan: StudyPlan }) {
  const due = countdown(plan.deadlineAt);
  return due ? <span className={cn('shrink-0 text-[11px]', due.urgent ? 'text-ember-300' : 'text-night-500')}>{due.text}</span> : null;
}

/** Nothing is tracked until the student approves — and they see every resolved reference first. */
function ProposalPreview({ plan }: { plan: StudyPlan }) {
  const { approve, abandon } = usePlanActions();
  return (
    <div className="mx-1 mb-1.5 rounded-xl border border-beacon-400/20 bg-beacon-500/[0.06] p-2.5" aria-label={`Proposed plan: ${plan.goal}`}>
      <div className="flex items-start gap-2">
        <Badge tone="beacon" className="shrink-0 px-1.5 py-0 text-[10px]">
          {plan.revisionOf ? 'Revision' : 'Proposed'}
        </Badge>
        <span className="min-w-0 flex-1 text-[12.5px] leading-4 text-night-100">{plan.goal}</span>
        <Deadline plan={plan} />
      </div>
      <ol className="mt-2 space-y-1.5">
        {plan.steps.map((step, i) => (
          <li key={step.id} className="text-[12px] leading-4">
            <span className="text-night-500">{i + 1}.</span> <span className={cn('text-night-200', step.state === 'done' && 'text-night-500 line-through')}>{step.title}</span>
            <span className="mt-0.5 flex flex-wrap gap-1 pl-3.5">
              {step.entityRefs.map((ref, j) => (
                <span key={ref} className="rounded-md bg-white/[0.05] px-1.5 text-[10.5px] text-night-400">
                  {refLabel(ref)}
                  {j === 0 && <>: {step.subject}</>}
                </span>
              ))}
            </span>
          </li>
        ))}
      </ol>
      {plan.notes.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11px] leading-4 text-night-500" aria-label="Notes">
          {plan.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <div className="mt-2.5 flex justify-end gap-1.5">
        <Button variant="ghost" size="sm" disabled={abandon.isPending} onClick={() => abandon.mutate(plan.id)}>
          Discard
        </Button>
        <Button variant="primary" size="sm" loading={approve.isPending} onClick={() => approve.mutate(plan.id)}>
          {plan.revisionOf ? 'Use revision' : 'Start plan'}
        </Button>
      </div>
    </div>
  );
}

function PlanRow({ plan, startOpen }: { plan: StudyPlan; startOpen: boolean }) {
  const { abandon } = usePlanActions();
  const [open, setOpen] = useState(startOpen);
  const { done, stale, total } = progressOf(plan);
  const finished = plan.status === 'completed';

  return (
    <div className="mx-1 mb-1 rounded-xl px-1.5 py-1.5">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full cursor-pointer items-center gap-2 px-1 text-left">
        <ListChecks className={cn('size-3.5 shrink-0', finished ? 'text-aurora-300' : 'text-beacon-300')} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-night-100">{plan.goal}</span>
        {finished ? <span className="shrink-0 text-[11px] text-aurora-300">done</span> : <Deadline plan={plan} />}
        <ChevronDown className={cn('size-3.5 shrink-0 text-night-500 transition', open && 'rotate-180')} />
      </button>
      <div className="mt-1.5 flex items-center gap-2 px-1">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={total} aria-label="Plan progress">
          <div className="h-full rounded-full bg-gradient-to-r from-beacon-500 to-aurora-400 transition-[width] duration-700" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>
        <span className="shrink-0 text-[10.5px] text-night-500">
          {done}/{total}
          {stale > 0 && <span className="text-ember-300"> · {stale} stale</span>}
        </span>
      </div>
      {open && (
        <>
          <ul className="mt-1.5 space-y-0.5" aria-label={`Steps for ${plan.goal}`}>
            {plan.steps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </ul>
          {!finished && (
            <div className="mt-1 flex justify-end">
              <ConfirmButton variant="ghost" size="sm" className="h-7 text-[11.5px]" confirmLabel="Stop plan" disabled={abandon.isPending} onConfirm={() => abandon.mutate(plan.id)}>
                Stop following
              </ConfirmButton>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StepRow({ step }: { step: PlanStep }) {
  const { go } = useNav();
  const action = stepAction(step);
  const icon =
    step.state === 'done' ? <Check className="size-3.5 text-aurora-300" /> : step.state === 'stale' ? <AlertTriangle className="size-3.5 text-ember-400" /> : <Circle className="size-3 text-night-500" />;
  return (
    <li className="group flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-white/[0.04]">
      <span className="grid size-4 shrink-0 place-items-center" aria-label={step.state}>
        {icon}
      </span>
      <span className={cn('min-w-0 flex-1 truncate text-[12px]', step.state === 'pending' ? 'text-night-200' : 'text-night-500', step.state === 'done' && 'line-through')} title={step.detail || step.title}>
        {step.title}
      </span>
      {step.state === 'stale' && <span className="shrink-0 text-[10.5px] text-ember-300">changed</span>}
      {step.state === 'pending' &&
        ('view' in action ? (
          <button
            onClick={() => go(action.view, action.params)}
            className="flex shrink-0 cursor-pointer items-center gap-0.5 text-[11px] text-night-400 opacity-80 transition group-hover:opacity-100 hover:text-beacon-200"
          >
            {action.label} <ArrowRight className="size-3" />
          </button>
        ) : (
          <Tooltip content={action.hint}>
            <span className="shrink-0 text-[11px] text-night-500">{action.label}</span>
          </Tooltip>
        ))}
    </li>
  );
}
