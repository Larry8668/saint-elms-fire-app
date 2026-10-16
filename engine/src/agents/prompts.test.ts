import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WIKI_KEEPER_INSTRUCTIONS } from '../brain/compiler/draft';
import { SEMANTIC_REVIEW_INSTRUCTIONS } from '../brain/maintenance/semantic';
import { teacherInstructions, UNTRUSTED_CONTENT_NOTE } from './prompts';

test('every prompt that interpolates retrieved material marks it as untrusted data, in the same words', () => {
  const prompts = [
    WIKI_KEEPER_INSTRUCTIONS,
    SEMANTIC_REVIEW_INSTRUCTIONS,
    teacherInstructions('friend', 'Ada'),
    teacherInstructions('guide', 'Ada'),
    teacherInstructions('philosopher', 'Ada'),
  ];
  for (const instructions of prompts) {
    assert.ok(instructions.includes(UNTRUSTED_CONTENT_NOTE), 'the untrusted-content line is present, word for word');
  }
});
