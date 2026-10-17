import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repairJsonEscapes } from './json-escapes';

const parse = (raw: string) => JSON.parse(repairJsonEscapes(raw).text) as Record<string, string>;

test('LaTeX that collides with valid JSON escapes survives instead of decoding to control characters', () => {
  // The live case: a vision reading of "30°" came back with a TAB where `\text` was.
  const raw = String.raw`{"t": "The angle is $30^\text{o}$, $\frac{1}{2}mv^2$, $\theta$, $\beta$, $\rho$, $\nabla \cdot F$, $a \to b$"}`;
  assert.equal(parse(raw).t, String.raw`The angle is $30^\text{o}$, $\frac{1}{2}mv^2$, $\theta$, $\beta$, $\rho$, $\nabla \cdot F$, $a \to b$`);
  assert.doesNotMatch(parse(raw).t, /[\t\f\b\r]/);
});

test('invalid escapes that used to fail the whole parse are kept as literal backslashes', () => {
  const raw = String.raw`{"t": "$\alpha + \sqrt{x} \cdot \Delta$ and \(E = mc^2\) and \[F = ma\]"}`;
  assert.throws(() => JSON.parse(raw));
  assert.equal(parse(raw).t, String.raw`$\alpha + \sqrt{x} \cdot \Delta$ and \(E = mc^2\) and \[F = ma\]`);
});

test('ordinary escapes are untouched, including a newline before an ordinary word', () => {
  const raw = '{"t": "line one\\nThe next\\tcolumn \\"quoted\\" \\\\ back\\/slash caf\\u00e9\\nused\\rreturn"}';
  const { text, repaired } = repairJsonEscapes(raw);
  assert.equal(repaired, 0);
  assert.equal(text, raw);
  assert.equal(parse(raw).t, 'line one\nThe next\tcolumn "quoted" \\ back/slash café\nused\rreturn');
});

test('an already-escaped LaTeX backslash is not doubled again', () => {
  const raw = String.raw`{"t": "$\\text{ok}$ and $\\alpha$"}`;
  const { text, repaired } = repairJsonEscapes(raw);
  assert.equal(repaired, 0);
  assert.equal(JSON.parse(text).t, String.raw`$\text{ok}$ and $\alpha$`);
});

test('the repair count reports what changed', () => {
  assert.equal(repairJsonEscapes(String.raw`{"t": "\text and \alpha and \n"}`).repaired, 2);
});

test('backspace or form feed before a letter is always LaTeX, even for commands not listed', () => {
  const raw = String.raw`{"t": "$\boldsymbol{v}$, $\bigl( x \bigr)$, $\fbox{1}$, $\frac12$"}`;
  assert.equal(parse(raw).t, String.raw`$\boldsymbol{v}$, $\bigl( x \bigr)$, $\fbox{1}$, $\frac12$`);
  assert.doesNotMatch(parse(raw).t, /[\b\f]/);
});

test('common text and delimiter commands that open with t, r or n survive', () => {
  const raw = String.raw`{"t": "$\texttt{x}$ $\textsf{y}$ $\therefore$ $\rbrace$ $\rVert v \rVert$ $a \nleq b$ $\tbinom{n}{k}$"}`;
  assert.equal(parse(raw).t, String.raw`$\texttt{x}$ $\textsf{y}$ $\therefore$ $\rbrace$ $\rVert v \rVert$ $a \nleq b$ $\tbinom{n}{k}$`);
  assert.doesNotMatch(parse(raw).t, /[\t\r\n]/);
});
