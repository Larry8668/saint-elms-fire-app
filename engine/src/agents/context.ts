import type { ChatStreamEvent, SourceRef, TeacherId } from '@sef/shared';

/** Per-request state shared by the harness and the tools it hands to an agent. */
export class TurnContext {
  readonly sources = new Map<string, SourceRef>();
  readonly toolCalls: Array<{ tool: string; summary: string }> = [];
  readonly lessonIds = new Set<string>();
  handoff?: { to: TeacherId; reason: string };

  constructor(private readonly emit: (event: ChatStreamEvent) => void) {}

  addSource(source: SourceRef) {
    this.sources.set(`${source.kind}:${source.id}`, source);
    if (source.kind === 'lesson') this.lessonIds.add(source.id);
  }

  recordTool(tool: string, summary: string) {
    this.toolCalls.push({ tool, summary });
    this.emit({ type: 'tool', tool, summary });
  }

  status(message: string) {
    this.emit({ type: 'status', message });
  }
}
