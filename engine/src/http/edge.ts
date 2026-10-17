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
  /**
   * Whether the caller may be someone other than the person at this device: always on a
   * hosted seat, and otherwise whenever the request was forwarded (any X-Forwarded-* or
   * Forwarded header) or its socket peer is not loopback (or a listed ENGINE_DEVICE_PEERS
   * address). Device-only conveniences — the profile picker, the password-less offline
   * unlock and keyless device polls — close for remote callers.
   */
  remote(c: Context): boolean;
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

/**
 * Parses `ip` and `ip/prefix` entries; malformed ones are dropped rather than widening the
 * set, and named in `dropped` so startup can say so. The prefix must be 1-3 digits inside
 * the family's range: `Number('')` is 0, so a lenient parse would turn `10.0.0.1/` into /0.
 */
export function parseProxyEntries(raw: string): { list: BlockList; dropped: string[] } {
  const list = new BlockList();
  const dropped: string[] = [];
  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    const parts = entry.split('/');
    const address = parts[0]!;
    const family = isIP(address);
    if (!family || parts.length > 2) {
      dropped.push(entry);
      continue;
    }
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (parts.length === 1) {
      list.addAddress(address, type);
      continue;
    }
    const prefix = parts[1]!;
    const bits = /^\d{1,3}$/.test(prefix) ? Number(prefix) : NaN;
    if (bits >= 0 && bits <= (family === 4 ? 32 : 128)) list.addSubnet(address, bits, type);
    else dropped.push(entry);
  }
  return { list, dropped };
}

export const parseProxyList = (raw: string): BlockList => parseProxyEntries(raw).list;

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

const FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded'];

const lastEntry = (header: string | undefined): string | undefined => header?.split(',').map((part) => part.trim()).filter(Boolean).at(-1);

export function edgePolicy(env: NodeJS.ProcessEnv = process.env): EdgePolicy {
  const publicHost = parsePublicHost(env.ENGINE_PUBLIC_HOST);
  const trustProxy = truthy(env.ENGINE_TRUST_PROXY);
  const proxies = parseProxyList(env.ENGINE_TRUSTED_PROXIES?.trim() || DEFAULT_TRUSTED_PROXIES);
  // Direct peers that count as "this device": loopback, plus e.g. a container's bridge gateway.
  const devicePeers = parseProxyList([DEFAULT_TRUSTED_PROXIES, env.ENGINE_DEVICE_PEERS?.trim()].filter(Boolean).join(','));
  const origins = new Set(
    [
      ...BUILT_IN_ORIGINS,
      // The edge terminates TLS, so the served UI's origin is always https.
      ...(publicHost ? [`https://${publicHost}`] : []),
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
    remote: (c) => {
      if (publicHost !== null) return true;
      if (FORWARDING_HEADERS.some((name) => c.req.header(name) !== undefined)) return true;
      const peer = peerOf(c);
      // No socket at all is an in-process request (tests, app.request); a real one always has a peer.
      return peer !== null && !listed(devicePeers, peer);
    },
  };
}

export interface EdgeStartupCheck {
  /** Configurations that would fail open; the engine refuses to start on any of these. */
  errors: string[];
  warnings: string[];
}

const isLoopbackName = (name: string): boolean => {
  const host = name.replace(/^\[(.+)\]$/, '$1').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return isIP(host) !== 0 && listed(parseProxyList(DEFAULT_TRUSTED_PROXIES), host);
};

/**
 * Read once at boot: what the edge env would do, said out loud before the first request.
 * Without ENGINE_PUBLIC_HOST the engine runs in device mode, so a deployment that is in
 * fact reachable from elsewhere — a non-loopback bind, or an https origin it serves to —
 * would fail open. Those refuse to start instead.
 */
export function edgeStartupCheck(env: NodeJS.ProcessEnv = process.env, bindHost = env.ENGINE_HOST?.trim() || '127.0.0.1'): EdgeStartupCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const dropped = (name: string) => {
    const raw = env[name]?.trim();
    if (raw) for (const entry of parseProxyEntries(raw).dropped) warnings.push(`${name} entry "${entry}" is malformed and was dropped.`);
  };
  dropped('ENGINE_TRUSTED_PROXIES');
  dropped('ENGINE_DEVICE_PEERS');

  const publicHost = parsePublicHost(env.ENGINE_PUBLIC_HOST);
  if (env.ENGINE_PUBLIC_HOST?.trim() && !publicHost) {
    errors.push(`ENGINE_PUBLIC_HOST "${env.ENGINE_PUBLIC_HOST.trim()}" is not a usable public hostname (loopback and wildcards are refused).`);
  }
  if (publicHost) return { errors, warnings };

  if (!isLoopbackName(bindHost)) {
    if (env.ENGINE_DEVICE_PEERS?.trim()) {
      warnings.push(
        `ENGINE_HOST=${bindHost} listens beyond loopback without ENGINE_PUBLIC_HOST; direct callers from ENGINE_DEVICE_PEERS are treated as this device. Publish the port on loopback only.`,
      );
    } else {
      errors.push(
        `ENGINE_HOST=${bindHost} listens beyond loopback but ENGINE_PUBLIC_HOST is unset. Set ENGINE_PUBLIC_HOST for any public deployment, or ENGINE_DEVICE_PEERS for a container whose port is published on loopback only.`,
      );
    }
  }
  for (const origin of (env.ENGINE_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean)) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      continue;
    }
    if (isLoopbackName(url.hostname)) continue;
    if (url.protocol === 'https:') {
      errors.push(`ENGINE_ALLOWED_ORIGINS includes ${origin}, a public https origin, but ENGINE_PUBLIC_HOST is unset. Set ENGINE_PUBLIC_HOST for any public deployment.`);
    } else {
      warnings.push(`ENGINE_ALLOWED_ORIGINS includes non-loopback ${origin} while ENGINE_PUBLIC_HOST is unset.`);
    }
  }
  return { errors, warnings };
}
