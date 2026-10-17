import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgetSeat, normalizeSeatUrl, readSeat, writeSeat } from './seat';

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
  for (const bad of ['http://4100-abc.instabox.tech', 'https://u:p@seat.test', 'https://seat.test/?x=1', 'javascript:alert(1)', 'not a url']) {
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

test('a tampered or non-https stored value reads as no seat', () => {
  const store = memory();
  store.setItem('sef.seat', JSON.stringify({ engineUrl: 'http://evil.test' }));
  assert.equal(readSeat(store), null);
  store.setItem('sef.seat', '{not json');
  assert.equal(readSeat(store), null);
  assert.throws(() => writeSeat({ engineUrl: 'http://x.test' }, store));
});
