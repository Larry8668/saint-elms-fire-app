import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { edgePolicy, edgeStartupCheck, parseProxyEntries, parseProxyList, parsePublicHost } from './edge';

/** The node-server binding getConnInfo reads; `null` models an in-process request with no socket. */
const socketFrom = (remoteAddress: string | null) => (remoteAddress ? { incoming: { socket: { remoteAddress, remotePort: 50000, remoteFamily: remoteAddress.includes(':') ? 'IPv6' : 'IPv4' } } } : {});

async function view(env: NodeJS.ProcessEnv, peer: string | null, headers: Record<string, string>) {
  const policy = edgePolicy(env);
  const app = new Hono();
  app.get('/', (c) => c.json({ admits: policy.admits(c), client: policy.client(c), scheme: policy.scheme(c) }));
  const res = await app.request('/', { headers }, socketFrom(peer));
  return (await res.json()) as { admits: boolean; client: string; scheme: string };
}

const SEAT = 'seat.example.test';
const PROXIED = { ENGINE_PUBLIC_HOST: SEAT, ENGINE_TRUST_PROXY: '1' };

test('Host gate and forwarded headers, case by case', async () => {
  const edgeHeaders = { host: '127.0.0.1:4100', 'x-forwarded-host': SEAT, 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'https' };
  const table: Array<{ name: string; env: NodeJS.ProcessEnv; peer: string | null; headers: Record<string, string>; admits: boolean; client: string; scheme: string }> = [
    { name: 'loopback engine, direct loopback caller', env: {}, peer: '127.0.0.1', headers: { host: '127.0.0.1:4100' }, admits: true, client: '127.0.0.1', scheme: 'http' },
    { name: 'loopback engine, bracketed IPv6 loopback', env: {}, peer: '::1', headers: { host: '[::1]:4100' }, admits: true, client: '::1', scheme: 'http' },
    { name: 'loopback engine, bare IPv6 loopback literal', env: {}, peer: '::1', headers: { host: '::1' }, admits: true, client: '::1', scheme: 'http' },
    { name: 'loopback engine, bare non-loopback IPv6', env: {}, peer: '::1', headers: { host: '2001:db8::1' }, admits: false, client: '::1', scheme: 'http' },
    { name: 'loopback engine, rebound name', env: {}, peer: '127.0.0.1', headers: { host: 'rebound.evil.test' }, admits: false, client: '127.0.0.1', scheme: 'http' },
    {
      name: 'loopback engine ignores forwarded headers entirely',
      env: {},
      peer: '127.0.0.1',
      headers: { host: '127.0.0.1:4100', 'x-forwarded-host': 'evil.example', 'x-forwarded-for': '6.6.6.6', 'x-forwarded-proto': 'https' },
      admits: true,
      client: '127.0.0.1',
      scheme: 'http',
    },
    { name: 'seat, local caller on the box (no XFH)', env: PROXIED, peer: '127.0.0.1', headers: { host: '127.0.0.1:4100' }, admits: true, client: '127.0.0.1', scheme: 'http' },
    { name: 'seat, the edge with a matching XFH', env: PROXIED, peer: '127.0.0.1', headers: edgeHeaders, admits: true, client: '198.51.100.7', scheme: 'https' },
    { name: 'seat, IPv4-mapped loopback peer is still the edge', env: PROXIED, peer: '::ffff:127.0.0.1', headers: edgeHeaders, admits: true, client: '198.51.100.7', scheme: 'https' },
    {
      name: 'seat, trusted peer with a mismatched XFH is refused',
      env: PROXIED,
      peer: '127.0.0.1',
      headers: { ...edgeHeaders, 'x-forwarded-host': 'other-seat.example.test' },
      admits: false,
      client: '198.51.100.7',
      scheme: 'https',
    },
    {
      name: 'trusted proxy but no public host: any XFH is a mismatch',
      env: { ENGINE_TRUST_PROXY: '1' },
      peer: '127.0.0.1',
      headers: edgeHeaders,
      admits: false,
      client: '198.51.100.7',
      scheme: 'https',
    },
    {
      name: 'seat, untrusted peer spoofing XFH/XFF/XFP: headers ignored, Host rules apply',
      env: PROXIED,
      peer: '203.0.113.50',
      headers: { host: '127.0.0.1:4100', 'x-forwarded-host': 'evil.example', 'x-forwarded-for': '6.6.6.6', 'x-forwarded-proto': 'https' },
      admits: true,
      client: '203.0.113.50',
      scheme: 'http',
    },
    { name: 'seat, untrusted peer with a foreign Host', env: PROXIED, peer: '203.0.113.50', headers: { host: 'evil.example' }, admits: false, client: '203.0.113.50', scheme: 'http' },
    { name: 'seat, an edge that preserves the public Host', env: PROXIED, peer: '127.0.0.1', headers: { host: `${SEAT}:443` }, admits: true, client: '127.0.0.1', scheme: 'http' },
    {
      name: 'trust off: forwarded headers ignored even from loopback',
      env: { ENGINE_PUBLIC_HOST: SEAT },
      peer: '127.0.0.1',
      headers: { ...edgeHeaders, 'x-forwarded-host': 'evil.example' },
      admits: true,
      client: '127.0.0.1',
      scheme: 'http',
    },
    {
      name: 'docker bridge gateway is untrusted by default',
      env: PROXIED,
      peer: '172.17.0.1',
      headers: { ...edgeHeaders, 'x-forwarded-host': 'evil.example' },
      admits: true,
      client: '172.17.0.1',
      scheme: 'http',
    },
    {
      name: 'docker bridge gateway trusted once listed',
      env: { ...PROXIED, ENGINE_TRUSTED_PROXIES: '127.0.0.1,172.17.0.0/16' },
      peer: '172.17.0.1',
      headers: edgeHeaders,
      admits: true,
      client: '198.51.100.7',
      scheme: 'https',
    },
    { name: 'no socket (in-process) is never a trusted proxy', env: PROXIED, peer: null, headers: edgeHeaders, admits: true, client: 'local', scheme: 'http' },
  ];
  for (const row of table) {
    const seen = await view(row.env, row.peer, row.headers);
    assert.deepEqual(seen, { admits: row.admits, client: row.client, scheme: row.scheme }, row.name);
  }
});

