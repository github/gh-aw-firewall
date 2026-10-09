import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const scriptPath = path.resolve(__dirname, 'build-test-matrix.sh');

function createCommandStubs(binDir: string): void {
  const stubs: Record<string, string> = {
    curl: 'printf ":"',
    git: `url=""
target=""
for arg in "$@"; do
  case "$arg" in
    https://*) url="$arg" ;;
    *) target="$arg" ;;
  esac
done
if [ "\${BUILD_TEST_FAIL_CLONES:-0}" = 1 ]; then
  echo "simulated clone failure" >&2
  exit 1
fi
case "$url" in
  *-bun.git) mkdir -p "$target/elysia" "$target/hono" ;;
  *-cpp.git) mkdir -p "$target/fmt" "$target/json" ;;
  *-deno.git) mkdir -p "$target/oak" "$target/std" ;;
  *-dotnet.git) mkdir -p "$target/hello-world" "$target/json-parse" ;;
  *-go.git) mkdir -p "$target/color" "$target/env" "$target/uuid" ;;
  *-java.git) mkdir -p "$target/gson" "$target/caffeine" ;;
  *-node.git) mkdir -p "$target/clsx" "$target/execa" "$target/p-limit" ;;
  *-rust.git) mkdir -p "$target/fd" "$target/zoxide" ;;
esac`,
    bun: 'echo "2 pass, 0 fail"',
    cmake: 'exit 0',
    cargo: 'if [ "$1" = test ]; then echo "test result: ok. 2 passed; 0 failed; 0 ignored"; fi',
    deno: 'echo "ok | 2 passed | 0 failed"',
    dotnet: 'exit 0',
    go: `if [ "$1" = test ]; then
  if [ "\${BUILD_TEST_FAIL_GO_TESTS:-0}" = 1 ]; then
    echo "simulated Go test failure" >&2
    exit 1
  fi
  echo '{"Action":"pass","Test":"example"}'
fi`,
    make: 'exit 0',
    mvn: 'case "$*" in *test*) echo "Tests run: 2, Failures: 0, Errors: 0, Skipped: 0" ;; esac',
    npm: 'if [ "$1" = test ]; then echo "2 passing"; fi',
  };

  for (const [name, body] of Object.entries(stubs)) {
    const filePath = path.join(binDir, name);
    writeFileSync(filePath, `#!/bin/sh\n${body}\n`);
    chmodSync(filePath, 0o755);
  }
}

function runMatrix(options: { failClones?: boolean; failGoTests?: boolean } = {}): Record<string, any> {
  const root = mkdtempSync(path.join(tmpdir(), 'build-test-matrix-'));
  const binDir = path.join(root, 'bin');
  const dataDir = path.join(root, 'results');
  mkdirSync(binDir);
  createCommandStubs(binDir);

  try {
    execFileSync('bash', [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        HOME: root,
        BUILD_TEST_DATA_DIR: dataDir,
        BUILD_TEST_FAIL_CLONES: options.failClones ? '1' : '0',
        BUILD_TEST_FAIL_GO_TESTS: options.failGoTests ? '1' : '0',
      },
      timeout: 30_000,
    });
    return JSON.parse(readFileSync(path.join(dataDir, 'results.json'), 'utf8'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('build-test matrix script', () => {
  it('records all project results and parsed test counts', () => {
    const results = runMatrix();
    const projects = results.ecosystems.flatMap((ecosystem: any) => ecosystem.projects);

    expect(projects).toHaveLength(18);
    expect(results).toMatchObject({
      status: 'PASS',
      ecosystemsPassed: 8,
      ecosystemCount: 8,
      allClonesFailed: false,
    });
    for (const ecosystem of ['Bun', 'Deno', 'Go', 'Java', 'Node.js', 'Rust']) {
      const project = projects.find((result: any) => result.ecosystem === ecosystem);
      expect(project.tests.counts).toEqual({
        passed: ecosystem === 'Go' ? 1 : 2,
        failed: 0,
        skipped: 0,
        total: ecosystem === 'Go' ? 1 : 2,
      });
    }
  });

  it('records every clone failure and marks the run as all-clones-failed', () => {
    const results = runMatrix({ failClones: true });
    const projects = results.ecosystems.flatMap((ecosystem: any) => ecosystem.projects);

    expect(results).toMatchObject({
      status: 'FAIL',
      ecosystemsPassed: 0,
      allClonesFailed: true,
    });
    expect(projects).toHaveLength(18);
    expect(projects.every((project: any) => project.status === 'CLONE_FAILED')).toBe(true);
  });

  it('keeps going and records errors when tests fail', () => {
    const results = runMatrix({ failGoTests: true });
    const goProjects = results.ecosystems.find((ecosystem: any) => ecosystem.name === 'Go').projects;

    expect(results.status).toBe('FAIL');
    expect(results.ecosystems.find((ecosystem: any) => ecosystem.name === 'Bun').status).toBe('PASS');
    expect(goProjects.every((project: any) =>
      project.status === 'FAIL' && project.error.includes('simulated Go test failure'))).toBe(true);
  });
});
