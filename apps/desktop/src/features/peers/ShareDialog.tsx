import type { PublishShareRequest, ShareScreening, SharedAttachment, SourceSummary } from '@sef/shared';
import { CheckCircle2, Paperclip, Send, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/overlays';
import { Badge, Input, Label, Panel, Select, SkeletonText, Textarea } from '@/components/ui/primitives';
import { usePrepareShare, usePublishShare, useSharePages, useSourceList } from './peer-queries';
import { screeningBadge } from './screening';

const ATTACHABLE_MEDIA = new Set(['text/plain', 'text/markdown', 'application/pdf', 'image/png', 'image/jpeg']);
const ATTACHABLE_KINDS = new Set(['note', 'document', 'image']);
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const MARKDOWN_LIMIT = 10_000;

const attachable = (s: SourceSummary) => ATTACHABLE_KINDS.has(s.kind) && ATTACHABLE_MEDIA.has(s.mediaType) && s.bytes <= ATTACHMENT_MAX_BYTES;
const descriptor = (s: SourceSummary): SharedAttachment => ({
  id: s.id,
  name: s.title.slice(0, 200),
  mediaType: s.mediaType as SharedAttachment['mediaType'],
  sha256: s.sha256,
  bytes: s.bytes,
});

/**
 * Publish flow: pick a page → the engine freezes an exact draft → the student edits,
 * chooses attachment *descriptors* and ticks each disclosure → publish relays the
 * previewed body verbatim. The JSON panel is the literal network payload.
 */
export function ShareDialog({ open, onOpenChange, initialPageId }: { open: boolean; onOpenChange: (open: boolean) => void; initialPageId?: string }) {
  const pages = useSharePages();
  const sources = useSourceList();
  const prepare = usePrepareShare();
  const publish = usePublishShare();

  const [pageId, setPageId] = useState<string>(initialPageId ?? '');
  const [request, setRequest] = useState<PublishShareRequest | null>(null);
  const [cohortId, setCohortId] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [screening, setScreening] = useState<ShareScreening | null>(null);
  const [published, setPublished] = useState<string | null>(null);
  const [ackCohort, setAckCohort] = useState(false);
  const [ackFeed, setAckFeed] = useState(false);
  const [ackCaveat, setAckCaveat] = useState(false);

  useEffect(() => {
    if (open && initialPageId) setPageId(initialPageId);
  }, [open, initialPageId]);

  useEffect(() => {
    if (!open || !pageId) return;
    prepare.mutate(
      { pageId },
      {
        onSuccess: (draft) => {
          setRequest(draft.request);
          setCohortId(draft.cohortId);
          setExcluded(draft.excluded);
          setScreening(draft.screening ?? null);
          setPublished(null);
        },
      },
    );
    // prepare once per selected page; attachments are folded in locally below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pageId]);

  const reset = () => {
    setPageId(initialPageId ?? '');
    setRequest(null);
    setExcluded([]);
    setScreening(null);
    setPublished(null);
    setAckCohort(false);
    setAckFeed(false);
    setAckCaveat(false);
  };

  const candidates = useMemo(() => (sources.data?.sources ?? []).filter(attachable), [sources.data]);
  const chosen = new Set(request?.payload.attachments.map((a) => a.id) ?? []);
  const toggleAttachment = (source: SourceSummary, on: boolean) => {
    if (!request) return;
    const attachments = on ? [...request.payload.attachments, descriptor(source)] : request.payload.attachments.filter((a) => a.id !== source.id);
    setRequest({ ...request, payload: { ...request.payload, attachments } });
    setScreening(null); // attachment names are screened too — the old verdict no longer applies
  };

  const markdownLength = request?.payload.markdown.length ?? 0;
  const ready = Boolean(request) && ackCohort && ackFeed && ackCaveat && request!.payload.title.trim().length > 0 && markdownLength <= MARKDOWN_LIMIT;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="Share with your cohort"
      description="Everything in the preview is what leaves this device — nothing else does."
      className="w-[min(760px,calc(100vw-2rem))]"
    >
      {published ? (
        <Panel className="p-5 text-center">
          <CheckCircle2 className="mx-auto size-8 text-aurora-300" />
          <p className="mt-3 text-[15px] text-night-100">{published}</p>
          <Button className="mt-4" size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </Panel>
      ) : (
        <div className="space-y-4">
          <div>
            <Label htmlFor="share-page">Page to share</Label>
            <Select id="share-page" value={pageId} onChange={(e) => setPageId(e.target.value)}>
              <option value="">Choose a page…</option>
              {(pages.data?.items ?? []).map((page) => (
                <option key={page.id} value={page.id}>
                  {page.title} ({page.kind})
                </option>
              ))}
            </Select>
          </div>

          {pageId && prepare.isPending && <SkeletonText lines={5} />}

          {request && (
            <>
              <div>
                <Label htmlFor="share-title">Title</Label>
                <Input
                  id="share-title"
                  value={request.payload.title}
                  maxLength={160}
                  onChange={(e) => {
                    setRequest({ ...request, payload: { ...request.payload, title: e.target.value } });
                    setScreening(null); // the screened text changed — the old verdict no longer applies
                  }}
                />
              </div>
              <div>
                <Label htmlFor="share-markdown">
                  Shared text{' '}
                  <span className={markdownLength > MARKDOWN_LIMIT ? 'text-ember-300' : 'text-night-500'}>
                    ({markdownLength.toLocaleString()}/{MARKDOWN_LIMIT.toLocaleString()} chars)
                  </span>
                </Label>
                <Textarea
                  id="share-markdown"
                  value={request.payload.markdown}
                  rows={10}
                  onChange={(e) => {
                    setRequest({ ...request, payload: { ...request.payload, markdown: e.target.value } });
                    setScreening(null); // the screened text changed — the old verdict no longer applies
                  }}
                />
                <p className="mt-1 text-[12px] text-night-500">
                  Links in the text become citations automatically (up to 20). Links to pages you did not share stay readable as
                  explicit references — they just will not resolve for classmates.
                </p>
              </div>

              {candidates.length > 0 && (
                <div>
                  <Label>Attachment descriptors — originals stay on this device</Label>
                  <div className="mt-1 space-y-1.5">
                    {candidates.map((source) => (
                      <label key={source.id} className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-white/[0.07] p-2.5 text-[13px] text-night-300 hover:bg-white/[0.03]">
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-beacon-400"
                          checked={chosen.has(source.id)}
                          onChange={(e) => toggleAttachment(source, e.target.checked)}
                        />
                        <span className="flex items-center gap-1.5">
                          <Paperclip className="size-3.5" /> {source.title} · {source.mediaType} · {Math.ceil(source.bytes / 1024)} KB
                          <span className="text-night-600">— I created this or have the right to share it</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {excluded.length > 0 && (
                <Panel className="p-3">
                  <div className="text-[12px] font-medium tracking-wide text-night-400 uppercase">Left out by the builder</div>
                  <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[12px] text-night-500">
                    {excluded.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </Panel>
              )}

              {screening && (
                <Panel className="flex items-start gap-2.5 p-3">
                  <ShieldCheck className={`mt-0.5 size-4 shrink-0 ${screening.status === 'flagged' ? 'text-ember-300' : 'text-night-400'}`} />
                  <span className="text-[13px] text-night-300">
                    <Badge tone={screeningBadge(screening).tone}>{screeningBadge(screening).label}</Badge>
                    <span className="mt-1 block text-[12px] text-night-500">
                      {screening.status === 'flagged'
                        ? 'This is what classmates will see flagged when they import it. You can still publish — screening never blocks.'
                        : 'This is the on-device check classmates will run on import. Editing the text or attachments clears it.'}
                    </span>
                  </span>
                </Panel>
              )}

              <details className="rounded-xl border border-white/[0.07] bg-black/20 p-3">
                <summary className="cursor-pointer text-[13px] font-medium text-night-300">Exact network payload</summary>
                <pre className="mt-2 max-h-64 overflow-auto text-[11px] leading-relaxed text-night-400">{JSON.stringify(request, null, 2)}</pre>
              </details>

              <Panel className="space-y-2.5 p-4">
                <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-night-200">
                  <input type="checkbox" className="mt-0.5 accent-beacon-400" checked={ackCohort} onChange={(e) => setAckCohort(e.target.checked)} />
                  <span>
                    This goes to <strong>everyone in cohort {cohortId ?? '…'}</strong> — I cannot choose a subset.
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-night-200">
                  <input type="checkbox" className="mt-0.5 accent-beacon-400" checked={ackFeed} onChange={(e) => setAckFeed(e.target.checked)} />
                  <span>The university-operated feed can read what I publish.</span>
                </label>
                <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-night-200">
                  <input type="checkbox" className="mt-0.5 accent-beacon-400" checked={ackCaveat} onChange={(e) => setAckCaveat(e.target.checked)} />
                  <span>I checked the preview myself — automatic exclusions are a starting point, not a guarantee.</span>
                </label>
              </Panel>

              <div className="flex justify-end gap-2 border-t border-white/[0.06] pt-4">
                <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!ready}
                  loading={publish.isPending}
                  onClick={() =>
                    publish.mutate(request, {
                      onSuccess: (result) =>
                        setPublished(
                          result.replayed
                            ? 'Already published — the university replayed your earlier share.'
                            : `Published to cohort ${result.share.cohortId}.`,
                        ),
                    })
                  }
                >
                  <Send /> Publish to cohort
                </Button>
              </div>
            </>
          )}

          {!pageId && pages.data?.items.length === 0 && (
            <p className="text-sm text-night-400">No shareable pages yet — write something in your brain first.</p>
          )}
        </div>
      )}
    </Dialog>
  );
}
