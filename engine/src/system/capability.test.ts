import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../config';
import { ProcessError, type RunCommand } from '../media/process';
import { detectCapability, GEMMA4, parseDarwinGpu, probeGpu, SHIELDGEMMA, suggestFor, type CapabilityProbe } from './capability';

const GB = 1024 ** 3;

/** A runner that answers known commands and reports anything else as not installed. */
const fakeRun =
  (answers: Record<string, { code: number; stdout: string }>, calls: string[] = []): RunCommand =>
  async (command) => {
    calls.push(command);
    const answer = answers[command];
    if (!answer) throw new ProcessError(`${command} is not installed on this device.`, 'missing');
    return { ...answer, stderr: '' };
  };

const machine = (ramGb: number, platform: NodeJS.Platform = 'darwin', run: RunCommand = fakeRun({})): CapabilityProbe => ({
  platform,
  totalMemBytes: () => ramGb * GB,
  run,
});

test('the tier table sizes each role to installed memory', () => {
  const cases: Array<[number, string, string, string, string]> = [
    [8, GEMMA4.e2b, GEMMA4.e2b, GEMMA4.e2b, SHIELDGEMMA.b2],
    [16, GEMMA4.e4b, GEMMA4.e4b, GEMMA4.e4b, SHIELDGEMMA.b2],
    [24, GEMMA4.e4b, GEMMA4.e4b, GEMMA4.e4b, SHIELDGEMMA.b2],
    [32, GEMMA4.e4b, GEMMA4.b26, GEMMA4.e4b, SHIELDGEMMA.b9],
    [36, GEMMA4.e4b, GEMMA4.b26, GEMMA4.e4b, SHIELDGEMMA.b9],
    [48, GEMMA4.e4b, GEMMA4.b31, GEMMA4.e4b, SHIELDGEMMA.b9],
    [64, GEMMA4.b26, GEMMA4.b31, GEMMA4.e4b, SHIELDGEMMA.b9],
    [128, GEMMA4.b26, GEMMA4.b31, GEMMA4.e4b, SHIELDGEMMA.b9],
  ];
  for (const [ram, tutor, brain, vision, safety] of cases) {
    assert.deepEqual(suggestFor(ram), { tutor, brain, vision, safety }, `${ram} GB`);
  }
  assert.equal(suggestFor(31.2).safety, SHIELDGEMMA.b9, 'a 32 GB machine reporting ~31 GiB still gets the larger screener');
});

test('a machine reporting slightly under its installed size keeps its tier', () => {
  assert.equal(suggestFor(31.2).brain, GEMMA4.b26, 'a 32 GB Linux box reports ~31 GiB');
  assert.equal(suggestFor(15.5).tutor, GEMMA4.e4b);
  assert.equal(suggestFor(28).brain, GEMMA4.e4b, 'well under 32 GB is not rounded up');
});

test('vision never leaves the E-models, which carry the audio encoder', () => {
  for (const ram of [8, 16, 32, 48, 64, 256]) {
    assert.match(suggestFor(ram).vision, /:e[24]b$/);
  }
});

test('unreadable memory degrades quietly to the configured defaults', async () => {
  const d = config.defaults;
  assert.deepEqual(suggestFor(null), { tutor: d.tutorModel, brain: d.brainModel, vision: d.visionModel, safety: d.safetyModel });

  for (const totalMemBytes of [() => 0, () => Number.NaN, () => { throw new Error('no /proc'); }]) {
    const capability = await detectCapability({ platform: 'linux', totalMemBytes, run: fakeRun({}) });
    assert.equal(capability.ramGb, null);
    assert.equal(capability.suggested.brain, d.brainModel);
    assert.equal(capability.gpu, undefined);
  }
});

test('the GPU probe reads system_profiler on macOS', async () => {
  const json = JSON.stringify({ SPDisplaysDataType: [{ _name: 'kHW_AppleM3ProItem', sppci_model: 'Apple M3 Pro' }] });
  const capability = await detectCapability(machine(36, 'darwin', fakeRun({ system_profiler: { code: 0, stdout: json } })));
  assert.deepEqual(capability, { ramGb: 36, gpu: 'Apple M3 Pro', suggested: suggestFor(36) });
  assert.equal(parseDarwinGpu('not json'), undefined);
  assert.equal(parseDarwinGpu('{}'), undefined);
});

test('the GPU probe prefers nvidia-smi, then rocm-smi, on Linux', async () => {
  const nvidia = fakeRun({ 'nvidia-smi': { code: 0, stdout: 'NVIDIA GeForce RTX 4090\nNVIDIA GeForce RTX 4090\n' } });
  assert.equal(await probeGpu(machine(64, 'linux', nvidia)), 'NVIDIA GeForce RTX 4090');

  const calls: string[] = [];
  const rocm = fakeRun({ 'rocm-smi': { code: 0, stdout: 'Card series: Radeon' } }, calls);
  assert.equal(await probeGpu(machine(64, 'linux', rocm)), 'AMD GPU (ROCm)');
  assert.deepEqual(calls, ['nvidia-smi', 'rocm-smi']);
});

test('a failing or missing probe is RAM-only, never an error', async () => {
  const failing = fakeRun({ 'nvidia-smi': { code: 9, stdout: '' }, 'rocm-smi': { code: 1, stdout: '' } });
  const capability = await detectCapability(machine(32, 'linux', failing));
  assert.equal(capability.gpu, undefined);
  assert.equal(capability.suggested.brain, GEMMA4.b26);

  const timedOut: RunCommand = async () => {
    throw new ProcessError('system_profiler did not answer', 'timed_out');
  };
  assert.equal(await probeGpu(machine(16, 'darwin', timedOut)), undefined);
  assert.equal(await probeGpu(machine(16, 'win32')), undefined, 'unsupported platforms are not probed');
});
