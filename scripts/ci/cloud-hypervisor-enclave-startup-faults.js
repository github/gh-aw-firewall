'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');

const FAULT_PHASES = Object.freeze(['vmCreate', 'vmBoot']);

// This module is loaded only by the acceptance driver, never by the CLI.
// The control is a host closure; it has no file, environment, or wire selector.
function withStartupFault(storage, phase, capture, ApiClient) {
  if (!FAULT_PHASES.includes(phase)) throw new Error('Unsupported host startup fault phase');
  if (!ApiClient) ApiClient = require('../../dist/cloud-hypervisor/api-client').CloudHypervisorApiClient;
  let fired = false;
  const fail = async (socketPath) => {
    if (fired) throw new Error('Host startup fault was unexpectedly reused');
    fired = true;
    await capture(socketPath);
    throw new Error('Acceptance-only host startup fault');
  };
  class StartupFaultClient extends ApiClient {
    async vmCreate(config) {
      await super.vmCreate(config);
      if (phase === 'vmCreate') await fail(this.faultSocket);
    }
    async vmBoot() {
      await super.vmBoot();
      if (phase === 'vmBoot') await fail(this.faultSocket);
    }
  }
  return {
    ...storage,
    managerDependencies: {
      ...storage.managerDependencies,
      createClient(socketPath, timeoutMs) {
        const client = new StartupFaultClient({ socketPath, timeoutMs });
        client.faultSocket = socketPath;
        return client;
      },
    },
  };
}

function assertAllocatedResources(resource, cleanup, runId, invocationId, ownerPid) {
  if (resource.runId !== runId || resource.invocationId !== invocationId
      || resource.owner?.pid !== ownerPid || resource.state !== 'pending'
      || !resource.directoryIdentity || !resource.mount || !resource.snapshot
      || !resource.storage?.mountedIdentity || !resource.storage?.mounts?.length
      || cleanup.runId !== resource.vmRunId || cleanup.owner?.pid !== ownerPid
      || cleanup.workload?.invocationId !== invocationId
      || !cleanup.identities?.runDirectory || !cleanup.identities?.cgroup
      || !cleanup.identities?.netns || !cleanup.vmmIdentity?.uid
      || cleanup.processes?.vmm?.state !== 'live'
      || !cleanup.processes.vmm.identity || !cleanup.mounts?.length
      || !Object.values(cleanup.processes).some((record) =>
        record !== cleanup.processes.vmm && record.state === 'live' && record.identity)) {
    throw new Error('Startup fault did not reach genuine journaled VM, network, cgroup and virtio-fs allocation');
  }
}

function assertStartupCleanup(before, after, cleanup, exists) {
  const identities = (record) => ({
    runId: record.runId, entryId: record.entryId, invocationId: record.invocationId,
    vmRunId: record.vmRunId, owner: record.owner, bootId: record.bootId,
    directory: record.directory, directoryIdentity: record.directoryIdentity,
    ancestors: record.ancestors, mount: record.mount, snapshot: record.snapshot,
    storage: record.storage,
  });
  const expected = {
    ...before,
    storage: {
      ...before.storage,
      mounts: before.storage.mounts.filter((mount) => mount.mountPoint !== before.snapshot.path),
    },
  };
  if (after.state !== 'cleaned' || !isDeepStrictEqual(identities(expected), identities(after))
      || [before.directory, before.storage.directory, before.snapshot.path,
        cleanup.paths.runDirectory, cleanup.paths.cgroupPath,
        cleanup.paths.virtiofsdShareDirectory, cleanup.network.netnsPath,
        `/run/awf-cloud-hypervisor/pending-cleanup/${before.vmRunId}.json`].some(exists)) {
    throw new Error('Startup failure did not clean the exact recorded resource identities');
  }
}

