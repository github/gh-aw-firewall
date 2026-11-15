import * as fs from 'fs';
import * as path from 'path';
import { evaluate } from './nvx-promotion-evaluator';
import { aggregateCampaign, isSuccessfulPilot, validateProgressionEvidence } from './nvx-campaign/aggregate';
import { createCampaignCells, createCampaignManifest, selectPendingCellSamples } from './nvx-campaign/manifest';
import type { CampaignCell, CampaignManifest, CampaignResults, SampleArtifact } from './nvx-campaign/manifest';
import { generateDryRunArtifacts, loadThresholds, report } from './nvx-campaign/report';

export {
  RESOURCE_PROFILE_LIMITS,
  createCampaignManifest,
  createCampaignCells,
  selectPendingCellSamples,
} from './nvx-campaign/manifest';
export type {
  CampaignMode,
  CampaignSample,
  ResourceLimits,
  CampaignProvenance,
  RecoverySample,
  CampaignManifest,
  CampaignCell,
  RunEvidence,
  RecoveryEvidence,
  SampleArtifact,
  CampaignResults,
} from './nvx-campaign/manifest';
export { aggregateCampaign, isSuccessfulPilot, validateProgressionEvidence } from './nvx-campaign/aggregate';
export { generateDryRunArtifacts } from './nvx-campaign/report';

