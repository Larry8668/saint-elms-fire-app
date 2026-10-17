/**
 * Typed client for seat provisioning. api.instabox.sh sends no CORS headers, so nothing here
 * calls it: every function is an `invoke` into the Tauri shell (src-tauri/src/seat), which
 * holds the student's key in the OS keychain and talks to Instabox itself. JavaScript hands
 * the key over once with `saveKey` and never sees it again.
 */

/** The shell's error shape. `code` is Instabox's own (`quota_exceeded`, `no_capacity`, ...) when it sent one. */
export interface SeatErrorShape {
  code: string;
  message: string;
  status: number;
  retryable: boolean;
}

export class SeatError extends Error implements SeatErrorShape {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  constructor(shape: SeatErrorShape) {
    super(shape.message);
    this.code = shape.code;
    this.status = shape.status;
    this.retryable = shape.retryable;
  }
}

export interface InstaboxAccount {
  login: string;
  activated: boolean;
  inviteRequired: boolean;
}

export type MachineState =
  | 'creating'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'suspending'
  | 'suspended'
  | 'resuming'
  | 'deleting'
  | 'deleted'
  | 'error';

export interface SeatMachine {
  id: string;
  name: string;
  state: MachineState;
  runtime?: { ready: boolean } | null;
  autoSuspendedAt?: string | null;
  operationId?: string | null;
}

export interface SeatOperation {
  id: string;
  machineId?: string | null;
  type: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  phase?: string | null;
  error?: { code: string; message: string; retryable: boolean } | null;
}

export interface PublishedPort {
  port: number;
  url: string;
}

export interface BootstrapParams {
  /** Git ref or commit of the app repo the box runs. */
  gitRef: string;
  publicHost: string;
  uniUrl: string;
  chatModel?: string;
  embedModel?: string;
}

export interface BootstrapStep {
  name: string;
  state: 'running' | 'done' | 'failed';
  seconds: number | null;
}

export interface BootstrapStatus {
  /** `absent`, `starting`, `running`, `done` or `failed:<step>`. */
  state: string;
  running: boolean;
  steps: BootstrapStep[];
  logTail: string;
}

export interface SeatHealth {
  ok: boolean;
  /** 0 when nothing answered; 502 box up but engine not listening; 503 box offline. */
  status: number;
}

/** How calls reach the shell. Tests pass a fake; the app uses Tauri's `invoke`. */
export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const isShape = (value: unknown): value is SeatErrorShape =>
  typeof value === 'object' && value !== null && typeof (value as SeatErrorShape).code === 'string' && typeof (value as SeatErrorShape).message === 'string';

/** True inside the desktop shell. A plain browser cannot provision a seat. */
export const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const tauriInvoke: Invoke = async <T,>(command: string, args?: Record<string, unknown>) => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
};

export function createSeatClient(invoke: Invoke = tauriInvoke) {
  const call = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>(command, args);
    } catch (error) {
      if (isShape(error)) throw new SeatError(error);
      throw new SeatError({ code: 'shell_unavailable', message: String(error), status: 0, retryable: false });
    }
  };
  return {
    saveKey: (key: string) => call<void>('seat_key_save', { key }),
    hasKey: () => call<boolean>('seat_key_present'),
    forgetKey: () => call<void>('seat_key_forget'),
    account: () => call<InstaboxAccount>('seat_account'),
    /** Machines carrying the seat label only (`metadata=app:sef-seat`). */
    listSeats: () => call<SeatMachine[]>('seat_list'),
    createSeat: (name: string, idempotencyKey: string) => call<SeatOperation>('seat_create', { name, idempotencyKey }),
    /** One long poll (up to 25 s server side). */
    operation: (operationId: string) => call<SeatOperation>('seat_operation', { operationId }),
    machine: (machineId: string) => call<SeatMachine>('seat_machine', { machineId }),
    power: (machineId: string, action: 'start' | 'resume', idempotencyKey: string) => call<SeatOperation>('seat_power', { machineId, action, idempotencyKey }),
    publish: (machineId: string) => call<PublishedPort>('seat_publish', { machineId }),
    startBootstrap: (machineId: string, params: BootstrapParams) => call<'started' | 'already_running'>('seat_bootstrap_start', { machineId, params }),
    bootstrapStatus: (machineId: string) => call<BootstrapStatus>('seat_bootstrap_status', { machineId }),
    health: (url: string) => call<SeatHealth>('seat_health', { url }),
  };
}

export type SeatClient = ReturnType<typeof createSeatClient>;
