import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEMO_ADMIN, DEMO_PERSONAS } from '@sef/shared';
import { AccountStore } from './accounts';

const dir = (prefix: string) => mkdtemp(path.join(tmpdir(), prefix));

test('first boot seeds the operator admin and, while SEED_DEMO holds, the demo students; a reload never re-seeds', async () => {
  const dataDir = await dir('sef-accounts-demo-');
  const store = new AccountStore(dataDir);
  assert.equal(await store.load(), true, 'no accounts file means a first boot');
  const list = store.list();
  assert.ok(list.some((a) => a.id === DEMO_ADMIN.id && a.role === 'admin'));
  for (const p of DEMO_PERSONAS) assert.ok(list.some((a) => a.id === p.id), `missing demo persona ${p.id}`);

  const reloaded = new AccountStore(dataDir);
  assert.equal(await reloaded.load(), false, 'a persisted store is not a first boot');
  assert.equal(reloaded.list().length, list.length);
});

test('SEED_DEMO=false seeds only the operator admin — the demo students never exist', async () => {
  const store = new AccountStore(await dir('sef-accounts-nodemo-'), { seedDemo: false });
  assert.equal(await store.load(), true);
  const list = store.list();
  assert.deepEqual(
    list.map((a) => a.id),
    [DEMO_ADMIN.id],
  );
});

test('production refuses to seed accounts with the public demo password', async () => {
  const store = new AccountStore(await dir('sef-accounts-prod-'));
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(store.load(), /public demo password/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
