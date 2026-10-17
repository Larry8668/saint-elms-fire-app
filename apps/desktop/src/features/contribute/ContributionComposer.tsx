import { useMutation } from '@tanstack/react-query';
import { FileUp, MessagesSquare, Send } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { TEACHERS, type ContributeBody, type SourceReceipt, type VideoPreview } from '@sef/shared';
import { Button } from '@/components/ui/button';
import { Tabs } from '@/components/ui/overlays';
import { Badge, Eyebrow, Input, Label, Panel, Textarea } from '@/components/ui/primitives';
import { api, fileToBase64 } from '@/lib/api';
import { cn } from '@/lib/cn';
import { log } from '@/lib/log';
import { useInvalidateBrain, useSessions } from '@/lib/queries';
import { timeAgo } from '@/lib/time';
import { formatSeconds, normalizeMediaType, textContribution, uploadContribution } from './review';

type Mode = 'write' | 'upload' | 'link' | 'conversation';

/** Own understanding vs external material — the provenance the record will carry. */
function OriginToggle({ own, onChange }: { own: boolean; onChange: (own: boolean) => void }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-[12.5px] font-medium text-night-300">Whose words are these?</legend>
      <div className="grid grid-cols-2 gap-2">
        {[
          { own: true, label: 'My own thinking', hint: 'Counts as your understanding' },
          { own: false, label: 'From somewhere else', hint: 'Filed with its real attribution' },
        ].map((choice) => (
          <button
            key={String(choice.own)}
            type="button"
            aria-pressed={own === choice.own}
            onClick={() => onChange(choice.own)}
            className={cn(
              'rounded-xl border px-3 py-2.5 text-left transition',
              own === choice.own ? 'border-beacon-400/60 bg-beacon-500/[0.12] text-night-100' : 'border-white/[0.08] text-night-400 hover:border-white/[0.16] hover:text-night-200',
            )}
          >
            <span className="block text-[13px] font-medium">{choice.label}</span>
            <span className="mt-0.5 block text-[11px] leading-4 opacity-70">{choice.hint}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** Creator + link — only asked when the material is not the student's own. */
function AttributionFields({ creator, url, onCreator, onUrl }: { creator: string; url: string; onCreator: (v: string) => void; onUrl: (v: string) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <Label htmlFor="contrib-creator">Who made it? (optional)</Label>
        <Input id="contrib-creator" value={creator} onChange={(e) => onCreator(e.target.value)} placeholder="e.g. OpenStax, a friend, a video" />
      </div>
      <div>
        <Label htmlFor="contrib-url">Where is it from? (optional)</Label>
        <Input id="contrib-url" value={url} onChange={(e) => onUrl(e.target.value)} placeholder="https://…" inputMode="url" />
      </div>
    </div>
  );
}

const MODES: Array<{ value: Mode; label: string }> = [
  { value: 'write', label: 'Write or paste' },
  { value: 'upload', label: 'Upload a file' },
  { value: 'link', label: 'A video link' },
  { value: 'conversation', label: 'From a conversation' },
];

const UPLOAD_ACCEPT = '.pdf,.txt,.md,.markdown,.png,.jpg,.jpeg,.webp,.heic,.mp3,.wav,.m4a,.aac,.ogg,.flac,.weba,.3gp,image/*,audio/*,application/pdf,text/plain,text/markdown';

/**
 * The contribution desk: everything a student files — a note, a paste, a photo, a PDF, a
 * conversation — is kept as an immutable source first. Nothing is compiled here.
 */
export function ContributionComposer({ onFiled }: { onFiled: (receipt: SourceReceipt) => void }) {
  const [mode, setMode] = useState<Mode>('write');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [own, setOwn] = useState(true);
  const [creator, setCreator] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<{ name: string; mediaType: string; data: string; preview: string } | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [preview, setPreview] = useState<VideoPreview | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const sessions = useSessions();
  const invalidateBrain = useInvalidateBrain();

  const attribution = () => {
    const trimmedCreator = creator.trim();
    const trimmedUrl = url.trim();
    return trimmedCreator || trimmedUrl ? { attribution: { ...(trimmedCreator ? { creator: trimmedCreator } : {}), ...(trimmedUrl ? { url: trimmedUrl } : {}) } } : {};
  };

  const contribute = useMutation({
    mutationFn: (body: ContributeBody) => api.contribute(body),
    onSuccess: (receipt) => {
      invalidateBrain();
      onFiled(receipt);
      toast.success(receipt.reused ? 'Already on file — its job picks up where it left off' : 'Kept — check the reading before it is proposed');
      reset();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const previewLink = useMutation({
    mutationFn: (url: string) => api.videoPreview(url),
    onSuccess: setPreview,
    onError: (e) => toast.error((e as Error).message),
  });

  const fetchLink = useMutation({
    mutationFn: (url: string) => api.videoIngest(url),
    onSuccess: (receipt) => {
      invalidateBrain();
      onFiled(receipt);
      toast.success('Kept — check the transcript before it is proposed');
      reset();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const freeze = useMutation({
    mutationFn: (sessionId: string) => api.reflectReview(sessionId),
    onSuccess: (receipt) => {
      invalidateBrain();
      onFiled(receipt);
      toast.success('Conversation kept — it waits for your review before touching your wiki');
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const reset = () => {
    setTitle('');
    setText('');
    setFile(null);
    setCreator('');
    setUrl('');
    setVideoUrl('');
    setPreview(null);
    setOwn(true);
  };

  const pick = async (chosen: File | undefined) => {
    if (!chosen) return;
    const mediaType = normalizeMediaType(chosen);
    try {
      const encoded = await fileToBase64(chosen, mediaType);
      setFile({ name: chosen.name, mediaType, data: encoded.data, preview: encoded.preview });
      if (!title) setTitle(chosen.name.replace(/\.[^.]+$/, ''));
    } catch (error) {
      log.error('contribution_file_read_failed', { error: String(error) });
      toast.error('Could not read that file.');
    }
  };

  const submitText = () => {
    const { kind, origin } = textContribution(own);
    contribute.mutate({ kind, title: title.trim() || 'A note', mediaType: 'text/markdown', data: btoa(unescape(encodeURIComponent(text))), origin, ...(origin === 'external' ? attribution() : {}) });
  };

  const submitFile = () => {
    if (!file) return;
    const { kind, origin } = uploadContribution(file.mediaType, own);
    contribute.mutate({ kind, title: title.trim() || file.name, mediaType: file.mediaType, data: file.data, origin, ...(origin === 'external' ? attribution() : {}) });
  };

  const pendingSessions = (sessions.data ?? []).filter((s) => s.pending > 0);

  return (
    <Panel className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Eyebrow>File something</Eyebrow>
        <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)} items={MODES} />
      </div>

      {mode === 'write' && (
        <div className="space-y-4">
          <div>
            <Label htmlFor="contrib-title">Title</Label>
            <Input id="contrib-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. What I think friction really does" />
          </div>
          <div>
            <Label htmlFor="contrib-text">The words</Label>
            <Textarea id="contrib-text" value={text} onChange={(e) => setText(e.target.value)} rows={7} placeholder="Write your own understanding, or paste text you found — mark which below." className="leading-6" />
          </div>
          <OriginToggle own={own} onChange={setOwn} />
          {!own && <AttributionFields creator={creator} url={url} onCreator={setCreator} onUrl={setUrl} />}
          <div className="flex justify-end">
            <Button variant="primary" disabled={!text.trim()} loading={contribute.isPending} onClick={submitText}>
              <Send /> Keep it
            </Button>
          </div>
        </div>
      )}

      {mode === 'upload' && (
        <div className="space-y-4">
          <button
            type="button"
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
            aria-label="Choose a file to add"
            className={cn(
              'glass relative grid min-h-40 w-full cursor-pointer place-items-center rounded-2xl border-dashed p-4 text-center transition',
              dragging ? 'border-beacon-400/70 bg-beacon-500/10' : 'hover:border-white/20',
            )}
          >
            {file ? (
              file.mediaType.startsWith('image/') ? (
                <img src={file.preview} alt={file.name} className="max-h-44 rounded-lg object-contain" />
              ) : (
                <span className="block text-center">
                  <FileUp className="mx-auto mb-2 size-6 text-beacon-300" />
                  <span className="block text-[14px] font-medium text-night-100">{file.name}</span>
                  <span className="mt-0.5 block text-[12px] text-night-500">{file.mediaType}</span>
                </span>
              )
            ) : (
              <span className="block">
                <FileUp className="mx-auto mb-2 size-6 text-beacon-300" />
                <span className="block text-[14px] font-medium text-night-100">Drop a file, or click to choose</span>
                <span className="mt-1 block text-[12px] text-night-500">PDF · image of notes · audio recording · markdown or text · stays on this device</span>
              </span>
            )}
          </button>
          <input
            ref={input}
            type="file"
            accept={UPLOAD_ACCEPT}
            className="hidden"
            onChange={(e) => void pick(e.target.files?.[0])}
          />
          <div>
            <Label htmlFor="contrib-file-title">Title</Label>
            <Input id="contrib-file-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is this?" />
          </div>
          {file?.mediaType.startsWith('image/') || file?.mediaType.startsWith('audio/') ? (
            <OriginToggle own={own} onChange={setOwn} />
          ) : (
            file && <p className="rounded-xl bg-black/20 px-3 py-2 text-[12px] text-night-400">Documents file as external material — if these are your own words, paste them under “Write”.</p>
          )}
          {file && uploadContribution(file.mediaType, own).origin === 'external' && <AttributionFields creator={creator} url={url} onCreator={setCreator} onUrl={setUrl} />}
          <div className="flex justify-end gap-2">
            {file && (
              <Button variant="ghost" onClick={() => setFile(null)}>
                Clear
              </Button>
            )}
            <Button variant="primary" disabled={!file} loading={contribute.isPending} onClick={submitFile}>
              <Send /> Keep it
            </Button>
          </div>
        </div>
      )}

      {mode === 'link' && (
        <div className="space-y-4">
          <div>
            <Label htmlFor="contrib-video-url">YouTube link</Label>
            <div className="flex gap-2">
              <Input
                id="contrib-video-url"
                value={videoUrl}
                onChange={(e) => {
                  setVideoUrl(e.target.value);
                  setPreview(null);
                }}
                placeholder="https://www.youtube.com/watch?v=…"
                inputMode="url"
              />
              <Button variant="outline" disabled={!videoUrl.trim()} loading={previewLink.isPending} onClick={() => previewLink.mutate(videoUrl.trim())}>
                Look it up
              </Button>
            </div>
            <p className="mt-1.5 text-[12px] text-night-500">Nothing is downloaded until you approve the preview.</p>
          </div>
          {preview && (
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
              {preview.thumbnailUrl && <img src={preview.thumbnailUrl} alt="" className="mb-3 aspect-video w-full rounded-lg border border-white/[0.06] bg-black/30 object-cover" />}
              <div className="text-[14px] font-medium text-night-100">{preview.title}</div>
              <div className="mt-0.5 text-[12px] text-night-500">
                {[preview.uploader, formatSeconds(preview.seconds), 'YouTube'].filter(Boolean).join(' · ')}
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-[12px] leading-5 text-night-400">Keeps the audio track only, transcribed like any recording — the video itself is never stored.</p>
                <Button variant="primary" loading={fetchLink.isPending} onClick={() => fetchLink.mutate(preview.url)}>
                  <Send /> Fetch and transcribe
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {mode === 'conversation' && (
        <div className="space-y-3">
          <p className="text-[13px] leading-6 text-night-400">
            Freezing a conversation keeps its un-reflected turns as a source. The proposal it leads to still waits for your review —
            the turns only count as reflected once you accept it.
          </p>
          {sessions.isLoading && <div className="text-sm text-night-500">Loading conversations…</div>}
          {!sessions.isLoading && pendingSessions.length === 0 && (
            <p className="rounded-xl border border-dashed border-white/[0.1] p-4 text-[13px] text-night-400">No un-reflected conversation turns. Talk with a teacher first — then their reflection comes here for review.</p>
          )}
          {pendingSessions.map((session) => (
            <div key={session.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge tone="beacon">{TEACHERS[session.teacher].name}</Badge>
                  <span className="text-[11.5px] text-night-500">
                    {session.pending} new turn{session.pending === 1 ? '' : 's'} · {timeAgo(session.updatedAt)}
                  </span>
                </div>
                <p className="mt-1 truncate text-[13px] text-night-300">{session.preview || 'Conversation'}</p>
              </div>
              <Button size="sm" variant="outline" loading={freeze.isPending && freeze.variables === session.id} onClick={() => freeze.mutate(session.id)}>
                <MessagesSquare /> Keep for review
              </Button>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
