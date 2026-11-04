'use strict';
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, module, process, __dirname, Buffer */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const execa = require('execa');
const { checkProxy } = require('./proxy-check.cjs');

function install() {
  assert.equal(process.env.AWF_CH_HARNESS_TEST, '1', 'test preload requires explicit opt-in');
  const root = path.resolve(__dirname, '../../../..');
  const observations = require(`${root}/dist/harness-observation`);
  const models = require(`${root}/dist/copilot-model`);
  const { resolveLogPaths } = require(`${root}/dist/log-paths`);
  const { CloudHypervisorManager } = require(`${root}/dist/cloud-hypervisor/manager`);
  const observe = observations.observeHarness;
  const execute = CloudHypervisorManager.prototype.execute;
  let probeRequest;
  let published = false;
  const directory = process.env.AWF_CH_CASE;
  const expected = JSON.parse(fs.readFileSync(`${directory}/expected.json`, 'utf8'));
  const evidenceFile = `${directory}/evidence.json`;
  const evidence = { schemaVersion: 1, evidence: 'live-cloud-hypervisor', commandEntered: false };
  const save = () => fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  const context = request => ({
    uid: request.uid, gid: request.gid, cwd: request.cwd, shell: request.argv.slice(0, 2),
    path: request.env.PATH, home: request.env.HOME, fixtureEnv: request.env.FIXTURE_ENV,
    runtime: request.env.AWF_RUNTIME,
  });
  CloudHypervisorManager.prototype.execute = function(request) {
    if (request.requestId.startsWith('harness-')) {
      probeRequest = request;
      assert.equal(request.timeoutMs, 10000);
      assert.equal(request.auditOutput, false);
      assert.equal(request.tty, false);
      evidence.probeRequest = context(request);
      save();
    } else if (request.requestId.startsWith('agent-')) {
      assert(published, 'command entered before report/consumer checks');
      assert.deepEqual(context(request), context(probeRequest));
      assert.deepEqual(request.env, probeRequest.env);
      assert.deepEqual(request.argv.slice(0, 2), ['/bin/sh', '-lc']);
      evidence.commandEntered = true;
      evidence.commandRequest = context(request);
      save();
    }
    return execute.call(this, request);
  };
  observations.observeHarness = async (config, probe) => {
    assert.equal(config.containerRuntime, 'cloud-hypervisor');
    assert(!fs.existsSync(`${directory}/workspace/command-context`));
    const validate = models.validateCopilotModel;
    const token = config.copilotGithubToken;
    const additionalEnv = config.additionalEnv;
    // Install only around the real ready-runtime recheck, after sidecar/guest
    // configuration. This signal is never sent as a provider credential.
    config.copilotGithubToken = 'test-only-not-a-credential';
    config.additionalEnv = { ...additionalEnv, COPILOT_MODEL: 'gpt-6-sol' };
    models.validateCopilotModel = (model, input) => validate(model, {
      ...input, harnesses: expected.floor ? [{
        scope: { provider: 'copilot', channel: 'copilot-cli' },
        name: 'copilot-cli', minimum: expected.floor, scheme: 'semver',
        reason: 'Cloud Hypervisor test-only floor', provenance: { authority: 'maintained' },
      }] : [],
    });
    let failure;
    const started = Date.now();
    try {
      await observe(config, async command => {
        const result = await probe(command);
        evidence.probeBytes = Buffer.byteLength(result.stdout);
        evidence.probeTimedOut = result.timedOut;
        evidence.probeOverflow = result.overflow;
        return result;
      });
    } catch (error) {
      failure = error;
    } finally {
      models.validateCopilotModel = validate;
      config.copilotGithubToken = token;
      config.additionalEnv = additionalEnv;
    }
    evidence.probeDurationMs = Date.now() - started;
    evidence.check = 'published-report';
    save();
    const filename = path.join(resolveLogPaths(config).apiProxyLogs, 'harness-observation.json');
    const report = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (expected.cancel) {
      evidence.cancellationReportStatus = report.status;
      save();
      if (failure) throw failure;
      return report;
    }
    assert.deepEqual(report, {
      ...observations.harnessContext(config),
      ...(expected.reason ? { status: 'unavailable', reason: expected.reason } : {
        status: 'observed', version: expected.version, resolvedBinary: expected.binary,
      }),
    });
    assert.equal(fs.statSync(filename).uid, 0);
    assert.equal(fs.statSync(filename).mode & 0o022, 0);
    assert(!JSON.stringify(report).includes('discard-this-ch'));
    assert(!fs.existsSync(`${directory}/workspace/command-context`));
    evidence.report = report;
    evidence.check = 'probe-bounds';
    save();
    if (expected.mode === 'timeout') {
      assert(evidence.probeTimedOut);
      assert(evidence.probeDurationMs >= 9900 && evidence.probeDurationMs < 20000);
    }
    if (expected.mode === 'boundary') assert.equal(evidence.probeBytes, 4096);
    if (['overflow', 'over-boundary'].includes(expected.mode)) {
      assert.equal(evidence.probeBytes, 4097);
      assert.equal(evidence.probeOverflow, true);
    }
    evidence.check = 'mounted-proxy-consumers';
    save();
    const consumer = await execa('docker', ['exec', 'awf-api-proxy', 'node', '-e',
      `(${checkProxy.toString()})(${JSON.stringify(report)}).then(value => process.stdout.write(JSON.stringify(value)))`],
    { timeout: 10000, maxBuffer: 16384 });
    evidence.proxy = JSON.parse(consumer.stdout);
    evidence.check = 'host-admission';
    if (expected.blocked) {
      assert(failure, 'incompatible/unverified command was not blocked');
      const code = expected.reason ? 'harness_unverified' : 'harness_incompatible';
      assert.match(failure.message, new RegExp(code));
      assert(!failure.message.includes('discard-this-ch'));
      evidence.blocked = code;
      save();
      throw failure;
    }
    if (failure) throw failure;
    published = true;
    save();
    return report;
  };
}

if (process.env.AWF_CH_HARNESS_TEST === '1') install();
module.exports = { install };
