import type { PeerFeedItem } from '@sef/shared';
import { Ban, Download, Eye, EyeOff, Paperclip, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Badge, Panel } from '@/components/ui/primitives';
import { timeAgo } from '@/lib/time';

const formatBytes = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

/**
 * One cohort feed item. The preview shows the payload exactly as the network carried it;
 * "Import" freezes it as a peer source — the brain itself only changes when the student
 * accepts the proposal it produces.
 */
export function ShareCard({
  item,
  onImport,
  onWithdraw,
  onIgnore,
  importing,
  withdrawing,
}: {
  item: PeerFeedItem;
  onImport: () => void;
  onWithdraw: () => void;
  onIgnore: (ignored: boolean) => void;
  importing: boolean;
  withdrawing: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Panel className="flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-medium text-night-100">{item.payload.title}</h3>
          <div className="mt-0.5 text-[12px] text-night-500">
            {item.mine ? 'You' : item.senderName} · {timeAgo(item.createdAt)} · rev {item.revision}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {item.mine && <Badge tone="beacon">Yours</Badge>}
          {item.state !== 'published' && <Badge tone="ember">{item.state}</Badge>}
          {item.import && <Badge tone="aurora">Imported</Badge>}
          {item.ignored && <Badge tone="neutral">Hidden</Badge>}
        </div>
      </div>

      <div className={open ? 'mt-3' : 'mt-3 line-clamp-6'}>
        <Markdown variant="chat" className="text-night-300">
          {item.payload.markdown}
        </Markdown>
      </div>

      {item.payload.attachments.length > 0 && (
        <div className="mt-3 space-y-1">
          {item.payload.attachments.map((a) => (
            <div key={a.id} className="flex items-center gap-2 text-[12px] text-night-500" title={`sha256 ${a.sha256}`}>
              <Paperclip className="size-3" /> {a.name} · {a.mediaType} · {formatBytes(a.bytes)} · descriptor only
            </div>
          ))}
        </div>
      )}
      {item.payload.citations.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.payload.citations.map((citation, i) => (
            <Badge key={i} tone="neutral" className="max-w-64 truncate" title={citation.url ?? citation.locator ?? citation.title}>
              {citation.title}
            </Badge>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-white/[0.06] pt-3">
        <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
          {open ? <EyeOff /> : <Eye />} {open ? 'Collapse' : 'Preview'}
        </Button>
        {!item.mine && (
          <Button variant="ghost" size="sm" onClick={() => onIgnore(!item.ignored)}>
            <Ban /> {item.ignored ? 'Unhide' : 'Ignore'}
          </Button>
        )}
        {item.mine ? (
          item.state === 'published' && (
            <ConfirmButton variant="danger" size="sm" confirmLabel="Withdraw?" loading={withdrawing} onConfirm={onWithdraw}>
              <Undo2 /> Withdraw
            </ConfirmButton>
          )
        ) : (
          <Button
            variant="primary"
            size="sm"
            loading={importing}
            disabled={Boolean(item.import) || item.state !== 'published'}
            title={item.import ? 'This share is already in your brain pipeline' : undefined}
            onClick={onImport}
          >
            <Download /> {item.import ? 'Imported' : 'Import'}
          </Button>
        )}
      </div>
    </Panel>
  );
}
