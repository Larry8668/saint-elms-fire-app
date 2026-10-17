import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engineTarget, forgetWorkspace, isRemoteTarget, isWorkspaceTarget, normalizeWorkspaceUrl, takeWorkspaceFromUrl, writeWorkspace } from './seat';

test('engine calls go to the local engine unless the UI is served by an engine itself', () => {
  assert.deepEqual(engineTarget(undefined, 'localhost'), { kind: 'local', base: 'http://127.0.0.1:4100' });
  assert.equal(engineTarget('http://127.0.0.1:4910', 'localhost').base, 'http://127.0.0.1:4910', 'the build-time local address still applies');
  assert.equal(isRemoteTarget(engineTarget(undefined, '4100-abc.instabox.tech')), false);
});

test('the UI an engine serves itself calls its own origin; outside loopback that is a remote workspace', () => {
  const served = engineTarget('same-origin', '4100-abc.instabox.tech');
  assert.deepEqual(served, { kind: 'served', base: '', remote: true });
  assert.equal(isRemoteTarget(served), true);
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) assert.equal(isRemoteTarget(engineTarget('same-origin', host)), false, host);
  assert.equal(isRemoteTarget(engineTarget('same-origin', null)), false, 'no page (tests, workers) is not remote');
});

class MemoryStorage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}
const memory = () => new MemoryStorage() as unknown as Storage;
const VM = 'https://4100-m1abc.instabox.tech';
const SUFFIX = '.instabox.tech';

test('a stored workspace wins over the build-time local engine, and forgetting it goes back to local', () => {
  const store = memory();
  assert.equal(writeWorkspace(`${VM}/`, store, SUFFIX), true);
  assert.deepEqual(engineTarget('http://127.0.0.1:4910', 'sef.vercel.app', store, SUFFIX), { kind: 'workspace', base: VM, host: '4100-m1abc.instabox.tech' });
  assert.equal(isRemoteTarget(engineTarget(undefined, 'sef.vercel.app', store, SUFFIX)), true, 'a workspace sits behind an edge');
  assert.equal(isWorkspaceTarget(engineTarget(undefined, 'sef.vercel.app', store, SUFFIX)), true);
  assert.equal(engineTarget('same-origin', '4100-m1abc.instabox.tech', store, SUFFIX).kind, 'served', 'a UI the VM serves itself keeps calling its own origin');
  forgetWorkspace(store);
  assert.deepEqual(engineTarget('http://127.0.0.1:4910', 'sef.vercel.app', store, SUFFIX), { kind: 'local', base: 'http://127.0.0.1:4910' });
});

test('workspace URLs: https under the configured host suffix, http only on loopback, nothing else', () => {
  assert.equal(normalizeWorkspaceUrl(VM, SUFFIX), VM);
  assert.equal(normalizeWorkspaceUrl('HTTPS://4100-M1ABC.Instabox.Tech:443/', SUFFIX), VM);
  for (const bad of [
    'https://evil.test',
    'https://instabox.tech.evil.test',
    'https://evilinstabox.tech',
    'https://instabox.tech',
    'http://4100-m1abc.instabox.tech',
    'http://127.0.0.1:3511',
    `${VM}/engine`,
    `${VM}/?x=1`,
    `${VM}/#x`,
    'https://user:pw@4100-m1abc.instabox.tech',
    'javascript:alert(1)',
    'not a url',
    '',
  ]) {
    assert.equal(normalizeWorkspaceUrl(bad, SUFFIX), null, bad);
  }
  // A local drill (VITE_WORKSPACE_HOST_SUFFIX=127.0.0.1): plain http only because it is loopback.
  assert.equal(normalizeWorkspaceUrl('http://127.0.0.1:3511', '127.0.0.1'), 'http://127.0.0.1:3511');
  assert.equal(normalizeWorkspaceUrl('http://10.0.0.5:3511', '10.0.0.5'), null, 'plain http off loopback is never a workspace');
  assert.equal(normalizeWorkspaceUrl('https://4100-x.localhost', 'localhost'), 'https://4100-x.localhost');
});

test('a corrupt or disallowed stored workspace is cleared and reads as local, never throws', () => {
  for (const raw of ['{not json', 'null', '"x"', '{}', JSON.stringify({ engineUrl: 42 }), JSON.stringify({ engineUrl: 'https://attacker.example' }), JSON.stringify({ engineUrl: 'http://4100-m1abc.instabox.tech' })]) {
    const store = memory();
    store.setItem('sef.workspace', raw);
    assert.equal(engineTarget(undefined, 'sef.vercel.app', store, SUFFIX).kind, 'local', raw);
    assert.equal(store.getItem('sef.workspace'), null, `${raw} cleared`);
  }
  assert.equal(writeWorkspace('https://attacker.example', memory(), SUFFIX), false);
  const refusing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } } as unknown as Storage;
  assert.equal(engineTarget(undefined, null, refusing, SUFFIX).kind, 'local');
  assert.equal(writeWorkspace(VM, refusing, SUFFIX), false);
  assert.equal(engineTarget(undefined, null, null, SUFFIX).kind, 'local', 'no storage at all');
});

test('?workspace= intake: stores an allowed VM, strips the parameter, drops a token held for another engine', () => {
  const store = memory();
  const session = memory();
  session.setItem('sef.session', '{"token":"old"}');
  const replaced: string[] = [];
  const intake = (href: string) => takeWorkspaceFromUrl({ href, replaceUrl: (url) => replaced.push(url), store, session, suffix: SUFFIX });

  assert.equal(intake(`https://sef.vercel.app/?workspace=${encodeURIComponent(VM)}&tab=chat#top`), 'stored');
  assert.deepEqual(replaced, ['/?tab=chat#top']);
  assert.equal(engineTarget(undefined, 'sef.vercel.app', store, SUFFIX).base, VM);
  assert.equal(session.getItem('sef.session'), null, 'a token belongs to one engine');

  session.setItem('sef.session', '{"token":"current"}');
  assert.equal(intake(`https://sef.vercel.app/?workspace=${encodeURIComponent(VM)}`), 'stored');
  assert.equal(session.getItem('sef.session'), '{"token":"current"}', 'the same workspace again keeps the sign-in');

  // A forged link: refused, stripped, and the workspace already stored stays as it was.
  for (const forged of ['https://attacker.example', 'http://4100-m1abc.instabox.tech', 'https://4100-m1abc.instabox.tech.attacker.example']) {
    assert.equal(intake(`https://sef.vercel.app/?workspace=${encodeURIComponent(forged)}`), 'refused', forged);
    assert.equal(engineTarget(undefined, 'sef.vercel.app', store, SUFFIX).base, VM);
  }
  assert.equal(replaced.at(-1), '/');
  assert.equal(session.getItem('sef.session'), '{"token":"current"}');

  const before = replaced.length;
  assert.equal(intake('https://sef.vercel.app/?tab=chat'), 'none');
  assert.equal(replaced.length, before, 'no parameter, no history change');
});
