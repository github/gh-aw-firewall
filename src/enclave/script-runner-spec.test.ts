import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const root = path.join(__dirname, '..', '..', 'containers');
const {
  deriveQueryContainerSpec,
  ENCLAVE_INVOCATION_LABEL,
  ENCLAVE_RUN_LABEL,
} = require(path.join(root, 'enclave', 'script-executor', 'script-runner-spec.js'));
const { loadConfig } = require(path.join(root, 'enclave', 'mcp-server', 'config.js'));
/* eslint-enable @typescript-eslint/no-require-imports */

describe('unified enclave script runner specification', () => {
  const config = {
    hostWorkDir: '/daemon/private/enclave/work',
    queryMountDir: '/query',
    queryScriptPath: '/awf/query-script.py',
    querySeccompPath: '/opt/awf/query-seccomp.json',
    queryImage: 'ghcr.io/github/awf-enclave-script:pinned',
    memoryLimit: '768m',
    cpuLimit: '0.5',
    pidsLimit: 47,
    tmpfsLimit: '96m',
    queryUid: 65534,
    queryGid: 65534,
    runLabelKey: ENCLAVE_RUN_LABEL,
    invocationLabelKey: ENCLAVE_INVOCATION_LABEL,
    containerPrefix: 'awf-enclave-script',
  };

  it('uses enclave labels and every trusted isolation/resource control', () => {
    const spec = deriveQueryContainerSpec({
      config,
      runId: 'abcdef1234567890',
      invocationId: '0123456789abcdef',
      runtimeName: 'runsc',
      request: {
        image: 'attacker/image',
        memoryLimit: '99g',
        network: 'host',
        mounts: ['/etc:/host'],
      },
    });
    const args = spec.launchArgs;
    expect(spec.containerName).toBe('awf-enclave-script-abcdef123456-0123456789abcdef');
    expect(args).toEqual(expect.arrayContaining([
      '--label', 'awf.enclave.run=abcdef1234567890',
      '--label', 'awf.enclave.invocation=0123456789abcdef',
      '--network', 'none',
      '--read-only',
      '--memory', '768m',
      '--memory-swap', '768m',
      '--cpus', '0.5',
      '--pids-limit', '47',
      '--runtime', 'runsc',
      '--security-opt', 'no-new-privileges:true',
    ]));
    expect(args).toContain('/tmp:rw,noexec,nosuid,nodev,size=96m');
    expect(args).toContain('/query:rw,nosuid,nodev,size=96m,uid=65534,gid=65534,mode=0700');
    expect(args).toContain('/daemon/private/enclave/work/0123456789abcdef/out:/awf/out:rw');
    expect(args).not.toContain('/daemon/private/enclave/work/0123456789abcdef/out:/query/out:rw');
    expect(args.join(' ')).not.toMatch(/attacker|99g|network host|\/etc:\/host/);
    expect(spec.runListArgs).toContain('label=awf.enclave.run=abcdef1234567890');
    expect(spec.invocationListArgs).toContain(
      'label=awf.enclave.invocation=0123456789abcdef',
    );
  });

  it('loads trusted resource and disclosure bounds only from server environment', () => {
    const original = { ...process.env };
    Object.assign(process.env, {
      AWF_ENCLAVE_BACKEND: 'gvisor',
      AWF_ENCLAVE_PRIMARY_BACKEND: 'docker',
      AWF_ENCLAVE_HOST_WORK_DIR: '/daemon/private/enclave/work',
      AWF_ENCLAVE_IMAGE: 'image:pinned',
      AWF_ENCLAVE_TIMEOUT: '41',
      AWF_ENCLAVE_MEMORY: '700m',
      AWF_ENCLAVE_CPU: '0.25',
      AWF_ENCLAVE_PIDS: '33',
      AWF_ENCLAVE_TMPFS: '80m',
      AWF_ENCLAVE_MAX_OUTPUT_BYTES: '4096',
      AWF_ENCLAVE_MAX_SCRIPT_BYTES: '2048',
    });
    try {
      expect(loadConfig({ readFileSync: () => 'a'.repeat(64) })).toMatchObject({
        executorBackend: 'gvisor',
        timeoutSeconds: 41,
        memoryLimit: '700m',
        cpuLimit: '0.25',
        pidsLimit: 33,
        tmpfsLimit: '80m',
        maxOutputBytes: 4096,
        maxScriptBytes: 2048,
        runLabelKey: 'awf.enclave.run',
        invocationLabelKey: 'awf.enclave.invocation',
      });
    } finally {
      process.env = original;
    }
  });
});
