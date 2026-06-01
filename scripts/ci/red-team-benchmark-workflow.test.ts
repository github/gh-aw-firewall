import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'red-team-benchmark.md');
const lockPath = path.join(workflowsDir, 'red-team-benchmark.lock.yml');

describe('red-team benchmark workflow config', () => {
  it('has correct schedule, engine and safety settings in source workflow', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Schedule and trigger
    expect(source).toContain('schedule: weekly');
    expect(source).toContain('workflow_dispatch');

    // Engine
    expect(source).toContain('id: claude');
    expect(source).toContain('model: claude-haiku-4-5');
    expect(source).toContain('max-turns: 8');

    // AWF sandbox for the agent step
    expect(source).toContain('id: awf');

    // Permissions are read-only (safe-outputs handles issue creation via gh-aw auth)
    expect(source).toContain('contents: read');
    expect(source).toContain('issues: read');

    // Network restricted to github
    expect(source).toContain("- github");

    // Timeout allows long benchmark runs
    expect(source).toContain('timeout-minutes: 90');

    // Safe outputs
    expect(source).toContain('create-issue');
    expect(source).toContain('title-prefix: "[Red-Team Benchmark] "');
    expect(source).toContain('labels: [security]');
    expect(source).toContain('threat-detection');
  });

  it('pre-steps install adversarial_dojo and run both baseline and AWF-protected benchmarks', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Tool installation
    expect(source).toContain('astral.sh/uv/install.sh');
    expect(source).toContain('adversarial_dojo');
    expect(source).toContain('ADVERSARIAL_DOJO_REF="f51227612e43d98658679710d5505989e7f53ec7"');
    expect(source).toContain('search-attacks --help');
    expect(source).toContain("-- '--out'");
    expect(source).toContain("-- '--victim-provider'");
    expect(source).toContain('Install Claude CLI');
    expect(source).toContain('npm install -g @anthropic-ai/claude-code');

    // Codex CLI for red-team/user-task agents
    expect(source).toContain('Install Codex CLI');
    expect(source).toContain('npm install -g @openai/codex');

    // Build and install AWF from source
    expect(source).toContain('Build and install AWF from source');
    expect(source).toContain('npm run build');
    expect(source).toContain('/usr/local/bin/awf');

    // Config file creation
    expect(source).toContain('Write AWF benchmark config');
    expect(source).toContain('awf-exfiltration-defense');
    expect(source).toContain('AWF_CANARY_SECRET_12345');

    // AWF agentshim wraps victim with firewall
    expect(source).toContain('Create AWF agentshim for victim');
    expect(source).toContain('sudo awf');
    expect(source).toContain('--allow-domains api.anthropic.com');
    expect(source).toContain('--proxy-logs-dir /tmp/gh-aw/agent/awf/firewall-logs');
    expect(source).toContain('-- claude --max-turns 10');

    // Both benchmark runs
    expect(source).toContain('Run baseline benchmark (victim without AWF)');
    expect(source).toContain('Run AWF-protected benchmark (victim inside AWF sandbox)');

    // Graceful handling of missing API keys
    expect(source).toContain('Missing API keys');
    expect(source).toContain('ANTHROPIC_API_KEY');
    expect(source).toContain('OPENAI_API_KEY');

    // Results stored for agent
    expect(source).toContain('/tmp/gh-aw/agent/benchmark-summary.json');
    expect(source).toContain('/tmp/gh-aw/agent/baseline/summary.json');
    expect(source).toContain('/tmp/gh-aw/agent/awf/summary.json');

    // Squid log collection
    expect(source).toContain('squid-access.log');
    expect(source).toContain('DENIED');
    expect(source).toContain('missing claude binary');

    // Summary step captures key outputs
    expect(source).toContain('Write benchmark summary');
    expect(source).toContain('awf_effective');
  });

  it('agent prompt instructs analysis and reporting of AWF effectiveness', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Benchmark context
    expect(source).toContain('adversarial_dojo');
    expect(source).toContain('exfiltration');
    expect(source).toContain('prompt injection');

    // Two configurations explained
    expect(source).toContain('Baseline');
    expect(source).toContain('AWF-protected');

    // Metrics table required in output
    expect(source).toContain('Leaks (no AWF)');
    expect(source).toContain('Leaks (with AWF)');
    expect(source).toContain('Blocked requests');
    expect(source).toContain('AWF effective');

    // Attack vectors analysis
    expect(source).toContain('Attack Vectors');

    // Blocked domains from Squid log
    expect(source).toContain('Blocked Domains');
    expect(source).toContain('squid-access.log');

    // Handles skipped runs (missing API keys)
    expect(source).toContain('skipped');
    expect(source).toContain('noop');
  });

  it('lock file exists and references correct workflow structure', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    // Auto-generated header
    expect(lock).toContain('DO NOT EDIT');

    // Weekly schedule compiled
    expect(lock).toContain('cron:');

    // AWF agentshim content compiled into lock
    expect(lock).toContain('awf-agentshim.sh');
    expect(lock).toContain('api.anthropic.com');
    expect(lock).toContain('proxy-logs-dir /tmp/gh-aw/agent/awf/firewall-logs');
    expect(lock).toContain('Install Claude CLI');
    expect(lock).toContain('ADVERSARIAL_DOJO_REF');
    expect(lock).toContain('f51227612e43d98658679710d5505989e7f53ec7');
    expect(lock).toContain('--out');

    // Benchmark steps present
    expect(lock).toContain('baseline');
    expect(lock).toContain('awf_run');

    // Agent turn limit compiled
    expect(lock).toContain('--max-turns 8');
  });
});
