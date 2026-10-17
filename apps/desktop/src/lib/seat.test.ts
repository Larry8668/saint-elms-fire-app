import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engineTarget, forgetSeat, isRemoteTarget, normalizeSeatUrl, readSeat, seatHost, setPreferLocalEngine, writeSeat } from './seat';

const memory = (): Storage => {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  };
};

test('a seat URL is reduced to its https origin; anything else is refused', () => {
  assert.equal(normalizeSeatUrl('https://4100-abc.instabox.tech/'), 'https://4100-abc.instabox.tech');
  assert.equal(normalizeSeatUrl(' https://seat.tail1.ts.net:4100 '), 'https://seat.tail1.ts.net:4100');
  assert.equal(normalizeSeatUrl('http://127.0.0.1:4100/'), 'http://127.0.0.1:4100', 'plain http only on loopback');
  for (const bad of ['http://4100-abc.instabox.tech', 'http://192.168.1.5:4100', 'https://u:p@seat.test', 'https://seat.test/?x=1', 'javascript:alert(1)', 'not a url', '']) {
    assert.equal(normalizeSeatUrl(bad), null, bad);
  }
});

test('the seat round-trips through storage and can be forgotten', () => {
  const store = memory();
  assert.equal(readSeat(store), null);
  writeSeat({ engineUrl: 'https://4100-abc.instabox.tech/', machineId: 'm_abc' }, store);
  assert.deepEqual(readSeat(store), { engineUrl: 'https://4100-abc.instabox.tech', machineId: 'm_abc' });
  forgetSeat(store);
  assert.equal(readSeat(store), null);
});

test('a corrupt, legacy or non-seat record reads as no seat and is cleared', () => {
  const corrupt = ['{not json', 'null', '"https://seat.test"', '[]', JSON.stringify({ engineUrl: 'http://evil.test' }), JSON.stringify({ engineUrl: 42 }), JSON.stringify({ engineUrl: '::::' }), JSON.stringify({ url: 'https://old.test' })];
  for (const raw of corrupt) {
    const store = memory();
    store.setItem('sef.seat', raw);
    assert.equal(readSeat(store), null, raw);
    assert.equal(store.getItem('sef.seat'), null, `cleared: ${raw}`);
  }
  assert.throws(() => writeSeat({ engineUrl: 'http://x.test' }, memory()));
});

test('storage that throws reads as no seat instead of breaking the caller', () => {
  const hostile = { ...memory(), getItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } } as Storage;
  assert.equal(readSeat(hostile), null);
});

test('the displayed host never throws', () => {
  assert.equal(seatHost('https://4100-abc.instabox.tech'), '4100-abc.instabox.tech');
  assert.equal(seatHost('not a url'), null);
  assert.equal(seatHost(''), null);
});

test('engine calls follow the stored seat, and the local toggle keeps the seat for later', () => {
  const store = memory();
  assert.deepEqual(engineTarget(store, undefined), { kind: 'local', base: 'http://127.0.0.1:4100', seat: null });
  assert.equal(engineTarget(store, 'http://127.0.0.1:4910').base, 'http://127.0.0.1:4910', 'the build-time local address still applies');

  writeSeat({ engineUrl: 'https://4100-abc.instabox.tech', machineId: 'm_abc' }, store);
  const seat = engineTarget(store, undefined);
  assert.equal(seat.kind, 'seat');
  assert.equal(seat.base, 'https://4100-abc.instabox.tech');
  assert.equal(isRemoteTarget(seat), true);

  setPreferLocalEngine(true, store);
  const local = engineTarget(store, undefined);
  assert.equal(local.kind, 'local');
  assert.equal(local.base, 'http://127.0.0.1:4100');
  assert.deepEqual(local.kind === 'local' && local.seat, { engineUrl: 'https://4100-abc.instabox.tech', machineId: 'm_abc' }, 'switching back is one click');
  assert.equal(isRemoteTarget(local), false);

  setPreferLocalEngine(false, store);
  assert.equal(engineTarget(store, undefined).kind, 'seat');

  setPreferLocalEngine(true, store);
  forgetSeat(store);
  assert.equal(engineTarget(store, undefined).kind, 'local');
  assert.equal(store.length, 0, 'forgetting the seat clears the toggle too');
});

test('the seat and the toggle survive a restart: every read goes back to storage', () => {
  const store = memory();
  writeSeat({ engineUrl: 'https://seat.tail1.ts.net' }, store);
  setPreferLocalEngine(true, store);
  const restored = memory();
  for (let i = 0; i < store.length; i += 1) restored.setItem(store.key(i)!, store.getItem(store.key(i)!)!);
  assert.equal(engineTarget(restored, undefined).kind, 'local');
  setPreferLocalEngine(false, restored);
  assert.equal(engineTarget(restored, undefined).base, 'https://seat.tail1.ts.net', 'any https host, not only instabox.tech');
});

test('the UI an engine serves itself calls its own origin, whatever is stored', () => {
  const store = memory();
  writeSeat({ engineUrl: 'https://4100-abc.instabox.tech' }, store);
  const served = engineTarget(store, 'same-origin');
  assert.equal(served.kind, 'served');
  assert.equal(served.base, '');
  assert.equal(isRemoteTarget(served), true, 'outside loopback a served page is a seat');
});
