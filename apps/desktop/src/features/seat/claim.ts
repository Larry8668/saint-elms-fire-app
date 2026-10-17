import { SeatError, type BootstrapStatus, type SeatClient, type SeatMachine } from '@/lib/instabox';

/**
 * "Claim your seat": the checklist that turns an Instabox key into a running engine.
 *
 * Every step is safe to run again, so a retry re-runs the failed step and carries on:
 * - the create reuses the same Idempotency-Key, and a labelled-machine list runs first, so a
 *   resumed flow never makes a second box;
 * - publishing a port is idempotent server side;
 * - the bootstrap script converges, and a run already in progress is joined, not restarted.
 *
 * Publishing comes before bootstrap: the engine's env needs the edge hostname, and
 * publishing is instant and starts nothing.
 *
 * Progress (machine id, idempotency keys, seat URL) persists between attempts; it holds no
 * secret. The key itself goes into the OS keychain in the first step and stays there.
 */

export const CLAIM_STEPS = ['key', 'machine', 'ready', 'publish', 'bootstrap', 'health', 'save'] as const;
export type ClaimStepId = (typeof CLAIM_STEPS)[number];

export const STEP_LABEL: Record<ClaimStepId, string> = {
  key: 'Instabox key saved in your keychain',
  machine: 'Find or create your seat machine',
  ready: 'Machine running',
  publish: 'Publish the engine URL',
  bootstrap: 'Install the engine, vault and models',
  health: 'Engine answering at its public URL',
  save: 'Remember this seat',
};

export interface ClaimFailure {
  code: string;
  message: string;
  /** The step a retry starts from (usually the failed one). */
  retryFrom: ClaimStepId;
}

export type StepStatus = 'pending' | 'running' | 'done' | 'error';

export interface ClaimView {
  steps: Record<ClaimStepId, StepStatus>;
  current: ClaimStepId | null;
  failure: ClaimFailure | null;
  /** Live detail for the running step: the bootstrap's own sub-steps, a poll count. */
  detail: string | null;
  bootstrap: BootstrapStatus | null;
  seatUrl: string | null;
  complete: boolean;
}

/** What survives between attempts. Non-secret by construction. */
export interface ClaimProgress {
  machineId?: string;
  createKey?: string;
  createOperationId?: string;
  powerKey?: string;
  seatUrl?: string;
  doneThrough?: ClaimStepId;
}

export interface ProgressStore {
  load(): ClaimProgress;
  save(progress: ClaimProgress): void;
  clear(): void;
}

export interface ClaimConfig {
  machineName: string;
  gitRef: string;
  uniUrl: string;
  /** A key typed in this attempt; absent when the keychain already has one. */
  key?: string;
}

export interface ClaimDeps {
  client: SeatClient;
  store: ProgressStore;
  /** Persist the finished seat (lib/seat.ts writeSeat in the app). */
  remember: (seat: { engineUrl: string; machineId: string }) => void;
  newKey?: () => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onChange?: (view: ClaimView) => void;
  timing?: Partial<typeof DEFAULT_TIMING>;
}

export const DEFAULT_TIMING = {
  machinePollMs: 3_000,
  machineDeadlineMs: 5 * 60_000,
  maxOperationPolls: 24,
  bootstrapPollMs: 5_000,
  bootstrapDeadlineMs: 45 * 60_000,
  /** A launched run that never takes its lock within this window did not start. */
  bootstrapStartGraceMs: 60_000,
  healthPollMs: 3_000,
  healthDeadlineMs: 4 * 60_000,
};

const GONE: ReadonlySet<SeatMachine['state']> = new Set(['deleting', 'deleted', 'error']);

/** Plain copy for each failure the student can act on. Never the raw message alone. */
export function describeFailure(code: string, fallback: string): string {
  switch (code) {
    case 'key_missing':
      return 'Paste your Instabox API key to start.';
    case 'unauthenticated':
    case 'api_key_revoked':
    case 'api_key_expired':
      return 'Instabox did not accept that key. Create a new one in the Instabox dashboard and paste it again.';
    case 'insufficient_scope':
    case 'permission_denied':
      return 'That key cannot manage machines. Create a key with Full access, or at least machines:read, machines:write and machines:delete.';
    case 'invite_required':
      return 'Your Instabox account is not activated yet. Redeem your invite code (your university sends one at admission), then retry.';
    case 'quota_exceeded':
      return 'Your Instabox account is at its machine limit. Delete a machine you no longer need in the Instabox dashboard, then retry.';
    case 'no_capacity':
      return 'Instabox has no free capacity right now. Nothing was created; try again in a few minutes.';
    case 'machine_not_running':
      return 'Your seat machine is stopped or paused. Retry starts it again.';
    case 'network':
      return 'Could not reach Instabox. Check your connection, then retry.';
    case 'shell_unavailable':
      return 'Seat setup runs in the desktop app; this window cannot reach it.';
    default:
      return fallback;
  }
}

