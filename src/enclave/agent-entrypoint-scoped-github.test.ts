import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const endpoint = 'http://172.31.0.40:8080/mcp/github';
const bearer = 'scoped-executor-private-sentinel';
const agentId = 'legacy-agent-id-'.repeat(3);
const entrypoint = path.join(__dirname, '../../containers/enclave/agent-entrypoint.py');
const harness = String.raw`
import importlib.util, json, os
from pathlib import Path
spec = importlib.util.spec_from_file_location("agent_entrypoint", os.environ["ENTRYPOINT"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
root = Path(os.environ["HARNESS_ROOT"])
module.AGENT_DIR = root / "agent"
module.GITHUB_AGENT_ID_PATH = root / "agent-id"
module.GITHUB_BEARER_PATH = root / "bearer"
module.GITHUB_MCP_CONFIG_PATH = module.AGENT_DIR / "github-mcp.json"
module.SESSION_LOG_PATH = root / "session.jsonl"
module.SESSION_LOG_PATH.write_text("")
try:
    module.configure_github_mcp()
except (OSError, UnicodeDecodeError, ValueError):
    module.append_event({"event": "failure", "category": "configuration-invalid"})
    print(json.dumps({"valid": False, "configExists": module.GITHUB_MCP_CONFIG_PATH.exists(),
                      "transcript": module.SESSION_LOG_PATH.read_text()}))
else:
    checks = []
    def preflight(identifier, *args, **kwargs):
        checks.append(identifier)
        if identifier in ("github-agent-id", "github-bearer"):
            return None if args[0].is_file() else FileNotFoundError(2, "missing")
        return None
    module.preflight_path = preflight
    valid = module.run_preflight(root / "copilot-logs")
    print(json.dumps({
        "valid": valid,
        "config": json.loads(module.GITHUB_MCP_CONFIG_PATH.read_text()),
        "mode": module.GITHUB_MCP_CONFIG_PATH.stat().st_mode & 0o777,
        "checks": checks,
        "redacted": module.redact_diagnostics(os.environ["TEST_BEARER"]),
        "transcript": module.SESSION_LOG_PATH.read_text(),
    }))
`;

