import type { ChatAttachment, ChatTurn } from '@sef/shared';

type TextPart = { type: 'text'; text: string };
type ImagePart = { type: 'image'; image: string; mediaType: string };
export type ModelMessage = { role: 'user' | 'assistant' | 'system'; content: string | Array<TextPart | ImagePart> };

export const MAX_HISTORY_TURNS = 10;

export function imageParts(attachments: ChatAttachment[] = []): ImagePart[] {
  return attachments.filter((a) => a.kind === 'image').map((a) => ({ type: 'image', image: a.data, mediaType: a.mimeType }));
}

/** Recent history as model messages; images only on the latest user turn to keep context small. */
export function toModelMessages(turns: ChatTurn[], latestUserText: string): ModelMessage[] {
  const recent = turns.slice(-MAX_HISTORY_TURNS);
  return recent.map((turn, index) => {
    const isLatest = index === recent.length - 1 && turn.role === 'user';
    if (!isLatest) return { role: turn.role, content: turn.content };
    const images = imageParts(turn.attachments);
    return images.length
      ? { role: 'user', content: [{ type: 'text', text: latestUserText }, ...images] }
      : { role: 'user', content: latestUserText };
  });
}