/** Errors whose outcome is unknown (nothing came back) keep the same create key on retry. */
const outcomeUnknown = (error: SeatError) => error.status === 0;

class StepFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryFrom?: ClaimStepId,
  ) {
    super(message);
  }
}

export class ClaimRunner {
  private progress: ClaimProgress;
  private view: ClaimView;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly newKey: () => string;
  private readonly timing: typeof DEFAULT_TIMING;
  private cancelled = false;

  constructor(private readonly deps: ClaimDeps) {
    this.progress = deps.store.load();
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
    this.newKey = deps.newKey ?? (() => crypto.randomUUID());
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    // Past the key step, progress is only as good as the machine it points at.
    const recorded = this.progress.doneThrough ? CLAIM_STEPS.indexOf(this.progress.doneThrough) : -1;
    const through = this.progress.machineId ? recorded : Math.min(recorded, 0);
    this.view = {
      steps: Object.fromEntries(CLAIM_STEPS.map((s, i) => [s, i <= through ? 'done' : 'pending'])) as Record<ClaimStepId, StepStatus>,
      current: null,
      failure: null,
      detail: null,
      bootstrap: null,
      seatUrl: this.progress.seatUrl ?? null,
      complete: false,
    };
  }

  get state(): ClaimView {
    return this.view;
  }

  /** Stops polling at the next opportunity (the dialog closed). Progress is kept. */
  cancel() {
    this.cancelled = true;
  }

  /**
   * Runs from `from` (default: the first unfinished step) to the end, or until a step fails.
   * A key step always runs when a key is supplied, so a corrected key replaces a rejected one.
   */
  async run(config: ClaimConfig, from?: ClaimStepId): Promise<ClaimView> {
    this.cancelled = false;
    let start = from ?? CLAIM_STEPS.find((s) => this.view.steps[s] !== 'done') ?? 'save';
    if (config.key) start = 'key';
    const startIndex = CLAIM_STEPS.indexOf(start);
    for (const step of CLAIM_STEPS.slice(startIndex)) this.patch({ steps: { ...this.view.steps, [step]: 'pending' } });
    this.patch({ failure: null, complete: false });

    for (const step of CLAIM_STEPS.slice(startIndex)) {
      if (this.cancelled) return this.view;
      this.patch({ current: step, detail: null, steps: { ...this.view.steps, [step]: 'running' } });
      try {
        await this.steps[step](config);
      } catch (error) {
        if (this.cancelled) return this.view;
        const failure = this.failureOf(step, error);
        this.patch({ failure, detail: null, steps: { ...this.view.steps, [step]: 'error' } });
        return this.view;
      }
      this.update({ doneThrough: step });
      this.patch({ steps: { ...this.view.steps, [step]: 'done' } });
    }
    this.deps.store.clear();
    this.patch({ current: null, detail: null, complete: true });
    return this.view;
  }

  /** Re-runs from where the last failure says to. */
  retry(config: ClaimConfig) {
    return this.run(config, this.view.failure?.retryFrom);
  }

  private failureOf(step: ClaimStepId, error: unknown): ClaimFailure {
    if (error instanceof StepFailure) return { code: error.code, message: error.message, retryFrom: error.retryFrom ?? step };
    if (error instanceof SeatError) {
      // A stopped box fails later steps; starting it again is the ready step's job.
      const retryFrom = error.code === 'machine_not_running' && CLAIM_STEPS.indexOf(step) > CLAIM_STEPS.indexOf('ready') ? 'ready' : step;
      return { code: error.code, message: describeFailure(error.code, error.message), retryFrom };
    }
    return { code: 'unexpected', message: error instanceof Error ? error.message : String(error), retryFrom: step };
  }

  private patch(next: Partial<ClaimView>) {
    this.view = { ...this.view, ...next };
    this.deps.onChange?.(this.view);
  }

