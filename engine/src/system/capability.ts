import os from 'node:os';
import type { DeviceCapability, TieredRole } from '@sef/shared';
import { config, errorFields, log } from '../config';
import { spawnProcess, type RunCommand } from '../media/process';

const GB = 1024 ** 3;
const PROBE_TIMEOUT_MS = 5_000;
/** OSes report a few percent under the installed size (firmware and kernel reservations). */
const REPORTED_RAM_SLACK = 0.95;

export const GEMMA4 = { e2b: 'gemma4:e2b', e4b: 'gemma4:e4b', b26: 'gemma4:26b', b31: 'gemma4:31b' } as const;

interface Tier {
  minRamGb: number;
  suggested: Record<TieredRole, string>;
}

/**
 * Highest first. The brain (batch keeper/reviewer) climbs first; the tutor stays on e4b for
 * chat latency until there is room for two large models; vision stays on an E-model because
 * only those carry the audio encoder that source transcription depends on.
 */
export const TIERS: readonly Tier[] = [
  { minRamGb: 64, suggested: { tutor: GEMMA4.b26, brain: GEMMA4.b31, vision: GEMMA4.e4b } },
  { minRamGb: 48, suggested: { tutor: GEMMA4.e4b, brain: GEMMA4.b31, vision: GEMMA4.e4b } },
  { minRamGb: 32, suggested: { tutor: GEMMA4.e4b, brain: GEMMA4.b26, vision: GEMMA4.e4b } },
  { minRamGb: 12, suggested: { tutor: GEMMA4.e4b, brain: GEMMA4.e4b, vision: GEMMA4.e4b } },
  { minRamGb: 0, suggested: { tutor: GEMMA4.e2b, brain: GEMMA4.e2b, vision: GEMMA4.e2b } },
];

/** The OS seams detection reads through; tests replace them with fixed machines. */
export interface CapabilityProbe {
  platform: NodeJS.Platform;
  totalMemBytes: () => number;
  run: RunCommand;
}

const systemProbe: CapabilityProbe = { platform: process.platform, totalMemBytes: os.totalmem, run: spawnProcess };

const configuredDefaults = (): Record<TieredRole, string> => {
  const d = config.defaults;
  return { tutor: d.tutorModel, brain: d.brainModel, vision: d.visionModel };
};

export function suggestFor(ramGb: number | null): Record<TieredRole, string> {
  if (ramGb === null) return configuredDefaults();
  const tier = TIERS.find((t) => ramGb >= t.minRamGb * REPORTED_RAM_SLACK) ?? TIERS[TIERS.length - 1]!;
  return { ...tier.suggested };
}

function readRamGb(probe: CapabilityProbe): number | null {
  try {
    const bytes = probe.totalMemBytes();
    return Number.isFinite(bytes) && bytes > 0 ? Math.round((bytes / GB) * 10) / 10 : null;
  } catch (error) {
    log.warn('ram_probe_failed', errorFields(error));
    return null;
  }
}

/** stdout of a zero-exit command, or undefined for anything else — a probe never throws. */
async function tryRun(run: RunCommand, command: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await run(command, args, { timeoutMs: PROBE_TIMEOUT_MS });
    return result.code === 0 ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

export function parseDarwinGpu(json: string): string | undefined {
  try {
    const displays = (JSON.parse(json) as { SPDisplaysDataType?: Array<{ sppci_model?: string }> }).SPDisplaysDataType ?? [];
    return displays.find((d) => d.sppci_model)?.sppci_model;
  } catch {
    return undefined;
  }
}

/** Best-effort and read-only: absence of an answer is never treated as absence of a GPU. */
export async function probeGpu(probe: CapabilityProbe): Promise<string | undefined> {
  if (probe.platform === 'darwin') {
    const out = await tryRun(probe.run, 'system_profiler', ['SPDisplaysDataType', '-json']);
    return out ? parseDarwinGpu(out) : undefined;
  }
  if (probe.platform === 'linux') {
    const nvidia = await tryRun(probe.run, 'nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']);
    const name = nvidia?.split('\n').map((line) => line.trim()).find(Boolean);
    if (name) return name;
    return (await tryRun(probe.run, 'rocm-smi', ['--showproductname'])) !== undefined ? 'AMD GPU (ROCm)' : undefined;
  }
  return undefined;
}

export async function detectCapability(probe: CapabilityProbe = systemProbe): Promise<DeviceCapability> {
  const ramGb = readRamGb(probe);
  const gpu = await probeGpu(probe);
  const capability: DeviceCapability = { ramGb, ...(gpu ? { gpu } : {}), suggested: suggestFor(ramGb) };
  log.info('device_capability', { ramGb, gpu: gpu ?? null, ...capability.suggested });
  return capability;
}
