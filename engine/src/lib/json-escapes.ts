/**
 * Local models asked for LaTeX inside JSON routinely write single backslashes. `\alpha` or
 * `\(` is an invalid JSON escape and fails the whole parse; `\text`, `\frac`, `\theta` are
 * *valid* escapes (`\t`, `\f`, …) and silently decode to a control character plus garbage.
 */

/** LaTeX commands whose first letter is also a JSON escape letter (b, f, n, r, t). */
const LATEX_COMMANDS = new Set([
  'bar', 'beta', 'begin', 'bf', 'big', 'bigg', 'binom', 'bmod', 'bot', 'boxed', 'bullet',
  'frac', 'forall', 'flat',
  'nabla', 'ne', 'neg', 'neq', 'ni', 'not', 'notin', 'nu', 'nonumber',
  'rangle', 'rceil', 'rfloor', 'rho', 'right', 'rightarrow', 'rm',
  'tan', 'tanh', 'tau', 'text', 'textbf', 'textit', 'textrm', 'tfrac', 'theta', 'tilde', 'times', 'to', 'top', 'triangle',
]);

const ESCAPE = /\\(u[0-9a-fA-F]{4}|["\\/]|[bfnrt][a-zA-Z]*|[\s\S])/g;

/**
 * Doubles backslashes that cannot be JSON escapes, and those that open a known LaTeX
 * command. Everything already valid and ordinary (`\n`, `\"`, `\\`, `\u00e9`) is untouched.
 * Backslashes are only legal inside JSON strings, so the repair cannot touch structure.
 */
export function repairJsonEscapes(raw: string): { text: string; repaired: number } {
  let repaired = 0;
  const text = raw.replace(ESCAPE, (match: string, body: string) => {
    if (body.length === 5 && body[0] === 'u') return match;
    if (body === '"' || body === '\\' || body === '/') return match;
    if (/^[bfnrt]/.test(body) && !LATEX_COMMANDS.has(body)) return match;
    repaired += 1;
    return `\\${match}`;
  });
  return { text, repaired };
}
