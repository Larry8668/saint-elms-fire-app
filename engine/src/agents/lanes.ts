export type FriendLane = 'ops' | 'academic' | 'privacy' | 'smalltalk';

const PRIVACY = /\b(phone|mobile|number|email|e-mail|address|whatsapp|instagram|contact details?)\b.*\b(of|for)\b|\b(classmate|friend|student|roommate)'?s?\s+(phone|number|email|address)/i;
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
