import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CampaignManifest,
  SampleArtifact,
  aggregateCampaign,
  createCampaignManifest,
} from './nvx-benchmark-campaign';
import {
  buildMeasuredArtifact,
  buildMeasuredRecoveryArtifact,
  matchedRuntimeAdapterTestHelpers,
} from './nvx-matched-runtime-adapter';
import { Thresholds } from './nvx-promotion-evaluator';

const thresholds = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', 'docs', 'nvx-promotion-thresholds.json'),
  'utf8',
)) as Thresholds;

function manifest(): CampaignManifest {
  return createCampaignManifest({
    campaignId: 'real-canary-test',
    mode: 'canary',
    sourceCommit: 'a'.repeat(40),
    runnerClass: 'ubuntu-24.04',
    runnerImage: 'ubuntu24/20261001.1',
    guestImage: 'matched-guest-v1',
  }, thresholds);
}

function evidence(campaign = manifest(), sampleIndex = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-adapter-test-'));
  const tokenUsagePath = path.join(root, 'token-usage.jsonl');
  const tokenTrackerAuditPath = path.join(root, 'token-tracker-audit.jsonl');
  const toolchainPath = path.join(root, 'toolchain.json');
  const sample = campaign.expectedRuns[sampleIndex];
  if (sample.workload === 'copilot-inference') {
    fs.writeFileSync(tokenUsagePath, [
      JSON.stringify({
        event: 'token_usage',
        input_tokens: 12,
        output_tokens: 3,
        cache_read_tokens: 4,
      }),
      '',
    ].join('\n'));
    fs.writeFileSync(tokenTrackerAuditPath, [
      JSON.stringify({ event: 'TRACK_START', rid: 'request-1' }),
      JSON.stringify({ event: 'TRACK_END', rid: 'request-1', result: 'ok' }),
      JSON.stringify({ event: 'TRACK_START', rid: 'request-2' }),
      JSON.stringify({ event: 'TRACK_END', rid: 'request-2', result: 'no_usage' }),
      JSON.stringify({ event: 'WS_TRACK_START', rid: 'request-3' }),
      '',
    ].join('\n'));
  }
  if (sample.runtime === 'nvx') {
    const packages = [
      'bash-5.2.37-r0',
      'curl-8.14.1-r3',
      'nodejs-22.23.2-r0',
      'npm-11.6.4-r0',
    ];
    fs.writeFileSync(toolchainPath, JSON.stringify({
      layerSha256: 'c'.repeat(64),
      packageInventorySha256: createHash('sha256').update(`${packages.join('\n')}\n`).digest('hex'),
      packages,
      tools: { bash: 'GNU bash 5.2.37', curl: 'curl 8.14.1', node: 'v22.23.2', npm: '11.6.4' },
    }));
  }
  return {
    campaign,
    sample,
    input: {
      attempt: 1,
      lifecyclePath: path.join(root, 'lifecycle.json'),
      assertionsPath: path.join(root, 'assertions.json'),
      residuePath: path.join(root, 'residue.json'),
      tokenUsagePath,
      tokenTrackerAuditPath,
      ...(sample.runtime === 'nvx' ? { toolchainPath } : {}),
      workflowRunId: 'run-1',
      jobId: 'canary',
      workflowAttemptId: '1',
    },
    lifecycle: {
      artifactPreflightStartedMs: 100,
      artifactPreflightCompletedMs: 120,
      runtimeReadyMs: 220,
      firstWorkloadMs: 240,
      workloadCompletedMs: 500,
      cleanupCompletedMs: 550,
      scratchBytes: 1024 * 1024,
      hostDiskBytes: 2 * 1024 * 1024,
      cpuUsageMicros: 1_250_000,
      guestTools: { node: 'v22.23.2', curl: 'curl 8.14.1' },
      cachePreparation: 'cold-cache-flushed' as const,
    },
    assertions: {
      assertions: Object.fromEntries(thresholds.zeroTolerance.map((name) => [name, true])),
      resourceLimitsEnforced: true,
      failureCategory: 'success',
    },
    metrics: { peakMemoryMiB: 64, peakPids: 4 },
  };
}

