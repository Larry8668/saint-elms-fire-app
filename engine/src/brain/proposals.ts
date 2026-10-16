import { readdir } from 'node:fs/promises';
import { CONTRACT_VERSION, WikiProposalRecordSchema, type WikiProposal, type WikiProposalRecord } from '@sef/shared';
import { readJson, writeJson } from '../lib/fs';
import { META_DIRECTORY, META_PROPOSALS_DIRECTORY, assertRecordId, vaultPath } from './vault-layout';

/**
 * One record per proposal under .meta/proposals/. The proposal inside is immutable once
 * written; only the review fields (state, decidedAt, decidedBy, note) ever change, and a
 * decided proposal never goes back to pending.
 */
export function proposalPath(root: string, id: string): string {
  return vaultPath(root, META_DIRECTORY, META_PROPOSALS_DIRECTORY, `${assertRecordId(id, 'Proposal id')}.json`);
}

export async function writeProposalRecord(root: string, record: WikiProposalRecord): Promise<void> {
  await writeJson(proposalPath(root, record.proposal.id), WikiProposalRecordSchema.parse(record));
}

export function pendingProposalRecord(proposal: WikiProposal, jobId: string): WikiProposalRecord {
  return WikiProposalRecordSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    proposal,
    jobId,
    state: 'pending',
    decidedAt: null,
    decidedBy: null,
  });
}

export async function readProposalRecord(root: string, id: string): Promise<WikiProposalRecord | null> {
  const raw = await readJson<unknown>(proposalPath(root, id), null);
  const record = WikiProposalRecordSchema.safeParse(raw);
  return record.success ? record.data : null;
}

export async function decideProposal(
  root: string,
  record: WikiProposalRecord,
  state: 'accepted' | 'rejected',
  decidedBy: 'student' | 'system',
  note?: string,
): Promise<WikiProposalRecord> {
  const next = WikiProposalRecordSchema.parse({
    ...record,
    state,
    decidedAt: new Date().toISOString(),
    decidedBy,
    ...(note ? { note } : {}),
  });
  await writeJson(proposalPath(root, record.proposal.id), next);
  return next;
}

/** Pending first (oldest queued first), then decided records newest-decided first. */
export async function listProposalRecords(root: string): Promise<WikiProposalRecord[]> {
  const records: WikiProposalRecord[] = [];
  const entries = await readdir(vaultPath(root, META_DIRECTORY, META_PROPOSALS_DIRECTORY), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const record = await readProposalRecord(root, entry.name.slice(0, -5));
    if (record) records.push(record);
  }
  return records.sort((a, b) => {
    if (a.state === 'pending' && b.state !== 'pending') return -1;
    if (a.state !== 'pending' && b.state === 'pending') return 1;
    const aAt = a.decidedAt ?? a.proposal.createdAt;
    const bAt = b.decidedAt ?? b.proposal.createdAt;
    return a.state === 'pending' ? aAt.localeCompare(bAt) : bAt.localeCompare(aAt);
  });
}
