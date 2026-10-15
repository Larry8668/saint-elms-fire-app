import assert from 'node:assert/strict';
import { test } from 'node:test';
import { streamTurn, TurnRefused } from './api';
import type { ChatStreamEvent } from '@sef/shared';

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
