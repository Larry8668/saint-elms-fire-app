import { BlockList, isIP } from 'node:net';
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

/**
 * Who may talk to the engine over HTTP. By default it serves loopback only: a hostile web
 * page can hit 127.0.0.1 but cannot produce an allowed Origin, and the Host check rejects
 * DNS-rebound names.
 *
 * A hosted seat sits behind a TLS edge that connects from the box itself: it forwards
 * `Host: 127.0.0.1:<port>` and names the public host in X-Forwarded-Host, the client in
 * X-Forwarded-For and the scheme in X-Forwarded-Proto. Those headers are honoured only
 * when the operator opted in (ENGINE_TRUST_PROXY) and the socket peer is a trusted proxy
 * (ENGINE_TRUSTED_PROXIES, loopback by default); from anyone else they are ignored.
 */
export interface EdgePolicy {
  /** The seat's published hostname, lower-cased, or null for a loopback-only engine. */
  publicHost: string | null;
  origins: ReadonlySet<string>;
  trustProxy: boolean;
  /** Host gate: loopback, the public host, and — through a trusted proxy — a forwarded host that is the public host. */
  admits(c: Context): boolean;
  /** The address to rate-limit by: the first untrusted hop through a trusted proxy, else the socket peer. */
  client(c: Context): string;
  /** 'https' only when a trusted proxy said so; a direct connection is plain http. */
  scheme(c: Context): 'http' | 'https';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Origins every engine accepts: the Vite dev server and the Tauri webview schemes. */
const BUILT_IN_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];

const DEFAULT_TRUSTED_PROXIES = '127.0.0.0/8,::1';

export const hostName = (host: string | undefined): string => {
  if (!host) return '';
  // RFC 7230 brackets IPv6 in Host, but a bare literal must not lose its colons to the port split.
  if (isIP(host) === 6) return host.toLowerCase();
  const bracketed = host.match(/^\[(.+)\]/)?.[1];
  return (bracketed ?? host.split(':')[0]!).toLowerCase();
};

/** Accepts `seat.example.test`, `seat.example.test:443` or `https://seat.example.test/`; anything else is ignored. */
export function parsePublicHost(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let candidate: string;
  try {
    candidate = new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  // A public host that is itself loopback, or a wildcard, would widen nothing safely.
  if (!candidate || LOOPBACK_HOSTS.has(candidate) || candidate.includes('*')) return null;
  return candidate;
}

/** `::ffff:127.0.0.1` is the IPv4 peer a dual-stack socket reports; compare it as IPv4. */
const normalizeIp = (address: string): string => {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  return mapped ?? address;
};

/** Parses `ip` and `ip/prefix` entries; malformed ones are dropped rather than widening the set. */
export function parseProxyList(raw: string): BlockList {
  const list = new BlockList();
  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    const [address, prefix] = entry.split('/');
    const family = isIP(address ?? '');
    if (!family) continue;
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) {
      list.addAddress(address!, type);
      continue;
    }
    const bits = Number(prefix);
    if (Number.isInteger(bits) && bits >= 0 && bits <= (family === 4 ? 32 : 128)) list.addSubnet(address!, bits, type);
  }
  return list;
}

const listed = (list: BlockList, address: string | null): boolean => {
  if (!address) return false;
  const ip = normalizeIp(address);
  const family = isIP(ip);
  return family !== 0 && list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
};

const truthy = (value: string | undefined) => ['1', 'true', 'yes'].includes(value?.trim().toLowerCase() ?? '');

/** The socket peer, or null for an in-process request (tests) that has no socket. */
const peerOf = (c: Context): string | null => {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
};

const lastEntry = (header: string | undefined): string | undefined => header?.split(',').map((part) => part.trim()).filter(Boolean).at(-1);

export function edgePolicy(env: NodeJS.ProcessEnv = process.env, enginePort?: number): EdgePolicy {
  const publicHost = parsePublicHost(env.ENGINE_PUBLIC_HOST);
  const trustProxy = truthy(env.ENGINE_TRUST_PROXY);
  const proxies = parseProxyList(env.ENGINE_TRUSTED_PROXIES?.trim() || DEFAULT_TRUSTED_PROXIES);
  const origins = new Set(
    [
      ...BUILT_IN_ORIGINS,
      // The edge terminates TLS, so the served UI's origin is always https.
      ...(publicHost ? [`https://${publicHost}`] : []),
      // The engine's own loopback origin, for its served UI opened on this machine.
      ...(env.ENGINE_STATIC_DIR?.trim() && enginePort ? [`http://127.0.0.1:${enginePort}`, `http://localhost:${enginePort}`] : []),
      ...(env.ENGINE_ALLOWED_ORIGINS ?? '').split(','),
    ]
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter((o) => o && o !== '*' && o !== 'null'),
  );

  const viaProxy = (c: Context) => trustProxy && listed(proxies, peerOf(c));
  const hostOk = (host: string | undefined) => {
    const name = hostName(host);
    return LOOPBACK_HOSTS.has(name) || (publicHost !== null && name === publicHost);
  };

  return {
    publicHost,
    origins,
    trustProxy,
    admits: (c) => {
      if (!hostOk(c.req.header('host'))) return false;
      if (!viaProxy(c)) return true;
      // A trusted proxy's forwarded host must be ours; absent means a local caller on the box.
      const forwarded = lastEntry(c.req.header('x-forwarded-host'));
      return forwarded === undefined || (publicHost !== null && hostName(forwarded) === publicHost);
    },
    client: (c) => {
      const peer = peerOf(c);
      if (viaProxy(c)) {
        // Right to left: every hop a trusted proxy appended, until the first one it did not
        // vouch for. Entries left of that are whatever the client chose to send.
        const hops = (c.req.header('x-forwarded-for') ?? '').split(',').map((part) => part.trim()).filter(Boolean);
        for (let i = hops.length - 1; i >= 0; i -= 1) {
          if (!listed(proxies, hops[i]!)) return normalizeIp(hops[i]!).slice(0, 64);
        }
      }
      return peer ? normalizeIp(peer) : 'local';
    },
    scheme: (c) => (viaProxy(c) && lastEntry(c.req.header('x-forwarded-proto'))?.toLowerCase() === 'https' ? 'https' : 'http'),
  };
}
