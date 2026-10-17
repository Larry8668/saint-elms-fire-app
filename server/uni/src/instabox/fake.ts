// A fake Instabox for contract and orchestrator tests: a real local HTTP server that keeps
// machines and operations, replays idempotent requests, enforces the machine quota, can run
// out of capacity, and serves each machine's published engine URL (`/engine/<id>/...`).
// Not a test file: only *.test.ts import it. Mirrors the behaviour recorded in
// docs/internal/CLOUD_SEAT_NOTES.md §4–§9, ported from PR-38's Rust contract tests.

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ExecResult, Machine, MachineState, Operation } from './client';

export const FAKE_KEY = 'ibk_fake_contract_key_0000';

export interface SeenRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

interface FakeOperation extends Operation {
  pollsLeft: number;
  finish?: () => void;
}

export type ExecHandler = (machine: Machine, body: { cmd: string; envs: Record<string, string>; timeoutSeconds: number }) =>
  | ExecResult
  | { status: number; code: string }
  | 'drop'
  | Promise<ExecResult | { status: number; code: string } | 'drop'>;

export interface Injection {
  match: (req: SeenRequest) => boolean;
  /** An HTTP error with an Instabox body, or 'drop' to cut the connection with no answer. */
  respond: { status: number; code: string; retryable?: boolean } | 'drop';
  times?: number;
}

const base32 = (n: number) => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = randomBytes(n);
  return Array.from(bytes, (b) => alphabet[b % 32]).join('');
};

function errorBody(status: number, code: string, retryable = false, operationId: string | null = null): [number, unknown] {
  return [status, { error: { code, message: `fake ${code}`, requestId: 'req_fake', retryable, operationId } }];
}

export class FakeInstabox {
  readonly seen: SeenRequest[] = [];
  readonly machines = new Map<string, Machine>();
  readonly operations = new Map<string, FakeOperation>();
  readonly deleted: string[] = [];
  readonly created: string[] = [];
  private readonly replays = new Map<string, { fingerprint: string; status: number; body: unknown }>();
  private server: Server | null = null;
  base = '';

