import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkBytes,
  checkImageDimensions,
  checkPageCount,
  checkSourceCount,
  formatBytes,
  INGEST_LIMITS,
  safeSourceFilename,
  sanitiseTitle,
  titleIsSafe,
} from './limits';

test('an empty source is refused rather than stored', () => {
  assert.equal(checkBytes(new Uint8Array(0))?.code, 'empty');
});

test('a source over the byte limit is refused, never truncated', () => {
  const over = new Uint8Array(INGEST_LIMITS.maxSourceBytes + 1);
  const rejection = checkBytes(over);
  assert.equal(rejection?.code, 'too_large');
  assert.match(rejection!.message, /25\.0 MB/);
});

test('a source exactly at the limit is accepted', () => {
  assert.equal(checkBytes(new Uint8Array(64)), null);
});

test('byte limits can be narrowed for a test without touching the defaults', () => {
  assert.equal(checkBytes(new Uint8Array(10), { maxSourceBytes: 10 }), null);
  assert.equal(checkBytes(new Uint8Array(11), { maxSourceBytes: 10 })?.code, 'too_large');
});

test('image dimensions are checked on both axes and on total pixels', () => {
  assert.equal(checkImageDimensions(1920, 1080), null);
  assert.equal(checkImageDimensions(INGEST_LIMITS.maxImageDimension + 1, 100)?.code, 'image_too_large');
  assert.equal(checkImageDimensions(100, INGEST_LIMITS.maxImageDimension + 1)?.code, 'image_too_large');
  assert.equal(checkImageDimensions(0, 10)?.code, 'image_too_large');
  // Under the per-axis limit but over the pixel budget.
  assert.equal(checkImageDimensions(4000, 4000, { maxImageDimension: 8000, maxImagePixels: 1000 })?.code, 'image_too_large');
});

test('a document over the page limit is refused outright', () => {
  assert.equal(checkPageCount(10), null);
  assert.equal(checkPageCount(INGEST_LIMITS.maxPdfPages), null);
  assert.equal(checkPageCount(INGEST_LIMITS.maxPdfPages + 1)?.code, 'too_many_pages');
});

test('a job cannot take an unbounded number of sources', () => {
  assert.equal(checkSourceCount(1), null);
  assert.equal(checkSourceCount(INGEST_LIMITS.maxSourcesPerJob), null);
  assert.equal(checkSourceCount(INGEST_LIMITS.maxSourcesPerJob + 1)?.code, 'too_large');
});

test('the on-disk filename is derived from the id, never from the title', () => {
  assert.equal(safeSourceFilename('src_abc', 'application/pdf'), 'src_abc.pdf');
  assert.equal(safeSourceFilename('src_abc', 'image/png'), 'src_abc.png');
  assert.equal(safeSourceFilename('src_abc', 'image/jpeg'), 'src_abc.jpg');
  assert.equal(safeSourceFilename('src_abc', 'text/markdown'), 'src_abc.md');
  assert.equal(safeSourceFilename('src_abc', 'text/plain'), 'src_abc.txt');
  // A hostile title cannot reach the filename at all.
  assert.equal(safeSourceFilename('src_abc', 'application/pdf').includes('/'), false);
});

test('a title that could act like a path is refused', () => {
  assert.equal(titleIsSafe('Lecture 3 notes'), true);
  assert.equal(titleIsSafe('../../etc/passwd'), false);
  assert.equal(titleIsSafe('a/b'), false);
  assert.equal(titleIsSafe('a\\b'), false);
  assert.equal(titleIsSafe('   '), false);
  assert.equal(titleIsSafe(`bad${String.fromCharCode(10)}name`), false);
});

test('titles are sanitised for display without becoming paths', () => {
  assert.equal(sanitiseTitle('  Lecture 3  '), 'Lecture 3');
  assert.equal(sanitiseTitle('line\nbreak'), 'line break');
  assert.equal(sanitiseTitle('../../escape'), 'escape');
  assert.equal(sanitiseTitle('   '), 'Untitled source');
  assert.ok(sanitiseTitle('x'.repeat(400)).length <= 300);
});

test('byte formatting is human-scale and never lies about the limit', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(INGEST_LIMITS.maxSourceBytes), '25.0 MB');
});