function usage(): never {
  throw new Error(
    'usage: nvx-benchmark-campaign plan <manifest.json> <campaign-id> <dry-run|canary|pilot-100|pilot-1000|full> ' +
      '<source-sha> <runner-class> <runner-image> <guest-image> | dry-run <manifest.json> ' +
      '<samples-dir> <workflow-run-id> <job-id> <workflow-attempt> | aggregate ' +
      '<manifest.json> <samples-dir> <results.json> <report.md> | matrix <manifest.json> ' +
      '<matrix.json> | pending <manifest.json> <cell.json> <samples-dir> <allow-infrastructure-retry> ' +
      '<pending.json> | progression <current-manifest.json> <predecessor-manifest.json> <predecessor-results.json>',
  );
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  const thresholds = loadThresholds();
  if (command === 'plan') {
    const [manifestPath, campaignId, mode, sourceCommit, runnerClass, runnerImage, guestImage] = args;
    if (!manifestPath || !campaignId || !mode || !sourceCommit || !runnerClass || !runnerImage || !guestImage) usage();
    if (mode !== 'dry-run' && mode !== 'canary' && mode !== 'pilot-100' && mode !== 'pilot-1000' && mode !== 'full') {
      throw new Error('mode must be dry-run, canary, pilot-100, pilot-1000, or full');
    }
    const manifest = createCampaignManifest({ campaignId, mode, sourceCommit, runnerClass, runnerImage, guestImage }, thresholds);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    process.stdout.write(
      `Campaign ${manifest.campaignId}: ${manifest.expectedRuns.length} runs + ` +
        `${manifest.expectedRecoveries.length} recoveries; estimated ${manifest.estimatedRunnerMinutes} ` +
        `runner-minutes (${(manifest.estimatedRunnerMinutes / 60).toFixed(1)} runner-hours).\n`,
    );
    return;
  }
  if (command === 'dry-run') {
    const [manifestPath, samplesDir, workflowRunId, jobId, workflowAttemptId] = args;
    if (!manifestPath || !samplesDir || !workflowRunId || !jobId || !workflowAttemptId) usage();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CampaignManifest;
    const artifacts = generateDryRunArtifacts(manifest, thresholds, {
      workflowRunId,
      jobId,
      workflowAttemptId,
    });
    fs.mkdirSync(samplesDir, { recursive: true });
    for (const artifact of artifacts) {
      const result = artifact.result;
      const file = path.join(samplesDir, `${artifact.kind}-${result.sampleId}-${result.attemptId}.json`);
      fs.writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
    }
    const results = aggregateCampaign(manifest, artifacts, thresholds);
    const evaluation = evaluate(results, thresholds);
    fs.writeFileSync(path.join(samplesDir, 'benchmark-results.json'), `${JSON.stringify(results, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(samplesDir, 'evaluation.json'), `${JSON.stringify(evaluation, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(samplesDir, 'report.md'), report(results, thresholds), { mode: 0o600 });
    if (evaluation.recommendation !== 'retain-preview') {
      throw new Error(`dry-run must retain preview; got ${evaluation.recommendation}`);
    }
    process.stdout.write(`Validated ${artifacts.length} dry-run evidence records; evaluator returned retain-preview.\n`);
    return;
  }
  if (command === 'matrix') {
    const [manifestPath, matrixPath] = args;
    if (!manifestPath || !matrixPath) usage();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CampaignManifest;
    const cells = createCampaignCells(manifest);
    fs.writeFileSync(matrixPath, `${JSON.stringify({ include: cells }, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    process.stdout.write(`Created ${cells.length} bounded execution cells.\n`);
    return;
  }
  if (command === 'pending') {
    const [manifestPath, cellPath, samplesDir, allowInfrastructureRetry, pendingPath] = args;
    if (!manifestPath || !cellPath || !samplesDir || !allowInfrastructureRetry || !pendingPath) usage();
    if (allowInfrastructureRetry !== 'true' && allowInfrastructureRetry !== 'false') {
      throw new Error('allow-infrastructure-retry must be true or false');
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CampaignManifest;
    const cell = JSON.parse(fs.readFileSync(cellPath, 'utf8')) as CampaignCell;
    const artifacts = fs.existsSync(samplesDir)
      ? fs
          .readdirSync(samplesDir)
          .filter((file) => /^(run|recovery)-.+\.json$/.test(file))
          .sort()
          .map((file) => JSON.parse(fs.readFileSync(path.join(samplesDir, file), 'utf8')) as SampleArtifact)
      : [];
    const pending = selectPendingCellSamples(manifest, cell, artifacts, allowInfrastructureRetry === 'true');
    fs.writeFileSync(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    process.stdout.write(`Selected ${pending.length} pending samples for ${cell.cellId}.\n`);
    return;
  }
  if (command === 'aggregate') {
    const [manifestPath, samplesDir, resultsPath, reportPath] = args;
    if (!manifestPath || !samplesDir || !resultsPath || !reportPath) usage();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CampaignManifest;
    const artifacts = fs
      .readdirSync(samplesDir)
      .filter((file) => file.endsWith('.json') && !['benchmark-results.json', 'evaluation.json'].includes(file))
      .sort()
      .map((file) => JSON.parse(fs.readFileSync(path.join(samplesDir, file), 'utf8')) as SampleArtifact);
    const results = aggregateCampaign(manifest, artifacts, thresholds);
    const evaluation = evaluate(results, thresholds);
    fs.writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(path.dirname(resultsPath), 'evaluation.json'), `${JSON.stringify(evaluation, null, 2)}\n`, { mode: 0o600 });
    const successfulPilot = isSuccessfulPilot(results);
    fs.writeFileSync(
      path.join(path.dirname(resultsPath), 'campaign-status.json'),
      `${JSON.stringify(
        {
          campaignId: results.campaignId,
          mode: results.mode,
          promotionEligible: results.promotionEligible,
          successfulPilot,
          recommendation: evaluation.recommendation,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(reportPath, report(results, thresholds), { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
    if (evaluation.recommendation === 'promote' || successfulPilot) return;
    process.exitCode = 1;
    return;
  }
  if (command === 'progression') {
    const [currentManifestPath, predecessorManifestPath, predecessorResultsPath] = args;
    if (!currentManifestPath || !predecessorManifestPath || !predecessorResultsPath) usage();
    const current = JSON.parse(fs.readFileSync(currentManifestPath, 'utf8')) as CampaignManifest;
    const predecessor = JSON.parse(fs.readFileSync(predecessorManifestPath, 'utf8')) as CampaignManifest;
    const results = JSON.parse(fs.readFileSync(predecessorResultsPath, 'utf8')) as CampaignResults;
    validateProgressionEvidence(current, predecessor, results);
    process.stdout.write(`Validated successful ${predecessor.mode} progression evidence from ${predecessor.campaignId}.\n`);
    return;
  }
  usage();
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
