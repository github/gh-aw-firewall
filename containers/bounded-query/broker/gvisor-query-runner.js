'use strict';

const { DockerQueryRunner } = require('./docker-query-runner');

const RUNSC_RUNTIME = 'runsc';
const RUNTIME_NAMES_FORMAT = '{{range $name, $_ := .Runtimes}}{{println $name}}{{end}}';

/** QueryRunner using Docker with the fixed runsc OCI runtime. */
class GvisorQueryRunner extends DockerQueryRunner {
  constructor(config, deps = {}) {
    super(config, deps, RUNSC_RUNTIME);
  }

  async assertAvailable() {
    await super.assertAvailable();
    const result = await this.docker.runDocker(
      ['info', '--format', RUNTIME_NAMES_FORMAT],
      30_000,
    );
    if (result.exitCode !== 0) {
      throw new Error('Unable to inspect Docker OCI runtimes for gVisor');
    }

    const runtimes = new Set(result.stdout.split('\n').map((name) => name.trim()).filter(Boolean));
    if (!runtimes.has(RUNSC_RUNTIME)) {
      throw new Error('gVisor query backend requires the runsc OCI runtime; no fallback is permitted');
    }
  }
}

module.exports = { GvisorQueryRunner, RUNSC_RUNTIME };