  private update(next: Partial<ClaimProgress>) {
    this.progress = { ...this.progress, ...next };
    for (const [k, v] of Object.entries(next)) if (v === undefined) delete (this.progress as Record<string, unknown>)[k];
    this.deps.store.save(this.progress);
  }

  private machineId(): string {
    if (!this.progress.machineId) throw new StepFailure('no_machine', 'There is no seat machine yet.', 'machine');
    return this.progress.machineId;
  }

  private readonly steps: Record<ClaimStepId, (config: ClaimConfig) => Promise<void>> = {
    key: async (config) => {
      const { client } = this.deps;
      if (config.key) await client.saveKey(config.key);
      else if (!(await client.hasKey())) throw new SeatError({ code: 'key_missing', message: 'No key yet.', status: 0, retryable: false });
      const account = await client.account();
      if (!account.activated) throw new StepFailure('invite_required', describeFailure('invite_required', ''));
    },

    machine: async (config) => {
      const { client } = this.deps;
      if (this.progress.machineId) {
        try {
          const known = await client.machine(this.progress.machineId);
          if (!GONE.has(known.state)) return;
        } catch (error) {
          if (!(error instanceof SeatError && error.code === 'not_found')) throw error;
        }
        this.update({ machineId: undefined, createOperationId: undefined, createKey: undefined, doneThrough: 'key' });
      }
      // The precheck: an existing labelled seat is adopted, never duplicated.
      const seats = (await client.listSeats()).filter((m) => !GONE.has(m.state));
      const existing = seats.find((m) => m.name === config.machineName) ?? seats[0];
      if (existing) {
        this.update({ machineId: existing.id, createOperationId: existing.operationId ?? undefined });
        this.patch({ detail: `Using your existing seat ${existing.name}` });
        return;
      }
      const createKey = this.progress.createKey ?? this.newKey();
      // Saved before the call: a retry after a lost response must replay, not create again.
      this.update({ createKey });
      try {
        const operation = await client.createSeat(config.machineName, createKey);
        this.update({ machineId: operation.machineId ?? undefined, createOperationId: operation.id });
      } catch (error) {
        // A definite refusal created nothing (no_capacity even frees the name); the next
        // attempt is a new request and needs a new key, or it would replay the refusal.
        if (error instanceof SeatError && !outcomeUnknown(error)) this.update({ createKey: undefined });
        throw error;
      }
      if (!this.progress.machineId) throw new StepFailure('unexpected_response', 'Instabox accepted the create but named no machine.');
    },

    ready: async () => {
      const { client } = this.deps;
      const id = this.machineId();
      if (this.progress.createOperationId) {
        for (let poll = 1; ; poll += 1) {
          const op = await client.operation(this.progress.createOperationId);
          if (op.state === 'succeeded') break;
          if (op.state === 'failed') {
            const code = op.error?.code ?? 'operation_failed';
            // A failed create leaves no machine; the next attempt starts from the precheck.
            if (op.type === 'create') this.update({ machineId: undefined, createKey: undefined, createOperationId: undefined, doneThrough: 'key' });
            throw new StepFailure(code, describeFailure(code, op.error?.message ?? 'Creating the machine failed.'), op.type === 'create' ? 'machine' : 'ready');
          }
          if (poll >= this.timing.maxOperationPolls) throw new StepFailure('operation_timeout', 'Instabox is still working on your machine. Retry to keep waiting.');
          this.patch({ detail: `Instabox: ${op.phase ?? op.state}` });
        }
        this.update({ createOperationId: undefined });
      }
      const deadline = this.now() + this.timing.machineDeadlineMs;
      for (;;) {
        if (this.cancelled) return;
        const machine = await client.machine(id);
        if (machine.state === 'running' && machine.runtime?.ready !== false) {
          this.update({ powerKey: undefined });
          return;
        }
        if (GONE.has(machine.state)) {
          this.update({ machineId: undefined, doneThrough: 'key' });
          throw new StepFailure('machine_gone', 'Your seat machine was deleted or failed. Retry creates a new one.', 'machine');
        }
        if (machine.state === 'stopped' || machine.state === 'suspended') {
          const powerKey = this.progress.powerKey ?? this.newKey();
          this.update({ powerKey });
          this.patch({ detail: machine.state === 'stopped' ? 'Starting your machine' : 'Resuming your machine' });
          await client.power(id, machine.state === 'stopped' ? 'start' : 'resume', powerKey);
        } else {
          this.patch({ detail: `Machine is ${machine.state}` });
        }
        if (this.now() > deadline) throw new StepFailure('machine_timeout', `The machine is still ${machine.state}. Retry to keep waiting.`);
        await this.sleep(this.timing.machinePollMs);
      }
    },

    publish: async () => {
      const port = await this.deps.client.publish(this.machineId());
      this.update({ seatUrl: port.url.replace(/\/+$/, '') });
      this.patch({ seatUrl: this.progress.seatUrl ?? null });
    },

    bootstrap: async (config) => {
      const { client } = this.deps;
      const id = this.machineId();
      const seatUrl = this.progress.seatUrl;
      if (!seatUrl) throw new StepFailure('no_url', 'The engine URL is not published yet.', 'publish');
      let status = await client.bootstrapStatus(id);
      this.patch({ bootstrap: status });
      if (status.state === 'done' && !status.running) return;
      let launchedAt = this.now();
      if (!status.running && status.state !== 'starting') {
        await client.startBootstrap(id, { gitRef: config.gitRef, publicHost: new URL(seatUrl).host, uniUrl: config.uniUrl });
        launchedAt = this.now();
      }
      const deadline = this.now() + this.timing.bootstrapDeadlineMs;
      for (;;) {
        if (this.cancelled) return;
        await this.sleep(this.timing.bootstrapPollMs);
        status = await client.bootstrapStatus(id);
        this.patch({ bootstrap: status, detail: describeBootstrap(status) });
        if (status.state === 'done' && !status.running) return;
        if (status.state.startsWith('failed:') && !status.running) {
          const step = status.state.slice('failed:'.length);
          throw new StepFailure('bootstrap_failed', `Setup stopped at "${step}". The log below says why; retry resumes from there.`);
        }
        if (status.state === 'starting' && !status.running && this.now() - launchedAt > this.timing.bootstrapStartGraceMs) {
          throw new StepFailure('bootstrap_not_started', 'The setup script did not start on the box. Retry launches it again.');
        }
        if (this.now() > deadline) throw new StepFailure('bootstrap_timeout', 'Setup is taking longer than expected. It keeps running on the box; retry to keep watching.');
      }
    },

    health: async () => {
      const seatUrl = this.progress.seatUrl;
      if (!seatUrl) throw new StepFailure('no_url', 'The engine URL is not published yet.', 'publish');
      const deadline = this.now() + this.timing.healthDeadlineMs;
      for (let attempt = 1; ; attempt += 1) {
        if (this.cancelled) return;
        const health = await this.deps.client.health(seatUrl);
        if (health.ok) return;
        if (health.status === 503) throw new StepFailure('machine_not_running', describeFailure('machine_not_running', ''), 'ready');
        this.patch({ detail: health.status === 502 ? `The engine is still starting (check ${attempt})` : `Waiting for the engine (check ${attempt})` });
        if (this.now() > deadline) throw new StepFailure('seat_unhealthy', 'The box is up but the engine is not answering. Retry setup to restart it.', 'bootstrap');
        await this.sleep(this.timing.healthPollMs);
      }
    },

    save: async () => {
      const seatUrl = this.progress.seatUrl;
      if (!seatUrl) throw new StepFailure('no_url', 'The engine URL is not published yet.', 'publish');
      this.deps.remember({ engineUrl: seatUrl, machineId: this.machineId() });
    },
  };
}

/** "Building the app (build), 4 of 8 steps done". */
export function describeBootstrap(status: BootstrapStatus): string {
  const running = status.steps.filter((s) => s.state === 'running').map((s) => s.name);
  const done = status.steps.filter((s) => s.state === 'done').length;
  if (status.state === 'starting' || status.steps.length === 0) return 'Starting the setup script';
  return running.length ? `Working on ${running.join(' and ')} (${done} steps done)` : `${done} steps done`;
}

/** localStorage-backed progress; the app's default store. */
export function localProgressStore(key = 'sef.seat.claim'): ProgressStore {
  return {
    load: () => {
      try {
        return (JSON.parse(localStorage.getItem(key) ?? '{}') as ClaimProgress) ?? {};
      } catch {
        return {};
      }
    },
    save: (progress) => localStorage.setItem(key, JSON.stringify(progress)),
    clear: () => localStorage.removeItem(key),
  };
}
