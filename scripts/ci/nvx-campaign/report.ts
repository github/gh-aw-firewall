import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { evaluate } from '../nvx-promotion-evaluator';
import type { Thresholds } from '../nvx-promotion-evaluator';
import { RESOURCE_PROFILE_LIMITS } from './constants';
import type { CampaignManifest, CampaignResults, SampleArtifact } from './manifest';

function dryRunAssertions(thresholds: Thresholds): Record<string, boolean> {
  return Object.fromEntries(thresholds.zeroTolerance.map((name) => [name, true]));
}

export function generateDryRunArtifacts(
  manifest: CampaignManifest,
  thresholds: Thresholds,
  identifiers: {
    workflowRunId: string;
    jobId: string;
    workflowAttemptId: string;
  },
): SampleArtifact[] {
  if (!manifest.dryRun) throw new Error('dry-run evidence requires a dry-run campaign manifest');
  const assertions = dryRunAssertions(thresholds);
  const runs: SampleArtifact[] = manifest.expectedRuns.map((sample) => {
    execFileSync(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
    });
    return {
      kind: 'run',
      result: {
        ...sample,
        campaignId: manifest.campaignId,
        attemptId: `${sample.sampleId}-attempt-1`,
        ...identifiers,
        success: true,
        failureCategory: 'success',
        artifactPreflightMs: 1,
        startupMs: 1,
        firstWorkloadMs: 1,
        endToEndMs: 1,
        cleanupMs: 1,
        peakMemoryMiB: 1,
        scratchMiB: 1,
        hostDiskMiB: 1,
        peakPids: 1,
        cpuSeconds: 1,
        apiProxyRequests: sample.workload === 'copilot-inference' ? 1 : 0,
        inputTokens: sample.workload === 'copilot-inference' ? 1 : 0,
        outputTokens: sample.workload === 'copilot-inference' ? 1 : 0,
        cacheReadTokens: sample.workload === 'copilot-inference' ? 1 : 0,
        assertionFailures: [],
        residue: [],
        assertions: { ...assertions },
        cachePreparation: sample.cache === 'cold' ? 'cold-cache-flushed' : 'warm-cache-primed',
        resourceLimits: { ...RESOURCE_PROFILE_LIMITS[sample.resourceProfile] },
        resourceLimitsEnforced: true,
        sourceCommit: manifest.sourceCommit,
        runnerClass: manifest.runnerClass,
        runnerImage: manifest.runnerImage,
        guestImage: manifest.guestImage,
        versions: { ...manifest.versions },
        provenance: structuredClone(manifest.provenance),
        evidenceKind: 'dry-run',
      },
    };
  });
  const recoveries: SampleArtifact[] = manifest.expectedRecoveries.map((sample) => {
    execFileSync(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
    });
    return {
      kind: 'recovery',
      result: {
        ...sample,
        campaignId: manifest.campaignId,
        attemptId: `${sample.sampleId}-attempt-1`,
        failureCategory: 'success',
        ...identifiers,
        success: true,
        durationMs: 1,
        assertionFailures: [],
        residue: [],
        readinessConfirmed: true,
        terminalObserved: true,
        managerKilledAfterCleanupRecord: sample.kind === 'stale-recovery',
        workloadAfterRecovery: sample.kind === 'stale-recovery',
        assertions: {
          ...assertions,
          processTreeGone: true,
          mountsRestored: true,
          namespacesRestored: true,
          cgroupsRestored: true,
          runDirectoryRemoved: true,
          scratchRemoved: true,
          snapshotRemoved: true,
          cleanupRecordRemoved: true,
          kvmAclRestored: true,
          identityCheckedCleanup: sample.kind === 'stale-recovery',
        },
        sourceCommit: manifest.sourceCommit,
        runnerClass: manifest.runnerClass,
        runnerImage: manifest.runnerImage,
        guestImage: manifest.guestImage,
        versions: { ...manifest.versions },
        provenance: structuredClone(manifest.provenance),
        evidenceKind: 'dry-run',
      },
    };
  });
  return [...runs, ...recoveries];
}

export function report(results: CampaignResults, thresholds: Thresholds): string {
  const evaluation = evaluate(results, thresholds);
  const lines = [
    '# NVX Phase 4 campaign report',
    '',
    `- Campaign: \`${results.campaignId}\``,
    `- Evidence: ${
      results.dryRun
        ? '**dry-run only (not benchmark data)**'
        : results.canary
          ? '**measured canary (excluded from promotion thresholds)**'
          : results.promotionEligible
            ? 'measured promotion campaign'
            : `**measured ${results.mode} pilot (excluded from promotion thresholds)**`
    }`,
    `- Runner: \`${results.runnerClass}\``,
    `- Samples: ${results.runs.length} primary runs; ${results.recoveries.length} recovery records`,
    `- Recommendation: **${evaluation.recommendation}**`,
    '',
    '| Runtime / lane | Samples | Success rate | Startup p50 / p95 (ms) | End-to-end p50 / p95 (ms) |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const key of Object.keys(evaluation.summary).sort()) {
    const values = evaluation.summary[key];
    lines.push(
      `| ${key} | ${values.runs} | ${(values.successRate * 100).toFixed(1)}% | ` +
        `${values['startupMs.p50']} / ${values['startupMs.p95']} | ` +
        `${values['endToEndMs.p50']} / ${values['endToEndMs.p95']} |`,
    );
  }
  lines.push('', '## Blockers', '');
  lines.push(...(evaluation.blockers.length ? evaluation.blockers.map((item) => `- ${item}`) : ['- None']));
  lines.push('', '## Unmet gates', '');
  lines.push(...(evaluation.unmetGates.length ? evaluation.unmetGates.map((item) => `- ${item}`) : ['- None']));
  return `${lines.join('\n')}\n`;
}

export function loadThresholds(): Thresholds {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'nvx-promotion-thresholds.json'), 'utf8')) as Thresholds;
}
