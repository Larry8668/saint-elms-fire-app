import { CONTRACT_VERSION, type VaultExport, type VaultImportConflict, type VaultImportPreview, type VaultImportResult } from '@sef/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, FileUp, PackageCheck, ShieldAlert, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, Eyebrow, Panel } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { log } from '@/lib/log';
import { useStudent } from '@/lib/session';
import { downloadVaultExport, exportNotice, formatBytes } from '@/lib/vault-export';

/**
 * Portable ownership: export the whole vault as one checksummed file, and restore one here —
 * always preview first, conflicts chosen page by page. Works offline; an expired enrolment
 * cannot hold the student's own files hostage.
 */
export function VaultPanel() {
  const { profile } = useStudent();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [archive, setArchive] = useState<VaultExport | null>(null);
  const [preview, setPreview] = useState<VaultImportPreview | null>(null);
  const [result, setResult] = useState<VaultImportResult | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const exporter = useMutation({
    mutationFn: downloadVaultExport,
    onSuccess: (exported) => setNotice(exportNotice(exported)),
    onError: (error) => log.warn('vault_export_failed', { error: String(error) }),
  });

  const previewer = useMutation({
    mutationFn: (candidate: unknown) => api.previewVaultImport(candidate),
    onSuccess: (next) => {
      setPreview(next);
      setChosen(new Set());
      setResult(null);
    },
  });

  const restorer = useMutation({
    mutationFn: ({ candidate, overwrite }: { candidate: VaultExport; overwrite: string[] }) => api.restoreVault(candidate, overwrite),
    onSuccess: (done) => {
      setResult(done);
      setPreview(null);
      setArchive(null);
      queryClient.invalidateQueries();
      log.info('vault_imported', { pages: done.applied.pages, sources: done.applied.sources });
    },
  });

  const pickFile = async (file: File) => {
    setNotice(null);
    setResult(null);
    setPreview(null);
    let candidate: unknown;
    try {
      candidate = JSON.parse(await file.text());
    } catch {
      setPreview({ schemaVersion: CONTRACT_VERSION, state: 'refused', code: 'malformed', reason: 'That file is not JSON — pick a vault export.', conflicts: [], warnings: [] });
      return;
    }
    if (typeof candidate === 'object' && candidate !== null) setArchive(candidate as VaultExport);
    previewer.mutate(candidate);
  };

  const toggleConflict = (conflict: VaultImportConflict, on: boolean) => {
    if (!conflict.id) return;
    const next = new Set(chosen);
    if (on) next.add(conflict.id);
    else next.delete(conflict.id);
    setChosen(next);
  };

  const busy = exporter.isPending || previewer.isPending || restorer.isPending;
  const error = exporter.error ?? previewer.error ?? restorer.error;

  return (
    <Panel className="p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Eyebrow>Your vault, yours to carry</Eyebrow>
          <p className="mt-1 text-[13px] leading-5 text-night-400">
            Everything in your second brain — pages, history, sources and your growth trail — exports to one checksummed file. Restoring always
            previews first and never overwrites a page you haven't chosen. Works entirely offline.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="secondary" loading={exporter.isPending} onClick={() => exporter.mutate()}>
          <Download /> Export my vault
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => fileInput.current?.click()}>
          <FileUp /> Restore from an export…
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void pickFile(file);
          }}
        />
      </div>

      {notice && (
        <p className="mt-3 flex items-center gap-2 text-[12.5px] text-aurora-300">
          <PackageCheck className="size-3.5" /> {notice}
        </p>
      )}
      {error && <p className="mt-3 text-[12.5px] text-rose-400">{error instanceof Error ? error.message : 'Something failed'}</p>}

      {preview && (
        <div className="mt-4 rounded-xl border border-white/[0.09] bg-black/25 p-4">
          {preview.state === 'refused' ? (
            <div className="flex items-start gap-2 text-[13px] text-rose-300">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" />
              <div>
                <div className="font-medium">This file can't be restored.</div>
                <div className="mt-0.5 text-night-400">{preview.reason}</div>
              </div>
            </div>
          ) : (
            <>
              <div className="text-[13px] text-night-300">
                Exported by <span className="text-night-100">{preview.archive?.exportedBy.studentId}</span> on{' '}
                {preview.archive ? new Date(preview.archive.createdAt).toLocaleString() : '—'} · {preview.archive?.counts.files} files (
                {formatBytes(preview.archive?.counts.bytes ?? 0)}) into <span className="text-night-100">{profile.name}</span>'s vault (
                {preview.destination?.pages} pages, {preview.destination?.sources} sources already here).
              </div>
              {preview.plan && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge tone="beacon">{preview.plan.writeFiles} files to write</Badge>
                  {preview.plan.createPages.length > 0 && <Badge tone="aurora">{preview.plan.createPages.length} new pages</Badge>}
                  {preview.plan.sources.create.length > 0 && <Badge tone="aurora">{preview.plan.sources.create.length} new sources</Badge>}
                  {preview.plan.unchanged > 0 && <Badge>{preview.plan.unchanged} already identical</Badge>}
                </div>
              )}
              {preview.warnings.map((warning) => (
                <p key={warning} className="mt-2 text-[12.5px] text-ember-300">
                  {warning}
                </p>
              ))}
              {preview.conflicts.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  <div className="text-[12px] font-medium uppercase tracking-wide text-night-400">
                    {preview.conflicts.length} conflict{preview.conflicts.length === 1 ? '' : 's'}
                  </div>
                  {preview.conflicts.map((conflict) => (
                    <label key={`${conflict.area}:${conflict.path}`} className="flex items-start gap-2.5 rounded-lg bg-white/[0.04] px-3 py-2 text-[12.5px] text-night-300">
                      {conflict.resolvable ? (
                        <input type="checkbox" className="mt-0.5" checked={conflict.id ? chosen.has(conflict.id) : false} onChange={(e) => toggleConflict(conflict, e.target.checked)} />
                      ) : (
                        <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-ember-300" />
                      )}
                      <span>
                        <span className="font-mono text-night-100">{conflict.id ?? conflict.path}</span> — {describeConflict(conflict)}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <div className="mt-4 flex items-center gap-3">
                <Button
                  variant="primary"
                  size="sm"
                  loading={restorer.isPending}
                  disabled={!archive}
                  onClick={() => archive && restorer.mutate({ candidate: archive, overwrite: [...chosen] })}
                >
                  <Upload /> Restore{chosen.size ? `, overwriting ${chosen.size} page${chosen.size === 1 ? '' : 's'}` : ''}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => (setPreview(null), setArchive(null), setChosen(new Set()))}>
                  Cancel
                </Button>
              </div>
              <p className="mt-2 text-[11.5px] text-night-500">Pages in conflict are left alone unless you tick them. Everything else merges in.</p>
            </>
          )}
        </div>
      )}

      {result && (
        <div className="mt-4 rounded-xl border border-aurora-400/20 bg-aurora-400/5 p-4 text-[13px] text-night-300">
          <span className="font-medium text-aurora-300">Restore complete.</span> {result.applied.pages} pages, {result.applied.sources} sources,{' '}
          {result.applied.events} growth entries, {result.applied.history} history snapshots restored.
          {result.conflicts.length > 0 && <span className="text-ember-300"> {result.conflicts.length} conflicted file{result.conflicts.length === 1 ? '' : 's'} left alone.</span>}
        </div>
      )}
    </Panel>
  );
}

function describeConflict(conflict: VaultImportConflict): string {
  switch (conflict.reason) {
    case 'moved':
      return 'this page lives under a different name here — overwriting replaces it there';
    case 'different_revision':
      return conflict.resolvable ? 'a different version exists here — overwriting keeps yours in history' : 'a different record already holds this id';
    case 'different_bytes':
      return 'different bytes already hold that name — left untouched';
    case 'newer_schema':
      return 'written by a newer version — left untouched';
    case 'malformed':
      return 'cannot be read safely — left untouched';
    case 'missing_bytes':
      return 'the archive declares bytes that are not there — left untouched';
    default:
      return 'conflict — left untouched';
  }
}
