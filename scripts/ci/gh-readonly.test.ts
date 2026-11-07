import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const script = path.resolve(__dirname, 'gh-readonly.py');

describe('shared authenticated gh command', () => {
  let directory: string;
  let capture: string;
  let environment: NodeJS.ProcessEnv;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-readonly-'));
    capture = path.join(directory, 'capture.json');
    const fakeGh = path.join(directory, 'gh');
    fs.writeFileSync(fakeGh, [
      '#!/usr/bin/env python3',
      'import json, os, sys',
      'with open(os.environ["GH_TEST_CAPTURE"], "w") as capture:',
      '    json.dump({"args": sys.argv[1:], "token": os.environ.get("GH_TOKEN")}, capture)',
    ].join('\n'));
    fs.chmodSync(fakeGh, 0o700);
    environment = {
      ...process.env,
      PATH: `${directory}${path.delimiter}${process.env.PATH ?? ''}`,
      GH_AW_GH_TOKEN: 'test-secret-token',
      GH_TEST_CAPTURE: capture,
    };
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  function run(args: string) {
    return spawnSync('python3', [script, args], { env: environment, encoding: 'utf8' });
  }

  it('passes parsed read commands to gh without exposing the token', () => {
    const result = run("pr list --repo 'octo/repo'");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('gh pr list --repo octo/repo\n');
    expect(result.stdout).not.toContain('test-secret-token');
    expect(JSON.parse(fs.readFileSync(capture, 'utf8'))).toEqual({
      args: ['pr', 'list', '--repo', 'octo/repo'],
      token: 'test-secret-token',
    });
  });

  it.each([
    'pr create --title test',
    'issue close 12',
    'run rerun 12',
    'repo view octo/repo --delete',
    'api repos/octo/repo/issues --method POST',
    'api repos/octo/repo/issues -XPUT',
    'api repos/octo/repo/issues -f state=open',
    'api repos/octo/repo/issues --field=state=open',
    'api repos/octo/repo/issues -H X-HTTP-Method-Override:DELETE',
    'api repos/octo/repo/issues --hostname attacker.example',
    'pr list; touch ignored',
  ])('rejects a write-capable or shell-interpreted request: %s', args => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Refusing request:');
    expect(fs.existsSync(capture)).toBe(false);
  });

  it('allows GET-only API queries, including explicit query fields', () => {
    const result = run('api repos/octo/repo/issues -X GET -f state=open');
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(capture, 'utf8')).args).toEqual([
      'api', 'repos/octo/repo/issues', '-X', 'GET', '-f', 'state=open',
    ]);
  });
});