  quota = 5;
  /** Polls an operation answers `running` before it finishes. */
  pollsToFinish = 1;
  /** The next N creates fail `no_capacity`: as a failed Operation ('op') or a synchronous 503 ('http'). */
  noCapacity = 0;
  noCapacityMode: 'op' | 'http' = 'op';
  /** A snapshot-restored box starts stopped per the docs; the measured one came back running (§9). */
  createdState: MachineState = 'stopped';
  pageSize = 50;
  injections: Injection[] = [];
  onExec: ExecHandler = () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false });
  /** The engine's public `/api/health` body per machine; a number answers with that status (502 = nothing listening). */
  health: (machineId: string) => unknown | number = () => ({ ok: true, engine: '0.2.0', uni: { reachable: true } });

  async listen(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.base;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  /** A machine that is not ours (the user's own box): the orchestrator must never touch it. */
  addForeignMachine(metadata: Record<string, string> = {}, state: MachineState = 'suspended'): Machine {
    const machine: Machine = { id: `m_${base32(26)}`, name: `box-${base32(6)}`, state, runtime: { ready: true }, metadata };
    this.machines.set(machine.id, machine);
    return machine;
  }

  requests(method: string, pathPrefix: string): SeenRequest[] {
    return this.seen.filter((r) => r.method === method && r.path.startsWith(pathPrefix));
  }

  private send(res: ServerResponse, status: number, body?: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  }

  private error(res: ServerResponse, status: number, code: string, retryable = false, operationId: string | null = null) {
    const [, body] = errorBody(status, code, retryable, operationId);
    this.send(res, status, body);
  }

  private op(type: string, machineId: string, finish?: () => void, failed?: { code: string }): FakeOperation {
    const op: FakeOperation = {
      id: `op_${base32(26)}`,
      type,
      machineId,
      state: failed ? 'failed' : 'queued',
      error: failed ? { code: failed.code, message: `fake ${failed.code}`, retryable: failed.code === 'no_capacity' } : null,
      pollsLeft: this.pollsToFinish,
      finish,
    };
    if (!failed && op.pollsLeft === 0) {
      op.state = 'succeeded';
      finish?.();
    }
    this.operations.set(op.id, op);
    return op;
  }

  private progress(op: FakeOperation) {
    if (op.state !== 'queued' && op.state !== 'running') return;
    if (op.pollsLeft > 0) {
      op.pollsLeft -= 1;
      op.state = 'running';
    } else {
      op.state = 'succeeded';
      op.finish?.();
    }
  }

  private publicOp({ pollsLeft: _p, finish: _f, ...op }: FakeOperation): Operation {
    return op;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
    const seen: SeenRequest = { method: req.method ?? 'GET', path: req.url ?? '/', headers, body: raw ? JSON.parse(raw) : undefined };
    const [path, query = ''] = seen.path.split('?');

    // The published engine URL: no API key (it is public), answers like the engine would.
    const engine = path!.match(/^\/engine\/(m_[a-z0-9]{26})(\/.*)$/);
    if (engine) {
      const machine = this.machines.get(engine[1]!);
      if (!machine) return this.send(res, 404, { error: 'This URL is not published.' });
      if (machine.state !== 'running') return this.send(res, 503, { error: 'Sandbox offline.' });
      if (engine[2] !== '/api/health') return this.send(res, 404);
      const health = this.health(machine.id);
      return typeof health === 'number' ? this.send(res, health, { error: 'Nothing is listening' }) : this.send(res, 200, health);
    }

    this.seen.push(seen);
    for (const injection of this.injections) {
      if ((injection.times ?? 1) > 0 && injection.match(seen)) {
        injection.times = (injection.times ?? 1) - 1;
        if (injection.respond === 'drop') return req.socket.destroy();
        return this.error(res, injection.respond.status, injection.respond.code, injection.respond.retryable ?? false);
      }
    }
    if (headers['x-api-key'] !== FAKE_KEY) return this.error(res, 401, 'unauthenticated');

    const key = headers['idempotency-key'];
    const lifecycle = (seen.method === 'POST' && (path === '/v1/machines' || /\/(start|resume|stop)$/.test(path!))) || seen.method === 'DELETE';
    if (lifecycle) {
      if (!key) return this.error(res, 400, 'bad_request');
      const fingerprint = createHash('sha256').update(`${seen.method} ${path} ${raw}`).digest('hex');
      const replay = this.replays.get(key);
      if (replay) {
        if (replay.fingerprint !== fingerprint) return this.error(res, 409, 'idempotency_conflict');
        return this.send(res, replay.status, replay.body);
      }
      const [status, body] = this.lifecycle(seen, path!);
      this.send(res, status, body);
      this.replays.set(key, { fingerprint, status, body });
      return;
    } else if (key) {
      // Exec and publish-port take no Idempotency-Key; the real API ignores one, the fake flags it.
      return this.error(res, 400, 'unexpected_idempotency_key');
    }

    if (seen.method === 'GET' && path === '/v1/machines') {
      const params = new URLSearchParams(query);
      const wanted = params.getAll('metadata').map((label) => {
        const at = label.indexOf(':');
        return [label.slice(0, at), label.slice(at + 1)] as const;
      });
      const all = [...this.machines.values()].filter((m) => wanted.every(([k, v]) => m.metadata?.[k] === v));
      const start = Number(params.get('cursor') ?? 0);
      const page = all.slice(start, start + this.pageSize);
      const next = start + this.pageSize < all.length ? String(start + this.pageSize) : null;
      return this.send(res, 200, { machines: page, nextCursor: next });
    }
    const machinePath = path!.match(/^\/v1\/machines\/(m_[a-z0-9]{26})(?:\/(exec|ports))?$/);
    if (seen.method === 'GET' && machinePath && !machinePath[2]) {
      // Real operations run on their own; here reading the machine moves its pending one along.
      for (const op of this.operations.values()) if (op.machineId === machinePath[1]) this.progress(op);
      const machine = this.machines.get(machinePath[1]!);
      return machine ? this.send(res, 200, machine) : this.error(res, 404, 'not_found');
    }
    const opPath = path!.match(/^\/v1\/operations\/(op_[a-z0-9]{26})$/);
    if (seen.method === 'GET' && opPath) {
      const op = this.operations.get(opPath[1]!);
      if (!op) return this.error(res, 404, 'not_found');
      this.progress(op);
      return this.send(res, 200, this.publicOp(op));
    }
    if (seen.method === 'POST' && machinePath?.[2] === 'exec') {
      const machine = this.machines.get(machinePath[1]!);
      if (!machine) return this.error(res, 404, 'not_found');
      if (machine.state !== 'running') return this.error(res, 409, 'machine_not_running');
      const result = await this.onExec(machine, seen.body);
      if (result === 'drop') return req.socket.destroy();
      if ('code' in result) return this.error(res, result.status, result.code);
      return this.send(res, 200, result);
    }
    if (seen.method === 'POST' && machinePath?.[2] === 'ports') {
      const machine = this.machines.get(machinePath[1]!);
      if (!machine) return this.error(res, 404, 'not_found');
      return this.send(res, 201, { id: 'pv_1', machineId: machine.id, port: seen.body.port, name: seen.body.name, url: `${this.base}/engine/${machine.id}`, createdAt: new Date().toISOString(), expiresAt: null });
    }
    return this.error(res, 404, 'not_found');
  }

  private lifecycle(seen: SeenRequest, path: string): [number, unknown] {
    if (seen.method === 'POST' && path === '/v1/machines') {
      if (this.noCapacity > 0) {
        this.noCapacity -= 1;
        if (this.noCapacityMode === 'http') return errorBody(503, 'no_capacity', true);
        // The sandbox is removed by Instabox; it never counts to quota.
        return [202, this.publicOp(this.op('create', `m_${base32(26)}`, undefined, { code: 'no_capacity' }))];
      }
      if (this.machines.size >= this.quota) return errorBody(429, 'quota_exceeded');
      if ([...this.machines.values()].some((m) => m.name === seen.body.name)) return errorBody(409, 'name_taken');
      const machine: Machine = {
        id: `m_${base32(26)}`,
        name: seen.body.name,
        state: 'creating',
        runtime: { ready: false },
        metadata: seen.body.metadata ?? {},
        createdAt: new Date().toISOString(),
      };
      this.machines.set(machine.id, machine);
      this.created.push(machine.id);
      const restored = seen.body.snapshotId ? this.createdState : 'running';
      const op = this.op('create', machine.id, () => {
        machine.state = restored;
        machine.runtime = { ready: restored === 'running' };
      });
      return [202, this.publicOp(op)];
    }
    const target = path.match(/^\/v1\/machines\/(m_[a-z0-9]{26})(?:\/(start|resume|stop))?$/);
    const machine = target ? this.machines.get(target[1]!) : undefined;
    if (!target || !machine) return errorBody(404, 'not_found');
    const running = [...this.operations.values()].find((o) => o.machineId === machine.id && (o.state === 'queued' || o.state === 'running'));
    const verb = seen.method === 'DELETE' ? 'delete' : target[2]!;
    if (running && running.type !== verb && running.type !== 'create') return errorBody(409, 'operation_conflict', false, running.id);
    if (verb === 'delete') {
      machine.state = 'deleting';
      const op = this.op('delete', machine.id, () => {
        this.machines.delete(machine.id);
        this.deleted.push(machine.id);
      });
      return [202, this.publicOp(op)];
    }
    const next: MachineState = verb === 'stop' ? 'stopped' : 'running';
    const op = this.op(verb, machine.id, () => {
      machine.state = next;
      machine.runtime = { ready: next === 'running' };
    });
    return [202, this.publicOp(op)];
  }
}
