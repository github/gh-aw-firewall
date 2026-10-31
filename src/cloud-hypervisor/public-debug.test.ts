import { Writable } from 'stream';
import { MicrovmVsockClient } from '../microvm/vsock-client';
import { CloudHypervisorManager } from './manager';
import { CLOUD_HYPERVISOR_CAPTURE_LIMIT_BYTES } from './manager-types';
import { createScriptEnclaveCloudHypervisorProfile } from './workload-profile';
import { config, dependencies, enclaveExportPlan, processMock } from './manager.test-utils';

function profile(debug: boolean) {
  return createScriptEnclaveCloudHypervisorProfile({
    enclaveId: 'script-entry', invocationId: 'b'.repeat(32),
    guest: { supervisorBinaryPath: '/opt/supervisor', supervisorSha256: 'a'.repeat(64) },
    exportPlan: enclaveExportPlan('script'),
    ...(debug ? { publicFixtureDebug: true } : {}),
  });
}

describe('public enclave debug manager lifecycle', () => {
  it('requires both explicit opt-in and a trusted host artifact destination', () => {
    expect(() => new CloudHypervisorManager(config(), '/tmp/awf', dependencies(),
      'debug', profile(true), undefined, undefined, true)).toThrow(/host-authorized/);
    expect(() => new CloudHypervisorManager(config({ enclaveDebugPublic: true }), '/tmp/awf',
      dependencies(), 'debug', profile(true), undefined, undefined, true)).toThrow(/host-authorized/);
  });

  it.each([false, true])('keeps default discard and public debug capture isolated (debug=%s)', async (debug) => {
    const client = new MicrovmVsockClient({ socketPath: '/unused', guestPort: 52 });
    jest.spyOn(client, 'connect').mockResolvedValue({
      version: 1, type: 'ready', requestId: 'control',
      capabilities: { stdin: true, tty: false, resize: false },
    });
    jest.spyOn(client, 'execute').mockResolvedValue({
      requestId: 'request', exitCode: 0, signal: null, timedOut: false,
    });
    const deps = dependencies({
      ...(debug ? {
        enclaveDebugArtifactDirectory: '/protected/cloud-hypervisor/invocation',
        enclaveDebugArtifactProtectedRoot: '/protected',
      } : {}),
      createVsockClient: jest.fn().mockReturnValue(client),
    });
    const vm = new CloudHypervisorManager(config({ enclaveDebugPublic: debug }), '/tmp/awf',
      deps, 'debug', profile(debug), undefined, undefined, true);
    await vm.start();
    await vm.startInstance();
    const untrusted = new Writable({ write: (_chunk, _encoding, done) => done() });
    const result = await vm.execute({ argv: ['true'], env: {}, cwd: '/', uid: 65534, gid: 65534,
      rawStdout: untrusted, rawStderr: untrusted });
    const request = jest.mocked(client.execute).mock.calls[0][0];
    if (debug) {
      expect(request.rawStdout).not.toBe(untrusted);
      expect(request.rawStderr).not.toBe(untrusted);
      request.rawStdout!.write(Buffer.alloc(CLOUD_HYPERVISOR_CAPTURE_LIMIT_BYTES + 100, 'x'));
      request.rawStderr!.write('RAW_GUEST_SECRET');
    } else {
      expect(request.rawStdout).toBeUndefined();
      expect(request.rawStderr).toBeUndefined();
    }
    expect(profile(debug).network).toEqual({ mode: 'none' });
    expect(profile(debug).resources).toEqual(profile(false).resources);
    expect(result).toEqual({ requestId: 'request', exitCode: 0, signal: null, timedOut: false });
    await vm.stop();
    if (debug) {
      expect(deps.writeFile).toHaveBeenCalledWith(
        '/protected/cloud-hypervisor/invocation/guest-stdout.raw.log',
        Buffer.alloc(0), { mode: 0o600 });
      expect(deps.writeFile).toHaveBeenCalledWith(
        '/protected/cloud-hypervisor/invocation/guest-stderr.raw.log',
        Buffer.from('RAW_GUEST_SECRET'), { mode: 0o600 });
      for (const [filePath, uid, gid] of jest.mocked(deps.chown).mock.calls) {
        if (filePath.startsWith('/protected/')) expect([uid, gid]).toEqual([0, 0]);
      }
      expect(deps.chown).toHaveBeenCalledWith('/protected', 0, 0);
      expect(deps.chmod).toHaveBeenCalledWith('/protected/cloud-hypervisor', 0o700);
      expect(deps.chmod).toHaveBeenCalledWith('/protected/cloud-hypervisor/invocation', 0o700);
      const writeOrder = jest.mocked(deps.writeFile).mock.invocationCallOrder[0];
      const deleteOrder = jest.mocked(deps.rm).mock.invocationCallOrder[0];
      expect(writeOrder).toBeLessThan(deleteOrder);
    } else {
      expect(deps.writeFile).not.toHaveBeenCalledWith(
        expect.stringContaining('guest-stdout.raw.log'), expect.anything(), expect.anything());
    }
  });

  it('collects failed-start diagnostics before automatic partial-start cleanup', async () => {
    const deps = dependencies({
      enclaveDebugArtifactDirectory: '/protected/cloud-hypervisor/failed-start',
      enclaveDebugArtifactProtectedRoot: '/protected',
      createClient: jest.fn(() => { throw new Error('API construction failed'); }),
    });
    const vm = new CloudHypervisorManager(config({ enclaveDebugPublic: true }), '/tmp/awf',
      deps, 'failed-start', profile(true), undefined, undefined, true);
    await expect(vm.start()).rejects.toThrow('API construction failed');
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/protected/cloud-hypervisor/failed-start/guest-stdout.raw.log', Buffer.alloc(0), { mode: 0o600 });
    expect(jest.mocked(deps.writeFile).mock.invocationCallOrder[0])
      .toBeLessThan(jest.mocked(deps.rm).mock.invocationCallOrder[0]);
    const writes = jest.mocked(deps.writeFile).mock.calls.length;
    await vm.stop();
    expect(jest.mocked(deps.writeFile).mock.calls.length).toBe(writes);
  });

  it('surfaces protected artifact collection failures instead of reporting successful cleanup', async () => {
    const deps = dependencies({
      enclaveDebugArtifactDirectory: '/protected/cloud-hypervisor/failed-write',
      enclaveDebugArtifactProtectedRoot: '/protected',
    });
    const vm = new CloudHypervisorManager(config({ enclaveDebugPublic: true }), '/tmp/awf',
      deps, 'failed-write', profile(true), undefined, undefined, true);
    await vm.start();
    jest.spyOn(vm, 'collectDiagnostics').mockRejectedValue(new Error('artifact write failed'));
    await expect(vm.stop()).rejects.toThrow();
  });

  it('retains evidence when failed termination prevents the normal cleanup hook', async () => {
    const child = processMock();
    jest.mocked(child.kill).mockImplementation(() => { throw new Error('termination failed'); });
    const readFileTail = jest.fn(async (source: string) => Buffer.from(
      source.includes('virtiofs') ? 'VIRTIOFS_EVIDENCE' : 'SOURCE_LOG',
    ));
    const deps = dependencies({
      enclaveDebugArtifactDirectory: '/protected/cloud-hypervisor/failed-stop',
      enclaveDebugArtifactProtectedRoot: '/protected',
      launch: jest.fn().mockReturnValue(child),
      readFileTail,
    });
    const vm = new CloudHypervisorManager(config({ enclaveDebugPublic: true }), '/tmp/awf',
      deps, 'failed-stop', profile(true), undefined, undefined, true);
    await vm.start();
    await expect(vm.stop()).rejects.toThrow(/termination failed/);
    expect(readFileTail).toHaveBeenCalledWith('/run/virtiofs-0.log', CLOUD_HYPERVISOR_CAPTURE_LIMIT_BYTES);
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/protected/cloud-hypervisor/failed-stop/guest-stderr.raw.log', Buffer.alloc(0), { mode: 0o600 });
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/protected/cloud-hypervisor/failed-stop/virtiofs-0-enclave-seed.log',
      Buffer.from('VIRTIOFS_EVIDENCE'), { mode: 0o600 });
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/protected/cloud-hypervisor/failed-stop/virtiofs-0-enclave-seed-confinement.json',
      Buffer.from('VIRTIOFS_EVIDENCE'), { mode: 0o600 });
    expect(deps.rm).not.toHaveBeenCalled();
  });

  it('retries a transient write failure before removing diagnostic sources', async () => {
    const readFileTail = jest.fn(async (source: string) =>
      source.endsWith('/serial.log') ? Buffer.from('SERIAL_TAIL') : Buffer.from('SOURCE'));
    const deps = dependencies({
      enclaveDebugArtifactDirectory: '/protected/cloud-hypervisor/transient-write',
      enclaveDebugArtifactProtectedRoot: '/protected',
      readFileTail,
    });
    jest.mocked(deps.writeFile).mockRejectedValueOnce(new Error('transient write failure'));
    const vm = new CloudHypervisorManager(config({ enclaveDebugPublic: true }), '/tmp/awf',
      deps, 'transient-write', profile(true), undefined, undefined, true);
    await vm.start();
    await expect(vm.stop()).rejects.toThrow(/transient write failure/);
    expect(deps.rm).not.toHaveBeenCalled();
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/protected/cloud-hypervisor/transient-write/serial.log',
      Buffer.from('SERIAL_TAIL'), { mode: 0o600 });

    await vm.stop();
    expect(readFileTail).toHaveBeenCalledWith(vm.paths.serialLogPath, CLOUD_HYPERVISOR_CAPTURE_LIMIT_BYTES);
    expect(deps.rm).toHaveBeenCalledWith(vm.paths.runDirectory, { recursive: true, force: true });
  });

  it('shares an in-flight collection across overlapping stop calls', async () => {
    const deps = dependencies({
      enclaveDebugArtifactDirectory: '/protected/cloud-hypervisor/concurrent-stop',
      enclaveDebugArtifactProtectedRoot: '/protected',
    });
    const vm = new CloudHypervisorManager(config({ enclaveDebugPublic: true }), '/tmp/awf',
      deps, 'concurrent-stop', profile(true), undefined, undefined, true);
    await vm.start();
    let finishCollection!: () => void;
    const collection = new Promise<void>((resolve) => { finishCollection = resolve; });
    const collect = jest.spyOn(vm, 'collectDiagnostics').mockReturnValue(collection);
    const first = vm.stop();
    const second = vm.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(collect).toHaveBeenCalledTimes(1);
    let secondFinished = false;
    void second.then(() => { secondFinished = true; }, () => { secondFinished = true; });
    expect(secondFinished).toBe(false);
    finishCollection();
    await Promise.allSettled([first, second]);
    expect(collect).toHaveBeenCalledTimes(1);
  });
});
