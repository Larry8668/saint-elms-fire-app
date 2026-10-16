import { useMutation } from '@tanstack/react-query';
import { Download, LogOut, PackageCheck, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/primitives';
import { log } from '@/lib/log';
import { portalUrl } from '@/lib/uni-url';
import { downloadVaultExport, exportNotice } from '@/lib/vault-export';
import { limitedAccessCopy, type LimitedReason } from './limited-access';

/**
 * What a limited (read/export-only) session sees instead of the dashboard: why the
 * session is limited, a working vault export, and the ways out. There is deliberately
 * no read-only dashboard — the engine enforces the mode on every route, so a browsing
 * shell would only promise clicks that 403. The student's own pages leave with them
 * through the export, and full access returns at the next full sign-in.
 */
export function LimitedAccessView({ reason, onSignOut }: { reason: LimitedReason | undefined; onSignOut: () => void }) {
  const copy = limitedAccessCopy(reason);
  const [notice, setNotice] = useState<string | null>(null);
  const exporter = useMutation({
    mutationFn: downloadVaultExport,
    onSuccess: (exported) => setNotice(exportNotice(exported)),
    onError: (error) => log.warn('vault_export_failed', { error: String(error) }),
  });

  return (
    <div className="sky-backdrop relative grid min-h-screen place-items-center overflow-y-auto px-6 py-12">
      <section className="glass-strong animate-rise w-full max-w-md rounded-3xl p-7 text-center">
        <EmptyState
          icon={<ShieldAlert />}
          title={copy.title}
          body={copy.body}
          action={
            <div className="flex flex-col items-center gap-3">
              <Button
                variant="secondary"
                loading={exporter.isPending}
                onClick={() => {
                  setNotice(null);
                  exporter.mutate();
                }}
              >
                <Download /> Export my vault
              </Button>
              {notice && (
                <p className="flex items-center justify-center gap-2 text-[12.5px] text-aurora-300">
                  <PackageCheck className="size-3.5 shrink-0" /> {notice}
                </p>
              )}
              {exporter.error && (
                <p className="text-[12.5px] text-rose-400">{exporter.error instanceof Error ? exporter.error.message : 'The export failed'}</p>
              )}
              {copy.restore && <p className="text-[12.5px] text-night-400">{copy.restore}</p>}
              <a href={portalUrl()} target="_blank" rel="noreferrer noopener" className="text-[13px] text-beacon-300 underline underline-offset-4">
                Open the university portal
              </a>
            </div>
          }
        />
        <Button variant="ghost" onClick={onSignOut} className="mt-6">
          <LogOut className="size-4" /> Sign out
        </Button>
      </section>
    </div>
  );
}
