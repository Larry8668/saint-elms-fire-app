const TIMEOUT_MS = 15000;

/** The uni server could not be reached at all (offline, DNS, timeout). Callers fall back to local data. */
export class UniUnreachableError extends Error {}

/** The uni server answered with an error status. */
export class UniHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    url: string,
  ) {
    super(`${url} → HTTP ${status}`);
  }
}

interface UniRequest {
  token?: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
}

export async function uniFetch<T>(baseUrl: string, pathname: string, req: UniRequest = {}): Promise<T> {
  const url = `${baseUrl.replace(/\/+$/, '')}${pathname}`;
  const headers: Record<string, string> = {};
  if (req.token) headers.authorization = `Bearer ${req.token}`;
  if (req.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(url, {
      method: req.method ?? 'GET',
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(req.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (error) {
    throw new UniUnreachableError(`${url}: ${(error as Error).message}`);
  }
  if (!res.ok) throw new UniHttpError(res.status, await res.json().catch(() => null), url);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
