import * as path from 'path';
import type { ExecaChildProcess } from 'execa';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import type { MicrovmNetworkLifecycle, MicrovmNetworkPlan } from '../microvm/network';
import type { CloudHypervisorApiClient, CloudHypervisorVmCounters, CloudHypervisorVmInfo } from './api-client';
import {
  formatError,
  type CloudHypervisorManagerDependencies,
  type CloudHypervisorRunPaths,
} from './manager-types';
import type { CloudHypervisorCgroup } from './launcher';
import type { MicrovmRootfsPreparer } from '../microvm/rootfs';
import type { VirtiofsdManager, VirtiofsdDevice } from './virtiofsd';
import type { CloudHypervisorGuestChannel } from './guest-execution';

const SHUTDOWN_GRACE_MS = 5_000;

export interface CloudHypervisorStopContext {
  config: CloudHypervisorOptions;
  dependencies: CloudHypervisorManagerDependencies;
  paths: CloudHypervisorRunPaths;
  process?: ExecaChildProcess<string>;
  client?: CloudHypervisorApiClient;
  network?: MicrovmNetworkLifecycle;
  networkPlan?: MicrovmNetworkPlan;
  rootfsPreparer?: MicrovmRootfsPreparer;
  virtiofsd?: VirtiofsdManager;
  fsDevices: VirtiofsdDevice[];
  guest?: CloudHypervisorGuestChannel;
  cgroup?: CloudHypervisorCgroup;
  instanceStarted: boolean;
  lastVmInfo?: CloudHypervisorVmInfo;
  lastVmCounters?: CloudHypervisorVmCounters;
  preserve?: boolean;
  beforeCleanup?: () => Promise<void>;
  setProcess(process: ExecaChildProcess<string> | undefined): void;
  setClient(client: CloudHypervisorApiClient | undefined): void;
  setNetwork(network: MicrovmNetworkLifecycle | undefined): void;
  setNetworkPlan(plan: MicrovmNetworkPlan | undefined): void;
  setRootfsPreparer(preparer: MicrovmRootfsPreparer | undefined): void;
  setVirtiofsd(virtiofsd: VirtiofsdManager | undefined): void;
  setFsDevices(devices: VirtiofsdDevice[]): void;
  setGuest(guest: CloudHypervisorGuestChannel | undefined): void;
  setCgroup(cgroup: CloudHypervisorCgroup | undefined): void;
  setInstanceStarted(started: boolean): void;
  setLastVmInfo(info: CloudHypervisorVmInfo | undefined): void;
  setLastVmCounters(counters: CloudHypervisorVmCounters | undefined): void;
}

export async function stopCloudHypervisor(context: CloudHypervisorStopContext): Promise<void> {
  const errors: unknown[] = [];
  const instanceWasStarted = context.instanceStarted;
  if (context.client && instanceWasStarted) {
    try { context.setLastVmInfo(await context.client.vmInfo()); } catch { context.setLastVmInfo(undefined); }
    try { context.setLastVmCounters(await context.client.vmCounters()); } catch { context.setLastVmCounters(undefined); }
  }
  let guestShutdownAcknowledged = false;
  if (context.guest) {
    const outcome = await context.guest.shutdown();
    guestShutdownAcknowledged = outcome.acknowledged;
    if (outcome.error !== undefined) errors.push(outcome.error);
  }
  context.setGuest(undefined);
  if (context.client && instanceWasStarted && guestShutdownAcknowledged) {
    try { await context.client.vmShutdown(); } catch { /* process termination is authoritative */ }
  }
  if (context.client) {
    try { await context.client.vmmShutdown(); } catch { /* process termination is authoritative */ }
  }

  let terminationConfirmed = !context.process ||
    context.process.exitCode !== null || context.process.signalCode !== null;
  if (context.process && context.process.exitCode === null && context.process.signalCode === null) {
    const child = context.process;
    try {
      terminationConfirmed = await waitForProcessExit(child, context.dependencies, SHUTDOWN_GRACE_MS);
      if (!child.killed && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM', { forceKillAfterTimeout: 2_000 });
      }
      if (!terminationConfirmed) {
        await child;
        if (child.exitCode === null && child.signalCode === null) {
          throw new Error('Cloud Hypervisor process termination was not confirmed');
        }
      }
      terminationConfirmed = true;
    } catch (error) {
      terminationConfirmed = child.exitCode !== null || child.signalCode !== null;
      errors.push(error);
    }
  }
  if (!terminationConfirmed && context.process) {
    if (errors.length === 0) errors.push(new Error('Cloud Hypervisor process termination was not confirmed'));
    try { await context.virtiofsd?.stop(); context.setVirtiofsd(undefined); context.setFsDevices([]); }
    catch (error) { errors.push(error); }
    throw new Error(`Cloud Hypervisor cleanup stopped before network/run-directory removal: ${errors.map(formatError).join('; ')}`);
  }
  context.setProcess(undefined);
  context.setClient(undefined);
  let virtiofsdTerminationConfirmed = true;
  try { await context.virtiofsd?.stop(); context.setVirtiofsd(undefined); }
  catch (error) { virtiofsdTerminationConfirmed = false; errors.push(error); }
  if (context.beforeCleanup) {
    try { await context.beforeCleanup(); } catch (error) { errors.push(error); }
  }
  if (!virtiofsdTerminationConfirmed) {
    throw new Error(`Cloud Hypervisor cleanup stopped before cgroup/run-directory removal: ${errors.map(formatError).join('; ')}`);
  }
  context.setFsDevices([]);
  context.setInstanceStarted(false);
  if (context.rootfsPreparer) {
    try {
      await context.dependencies.rm(path.dirname(context.rootfsPreparer.rootfsImagePath), { recursive: true, force: true });
    } catch (error) { errors.push(error); }
  }
  context.setRootfsPreparer(undefined);
  if (context.preserve) {
    try { await context.cgroup?.cleanup(); } catch (error) { errors.push(error); }
    context.setCgroup(undefined);
    throwCleanupErrors(errors, 'Cloud Hypervisor preservation failed: ');
    return;
  }
  try { await context.network?.cleanup(); context.setNetwork(undefined); context.setNetworkPlan(undefined); }
  catch (error) { errors.push(error); }
  try { await context.cgroup?.cleanup(); } catch (error) { errors.push(error); }
  context.setCgroup(undefined);
  if (!instanceWasStarted || terminationConfirmed) {
    try {
      await context.dependencies.rm(
        path.join(context.paths.runBaseDir, path.basename(context.config.cloudHypervisorBinary), context.paths.runId),
        { recursive: true, force: true },
      );
    } catch (error) { errors.push(error); }
  }
  throwCleanupErrors(errors, 'Cloud Hypervisor cleanup failed: ');
}

async function waitForProcessExit(
  child: ExecaChildProcess<string>,
  dependencies: CloudHypervisorManagerDependencies,
  timeoutMs: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < Math.max(1, Math.ceil(timeoutMs / 25)); attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    await dependencies.sleep(25);
  }
  return child.exitCode !== null || child.signalCode !== null;
}

function throwCleanupErrors(errors: unknown[], prefix: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new Error(`${prefix}${errors.map(formatError).join('; ')}`);
}
