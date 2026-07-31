'use strict';

const { DockerQueryRunner } = require('./docker-query-runner');

const RUNSC_RUNTIME = 'runsc';

/** QueryRunner using Docker with the fixed runsc OCI runtime. */
class GvisorQueryRunner extends DockerQueryRunner {
  constructor(config, deps = {}) {
    super(config, deps, RUNSC_RUNTIME);
  }

  async assertAvailable() {
    await super.assertAvailable();
    const result = await this.docker.runDocker(
      ['info', '--format', '{{json .Runtimes}}'],
      30_000,
    );
    if (result.exitCode !== 0) {
      throw new Error('Unable to inspect Docker OCI runtimes for gVisor');
    }

    let runtimes;
    try {
      runtimes = JSON.parse(result.stdout);
    } catch {
      throw new Error('Docker returned malformed OCI runtime information');
    }
    if (!runtimes || !Object.prototype.hasOwnProperty.call(runtimes, RUNSC_RUNTIME)) {
      throw new Error('gVisor query backend requires the runsc OCI runtime; no fallback is permitted');
    }
  }
}

module.exports = { GvisorQueryRunner, RUNSC_RUNTIME };
