import { countChars, sliceChars } from '../brain/sources/limits';

/** The longest query that may leave this device, anchor topic included. */
export const MAX_WEB_QUERY_CHARS = 200;

/**
 * What a model offers as a web query is data, not instructions: control characters and
 * newlines collapse to single spaces and the result is bounded before it reaches the network.
 */
export function sanitizeWebQuery(raw: string, maxChars = MAX_WEB_QUERY_CHARS): string {
  const oneLine = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return sliceChars(oneLine, maxChars);
}

/**
 * The outgoing query: the consented anchor topic always leads, the model's own words follow
 * in the room that remains. An offer that normalizes to nothing degrades to the topic-only
 * query — the same text the consent preview showed.
 */
export function anchorWebQuery(topic: string | undefined, modelQuery: string, maxChars = MAX_WEB_QUERY_CHARS): string {
  const anchor = sanitizeWebQuery(topic ?? '', maxChars);
  const offered = sanitizeWebQuery(modelQuery, maxChars);
  if (!anchor) return offered;
  if (!offered) return anchor;
  const separator = ' — ';
  const room = sliceChars(offered, Math.max(0, maxChars - countChars(anchor) - countChars(separator))).trimEnd();
  return room ? `${anchor}${separator}${room}` : anchor;
}
