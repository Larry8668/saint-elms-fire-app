import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { edgePolicy, parseProxyList, parsePublicHost } from './edge';

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
