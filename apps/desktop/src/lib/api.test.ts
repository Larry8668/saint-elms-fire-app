import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, BUFFERED_AFTER_MS, BUFFERED_NOTICE, EngineError, looksBuffered, streamTurn, TurnRefused } from './api';
import type { ChatStreamEvent } from '@sef/shared';
import { pinEngineTargetForTests } from './seat';

/** The fetch the module sees is swapped per test; the real engine is only ever the machine's own. */
function withFetch(stub: (url: string, init: RequestInit) => Promise<Response>, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const turn = { sessionId: 's-1', teacher: 'guide' as const, clientMessageId: 'm-1', message: 'what is gravity?' };

test('a turn carries the new message only — never a client-built history', async () => {
  const captured: { body?: Record<string, unknown> } = {};
  await withFetch(
    async (_url, init) => {
      captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
    },
    async () => {
      await streamTurn(turn, () => {});
    },
  );
  const sent = captured.body;
  assert.ok(sent);
  assert.equal(sent.sessionId, 's-1');
  assert.equal(sent.clientMessageId, 'm-1');
  assert.equal(sent.message, 'what is gravity?');
  assert.equal('messages' in sent, false, 'history belongs to the server; nothing may smuggle it');
  assert.ok('schemaVersion' in sent);
});

test('a JSON refusal before streaming is thrown as TurnRefused with its code', async () => {
  await withFetch(
    async () => new Response(JSON.stringify({ error: 'No such conversation.', code: 'unknown_session' }), { status: 404 }),
    async () => {
      await assert.rejects(
        () => streamTurn(turn, () => {}),
        (error: unknown) => {
          assert.ok(error instanceof TurnRefused);
          assert.equal(error.code, 'unknown_session');
          assert.equal(error.status, 404);
          return true;
        },
      );
    },
  );
});

test('a non-refusal failure is surfaced as an error event, not a throw', async () => {
  const events: ChatStreamEvent[] = [];
  await withFetch(
    async () => new Response(JSON.stringify({ error: 'engine exploded' }), { status: 500 }),
    async () => {
      await streamTurn(turn, (e) => events.push(e));
    },
  );
  assert.deepEqual(events, [{ type: 'error', message: 'engine exploded' }]);
});

test('SSE events stream through in order', async () => {
  const sse = ['data: {"type":"status","message":"thinking"}', '', 'data: {"type":"delta","text":"Hel"}', '', 'data: {"type":"delta","text":"lo"}', '', 'data: {"type":"done","text":"Hello","verification":{"model":"m","provider":"p","sources":[],"checks":[],"toolCalls":[]}}', '', ''].join('\n');
  const events: ChatStreamEvent[] = [];
  await withFetch(
    async () => new Response(new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }), { status: 200 }),
    async () => {
      await streamTurn(turn, (e) => events.push(e));
    },
  );
  assert.deepEqual(events.map((e) => e.type), ['status', 'delta', 'delta', 'done']);
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const edge = (status: 502 | 503) => new Response(status === 503 ? 'Sandbox offline. Its owner must start it to use this URL.' : 'Nothing is listening on this port.', { status, headers: { 'content-type': 'text/plain' } });

/** The UI a remote workspace VM serves itself: same-origin calls behind the Instabox edge. */
function onWorkspace(run: () => Promise<void>) {
  pinEngineTargetForTests({ kind: 'served', base: '', remote: true });
  return run().finally(() => pinEngineTargetForTests(null));
}

test('a workspace the edge reports as starting (502) is waited for, then the call goes again', async () => {
  const urls: string[] = [];
  let health = 0;
  await onWorkspace(() =>
    withFetch(
      async (url) => {
        urls.push(url);
        if (url.endsWith('/api/health')) return (health += 1) === 1 ? edge(502) : json({ ok: true });
        return urls.filter((u) => u.endsWith('/api/library')).length === 1 ? edge(502) : json({ courses: [], lessons: [] });
      },
      async () => {
        assert.deepEqual(await api.library(), { courses: [], lessons: [] });
      },
    ),
  );
  assert.deepEqual(urls, ['/api/library', '/api/health', '/api/health', '/api/library']);
});

test('a JSON 503 is the engine itself refusing, not the edge: no wake, no retry', async () => {
  const urls: string[] = [];
  await onWorkspace(() =>
    withFetch(
      async (url) => {
        urls.push(url);
        return json({ error: 'The university server is unreachable.', code: 'uni_unreachable' }, 503);
      },
      async () => {
        await assert.rejects(api.programme(), (error: unknown) => error instanceof EngineError && error.status === 503 && error.code === 'uni_unreachable');
      },
    ),
  );
  assert.deepEqual(urls, ['/api/programme']);
});

test('a write whose connection dropped is not resent after the wake: it may have landed', async () => {
  const sent: string[] = [];
  await onWorkspace(() =>
    withFetch(
      async (url, init) => {
        if (url.endsWith('/api/health')) return json({ ok: true });
        sent.push(`${init.method} ${url}`);
        throw new TypeError('Load failed');
      },
      async () => {
        await assert.rejects(api.installAll(), (error: unknown) => error instanceof EngineError && error.code === 'seat_woke');
      },
    ),
  );
  assert.deepEqual(sent, ['POST /api/sync/install-all']);
});

test('a read whose connection dropped is resent once the workspace answers again', async () => {
  const sent: string[] = [];
  await onWorkspace(() =>
    withFetch(
      async (url) => {
        if (url.endsWith('/api/health')) return json({ ok: true });
        sent.push(url);
        if (sent.length === 1) throw new TypeError('Load failed');
        return json({ courses: [], lessons: [] });
      },
      async () => {
        assert.deepEqual(await api.library(), { courses: [], lessons: [] });
      },
    ),
  );
  assert.deepEqual(sent, ['/api/library', '/api/library']);
});

test('a workspace failure never says "the local engine is not running"', async () => {
  await withFetch(
    async () => {
      throw new TypeError('fetch failed');
    },
    async () => {
      await assert.rejects(api.health(), /local engine is not running/, 'the local engine keeps its own message');
    },
  );
  const events: ChatStreamEvent[] = [];
  await onWorkspace(() =>
    withFetch(
      async (url) => (url.endsWith('/api/health') ? json({ ok: true }) : edge(503)),
      async () => {
        assert.equal(await streamTurn(turn, (e) => events.push(e)), 'failed');
      },
    ),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'error');
  assert.match((events[0] as { message: string }).message, /Your workspace is offline/);
  assert.doesNotMatch((events[0] as { message: string }).message, /local engine|pnpm/);
});

test('an answer that arrives all at once, late, is labelled as buffered before it is shown', async () => {
  const sse = 'data: {"type":"status","message":"thinking"}\n\ndata: {"type":"delta","text":"Hi"}\n\ndata: {"type":"done","text":"Hi","verification":{"model":"m","provider":"p","sources":[],"checks":[],"toolCalls":[]}}\n\n';
  let clock = 0;
  const events: ChatStreamEvent[] = [];
  await withFetch(
    async () =>
      new Response(
        new ReadableStream({
          start: (c) => {
            clock += BUFFERED_AFTER_MS + 500;
            c.enqueue(new TextEncoder().encode(sse));
            c.close();
          },
        }),
        { status: 200 },
      ),
    async () => {
      assert.equal(await streamTurn(turn, (e) => events.push(e), undefined, () => clock), 'buffered');
    },
  );
  assert.deepEqual(events.map((e) => e.type), ['status', 'status', 'delta', 'done']);
  assert.deepEqual(events[0], { type: 'status', message: BUFFERED_NOTICE });
});

test('a live stream is not mistaken for a buffered one', () => {
  assert.equal(looksBuffered(100, 0, true), false, 'a quick answer in one read is just quick');
  assert.equal(looksBuffered(BUFFERED_AFTER_MS + 1, 0, false), false, 'a late first status frame is a slow start, not buffering');
  assert.equal(looksBuffered(BUFFERED_AFTER_MS, 0, true), true);
});
