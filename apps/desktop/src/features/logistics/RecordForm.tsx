import { LOGISTICS_KINDS, type LogisticsRecord, type LogisticsWriteInput } from '@sef/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input, Label, Select, Textarea } from '@/components/ui/primitives';
import { useConfirmLogistics, useCreateLogistics, useUpdateLogistics } from '@/lib/queries';

const KIND_LABEL: Record<(typeof LOGISTICS_KINDS)[number], string> = {
  deadline: 'Deadline',
  event: 'Event',
  notice: 'Notice',
  timetable: 'Timetable',
  reminder: 'Reminder',
};

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || '';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** An instant dueAt becomes the wall-clock it shows in the record's own zone. */
const toLocalInput = (dueAt: string, timeZone: string | null): string => {
  if (DATE_ONLY.test(dueAt)) return dueAt;
  if (NAIVE_DATETIME.test(dueAt)) return dueAt.slice(0, 16);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      ...(timeZone ? { timeZone } : {}),
    }).formatToParts(new Date(dueAt));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
  } catch {
    return '';
  }
};

interface Draft {
  title: string;
  kind: LogisticsWriteInput['kind'];
  allDay: boolean;
  dueAt: string;
  timeZone: string;
  details: string;
}

const draftFrom = (record?: LogisticsRecord): Draft => ({
  title: record?.title ?? '',
  kind: record?.kind ?? 'deadline',
  allDay: record?.allDay ?? true,
  dueAt: record?.dueAt ? toLocalInput(record.dueAt, record.timeZone) : '',
  timeZone: record?.timeZone ?? localZone(),
  details: record?.details ?? '',
});

/**
 * Add / edit a logistics record. On a proposed record the primary action is "Save and
 * confirm" — the one click that turns a photo read-out into something the Friend may
 * use. On a confirmed record it is a plain save. Nothing here moves without a click.
 */
export function RecordForm({ record, onDone }: { record?: LogisticsRecord; onDone: () => void }) {
  const proposed = record?.state === 'proposed';
  const [draft, setDraft] = useState<Draft>(() => draftFrom(record));
  const create = useCreateLogistics();
  const update = useUpdateLogistics();
  const confirm = useConfirmLogistics();
  const busy = create.isPending || update.isPending || confirm.isPending;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const submit = () => {
    const title = draft.title.trim();
    if (!title) {
      toast.error('Give the record a title.');
      return;
    }
    const body: LogisticsWriteInput = {
      title,
      kind: draft.kind,
      allDay: draft.allDay,
      dueAt: draft.dueAt || null,
      timeZone: draft.timeZone.trim() || null,
      details: draft.details.trim(),
    };
    const done = () => onDone();
    if (proposed && record) confirm.mutate({ id: record.id, patch: body }, { onSuccess: done });
    else if (record) update.mutate({ id: record.id, patch: body }, { onSuccess: done });
    else create.mutate(body, { onSuccess: done });
  };

  return (
    <div className="glass rounded-2xl p-5">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <Label htmlFor="log-title">Title</Label>
          <Input id="log-title" value={draft.title} onChange={(e) => set('title', e.target.value)} placeholder="Semester fees — instalment 2" maxLength={200} />
        </div>
        <div>
          <Label htmlFor="log-kind">Kind</Label>
          <Select id="log-kind" value={draft.kind} onChange={(e) => set('kind', e.target.value as Draft['kind'])}>
            {LOGISTICS_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="log-tz">Time zone</Label>
          <Input id="log-tz" value={draft.timeZone} onChange={(e) => set('timeZone', e.target.value)} placeholder="Asia/Kolkata" maxLength={64} />
        </div>
        <div className="flex items-end pb-2">
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-night-300">
            <input type="checkbox" checked={draft.allDay} onChange={(e) => set('allDay', e.target.checked)} className="size-4 accent-beacon-500" />
            All-day / date only
          </label>
        </div>
        <div>
          <Label htmlFor="log-due">{draft.allDay ? 'Due date' : 'Due at'}</Label>
          <Input id="log-due" type={draft.allDay ? 'date' : 'datetime-local'} value={draft.dueAt} onChange={(e) => set('dueAt', e.target.value)} />
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="log-details">Details</Label>
          <Textarea id="log-details" rows={3} value={draft.details} onChange={(e) => set('details', e.target.value)} placeholder="Anything the Friend should know — where to pay, what to bring." maxLength={2000} />
        </div>
      </div>
      <div className="mt-5 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit} loading={busy}>
          {proposed ? 'Save and confirm' : record ? 'Save changes' : 'Add record'}
        </Button>
      </div>
    </div>
  );
}
