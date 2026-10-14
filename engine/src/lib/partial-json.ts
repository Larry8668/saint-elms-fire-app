/**
 * Recovers the longest valid prefix of truncated JSON by cutting back to the last
 * complete value and closing any open brackets. Returns null if nothing parses.
 */
export function parsePartialJson(text: string, maxAttempts = 600): unknown | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to repair
  }
  let attempts = 0;
  for (let i = trimmed.length - 1; i > 0 && attempts < maxAttempts; i -= 1) {
    const ch = trimmed[i];
    if (ch !== '}' && ch !== ']' && ch !== '"' && !/[0-9el]/.test(ch)) continue;
    attempts += 1;
    const candidate = trimmed.slice(0, i + 1);
    const closers = closingFor(candidate);
    if (closers === null) continue;
    try {
      return JSON.parse(candidate.replace(/,\s*$/, '') + closers);
    } catch {
      // keep cutting back
    }
  }
  return null;
}

/** Brackets needed to close `prefix`, or null if it ends inside a string. */
function closingFor(prefix: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of prefix) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  return inString ? null : stack.reverse().join('');
}