test('the client is the right-most untrusted X-Forwarded-For hop, never the spoofable left-most', async () => {
  const env = { ...PROXIED, ENGINE_TRUSTED_PROXIES: '127.0.0.1,10.0.0.0/8' };
  const at = async (xff: string) => (await view(env, '127.0.0.1', { host: '127.0.0.1:4100', 'x-forwarded-for': xff })).client;
  assert.equal(await at('6.6.6.6, 198.51.100.7'), '198.51.100.7', 'the client prepended a fake hop');
  assert.equal(await at('6.6.6.6, 198.51.100.7, 10.1.2.3'), '198.51.100.7', 'an inner trusted proxy is skipped');
  assert.equal(await at('10.1.2.3'), '127.0.0.1', 'all hops trusted: fall back to the peer');
});

test('ENGINE_PUBLIC_HOST accepts a bare name or a URL and refuses widening values', () => {
  assert.equal(parsePublicHost('seat.example.test'), 'seat.example.test');
  assert.equal(parsePublicHost(' https://Seat.Example.Test/ '), 'seat.example.test');
  assert.equal(parsePublicHost('seat.example.test:443'), 'seat.example.test');
  for (const bad of ['', '   ', 'localhost', '127.0.0.1', '*.example.test', 'http://']) assert.equal(parsePublicHost(bad), null, bad);
  assert.equal(parsePublicHost(undefined), null);
});

