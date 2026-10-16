import { formatDue, type LogisticsRecord } from '@sef/shared';
import { Archive, CalendarClock, Check, ChevronDown, ImagePlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, PageHeader, Panel } from '@/components/ui/primitives';
import { RowListSkeleton } from '@/components/ui/skeletons';
import { Tooltip } from '@/components/ui/overlays';
import { fileToBase64 } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useConfirmLogistics, useDeleteLogistics, useDismissLogistics, useExtractLogistics, useLogistics } from '@/lib/queries';
import { RecordForm } from './RecordForm';

/**
 * The student's private logistics ledger: deadlines, notices and timetable entries that
 * live on this device only. Confirmed records are what the Friend may cite; proposals
 * read out of a photo sit here until the student confirms or dismisses them — nothing
 * reaches the Friend's answers unconfirmed, and nothing in this view is shareable.
 */
export function LogisticsView() {
  const query = useLogistics();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const items = query.data?.items ?? [];
  const proposed = items.filter((r) => r.state === 'proposed');
  const confirmed = items.filter((r) => r.state === 'confirmed');
  const dismissed = items.filter((r) => r.state === 'dismissed');

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-8 md:px-10">
        <PageHeader
          eyebrow="Private to you"
          title="Logistics"
          description="Your deadlines, notices and timetable, kept on this device. The Friend grounds its campus answers in the confirmed ones — it can never see a classmate's, and nothing here is shared. A photo it reads lands below as a proposal until you confirm it."
          actions={
            <div className="flex gap-2">
              <ExtractButton />
              <Button variant="primary" onClick={() => setAdding((v) => !v)}>
                <Plus /> Add a record
              </Button>
            </div>
          }
        />

        {adding && (
          <div className="mb-6">
            <RecordForm onDone={() => setAdding(false)} />
          </div>
        )}

        {query.isPending ? (
          <RowListSkeleton rows={4} />
        ) : query.isError ? (
          <Panel className="p-6 text-sm text-rose-300">
            Could not load your logistics — {(query.error as Error).message}
          </Panel>
        ) : items.length === 0 && !adding ? (
          <EmptyState
            icon={<CalendarClock />}
            title="No logistics yet"
            body="Add a deadline or read it off a notice photo. Once confirmed, the Friend can ground campus answers in it — it stays on this device either way."
            action={
              <Button variant="primary" onClick={() => setAdding(true)}>
                <Plus /> Add your first record
              </Button>
            }
          />
        ) : (
          <div className="space-y-8">
            {proposed.length > 0 && (
              <section>
                <h2 className="mb-3 text-[11px] font-semibold tracking-[0.18em] text-gold-300 uppercase">
                  Awaiting your confirmation · {proposed.length}
                </h2>
                <p className="mb-3 max-w-2xl text-[13px] leading-5 text-night-400">
                  Read out of a photo — check each one before it can stand as fact for the Friend.
                </p>
                <div className="space-y-3">
                  {proposed.map((record) =>
                    editingId === record.id ? (
                      <RecordForm key={record.id} record={record} onDone={() => setEditingId(null)} />
                    ) : (
                      <RecordRow key={record.id} record={record} onEdit={() => setEditingId(record.id)} />
                    ),
                  )}
                </div>
              </section>
            )}

            <section>
              <h2 className="mb-3 text-[11px] font-semibold tracking-[0.18em] text-night-400 uppercase">Confirmed · {confirmed.length}</h2>
              {confirmed.length ? (
                <div className="space-y-3">
                  {confirmed.map((record) =>
                    editingId === record.id ? (
                      <RecordForm key={record.id} record={record} onDone={() => setEditingId(null)} />
                    ) : (
                      <RecordRow key={record.id} record={record} onEdit={() => setEditingId(record.id)} />
                    ),
                  )}
                </div>
              ) : (
                <Panel className="p-5 text-sm text-night-400">Nothing confirmed yet — the Friend cannot ground an answer in an empty ledger.</Panel>
              )}
            </section>

            {dismissed.length > 0 && (
              <section>
                <button
                  onClick={() => setShowDismissed((v) => !v)}
                  className="mb-3 flex cursor-pointer items-center gap-1.5 text-[11px] font-semibold tracking-[0.18em] text-night-500 uppercase hover:text-night-300"
                >
                  <ChevronDown className={cn('size-3.5 transition', showDismissed && 'rotate-180')} /> Dismissed · {dismissed.length}
                </button>
                {showDismissed && (
                  <div className="space-y-3">
                    {dismissed.map((record) => (
                      <RecordRow key={record.id} record={record} />
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function provenanceLabel(record: LogisticsRecord): string {
  if (record.provenance.kind === 'friend_extraction') {
    const note = record.provenance.note ? ` · ${record.provenance.note}` : '';
    return `Read by the Friend from a photo${note}`;
  }
  return 'You added this';
}

function RecordRow({ record, onEdit }: { record: LogisticsRecord; onEdit?: () => void }) {
  const confirm = useConfirmLogistics();
  const dismiss = useDismissLogistics();
  const remove = useDeleteLogistics();
  const busy = confirm.isPending || dismiss.isPending || remove.isPending;

  return (
    <Panel className={cn('flex items-start gap-4 p-5', record.state === 'dismissed' && 'opacity-60')}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[15px] font-medium text-night-100">{record.title}</h3>
          <Badge tone={record.state === 'confirmed' ? 'aurora' : record.state === 'proposed' ? 'gold' : 'neutral'}>
            {record.state === 'proposed' ? 'unconfirmed' : record.state}
          </Badge>
          <Badge>{record.kind}</Badge>
        </div>
        <p className="mt-1.5 text-[13px] text-night-300">{formatDue(record)}</p>
        {record.details && <p className="mt-1 text-[13px] leading-5 text-night-400">{record.details}</p>}
        <p className="mt-2 text-[11.5px] text-night-500" title={record.provenance.model ?? undefined}>
          {provenanceLabel(record)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {record.state === 'proposed' && (
          <>
            <Button size="sm" variant="primary" loading={confirm.isPending} disabled={busy && !confirm.isPending} onClick={() => confirm.mutate({ id: record.id })}>
              <Check /> Confirm
            </Button>
            {onEdit && (
              <Button size="sm" variant="secondary" onClick={onEdit}>
                <Pencil /> Edit
              </Button>
            )}
            <Tooltip content="Dismiss — kept on record, never used">
              <Button size="sm" variant="ghost" loading={dismiss.isPending} disabled={busy && !dismiss.isPending} onClick={() => dismiss.mutate(record.id)} aria-label="Dismiss">
                <Archive />
              </Button>
            </Tooltip>
          </>
        )}
        {record.state === 'confirmed' && onEdit && (
          <Button size="sm" variant="secondary" onClick={onEdit}>
            <Pencil /> Edit
          </Button>
        )}
        {record.state !== 'proposed' && (
          <Tooltip content="Delete this record">
            <Button size="sm" variant="ghost" loading={remove.isPending} disabled={busy && !remove.isPending} onClick={() => remove.mutate(record.id)} aria-label="Delete">
              <Trash2 className="text-rose-400/80" />
            </Button>
          </Tooltip>
        )}
      </div>
    </Panel>
  );
}

/**
 * The photo-to-proposal entry point: same pipeline the Friend runs on image turns.
 * The result is always proposals — the student's confirmation moves them, not the model.
 */
function ExtractButton() {
  const inputRef = useRef<HTMLInputElement>(null);
  const extract = useExtractLogistics();

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
      toast.error('Only PNG or JPEG photos can be read.');
      return;
    }
    try {
      const { mimeType, data } = await fileToBase64(file);
      extract.mutate({ image: { mimeType: mimeType as 'image/png' | 'image/jpeg', data }, note: file.name });
    } catch (error) {
      toast.error(`Could not read that photo — ${(error as Error).message}`);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={(e) => {
          void onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <Button variant="secondary" loading={extract.isPending} onClick={() => inputRef.current?.click()}>
        <ImagePlus /> Read a notice photo
      </Button>
    </>
  );
}