describe('static scoped GitHub bearer guest wiring', () => {
  let root: string;

  beforeEach(() => {
    root = path.join(process.cwd(), `.awf-scoped-github-${randomUUID()}`);
    fs.mkdirSync(path.join(root, 'agent'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bearer'), `${bearer}\n`, { mode: 0o400 });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function run(overrides: Record<string, string | undefined> = {}) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('AWF_ENCLAVE_')) delete env[key];
    }
    Object.assign(env, {
      PYTHONDONTWRITEBYTECODE: '1',
      ENTRYPOINT: entrypoint,
      HARNESS_ROOT: root,
      TEST_BEARER: bearer,
      AWF_ENCLAVE_AGENT_GITHUB_ENABLED: 'true',
      AWF_ENCLAVE_AGENT_GITHUB_AUTH_MODE: 'scoped-bearer',
      AWF_ENCLAVE_AGENT_GITHUB_MCP_URL: endpoint,
      AWF_ENCLAVE_AGENT_GITHUB_ALLOWED_TOOLS: '["list_issues","issue_read"]',
      ...overrides,
    });
    const result = spawnSync('python3', ['-c', harness], { encoding: 'utf8', env });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout);
    expect(output.transcript).not.toContain(bearer);
    expect(output.transcript).not.toContain(agentId);
    return output;
  }

  it.each([
    ['list_issues'],
    ['issue_read'],
    ['list_issues', 'issue_read'],
    ['issue_read', 'list_issues'],
  ])('uses the exact allowed tools %j without requiring a static identity', (...tools) => {
    const result = run({ AWF_ENCLAVE_AGENT_GITHUB_ALLOWED_TOOLS: JSON.stringify(tools) });
    expect(result.valid).toBe(true);
    expect(result.config.mcpServers.github).toEqual({
      type: 'http',
      url: endpoint,
      headers: { Authorization: bearer },
      tools,
    });
    expect(result.mode).toBe(0o600);
    expect(result.checks).toContain('github-bearer');
    expect(result.checks).not.toContain('github-agent-id');
    expect(result.redacted).toBe('[REDACTED]');
    expect(fs.existsSync(path.join(root, 'agent-id'))).toBe(false);
  });

  it('ignores a legacy identity even when it is present', () => {
    fs.writeFileSync(path.join(root, 'agent-id'), agentId);
    expect(run().config.mcpServers.github.headers).toEqual({ Authorization: bearer });
  });

  it('rejects scoped mode combined with dynamic delegation instead of bypassing its tool policy', () => {
    expect(run({
      AWF_ENCLAVE_AGENT_DYNAMIC_ENABLED: 'true',
      AWF_ENCLAVE_AGENT_DYNAMIC_REPO: 'octo-org/service',
      AWF_ENCLAVE_AGENT_GITHUB_ALLOWED_TOOLS: '["issue_read"]',
    })).toMatchObject({ valid: false, configExists: false });
  });

  it.each([
    undefined, '', 'not json', 'null', '{}', '"list_issues"', '[]',
    '["*"]', '["search_issues"]', '["issue_read","create_issue"]',
    '["issue_read","issue_read"]', '["list_issues",1]', '[{}]', '[null]',
  ])('rejects invalid allowed tools %j', (tools) => {
    expect(run({ AWF_ENCLAVE_AGENT_GITHUB_ALLOWED_TOOLS: tools }))
      .toMatchObject({ valid: false, configExists: false });
  });

  it.each([
    undefined, '', 'http://172.31.0.41:8080/mcp/github',
    'http://172.31.0.40:8081/mcp/github', 'https://172.31.0.40:8080/mcp/github',
    `${endpoint}/`, `${endpoint}?other=true`, 'http://evil.example/mcp/github',
  ])('rejects a non-fixed endpoint %j', (url) => {
    expect(run({ AWF_ENCLAVE_AGENT_GITHUB_MCP_URL: url }))
      .toMatchObject({ valid: false, configExists: false });
  });

  it('rejects a missing private bearer without falling back to an identity', () => {
    fs.unlinkSync(path.join(root, 'bearer'));
    fs.writeFileSync(path.join(root, 'agent-id'), agentId);
    expect(run()).toMatchObject({ valid: false, configExists: false });
  });

  it.each([
    '', 'short', 'bad bearer with spaces', 'x'.repeat(513),
    `${'x'.repeat(512)}\nextra`, 'x'.repeat(15) + '\nheader: injected', 'non-ascii-é-secret',
  ])('rejects malformed bearer case %#', (value) => {
    fs.chmodSync(path.join(root, 'bearer'), 0o600);
    fs.writeFileSync(path.join(root, 'bearer'), value);
    expect(run()).toMatchObject({ valid: false, configExists: false });
  });

  it.each(['unknown', 'bearer', ' scoped-bearer', ' '])(
    'rejects unknown auth mode %j instead of using the static identity',
    (mode) => {
      fs.writeFileSync(path.join(root, 'agent-id'), agentId);
      expect(run({
        AWF_ENCLAVE_AGENT_GITHUB_AUTH_MODE: mode,
        AWF_ENCLAVE_AGENT_GITHUB_PROFILE: 'issues-read-v1',
      })).toMatchObject({ valid: false, configExists: false });
    },
  );

  it.each([undefined, ''])('preserves Docker static identity auth with mode %j', (mode) => {
    fs.writeFileSync(path.join(root, 'agent-id'), agentId);
    fs.unlinkSync(path.join(root, 'bearer'));
    const result = run({
      AWF_ENCLAVE_AGENT_GITHUB_AUTH_MODE: mode,
      AWF_ENCLAVE_AGENT_GITHUB_PROFILE: 'issues-read-v1',
      AWF_ENCLAVE_AGENT_GITHUB_ALLOWED_TOOLS: undefined,
    });
    expect(result.valid).toBe(true);
    expect(result.config.mcpServers.github.headers).toEqual({ Authorization: agentId });
    expect(result.config.mcpServers.github.tools).toBeUndefined();
    expect(result.checks).toContain('github-agent-id');
    expect(result.checks).not.toContain('github-bearer');
  });
});