test('malformed trusted-proxy entries are dropped, never widening the set', () => {
  const list = parseProxyList('127.0.0.1, not-an-ip, 10.0.0.0/99, 192.168.0.0/16, ::1');
  assert.equal(list.check('127.0.0.1', 'ipv4'), true);
  assert.equal(list.check('192.168.4.4', 'ipv4'), true);
  assert.equal(list.check('10.0.0.1', 'ipv4'), false);
  assert.equal(list.check('::1', 'ipv6'), true);
});

test('a trailing slash or a bad prefix never becomes /0', () => {
  const v4 = ['172.17.0.1/', '172.17.0.1/ ', '172.17.0.1/abc', '172.17.0.1/33', '172.17.0.1/-1', '172.17.0.1/+8', '172.17.0.1/8.0', '172.17.0.1/0x8', '172.17.0.1/8/0'];
  const v6 = ['::1/', '::1/ ', '::1/abc', '::1/129', '::1/1e2'];
  for (const entry of [...v4, ...v6]) {
    const { list, dropped } = parseProxyEntries(entry);
    assert.deepEqual(dropped, [entry.trim()], `${entry} is dropped`);
    assert.equal(list.check('198.51.100.7', 'ipv4'), false, `${entry} trusts no stranger`);
    assert.equal(list.check('2001:db8::7', 'ipv6'), false, `${entry} trusts no stranger`);
  }
  // Valid prefixes still work, at both ends of the range.
  assert.equal(parseProxyList('10.0.0.0/8').check('10.9.9.9', 'ipv4'), true);
  assert.equal(parseProxyList('10.0.0.1/32').check('10.0.0.2', 'ipv4'), false);
  assert.equal(parseProxyList('fd00::/8').check('fd12::1', 'ipv6'), true);
  assert.equal(parseProxyList('::1/128').check('::1', 'ipv6'), true);
});

test('startup names every dropped trusted-proxy entry', () => {
  const { warnings, errors } = edgeStartupCheck({ ENGINE_TRUSTED_PROXIES: '127.0.0.1, 172.17.0.1/, ::1/129, not-an-ip' });
  assert.deepEqual(errors, []);
  for (const entry of ['172.17.0.1/', '::1/129', 'not-an-ip']) assert.ok(warnings.some((w) => w.includes(`"${entry}"`)), entry);
  assert.equal(warnings.length, 3);
  assert.deepEqual(edgeStartupCheck({}).warnings, []);
});

test('Origin allowlist: built-ins always, the seat origin derived, extras from env, never a wildcard', () => {
  const builtIn = ['http://localhost:5173', 'http://127.0.0.1:5173', 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];
  const local = edgePolicy({});
  for (const origin of builtIn) assert.ok(local.origins.has(origin), origin);
  assert.equal(local.origins.has('https://seat.example.test'), false);

  const seat = edgePolicy({ ENGINE_PUBLIC_HOST: 'seat.example.test', ENGINE_ALLOWED_ORIGINS: ' https://app.example.edu/ ,*,null,' });
  for (const origin of builtIn) assert.ok(seat.origins.has(origin), `${origin} stays allowed on a seat`);
  assert.ok(seat.origins.has('https://seat.example.test'), 'derived from ENGINE_PUBLIC_HOST, no duplication needed');
  assert.ok(seat.origins.has('https://app.example.edu'), 'trailing slash normalised');
  assert.equal(seat.origins.has('http://seat.example.test'), false, 'the edge serves https only');
  assert.equal(seat.origins.has('*'), false);
  assert.equal(seat.origins.has('null'), false);

  const served = edgePolicy({ ENGINE_STATIC_DIR: '/srv/ui' }, 4520);
  assert.ok(served.origins.has('http://127.0.0.1:4520'), 'the engine-served UI may call its own origin');
  assert.equal(edgePolicy({}, 4520).origins.has('http://127.0.0.1:4520'), false, 'only when it serves the UI');
});

