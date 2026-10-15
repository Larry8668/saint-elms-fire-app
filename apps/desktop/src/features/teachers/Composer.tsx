import { TEACHERS, type TeacherId } from '@sef/shared';
import { ArrowUp, ImagePlus, Square, Wifi, X } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/overlays';
import { fileToBase64 } from '@/lib/api';
import { cn } from '@/lib/cn';
import { log } from '@/lib/log';
import type { ChatMessage } from './chat-store';
import { TEACHER_LOOK } from './teacher-meta';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXTAREA_PX = 200;
/** The turn contract only carries png/jpeg, so anything else is refused at the boundary. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);

export type Attachments = NonNullable<ChatMessage['attachments']>;

export interface ComposerHandle {
  focus: () => void;
}

interface ComposerProps {
  teacher: TeacherId;
  draft: string;
  onDraftChange: (text: string) => void;
  attachments: Attachments;
  onAttachmentsChange: (a: Attachments) => void;
  busy: boolean;
  onSubmit: () => void;
  onStop: () => void;
}

/** Prompt bar: auto-growing input, image attach/paste, send ↔ stop. */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer({ teacher, draft, onDraftChange, attachments, onAttachmentsChange, busy, onSubmit, onStop }, ref) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const look = TEACHER_LOOK[teacher];
  const profile = TEACHERS[teacher];
  const canSend = Boolean(draft.trim() || attachments.length);

  useImperativeHandle(ref, () => ({ focus: () => textarea.current?.focus() }), []);

  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, [draft]);

  const attach = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!IMAGE_TYPES.has(file.type)) return toast.error('Only PNG and JPEG images can be attached.');
    if (file.size > MAX_IMAGE_BYTES) return toast.error('That image is over 8 MB.');
    try {
      const encoded = await fileToBase64(file);
      onAttachmentsChange([{ kind: 'image', mimeType: encoded.mimeType, data: encoded.data, preview: encoded.preview, name: file.name }]);
    } catch (error) {
      log.error('attach_failed', { error: String(error) });
      toast.error('Could not read that image.');
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className={cn('glass rounded-2xl transition focus-within:border-white/[0.14]', look.ring.replace('border-', 'focus-within:border-'))}>
        {attachments.length > 0 && (
          <div className="flex gap-2 px-3 pt-3">
            {attachments.map((a) => (
              <div key={a.name} className="group relative">
                <img src={a.preview} alt={a.name} className="size-16 rounded-xl border border-white/10 object-cover" />
                <button
                  onClick={() => onAttachmentsChange([])}
                  className="absolute -top-1.5 -right-1.5 grid size-5 cursor-pointer place-items-center rounded-full border border-white/10 bg-night-800 text-night-200 hover:bg-night-700"
                  aria-label="Remove image"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textarea}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!busy && canSend) onSubmit();
            }
          }}
          onPaste={(e) => {
            const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
            // Paste surfaces whatever the clipboard holds; the type check in attach() still gates it.
            if (!file) return;
            e.preventDefault();
            const list = new DataTransfer();
            list.items.add(file);
            void attach(list.files);
          }}
          rows={1}
          placeholder={`Ask ${profile.voice}…`}
          className="block max-h-[200px] min-h-12 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14.5px] leading-6 text-night-100 placeholder:text-night-500 focus:outline-none"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <Tooltip content="Attach a photo — a diagram, a textbook page, your handwritten working">
            <Button variant="ghost" size="icon" className="size-8" onClick={() => fileInput.current?.click()} aria-label="Attach image">
              <ImagePlus />
            </Button>
          </Tooltip>
          <input ref={fileInput} type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => { void attach(e.target.files); e.target.value = ''; }} />
          <span className={cn('ml-1 inline-flex items-center gap-1.5 rounded-full border border-white/[0.07] px-2 py-0.5 text-[11px] text-night-400')}>
            <look.Icon className={cn('size-3', look.accent)} /> {profile.name}
          </span>
          {profile.needsNetwork && (
            <span className="inline-flex items-center gap-1 text-[11px] text-night-500">
              <Wifi className="size-3" /> web
            </span>
          )}
          <span className="ml-auto hidden pr-2 text-[11px] text-night-600 sm:inline">
            <kbd className="font-sans">↵</kbd> send · <kbd className="font-sans">⇧↵</kbd> new line
          </span>
          {busy ? (
            <Button size="icon" variant="secondary" className="size-8" onClick={onStop} aria-label="Stop">
              <Square className="fill-current !size-3" />
            </Button>
          ) : (
            <Button size="icon" variant="primary" className="size-8" onClick={onSubmit} disabled={!canSend} aria-label="Send">
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
      <p className="mt-2 px-1 text-[11px] text-night-500">{profile.scope}</p>
    </div>
  );
});