async function runStartupFaultProbes(options) {
  const { ProductionTrustedCloudHypervisorEnclaveStorageProvider } =
    require('../../dist/cloud-hypervisor/trusted-enclave-storage');
  const { startCloudHypervisorEnclaveHostService } =
    require('../../dist/enclave/cloud-hypervisor-host-service');
  const { hostExecutorVmRunId } = require('../../dist/enclave/host-executor-journal');
  const { finiteSchemaHash } = require('../../dist/bounded-execution/schema-hash');
  const { processMatches } = require('../../dist/cloud-hypervisor/cleanup-process');
  const { resolveCleanupDependencies } = require('../../dist/cloud-hypervisor/cleanup-dependencies');
  const { validateRecord } = require('../../dist/cloud-hypervisor/cleanup-identity');
  const { createHostExecutorClient } = require('../../containers/enclave/mcp-server/host-executor-client');
  const { assertNoVmResidue } = require('./cloud-hypervisor-enclave-live-smoke');
  const provider = new ProductionTrustedCloudHypervisorEnclaveStorageProvider();
  const processDependencies = resolveCleanupDependencies();
  await provider.assertAvailable(options.config);
  let count = 0;
  for (const role of ['script', 'agent']) {
    for (const phase of FAULT_PHASES) {
      const directory = path.join(options.directory, `fault-${count++}`);
      fs.mkdirSync(directory, { mode: 0o700 });
      const runId = crypto.randomBytes(16).toString('hex');
      const invocationId = crypto.randomBytes(16).toString('hex');
      const seedId = crypto.randomBytes(16).toString('hex');
      const seedsDir = path.join(directory, 'seeds');
      fs.mkdirSync(seedsDir, { mode: 0o700 });
      fs.mkdirSync(path.join(seedsDir, seedId), { mode: 0o700 });
      fs.copyFileSync(path.resolve(__dirname, '../../README.md'), path.join(seedsDir, seedId, 'README.md'));
      const runState = {
        runId, seedsDir, invocationsDir: path.join(directory, 'invocations'),
        entries: [{
          entryId: role, executorKind: role, timeoutMs: 180_000,
          staticSeedIds: [seedId], dynamicAgents: false,
        }],
      };
      const serviceOptions = {
        config: options.config, environment: options.environment, runState,
        runtimeDir: path.join(directory, 'host'), workDir: directory,
        agentPolicies: {
          agent: { model: 'gpt-4.1', profile: 'openai', maxOutputBytes: 8192 },
        },
      };
      const storageRun = await provider.prepareRun(serviceOptions);
      const prepare = storageRun.backendDependencies.prepareInvocationStorage;
      if (!prepare) throw new Error('Production invocation storage seam is unavailable');
      const vmRunId = hostExecutorVmRunId({ runId, entryId: role, invocationId });
      const resourceFile = `/var/lib/awf-cloud-hypervisor/host-executor-journal/${runId}-${invocationId}.resources.json`;
      const cleanupFile = `/run/awf-cloud-hypervisor/pending-cleanup/${vmRunId}.json`;
      let evidence;
      let server;
      try {
        server = await startCloudHypervisorEnclaveHostService({
          ...serviceOptions,
          backendDependencies: {
            ...storageRun.backendDependencies,
            prepareInvocationStorage: async (...args) => withStartupFault(
              await prepare(...args), phase, async (socketPath) => {
                if (evidence) throw new Error('Startup fault produced duplicate evidence');
                const resource = JSON.parse(fs.readFileSync(resourceFile, 'utf8'));
                const cleanup = JSON.parse(fs.readFileSync(cleanupFile, 'utf8'));
                validateRecord(cleanup, cleanupFile, '/run/awf-cloud-hypervisor/pending-cleanup');
                assertAllocatedResources(resource, cleanup, runId, invocationId, process.pid);
                if (socketPath !== path.join(cleanup.paths.runDirectory, 'api.socket')
                    || !fs.statSync(socketPath).isSocket()
                    || !fs.existsSync(cleanup.paths.cgroupPath)) {
                  throw new Error('Startup fault allocation evidence is not live');
                }
                for (const record of Object.values(cleanup.processes)) {
                  if (record.state !== 'live' || !record.identity
                      || !await processMatches(processDependencies, record.identity, record)) {
                    throw new Error('Startup fault process identity is not live');
                  }
                }
                evidence = { resource, cleanup };
              },
            ),
          },
        });
        const client = createHostExecutorClient({ ...server, runId });
        const schema = { type: 'const', value: true };
        const request = {
          entryId: role, invocationId, executorKind: role, seedId,
          payload: role === 'script' ? 'raise SystemExit(99)' : 'Do not execute any tools.',
          schema, schemaHash: finiteSchemaHash(schema),
          admissionId: crypto.randomBytes(16).toString('hex'),
        };
        let response = await client.invoke(request);
        const deadline = Date.now() + 210_000;
        while (response.ok && ['running', 'cancelling'].includes(response.state) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          response = await client.status({ entryId: role, invocationId });
        }
        if (!evidence || !response.ok || response.state !== 'terminal'
            || response.outcome !== 'executor-failure' || response.result !== undefined) {
          throw new Error('Live startup fault did not produce a cleaned canonical executor failure');
        }
        assertStartupCleanup(evidence.resource, JSON.parse(fs.readFileSync(resourceFile, 'utf8')),
          evidence.cleanup, fs.existsSync);
        for (const record of Object.values(evidence.cleanup.processes)) {
          if (await processMatches(processDependencies, record.identity, record)) {
            throw new Error('Startup failure left an identity-matched VMM or virtio-fs process');
          }
        }
        const settled = await client.settle({ entryId: role, invocationId, resultDigest: response.resultDigest });
        if (!settled.ok || settled.state !== 'settled') throw new Error('Startup failure could not settle');
        const replay = await client.invoke(request);
        if (replay.ok || !['conflict', 'replayed', 'invalid-state'].includes(replay.error)) {
          throw new Error('Startup failure invocation was replayable');
        }
        assertNoVmResidue();
      } finally {
        if (server) await server.close();
        await storageRun.close();
      }
    }
  }
}

module.exports = { FAULT_PHASES, withStartupFault, assertAllocatedResources, assertStartupCleanup, runStartupFaultProbes };
