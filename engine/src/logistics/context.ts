import { formatDue, type LogisticsRecord } from '@sef/shared';
import type { TurnContext } from '../agents/context';
import type { LogisticsReader } from './store';

/** One record rendered for the prompt — and exactly what the evidence check measures against. */
export function recordLine(record: LogisticsRecord): string {
  const detail = record.details ? ` — ${record.details}` : '';
  return `- ${record.title} (${record.kind}, id: ${record.id}): ${formatDue(record)}${detail}`;
}

/**
 * The Friend's view of the student's own logistics, gated behind the declared
 * `context:logistics` capability. Confirmed records become citable evidence; proposed
 * ones are named in a shielded block — the model may say they exist and are awaiting
 * confirmation, and the evidence check keeps it from ever asserting their contents.
 */
export async function logisticsContext(store: LogisticsReader, ctx: TurnContext): Promise<void> {
  const [confirmed, proposed] = await Promise.all([store.confirmed(), store.proposed()]);
  ctx.recordTool('logistics', `${confirmed.length} confirmed, ${proposed.length} awaiting confirmation`);
  if (!confirmed.length && !proposed.length) {
    ctx.contextBlocks.push('YOUR LOGISTICS: nothing recorded yet — if asked about personal deadlines, say none are recorded rather than guessing.');
    return;
  }
  if (confirmed.length) {
    ctx.contextBlocks.push(`YOUR LOGISTICS — confirmed by the student, cite as [logistics: <id>]:\n${confirmed.map(recordLine).join('\n')}`);
    for (const record of confirmed) ctx.addSource({ kind: 'logistics', id: record.id, title: record.title }, recordLine(record));
  }
  if (proposed.length) {
    ctx.proposedLogistics = proposed.map((record) => ({ id: record.id, title: record.title, text: recordLine(record) }));
    ctx.shieldedBlocks.push(
      `UNCONFIRMED LOGISTICS — awaiting the student’s confirmation. You may name one as [withheld: <id>] and say it awaits confirmation; never state its contents as fact:\n${proposed.map(recordLine).join('\n')}`,
    );
  }
}