test('startup refuses configs that would run device mode on a reachable engine', () => {
  const refused = (env: NodeJS.ProcessEnv, bind?: string) => edgeStartupCheck(env, bind).errors;
  assert.deepEqual(refused({}), [], 'the loopback default');
  assert.deepEqual(refused({}, '127.0.0.1'), []);
  assert.deepEqual(refused({}, '::1'), []);
  assert.deepEqual(refused({}, 'localhost'), []);
  assert.equal(refused({}, '0.0.0.0').length, 1, 'a public bind without a public host');
  assert.match(refused({}, '::')[0]!, /ENGINE_PUBLIC_HOST/);
  assert.equal(refused({ ENGINE_ALLOWED_ORIGINS: 'https://seat.example.test' }).length, 1, 'the fail-open seat from the review');
  assert.equal(refused({ ENGINE_ALLOWED_ORIGINS: 'https://seat.example.test' }, '0.0.0.0').length, 2);
  assert.deepEqual(refused({ ENGINE_ALLOWED_ORIGINS: 'http://localhost:4173,https://tauri.localhost,http://[::1]:5173' }), [], 'loopback origins are fine');
  assert.equal(refused({ ENGINE_PUBLIC_HOST: 'localhost' }).length, 1, 'a public host that parses to nothing is not silently device mode');

  // A hosted seat may bind and serve publicly.
  assert.deepEqual(refused({ ENGINE_PUBLIC_HOST: 'seat.example.test', ENGINE_ALLOWED_ORIGINS: 'https://app.example.edu' }, '0.0.0.0'), []);
  // A container publishing its port on loopback declares its gateway instead (docker-compose.yml), and is warned.
  const container = edgeStartupCheck({ ENGINE_DEVICE_PEERS: '172.16.0.0/12' }, '0.0.0.0');
  assert.deepEqual(container.errors, []);
  assert.match(container.warnings.join(' '), /beyond loopback/);
  // A non-loopback http origin is not refused, but is said out loud.
  const lan = edgeStartupCheck({ ENGINE_ALLOWED_ORIGINS: 'http://192.168.1.5:5173' });
  assert.deepEqual(lan.errors, []);
  assert.equal(lan.warnings.length, 1);
});

test('remote(): hosted, forwarded or non-loopback', async () => {
  const policy = (env: NodeJS.ProcessEnv) => edgePolicy(env);
  const remoteOf = async (env: NodeJS.ProcessEnv, peer: string | null, headers: Record<string, string> = {}) => {
    const p = policy(env);
    const app = new Hono();
    app.get('/', (c) => c.json(p.remote(c)));
    return (await app.request('/', { headers: { host: '127.0.0.1:4100', ...headers } }, socketFrom(peer))).json();
  };
  assert.equal(await remoteOf({}, '127.0.0.1'), false);
  assert.equal(await remoteOf({}, '::1'), false);
  assert.equal(await remoteOf({}, '127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }), true);
  assert.equal(await remoteOf({}, '127.0.0.1', { 'x-forwarded-host': 'x' }), true);
  assert.equal(await remoteOf({}, '127.0.0.1', { 'x-forwarded-proto': 'https' }), true);
  assert.equal(await remoteOf({}, '127.0.0.1', { forwarded: 'for=1.2.3.4' }), true);
  assert.equal(await remoteOf({}, '192.168.1.9'), true);
  assert.equal(await remoteOf({ ENGINE_PUBLIC_HOST: SEAT }, '127.0.0.1'), true, 'hosted is always remote');
  assert.equal(await remoteOf({ ENGINE_DEVICE_PEERS: '192.168.0.0/16' }, '192.168.1.9'), false);
  assert.equal(await remoteOf({ ENGINE_DEVICE_PEERS: '192.168.1.9/' }, '8.8.8.8'), true, 'a malformed device peer never widens to /0');
});
