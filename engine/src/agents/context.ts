import type { CapabilityId, ChatStreamEvent, SourceRef, TeacherId } from '@sef/shared';
import type { ClaimVerdict } from '../brain/claim-evidence';

/** Per-request state shared by the harness and the tools it hands to an agent. */
export class TurnContext {
  readonly sources = new Map<string, SourceRef>();
  readonly toolCalls: Array<{ tool: string; summary: string }> = [];
  readonly lessonIds = new Set<string>();
  /**
   * The text each source actually showed this turn, keyed `${kind}:${id}`. Evidence checks
   * measure support against it; it is never serialised into the session or the response.
   */
  readonly evidenceText = new Map<string, string>();
  /**
   * Blocks the model saw (student brain, wiki claims). They may support a statement but can
   * never be cited — they are context, not sources.
   */
  readonly contextBlocks: string[] = [];
  /**
   * Blocks the model saw but may never assert: the WIKI CLAIMS block carries withheld claims'
   * text, so letting it support a statement would launder withheld provenance into a fact.
   * The claims it names exist as their own claim-kind evidence items, citable as [withheld: id].
   */
  readonly shieldedBlocks: string[] = [];
  /** Wiki-claim verdicts the prompt showed: assertable claims may be cited, withheld ones only named. */
  claimVerdicts: ClaimVerdict[] = [];
  /**
   * Unconfirmed logistics records the prompt named. They enter the evidence set as
   * withheld items — the Friend may name one but never assert its contents as fact.
   */
  proposedLogistics: Array<{ id: string; title: string; text: string }> = [];
  /** Capabilities this teacher asked for and was refused, in order. Surfaced on the verification panel. */
  readonly denied: CapabilityId[] = [];
  handoff?: { to: TeacherId; reason: string };

  constructor(private readonly emit: (event: ChatStreamEvent) => void) {}

  addSource(source: SourceRef, evidenceText?: string) {
    const key = `${source.kind}:${source.id}`;
    this.sources.set(key, source);
    if (evidenceText) this.evidenceText.set(key, evidenceText);
    if (source.kind === 'lesson') this.lessonIds.add(source.id);
  }

  recordRefusal(capability: CapabilityId) {
    if (!this.denied.includes(capability)) this.denied.push(capability);
  }

  recordTool(tool: string, summary: string) {
    this.toolCalls.push({ tool, summary });
    this.emit({ type: 'tool', tool, summary });
  }

  status(message: string) {
    this.emit({ type: 'status', message });
  }
}
