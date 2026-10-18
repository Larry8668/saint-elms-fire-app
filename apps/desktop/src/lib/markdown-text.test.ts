import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownToPlainText } from './markdown-text';

test('summary markdown flattens to the words a clamped card can show', () => {
  assert.equal(markdownToPlainText('# Momentum\n\n**Momentum** is *mass* times `velocity`.'), 'Momentum Momentum is mass times velocity.');
  assert.equal(markdownToPlainText('- first point\n- second, see [the notes](https://example.test)\n> quoted'), 'first point second, see the notes quoted');
  assert.equal(markdownToPlainText('__Bold__ and _soft_ and ~~gone~~'), 'Bold and soft and gone');
});

test('math, snake_case and lone symbols are left alone', () => {
  assert.equal(markdownToPlainText('Use $p = mv$ and $F = ma$'), 'Use $p = mv$ and $F = ma$');
  assert.equal(markdownToPlainText('the in_my_words field'), 'the in_my_words field');
  assert.equal(markdownToPlainText('2 * 3 = 6'), '2 * 3 = 6');
});
