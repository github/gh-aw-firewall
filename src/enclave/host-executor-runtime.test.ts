import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  HOST_EXECUTOR_DEFAULT_STATUS_LEASE_MS,
  prepareHostExecutorRuntime,
  validateRunState,
} from './host-executor-runtime';
import type { HostExecutorRunState } from './host-executor-server';

describe('host executor runtime preparation boundary', () => {
  let root: string;
  let runState: HostExecutorRunState;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awf-host-runtime-')));
    runState = {
      runId: 'a'.repeat(32),
      seedsDir: path.join(root, 'seeds'),
      invocationsDir: path.join(root, 'invocations'),
      journalDir: path.join(root, 'journal'),
      entries: [{
        entryId: 'script', executorKind: 'script', timeoutMs: 1_000,
        staticSeedIds: ['b'.repeat(32)], dynamicAgents: false,
      }],
    };
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('snapshots and freezes trusted run policy rather than retaining mutable catalogs', () => {
    const validated = validateRunState(runState);
    expect(validated).toEqual(runState);
    expect(validated).not.toBe(runState);
    expect(validated.entries[0].staticSeedIds).not.toBe(runState.entries[0].staticSeedIds);
    for (const value of [validated, validated.entries, validated.entries[0], validated.entries[0].staticSeedIds]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => validateRunState({ ...runState, seedsDir: `${root}/../seeds` }))
      .toThrow(/normalized absolute path/);
    expect(() => validateRunState({ ...runState, entries: [...runState.entries, ...runState.entries] }))
      .toThrow(/duplicate entry ID/);
  });

  it('creates the private runtime and exclusive capability only after durable setup', () => {
    const runtimeDir = path.join(root, 'runtime');
    const runtime = prepareHostExecutorRuntime({ runState, runtimeDir });
    expect(runtime.statusLeaseMs).toBe(HOST_EXECUTOR_DEFAULT_STATUS_LEASE_MS);
    expect(fs.statSync(runtimeDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(runtime.capabilityPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(runtime.capabilityPath, 'utf8')).toBe(runtime.capability.toString('hex'));
    expect(fs.existsSync(path.join(runState.journalDir!, `${runState.runId}.journal`))).toBe(true);
    expect(() => prepareHostExecutorRuntime({ runState, runtimeDir })).toThrow(/already exists/);
    expect(fs.readFileSync(runtime.capabilityPath, 'utf8')).toBe(runtime.capability.toString('hex'));
    runtime.capability.fill(0);
  });

  it('rejects a runtime directory symlink without writing a capability into its target', () => {
    const target = path.join(root, 'target');
    const runtimeDir = path.join(root, 'runtime');
    fs.mkdirSync(target);
    fs.symlinkSync(target, runtimeDir);
    expect(() => prepareHostExecutorRuntime({ runState, runtimeDir })).toThrow(/real directory/);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('never replaces existing or dangling capability symlinks', () => {
    const runtimeDir = path.join(root, 'runtime');
    const target = path.join(root, 'target');
    fs.mkdirSync(runtimeDir);
    fs.writeFileSync(target, 'preserved');
    const capabilityPath = path.join(runtimeDir, 'capability');
    fs.symlinkSync(target, capabilityPath);
    expect(() => prepareHostExecutorRuntime({ runState, runtimeDir })).toThrow(/already exists/);
    expect(fs.readFileSync(target, 'utf8')).toBe('preserved');
    fs.unlinkSync(target);
    expect(() => prepareHostExecutorRuntime({ runState, runtimeDir })).toThrow(/EEXIST/);
    expect(fs.lstatSync(capabilityPath).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('validates the lease and journal separation before creating a journal or capability', () => {
    const runtimeDir = path.join(root, 'runtime');
    expect(() => prepareHostExecutorRuntime({ runState, runtimeDir, statusLeaseMs: 0 }))
      .toThrow(/status lease/);
    expect(fs.existsSync(runState.journalDir!)).toBe(false);
    expect(() => prepareHostExecutorRuntime({
      runState: { ...runState, journalDir: path.join(runtimeDir, 'journal') }, runtimeDir,
    })).toThrow(/journal must be separate/);
    expect(fs.readdirSync(runtimeDir)).toEqual([]);
  });
});
