import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const repoRoot = path.join(__dirname, '..', '..');
const entrypoint = path.join(repoRoot, 'containers', 'bounded-agent', 'copilot-entrypoint.py');

describe('native Copilot bounded-agent adapter', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-copilot-enclave-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('runs Copilot with native tools and writes only its finite final response', async () => {
    const seed = path.join(root, 'seed');
    const agent = path.join(root, 'agent');
    fs.mkdirSync(seed);
    fs.mkdirSync(agent);
    fs.writeFileSync(path.join(root, 'task.txt'), 'Does go.mod exist?');
    fs.writeFileSync(path.join(root, 'schema.json'), '{"type":"boolean"}');
    fs.writeFileSync(path.join(agent, 'out'), '');
    fs.writeFileSync(path.join(agent, 'session.jsonl'), '');

    const fakeCopilot = path.join(root, 'copilot');
    fs.writeFileSync(fakeCopilot, `#!/bin/sh
if [ ! -f ${JSON.stringify(path.join(root, 'attempted'))} ]; then
  touch ${JSON.stringify(path.join(root, 'attempted'))}
  kill -ABRT $$
fi
printf '%s\\n' "$@" > ${JSON.stringify(path.join(root, 'args.txt'))}
printf '%s\\n' "$COPILOT_GITHUB_TOKEN" "$COPILOT_API_URL" > ${JSON.stringify(path.join(root, 'env.txt'))}
printf '● True\\n'
`);
    fs.chmodSync(fakeCopilot, 0o755);

    const driver = `
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("adapter", ${JSON.stringify(entrypoint)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.SEED_DIR = pathlib.Path(${JSON.stringify(seed)})
module.TASK_PATH = pathlib.Path(${JSON.stringify(path.join(root, 'task.txt'))})
module.SCHEMA_PATH = pathlib.Path(${JSON.stringify(path.join(root, 'schema.json'))})
module.OUT_PATH = pathlib.Path(${JSON.stringify(path.join(agent, 'out'))})
module.SESSION_LOG_PATH = pathlib.Path(${JSON.stringify(path.join(agent, 'session.jsonl'))})
module.AGENT_DIR = pathlib.Path(${JSON.stringify(agent)})
module.COPILOT_BIN = ${JSON.stringify(fakeCopilot)}
sys.exit(module.main())
`;
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile('python3', ['-c', driver], {
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          AWF_BOUNDED_AGENT_ENGINE: 'copilot',
          AWF_BOUNDED_AGENT_MODEL: 'gpt-4o-mini',
          AWF_BOUNDED_AGENT_MAX_OUTPUT_BYTES: '8192',
          AWF_BOUNDED_AGENT_DEADLINE_SECONDS: '30',
          COPILOT_GITHUB_TOKEN: '******',
          COPILOT_API_URL: 'http://172.31.0.30:10002',
        },
      }, (error, stdout, stderr) => resolve({
        code: typeof (error as { code?: unknown } | null)?.code === 'number'
          ? (error as { code: number }).code : error ? 1 : 0,
        stdout,
        stderr,
      }));
    });

    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(fs.readFileSync(path.join(agent, 'out'), 'utf8')).toBe('true');
    const args = fs.readFileSync(path.join(root, 'args.txt'), 'utf8');
    expect(args).toContain('--allow-all-tools');
    expect(args).toContain('--allow-all-paths');
    expect(args).toContain('--disable-builtin-mcps');
    expect(args).toMatch(/--stream\noff/);
    expect(args).toContain('built-in shell, bash');
    expect(args).toContain('lowercase JSON literal true or false');
    expect(args).not.toContain('{"type":"boolean"}');
    expect(fs.readFileSync(path.join(root, 'env.txt'), 'utf8')).toBe(
      '******\nhttp://172.31.0.30:10002\n',
    );
    const transcript = fs.readFileSync(path.join(agent, 'session.jsonl'), 'utf8');
    expect(transcript).toContain('"engine":"copilot"');
    expect(transcript).toContain('"event":"engine-retry"');
    expect(transcript).toContain('"signal":6');
    expect(transcript).toContain('"event":"success"');
    expect(transcript).not.toContain('github_pat_');
  });

  it('captures bounded redacted diagnostics when Copilot fails silently', async () => {
    const seed = path.join(root, 'seed');
    const agent = path.join(root, 'agent');
    const logs = path.join(agent, 'copilot-logs');
    fs.mkdirSync(seed);
    fs.mkdirSync(agent);
    fs.writeFileSync(path.join(root, 'task.txt'), 'Does go.mod exist?');
    fs.writeFileSync(path.join(root, 'schema.json'), '{"type":"boolean"}');
    fs.writeFileSync(path.join(agent, 'out'), '');
    fs.writeFileSync(path.join(agent, 'session.jsonl'), '');

    const fakeCopilot = path.join(root, 'copilot');
    fs.writeFileSync(fakeCopilot, `#!/bin/sh
mkdir -p ${JSON.stringify(logs)}
printf 'request failed\\nAuthorization: Bearer github_pat_sensitive\\n' > ${JSON.stringify(path.join(logs, 'process.log'))}
exit 1
`);
    fs.chmodSync(fakeCopilot, 0o755);

    const driver = `
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("adapter", ${JSON.stringify(entrypoint)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.SEED_DIR = pathlib.Path(${JSON.stringify(seed)})
module.TASK_PATH = pathlib.Path(${JSON.stringify(path.join(root, 'task.txt'))})
module.SCHEMA_PATH = pathlib.Path(${JSON.stringify(path.join(root, 'schema.json'))})
module.OUT_PATH = pathlib.Path(${JSON.stringify(path.join(agent, 'out'))})
module.SESSION_LOG_PATH = pathlib.Path(${JSON.stringify(path.join(agent, 'session.jsonl'))})
module.AGENT_DIR = pathlib.Path(${JSON.stringify(agent)})
module.COPILOT_BIN = ${JSON.stringify(fakeCopilot)}
sys.exit(module.main())
`;
    const result = await new Promise<{ code: number }>((resolve) => {
      execFile('python3', ['-c', driver], {
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          AWF_BOUNDED_AGENT_ENGINE: 'copilot',
          AWF_BOUNDED_AGENT_MODEL: 'gpt-4o-mini',
          AWF_BOUNDED_AGENT_MAX_OUTPUT_BYTES: '8192',
          AWF_BOUNDED_AGENT_DEADLINE_SECONDS: '30',
          COPILOT_GITHUB_TOKEN: '******',
          COPILOT_API_URL: 'http://172.31.0.30:10002',
        },
      }, (error) => resolve({
        code: typeof (error as { code?: unknown } | null)?.code === 'number'
          ? (error as { code: number }).code : error ? 1 : 0,
      }));
    });

    expect(result.code).toBe(24);
    const transcript = fs.readFileSync(path.join(agent, 'session.jsonl'), 'utf8');
    expect(transcript).toContain('"event":"engine-diagnostics"');
    expect(transcript).toContain('request failed');
    expect(transcript).toContain('Authorization: [REDACTED]');
    expect(transcript).not.toContain('github_pat_sensitive');
  });
});
