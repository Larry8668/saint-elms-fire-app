import { useId, useState, type ReactNode } from 'react';
import { Button } from './ui/button';
import { Input, Label, Panel, Select, Textarea } from './ui/primitives';
import { WorkingLabel } from './ui/loading';

/**
 * Every staff mutation carries a written reason, because the university records it in the audit
 * trail. This form collects it (and any extra field the action needs) before anything is sent:
 * a refusal must never leave the record half-changed, and a silent decision must never happen.
 */
export interface ReasonFormProps {
  title: string;
  description?: ReactNode;
  submitLabel: string;
  pending: boolean;
  /** Cohort actions supply a cohort; everything else does not. */
  showCohort?: boolean;
  cohorts?: { id: string; name: string }[];
  /** Destructive actions spell out the consequence and ask for a typed confirmation. */
  destructive?: boolean;
  /** Actions the server does not accept a reason for hide the field entirely. */
  requireReason?: boolean;
  /** Text the person must retype before a destructive action is enabled. */
  confirmationPhrase?: string;
  extraFields?: ReactNode;
  onSubmit: (value: { reason: string; cohortId?: string; confirmation?: string }) => void;
  onCancel?: () => void;
}

export function ReasonForm(props: ReasonFormProps) {
  const {
    title,
    description,
    submitLabel,
    pending,
    showCohort = false,
    cohorts = [],
    destructive = false,
    requireReason = true,
    confirmationPhrase,
    extraFields,
    onSubmit,
    onCancel,
  } = props;

  const reasonId = useId();
  const cohortId = useId();
  const confirmId = useId();
  const [reason, setReason] = useState('');
  const [cohort, setCohort] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [touched, setTouched] = useState(false);

  const reasonValid = !requireReason || reason.trim().length > 0;
  const cohortValid = !showCohort || cohort.length > 0;
  const confirmationValid = !confirmationPhrase || confirmation.trim() === confirmationPhrase;
  const valid = reasonValid && cohortValid && confirmationValid;

  return (
    <Panel className={destructive ? 'border-rose-400/30 p-5' : 'p-5'}>
      <h3 className={`text-sm font-semibold ${destructive ? 'text-rose-400' : 'text-night-100'}`}>{title}</h3>
      {description && <div className="mt-1 text-[13px] leading-5 text-night-400">{description}</div>}

      <form
        className="mt-4 space-y-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (!valid || pending) return;
          onSubmit({ reason: reason.trim(), cohortId: cohort || undefined, confirmation: confirmation.trim() });
        }}
      >
        {extraFields}

        {showCohort && (
          <div>
            <Label htmlFor={cohortId}>Cohort</Label>
            <Select
              id={cohortId}
              value={cohort}
              onChange={(event) => setCohort(event.target.value)}
              aria-describedby={`${cohortId}-hint`}
            >
              <option value="">Choose a cohort…</option>
              {cohorts.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name} ({entry.id})
                </option>
              ))}
            </Select>
            <p id={`${cohortId}-hint`} className="mt-1 text-[12px] text-night-500">
              Only cohorts the university has published can be assigned.
            </p>
          </div>
        )}

        {requireReason && (
          <div>
            <Label htmlFor={reasonId}>Reason (recorded in the audit trail)</Label>
            <Textarea
              id={reasonId}
              rows={2}
              value={reason}
              maxLength={2000}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why is this change being made?"
              aria-invalid={touched && !reasonValid}
              aria-describedby={touched && !reasonValid ? `${reasonId}-error` : undefined}
            />
            {touched && !reasonValid && (
              <p id={`${reasonId}-error`} className="mt-1 text-[12px] text-rose-400">
                A reason is required: the university records it against this change.
              </p>
            )}
          </div>
        )}

        {confirmationPhrase && (
          <div>
            <Label htmlFor={confirmId}>
              Type <span className="font-mono text-night-100">{confirmationPhrase}</span> to confirm
            </Label>
            <Input
              id={confirmId}
              value={confirmation}
              autoComplete="off"
              onChange={(event) => setConfirmation(event.target.value)}
              aria-invalid={confirmation.length > 0 && !confirmationValid}
            />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button type="submit" variant={destructive ? 'danger' : 'primary'} size="sm" loading={pending} disabled={pending || !valid}>
            {submitLabel}
          </Button>
          {onCancel && (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          {pending && <WorkingLabel label="Saving…" />}
        </div>
      </form>
    </Panel>
  );
}