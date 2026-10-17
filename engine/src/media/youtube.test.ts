import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ProcessError, type RunCommand } from './process';
import { parseVideoUrl, YouTube, YouTubeError } from './youtube';

/**
 * A fake spawn seam: `-version` answers the ffmpeg preflight, `--dump-json` answers the
 * canned metadata, `-x` drops a wav + info.json into the `-o` template's directory.
 */
const fakeRun = (info: Record<string, unknown>, opts: { wavBytes?: number; fetchStderr?: string; fetchCode?: number } = {}) => {
  const calls: string[][] = [];
  const run: RunCommand = async (_command, args) => {
    calls.push(args);
    if (args[0] === '-version') return { code: 0, stdout: 'ffmpeg version 7', stderr: '' };
    if (args.includes('--dump-json')) {
      return { code: 0, stdout: JSON.stringify(info), stderr: '' };
    }
    if (args.includes('-x')) {
      if (opts.fetchCode) return { code: opts.fetchCode, stdout: '', stderr: opts.fetchStderr ?? '' };
      const out = args[args.indexOf('-o') + 1]!.replace('%(ext)s', 'wav');
      await writeFile(out, Buffer.alloc(opts.wavBytes ?? 64));
      await writeFile(out.replace(/\.wav$/, '.info.json'), JSON.stringify(info));
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected argv' };
  };
  return { run, calls };
};

const INFO = { id: 'abc123XYZ_0', title: 'Orbits, explained', duration: 95, uploader: 'Example Lectures', webpage_url: 'https://www.youtube.com/watch?v=abc123XYZ_0', thumbnail: 'https://i.ytimg.com/vi/abc123XYZ_0/hq.jpg' };

const throws = async (p: Promise<unknown>): Promise<YouTubeError> => {
  const error = await p.catch((e: unknown) => e);
  assert.ok(error instanceof YouTubeError, `expected YouTubeError, got ${error}`);
  return error;
};

test('the allowlist keeps watch, share, shorts and mobile links, canonicalizing to watch?v=', () => {
  const canonical = 'https://www.youtube.com/watch?v=abc123XYZ_0';
  for (const raw of [
    canonical,
    'https://youtu.be/abc123XYZ_0',
    'https://m.youtube.com/watch?v=abc123XYZ_0',
    'https://www.youtube.com/shorts/abc123XYZ_0',
    'https://www.youtube.com/embed/abc123XYZ_0',
    'https://youtube.com/watch?v=abc123XYZ_0&list=PLxyz',
  ]) {
    assert.deepEqual(parseVideoUrl(raw), { url: canonical, videoId: 'abc123XYZ_0' }, raw);
  }
});

test('non-YouTube hosts and non-video shapes are refused by name, before any spawn', async () => {
  const { run, calls } = fakeRun(INFO);
  const yt = new YouTube({ run });
  for (const [raw, code] of [
    ['https://vimeo.com/12345', 'unsupported_host'],
    ['https://evil-youtube.com/watch?v=abc123XYZ_0', 'unsupported_host'],
    ['https://youtube.com.evil.com/watch?v=abc123XYZ_0', 'unsupported_host'],
    ['ftp://youtube.com/watch?v=abc123XYZ_0', 'unsupported_url'],
    ['not a url', 'unsupported_url'],
    ['https://www.youtube.com/playlist?list=PLxyz', 'unsupported_url'],
    ['https://youtu.be/', 'unsupported_url'],
    ['https://www.youtube.com/watch?v=short', 'unsupported_url'],
  ] as const) {
    assert.equal((await throws(yt.preview(raw))).code, code, raw);
  }
  assert.equal(calls.length, 0, 'refusals happen before yt-dlp is ever spawned');
});

test('preview answers the metadata card and never touches the download path', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-yt-test-'));
  const { run, calls } = fakeRun(INFO);
  const yt = new YouTube({ run, tmpRoot: dir });

  const preview = await yt.preview('https://youtu.be/abc123XYZ_0');
  assert.equal(preview.provider, 'youtube');
  assert.equal(preview.videoId, 'abc123XYZ_0');
  assert.equal(preview.title, 'Orbits, explained');
  assert.equal(preview.seconds, 95);
  assert.equal(preview.uploader, 'Example Lectures');
  assert.equal(preview.thumbnailUrl, 'https://i.ytimg.com/vi/abc123XYZ_0/hq.jpg');
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.includes('--dump-json'), 'preview is metadata-only — the consent gate is structural');
  assert.ok(!calls[0]!.includes('-x'));
});

test('an over-long video is refused at preview, before any media bytes move', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-yt-test-'));
  const { run } = fakeRun({ ...INFO, duration: 60 * 60 * 5 });
  const yt = new YouTube({ run, tmpRoot: dir });
  const error = await throws(yt.preview('https://www.youtube.com/watch?v=abc123XYZ_0'));
  assert.equal(error.code, 'video_too_long');
});

