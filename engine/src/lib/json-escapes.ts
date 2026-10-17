/**
 * Local models asked for LaTeX inside JSON routinely write single backslashes. `\alpha` or
 * `\(` is an invalid JSON escape and fails the whole parse; `\text`, `\frac`, `\theta` are
 * *valid* escapes (`\t`, `\f`, …) and silently decode to a control character plus garbage.
 */

/**
 * LaTeX commands whose first letter is a JSON escape a model *does* mean in prose (n, r, t).
 * Matched against the whole letter-run, so `\nused` (newline + "used") stays a newline.
 * Only add names that are not plausible words after a newline, tab or carriage return.
 */
const LATEX_COMMANDS = new Set([
  'nabla', 'ne', 'neg', 'neq', 'ngeq', 'ni', 'nleq', 'not', 'notin', 'nsubseteq', 'nu', 'nonumber',
  'rangle', 'rbrace', 'rbrack', 'rceil', 'rfloor', 'rho', 'right', 'rightarrow', 'rm', 'rvert', 'rVert',
  'tan', 'tanh', 'tau', 'tbinom', 'text', 'textbf', 'textit', 'textnormal', 'textrm', 'textsc', 'textsf', 'textstyle',
  'texttt', 'textwidth', 'tfrac', 'therefore', 'theta', 'thinspace', 'tilde', 'times', 'to', 'top', 'triangle',
  'triangleq',
]);

/**
 * Backspace and form feed never belong in model prose, so `\b` or `\f` before a letter is
 * always LaTeX (`\beta`, `\bigl`, `\boldsymbol`, `\frac`, `\fbox`, …), listed or not.
 */
const ALWAYS_LATEX = /^[bf][a-zA-Z]/;

const ESCAPE = /\\(u[0-9a-fA-F]{4}|["\\/]|[bfnrt][a-zA-Z]*|[\s\S])/g;

/**
 * Doubles backslashes that cannot be JSON escapes, `\b`/`\f` before a letter, and `\n`/`\r`/`\t`
 * when they open a known LaTeX command. Everything already valid and ordinary (`\n`, `\"`, `\\`, `\u00e9`) is untouched.
 * In valid JSON a backslash only appears inside strings (and Ollama's `format` grammar keeps
 * it there), so the repair cannot touch structure.
 */
export function repairJsonEscapes(raw: string): { text: string; repaired: number } {
  let repaired = 0;
  const text = raw.replace(ESCAPE, (match: string, body: string) => {
    if (body.length === 5 && body[0] === 'u') return match;
    if (body === '"' || body === '\\' || body === '/') return match;
    if (/^[bfnrt]/.test(body) && !ALWAYS_LATEX.test(body) && !LATEX_COMMANDS.has(body)) return match;
    repaired += 1;
    return `\\${match}`;
  });
  return { text, repaired };
}