describe('matched runtime measurement adapter', () => {
  it('creates a bounded matched canary excluded from promotion thresholds', () => {
    const campaign = manifest();
    expect(campaign.canary).toBe(true);
    expect(campaign.promotionEligible).toBe(false);
    expect(campaign.expectedRuns).toHaveLength(4);
    expect(campaign.expectedRecoveries).toEqual([]);
    expect(campaign.estimatedRunnerMinutes).toBe(40);
    expect(new Set(campaign.expectedRuns.map((sample) =>
      `${sample.runtime}/${sample.workload}/${sample.mode}/${sample.cache}/${sample.resourceProfile}`,
    ))).toEqual(new Set([
      'nvx/build-test/sequential/cold/default',
      'nvx/copilot-inference/sequential/cold/default',
      'cloud-hypervisor/build-test/sequential/cold/default',
      'cloud-hypervisor/copilot-inference/sequential/cold/default',
    ]));
  });

  it('parses real lifecycle, process, disk, and API-proxy evidence', () => {
    const data = evidence(manifest(), 1);
    const artifact = buildMeasuredArtifact(
      data.campaign, data.sample, data.input, data.lifecycle, data.assertions,
      [], data.metrics, 0, thresholds,
    );
    expect(artifact.kind).toBe('run');
    if (artifact.kind !== 'run') return;
    expect(artifact.result).toMatchObject({
      evidenceKind: 'measured',
      artifactPreflightMs: 20,
      startupMs: 100,
      firstWorkloadMs: 20,
      endToEndMs: 400,
      cleanupMs: 50,
      scratchMiB: 1,
      hostDiskMiB: 2,
      apiProxyRequests: 3,
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 4,
      cpuSeconds: 1.25,
      resourceProfile: 'default',
      cachePreparation: 'cold-cache-flushed',
      success: true,
    });
    expect(artifact.result.apiProxyRequests).toBe(3);
    expect(artifact.result.provenance.nvxGuestToolchain?.layerSha256).toBe('c'.repeat(64));
    expect(artifact.result.provenance.observedGuestTools).toEqual({
      node: 'v22.23.2',
      curl: 'curl 8.14.1',
    });
  });

  it('counts API-proxy starts independently when no response includes token usage', () => {
    const data = evidence(manifest(), 1);
    fs.writeFileSync(data.input.tokenUsagePath!, '');
    const artifact = buildMeasuredArtifact(
      data.campaign, data.sample, data.input, data.lifecycle, data.assertions,
      [], data.metrics, 0, thresholds,
    );
    if (artifact.kind !== 'run') return;
    expect(artifact.result.apiProxyRequests).toBe(3);
    expect(artifact.result.inputTokens).toBe(0);
    expect(artifact.result.outputTokens).toBe(0);
  });

  it('fails closed for missing metrics, provenance assertions, and token evidence', () => {
    const data = evidence(manifest(), 1);
    expect(() => buildMeasuredArtifact(
      data.campaign, data.sample, data.input,
      { ...data.lifecycle, cpuUsageMicros: 0 },
      data.assertions, [], data.metrics, 0, thresholds,
    )).toThrow('cpuUsageMicros');
    expect(() => buildMeasuredArtifact(
      data.campaign, data.sample, data.input,
      { ...data.lifecycle, scratchBytes: Number.NaN },
      data.assertions, [], data.metrics, 0, thresholds,
    )).toThrow('scratchBytes');
    expect(() => buildMeasuredArtifact(
      data.campaign, data.sample, data.input,
      { ...data.lifecycle, cachePreparation: 'warm-cache-primed' },
      data.assertions, [], data.metrics, 0, thresholds,
    )).toThrow('cache preparation');
    const missingAssertion = structuredClone(data.assertions);
    delete missingAssertion.assertions.credentialIsolation;
    expect(() => buildMeasuredArtifact(
      data.campaign, data.sample, data.input, data.lifecycle,
      missingAssertion, [], data.metrics, 0, thresholds,
    )).toThrow('credentialIsolation');
    fs.unlinkSync(data.input.tokenUsagePath);
    expect(() => buildMeasuredArtifact(
      data.campaign, data.sample, data.input, data.lifecycle,
      data.assertions, [], data.metrics, 0, thresholds,
    )).toThrow('token usage');
  });

  it('propagates security failures and residue into a failed measured record', () => {
    const data = evidence();
    data.assertions.assertions.egressPolicy = false;
    data.assertions.failureCategory = 'security-assertion';
    const artifact = buildMeasuredArtifact(
      data.campaign, data.sample, data.input, data.lifecycle, data.assertions,
      ['network-namespace'], data.metrics, 0, thresholds,
    );
    if (artifact.kind !== 'run') return;
    expect(artifact.result.success).toBe(false);
    expect(artifact.result.assertionFailures).toContain('egressPolicy');
    expect(artifact.result.residue).toEqual(['network-namespace']);
  });

  it('uses stable distinct attempt IDs', () => {
    const { stableAttemptId } = matchedRuntimeAdapterTestHelpers;
    expect(stableAttemptId('sample-a', 1)).toBe(stableAttemptId('sample-a', 1));
    expect(stableAttemptId('sample-a', 1)).not.toBe(stableAttemptId('sample-a', 2));
    expect(stableAttemptId('sample-a', 1)).not.toBe(stableAttemptId('sample-b', 1));
  });

  it('aggregates all four measured canary records deterministically', () => {
    const campaign = manifest();
    const artifacts = campaign.expectedRuns.map((_, index) => {
      const data = evidence(campaign, index);
      return buildMeasuredArtifact(
        data.campaign, data.sample, data.input, data.lifecycle, data.assertions,
        [], data.metrics, 0, thresholds,
      );
    }) as SampleArtifact[];
    const forward = aggregateCampaign(campaign, artifacts, thresholds);
    const reverse = aggregateCampaign(campaign, [...artifacts].reverse(), thresholds);
    expect(forward.runs).toHaveLength(4);
    expect(forward.recoveries).toEqual([]);
    expect(forward.canary).toBe(true);
    expect(forward.promotionEligible).toBe(false);
    expect(reverse.runs).toEqual(forward.runs);
    expect(reverse.observedSampleIds).toEqual(forward.observedSampleIds);

    const mismatchedTools = structuredClone(artifacts) as SampleArtifact[];
    const cloudSample = mismatchedTools.find((artifact) =>
      artifact.kind === 'run' && artifact.result.runtime === 'cloud-hypervisor',
    );
    if (cloudSample?.kind === 'run') {
      cloudSample.result.provenance.observedGuestTools!.node = 'v22.23.3';
    }
    expect(() => aggregateCampaign(campaign, mismatchedTools, thresholds))
      .toThrow('guest tool versions differ');

    const workloadSpecificLayer = structuredClone(artifacts) as SampleArtifact[];
    const secondNvxSample = workloadSpecificLayer.find((artifact) =>
      artifact.kind === 'run' && artifact.result.runtime === 'nvx' &&
      artifact.result.workload === 'copilot-inference',
    );
    if (secondNvxSample?.kind === 'run') {
      secondNvxSample.result.provenance.nvxGuestToolchain!.layerSha256 = 'e'.repeat(64);
    }
    expect(() => aggregateCampaign(campaign, workloadSpecificLayer, thresholds))
      .not.toThrow();

    const mismatchedToolchain = structuredClone(artifacts) as SampleArtifact[];
    const secondNvxToolchain = mismatchedToolchain.find((artifact) =>
      artifact.kind === 'run' && artifact.result.runtime === 'nvx' &&
      artifact.result.workload === 'copilot-inference',
    );
    if (secondNvxToolchain?.kind === 'run') {
      const toolchain = secondNvxToolchain.result.provenance.nvxGuestToolchain!;
      toolchain.packages.push('phase4-extra-tool-1.0.0-r0');
      toolchain.packageInventorySha256 = createHash('sha256')
        .update(`${toolchain.packages.join('\n')}\n`).digest('hex');
    }
    expect(() => aggregateCampaign(campaign, mismatchedToolchain, thresholds))
      .toThrow('NVX guest toolchain provenance differs');
  });

  it('parses complete measured recovery evidence and fails closed on omissions', () => {
    const campaign = createCampaignManifest({
      campaignId: 'recovery-test',
      mode: 'full',
      sourceCommit: 'b'.repeat(40),
      runnerClass: 'ubuntu-24.04',
      runnerImage: 'ubuntu24/20261001.1',
      guestImage: 'matched-guest-v1',
    }, thresholds);
    const sample = campaign.expectedRecoveries.find((item) =>
      item.runtime === 'nvx' && item.kind === 'stale-recovery',
    )!;
    const assertions = {
      ...Object.fromEntries(thresholds.zeroTolerance.map((name) => [name, true])),
      processTreeGone: true,
      mountsRestored: true,
      namespacesRestored: true,
      cgroupsRestored: true,
      runDirectoryRemoved: true,
      scratchRemoved: true,
      snapshotRemoved: true,
      cleanupRecordRemoved: true,
      kvmAclRestored: true,
      identityCheckedCleanup: true,
    };
    const measurement = {
      durationMs: 1234,
      success: true,
      failureCategory: 'success',
      assertions,
      assertionFailures: [],
      residue: [],
      readinessConfirmed: true,
      terminalObserved: true,
      managerKilledAfterCleanupRecord: true,
      workloadAfterRecovery: true,
    };
    const artifact = buildMeasuredRecoveryArtifact(
      campaign,
      sample,
      { attempt: 1, workflowRunId: 'run', jobId: 'recovery', workflowAttemptId: '1' },
      measurement,
      thresholds,
    );
    expect(artifact).toMatchObject({
      kind: 'recovery',
      result: {
        evidenceKind: 'measured',
        success: true,
        durationMs: 1234,
        managerKilledAfterCleanupRecord: true,
        workloadAfterRecovery: true,
      },
    });
    const incomplete = structuredClone(measurement);
    delete (incomplete.assertions as Record<string, boolean>).identityCheckedCleanup;
    expect(() => buildMeasuredRecoveryArtifact(
      campaign,
      sample,
      { attempt: 1, workflowRunId: 'run', jobId: 'recovery', workflowAttemptId: '1' },
      incomplete,
      thresholds,
    )).toThrow('identityCheckedCleanup');
  });
});
