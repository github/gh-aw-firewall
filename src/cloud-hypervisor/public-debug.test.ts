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
      ...(debug ? { enclaveDebugArtifactDirectory: '/protected/cloud-hypervisor/invocation' } : {}),
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
        expect.objectContaining({ length: CLOUD_HYPERVISOR_CAPTURE_LIMIT_BYTES }), { mode: 0o600 });
      expect(deps.writeFile).toHaveBeenCalledWith(
        '/protected/cloud-hypervisor/invocation/guest-stderr.raw.log',
        Buffer.from('RAW_GUEST_SECRET'), { mode: 0o600 });
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
    const deps = dependencies({ enclaveDebugArtifactDirectory: '/protected/cloud-hypervisor/failed-write' });
    const vm = new CloudHypervisorManager(config({ enclaveDebugPublic: true }), '/tmp/awf',
      deps, 'failed-write', profile(true), undefined, undefined, true);
    await vm.start();
    jest.spyOn(vm, 'collectDiagnostics').mockRejectedValue(new Error('artifact write failed'));
    await expect(vm.stop()).rejects.toThrow();
  });

  it('retains evidence when failed termination prevents the normal cleanup hook', async () => {
    const child = processMock();
    jest.mocked(child.kill).mockImplementation(() => { throw new Error('termination failed'); });
    const deps = dependencies({
      enclaveDebugArtifactDirectory: '/protected/cloud-hypervisor/failed-stop',
      launch: jest.fn().mockReturnValue(child),
    });
    const vm = new CloudHypervisorManager(config({ enclaveDebugPublic: true }), '/tmp/awf',
      deps, 'failed-stop', profile(true), undefined, undefined, true);
    await vm.start();
    await expect(vm.stop()).rejects.toThrow(/termination failed/);
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/protected/cloud-hypervisor/failed-stop/guest-stderr.raw.log', Buffer.alloc(0), { mode: 0o600 });
    expect(deps.rm).not.toHaveBeenCalled();
  });
});
