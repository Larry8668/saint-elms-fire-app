import type { ChatAttachment } from '@sef/shared';

export type FriendLane = 'ops' | 'academic' | 'privacy' | 'smalltalk';

/** Unambiguously a way to reach a person. */
const CONTACT = 'phone|mobile|email|e-mail|address|whatsapp|instagram|contact details?';
/** "number" is only a contact term next to a person; on its own it is a quantity. */
const AMBIGUOUS_CONTACT = 'number';
const PERSON = 'classmate|friend|student|roommate|colleague|flatmate|partner|class list|cohort|group';

/**
 * Three shapes of the same request, rather than one loose "contact word somewhere before
 * of/for". The old catch-all matched "a number of students" and refused a student for
 * talking about cohort statistics, which is the failure mode a blunt pattern always has.
 *
 * Bare "number" is deliberately held back from the second shape: "the number of pages"
 * and "a number of students" are not requests for anyone's contact details.
 *
 * The apostrophe class spans ASCII, typographic and backtick forms: mobile keyboards
 * autocorrect a typed "roommate's" into "roommate’s", and that must not slip past.
 */
const PRIVACY = new RegExp(
  [
    // "my roommate's number", "my classmate’s email address"
    `\\b(?:${PERSON})\\b\\s*(?:['’\`]s|of\\s+(?:my|our|his|her|their|the)\\s*)?\\s*\\b(?:${CONTACT}|${AMBIGUOUS_CONTACT})\\b`,
    // "the phone number for my classmate", "the email address for the class list"
    `\\b(?:${CONTACT}|${AMBIGUOUS_CONTACT})\\b\\s+(?:of|for)\\s+(?:my|our|his|her|their|the)\\s+\\b(?:${PERSON})\\b`,
    // "what's the phone number", "give me their email"
    `\\b(?:what'?s|what is|who'?s|who is|give me|send me|share|tell me)\\b[^?]{0,40}\\b(?:${CONTACT}|${AMBIGUOUS_CONTACT})\\b`,
  ].join('|'),
  'i',
);
const ACADEMIC =
  /\b(explain|derive|derivation|prove|proof|equation|formula|integral|derivative|theorem|lemma|velocity|momentum|energy|force|oscillat|wave|quantum|matrix|vector|calculus|limit|function|graph of|solve|homework|assignment problem|concept of)\b/i;
const OPS =
  /\b(fee|fees|deadline|calendar|timetable|exam schedule|hostel|library|office|registrar|attendance|scholarship|admission|registration|holiday|leave|id card|canteen|transport|wifi|portal|grievance|counsel)/i;
const SMALLTALK = /^\s*(hi|hello|hey|thanks|thank you|good (morning|evening|afternoon)|yo|sup)\b[\s!.?]*$/i;

/**
 * Runs before any model call so the Friend's boundaries hold even on a weak model:
 * classmates' contact details are refused, academic questions go to the Guide.
 */
export function classifyFriendLane(message: string): FriendLane {
  if (SMALLTALK.test(message)) return 'smalltalk';
  if (PRIVACY.test(message)) return 'privacy';
  if (OPS.test(message)) return 'ops';
  if (ACADEMIC.test(message)) return 'academic';
  return 'ops';
}

export const PRIVACY_REFUSAL =
  "I can't share another student's personal details — that stays with them. If you need to reach someone, the student support office can pass a message on.";

export const ACADEMIC_REDIRECT =
  "That's a question for your studies, and the Guide is the right companion for it — they teach from your released lessons. Want me to hand you over?";

export interface FriendInput {
  /** What the student typed. */
  text: string;
  /** Text already derived from an attached image (filename, alt text). Never model output. */
  attachmentText?: string;
}

/**
 * The same classification for images as for text. Privacy anywhere wins, then an academic
 * question in either half routes to the Guide, so smuggling a request through an image or an
 * alt-text field lands on the same lane as typing it.
 */
export function classifyFriendInput({ text, attachmentText = '' }: FriendInput): FriendLane {
  const parts = [text, attachmentText].map((p) => p.trim()).filter(Boolean);
  const lanes = parts.map((part) => classifyFriendLane(part));
  if (lanes.includes('privacy')) return 'privacy';
  if (lanes.includes('academic')) return 'academic';
  return lanes[0] ?? 'ops';
}

/**
 * What a model reported reading out of an image is untrusted input, not a clean answer: an
 * image can carry a contact list the typed message never showed. Re-classified the same way.
 */
export function extractedTextLane(text: string): FriendLane {
  return classifyFriendLane(text);
}

/**
 * The text already standing next to an attachment, derived without touching the bytes: what the
 * client labelled it with. It reaches the lane check before the image does, and it is never
 * treated as a capability grant.
 */
export function declaredAttachmentText(attachments: ChatAttachment[] = []): string {
  return attachments
    .map((a) => [a.name, a.altText].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n');
}