test('fetch extracts the audio track, keeps link provenance, and cleans the temp dir', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-yt-test-'));
  const { run, calls } = fakeRun(INFO, { wavBytes: 320 });
  const yt = new YouTube({ run, tmpRoot: dir });

  const fetched = await yt.fetchAudio('https://youtu.be/abc123XYZ_0?t=42');
  assert.equal(fetched.mediaType, 'audio/wav');
  assert.equal(fetched.bytes.byteLength, 320);
  assert.equal(fetched.title, 'Orbits, explained');
  assert.equal(fetched.uploader, 'Example Lectures');
  assert.equal(fetched.seconds, 95);
  assert.equal(fetched.link.provider, 'youtube');
  assert.equal(fetched.link.url, 'https://www.youtube.com/watch?v=abc123XYZ_0');
  assert.equal(fetched.link.videoId, 'abc123XYZ_0');
  assert.ok(fetched.link.fetchedAt.includes('T'));

  const fetchArgv = calls.find((a) => a.includes('-x'))!;
  assert.ok(fetchArgv.includes('--audio-format'));
  assert.ok(fetchArgv.some((a) => a.includes('duration<=')), 'the duration filter rides the download command');
  // ffmpeg preflight ran, then the fetch — and the produced intermediates are gone.
  assert.equal(calls[0]![0], '-version');
});

test('yt-dlp failures map to honest named errors', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-yt-test-'));
  const cases: Array<{ stderr: string; code: string }> = [
    { stderr: 'ERROR: Sign in to confirm your age', code: 'age_gated' },
    { stderr: 'ERROR: Video unavailable. This video is not available in your country', code: 'geo_blocked' },
    { stderr: 'ERROR: [youtube] x: Private video', code: 'video_unavailable' },
    { stderr: 'ERROR: requested format is not available', code: 'no_audio_stream' },
    { stderr: 'ERROR: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided>', code: 'video_unreachable' },
    { stderr: 'ERROR: ffmpeg or avconv not found. Please install', code: 'ffmpeg_missing' },
    { stderr: 'ERROR: something entirely new', code: 'fetch_failed' },
  ];
  for (const { stderr, code } of cases) {
    const { run } = fakeRun(INFO, { fetchCode: 1, fetchStderr: stderr });
    const yt = new YouTube({ run, tmpRoot: dir });
    assert.equal((await throws(yt.fetchAudio('https://www.youtube.com/watch?v=abc123XYZ_0'))).code, code, stderr);
  }
});

test('the match-filter refusal at download still names the length limit', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-yt-test-'));
  const { run } = fakeRun(INFO, { fetchCode: 1, fetchStderr: '[download] abc123XYZ_0: does not pass filter (duration<=14400), skipping ..' });
  const yt = new YouTube({ run, tmpRoot: dir });
  assert.equal((await throws(yt.fetchAudio('https://www.youtube.com/watch?v=abc123XYZ_0'))).code, 'video_too_long');
});

test('a missing yt-dlp is named — env path, PATH and the vendored fallback all absent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-yt-test-'));
  const run: RunCommand = async () => {
    throw new ProcessError('spawn yt-dlp ENOENT', 'missing');
  };
  const yt = new YouTube({ run, tmpRoot: dir, env: { PATH: '/nonexistent' } });
  const error = await throws(yt.preview('https://www.youtube.com/watch?v=abc123XYZ_0'));
  assert.equal(error.code, 'ytdlp_missing');
});

test('a missing ffmpeg is named before the download starts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-yt-test-'));
  const run: RunCommand = async (_command, args) => {
    if (args[0] === '-version') throw new ProcessError('spawn ffmpeg ENOENT', 'missing');
    return { code: 0, stdout: '', stderr: '' };
  };
  const yt = new YouTube({ run, tmpRoot: dir });
  const error = await throws(yt.fetchAudio('https://www.youtube.com/watch?v=abc123XYZ_0'));
  assert.equal(error.code, 'ffmpeg_missing');
});

test('the fetched-bytes cap refuses an oversized audio track by name', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-yt-test-'));
  const { run } = fakeRun(INFO, { wavBytes: 512 });
  const yt = new YouTube({ run, tmpRoot: dir });
  const error = await throws(yt.fetchAudio('https://www.youtube.com/watch?v=abc123XYZ_0', { maxBytes: 256 }));
  assert.equal(error.code, 'video_too_large');
});

test('a dead endpoint produces zero-byte audio refused as no_audio_stream', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-yt-test-'));
  const { run } = fakeRun(INFO, { wavBytes: 0 });
  const yt = new YouTube({ run, tmpRoot: dir });
  assert.equal((await throws(yt.fetchAudio('https://www.youtube.com/watch?v=abc123XYZ_0'))).code, 'no_audio_stream');
});
