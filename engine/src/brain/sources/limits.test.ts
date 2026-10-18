import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACCEPTED_MEDIA_TYPES,
  checkAudioDuration,
  checkBytes,
  checkImageDimensions,
  checkMediaType,
  checkSourceBytes,
  checkPageCount,
  checkSourceCount,
  countChars,
  formatBytes,
  INGEST_LIMITS,
  safeSourceFilename,
  sanitiseTitle,
  sliceChars,
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

test('the media allowlist is enforced by name, tolerating case and parameters', () => {
  assert.deepEqual([...ACCEPTED_MEDIA_TYPES].sort(), ['application/pdf', 'image/jpeg', 'image/png', 'text/markdown', 'text/plain']);
  assert.equal(checkMediaType('text/markdown'), null);
  assert.equal(checkMediaType('Text/Plain; charset=utf-8'), null);
  assert.equal(checkMediaType(' application/PDF '), null);
  assert.equal(checkMediaType('text/html')?.code, 'unsupported_media');
  assert.equal(checkMediaType('image/svg+xml')?.code, 'unsupported_media');
  assert.equal(checkMediaType('application/octet-stream')?.code, 'unsupported_media');
  assert.equal(checkMediaType('')?.code, 'unsupported_media');
  assert.match(checkMediaType('text/html')!.message, /text\/html/);
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
  // A media type we do not know gets the opaque extension — never a guessed one. Only an
  // exact match earns a friendly extension; 'application/pdf-evil' is not a PDF.
  assert.equal(safeSourceFilename('src_abc', 'application/pdf-evil'), 'src_abc.bin');
  assert.equal(safeSourceFilename('src_abc', 'application/octet-stream'), 'src_abc.bin');
  assert.equal(safeSourceFilename('src_abc', ' Application/PDF '), 'src_abc.pdf');
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
  // Floored, never rounded up: a size next to a hard limit must not overstate itself.
  assert.equal(formatBytes(1024 * 1024 * 25 + 900 * 1024), '25.8 MB');
  assert.equal(formatBytes(1536), '1 KB');
});

test('characters are counted as code points, not UTF-16 code units', () => {
  const books = `${'📚'.repeat(5)}abcde`;
  assert.equal(countChars(books), 10);
  assert.equal(sliceChars(books, 7), `${'📚'.repeat(5)}ab`);
  // A slice may never end inside a surrogate pair.
  assert.equal(sliceChars('a📚b', 2), 'a📚');
});

test('audio recordings are accepted as a family — ffmpeg decides readability, not a mime list', () => {
  assert.equal(checkMediaType('audio/wav'), null);
  assert.equal(checkMediaType('audio/mpeg'), null);
  assert.equal(checkMediaType('Audio/MP4; codecs=mp4a'), null, 'case and parameters tolerated');
  assert.equal(checkMediaType('audio/x-uncommon-container'), null, 'an uncommon audio type still reaches the probe');
  // Neighbouring families stay refused: the family check is not a wildcard.
  assert.equal(checkMediaType('video/x-flv')?.code, 'unsupported_media');
  assert.equal(checkMediaType('application/ogg')?.code, 'unsupported_media');
});

test('audio byte size runs against the audio cap, and duration is a named refusal', () => {
  // A note-sized check would refuse a lecture recording; the audio cap is its own.
  assert.equal(checkSourceBytes(new Uint8Array(INGEST_LIMITS.maxSourceBytes + 1), 'audio/mpeg'), null);
  assert.equal(checkSourceBytes(new Uint8Array(8), 'audio/mpeg', { maxAudioBytes: 4 })?.code, 'too_large');
  assert.equal(checkSourceBytes(new Uint8Array(0), 'audio/mpeg')?.code, 'empty');
  // Non-audio keeps the document cap.
  assert.equal(checkSourceBytes(new Uint8Array(INGEST_LIMITS.maxSourceBytes + 1), 'text/plain')?.code, 'too_large');

  assert.equal(checkAudioDuration(3600), null);
  assert.equal(checkAudioDuration(INGEST_LIMITS.maxAudioSeconds + 1)?.code, 'audio_too_long');
  assert.equal(checkAudioDuration(0)?.code, 'unsupported_media', 'a stream with no length did not read as audio');
  assert.match(checkAudioDuration(INGEST_LIMITS.maxAudioSeconds + 61)!.message, /4:00:00/);
});

test('audio downloads keep a playable extension; unknown audio keeps an honest one', () => {
  assert.equal(safeSourceFilename('src_abc', 'audio/mpeg'), 'src_abc.mp3');
  assert.equal(safeSourceFilename('src_abc', 'audio/wav'), 'src_abc.wav');
  assert.equal(safeSourceFilename('src_abc', 'audio/x-m4a'), 'src_abc.m4a');
  assert.equal(safeSourceFilename('src_abc', 'audio/x-strange'), 'src_abc.audio');
});

test('uploaded videos are a closed list of containers, not the whole video family', () => {
  for (const type of ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'Video/MP4; codecs=avc1']) {
    assert.equal(checkMediaType(type), null, `${type} is accepted`);
  }
  assert.equal(checkMediaType('video/x-msvideo')?.code, 'unsupported_media');
  assert.match(checkMediaType('video/x-msvideo')!.message, /MP4, MOV, WebM or MKV/);
});

test('video bytes run against their own cap, and download with their container extension', () => {
  assert.equal(INGEST_LIMITS.maxVideoBytes, 256 * 1024 * 1024);
  assert.equal(checkSourceBytes(new Uint8Array(INGEST_LIMITS.maxSourceBytes + 1), 'video/mp4'), null, 'a lecture video is not held to the document cap');
  const over = checkSourceBytes(new Uint8Array(8), 'video/webm', { maxVideoBytes: 4 });
  assert.equal(over?.code, 'too_large');
  assert.match(over!.message, /video limit/);
  assert.equal(checkSourceBytes(new Uint8Array(0), 'video/mp4')?.code, 'empty');
  assert.equal(safeSourceFilename('src_abc', 'video/mp4'), 'src_abc.mp4');
  assert.equal(safeSourceFilename('src_abc', 'video/quicktime'), 'src_abc.mov');
  assert.equal(safeSourceFilename('src_abc', 'video/x-matroska'), 'src_abc.mkv');
});
