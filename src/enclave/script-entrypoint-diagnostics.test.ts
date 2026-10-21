import { spawnSync } from 'child_process';
import * as path from 'path';

const entrypoint = path.resolve(__dirname, '../../containers/enclave/script-entrypoint.py');
const harness = String.raw`
import importlib.util
import os
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("script_entrypoint", os.environ["ENTRYPOINT"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
scenario = os.environ["SCENARIO"]

def operation(phase):
    def run(*args, **kwargs):
        if scenario == phase:
            raise PermissionError(13, "PRIVATE_SCRIPT PRIVATE_TOKEN /private/repository")
        if phase == "script-execute":
            if scenario == "exit-zero":
                raise SystemExit(0)
            print("true")
    return run

with patch.object(module.shutil, "copytree", operation("seed-copy")), \
     patch.object(module.Path, "symlink_to", operation("output-link")), \
     patch.object(module.os, "chdir", operation("working-directory")), \
     patch.object(module.runpy, "run_path", operation("script-execute")):
    try:
        module.main()
    except OSError:
        raise SystemExit(1)
`;

describe('script enclave guest lifecycle diagnostics', () => {
  it.each(['success', 'exit-zero', 'seed-copy', 'output-link', 'working-directory', 'script-execute'])(
    'records bounded stderr phases for %s without changing script stdout or exit status', scenario => {
      const result = spawnSync('python3', ['-c', harness], {
        encoding: 'utf8',
        env: { ...process.env, ENTRYPOINT: entrypoint, SCENARIO: scenario, PYTHONDONTWRITEBYTECODE: '1' },
      });
      const success = scenario === 'success' || scenario === 'exit-zero';
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(success ? 0 : 1);
      expect(result.stdout).toBe(scenario === 'success' ? 'true\n' : '');
      const records = result.stderr.trim().split('\n').map(line => JSON.parse(line));
      expect(records[0]).toMatchObject({ component: 'enclave-script', phase: 'startup', status: 'started' });
      expect(records[records.length - 1]).toMatchObject({
        phase: success ? 'script-execute' : scenario,
        status: success ? 'passed' : 'failed',
        ...(!success ? { errorType: 'PermissionError', code: 'EACCES' } : {}),
      });
      expect(records.length).toBeLessThanOrEqual(10);
      expect(result.stderr).not.toMatch(/PRIVATE_|\/private\/|TOKEN/);
      for (const record of records) expect(record.elapsedMs).toBeGreaterThanOrEqual(0);
    },
  );

  it('makes the disposable repository copy writable without following symlinks', () => {
    const source = String.raw`
import importlib.util
import os
import pathlib
import stat
import tempfile

spec = importlib.util.spec_from_file_location("script_entrypoint", os.environ["ENTRYPOINT"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    seed = root / "seed"
    repo = root / "repo"
    outside = root / "outside"
    (seed / "nested").mkdir(parents=True)
    (seed / "nested" / "file.txt").write_text("seed", encoding="utf-8")
    outside.write_text("outside", encoding="utf-8")
    outside.chmod(0o444)
    (seed / "link").symlink_to(outside)
    (seed / "nested" / "file.txt").chmod(0o444)
    (seed / "nested").chmod(0o555)
    seed.chmod(0o555)
    module.SEED = seed
    module.REPO = repo
    module.shutil.copytree(module.SEED, module.REPO, symlinks=True)
    module.make_repository_writable()
    existing = repo / "nested" / "file.txt"
    existing.write_text("updated", encoding="utf-8")
    (repo / "nested" / "created.txt").write_text("created", encoding="utf-8")
    assert existing.read_text(encoding="utf-8") == "updated"
    assert (repo / "nested" / "created.txt").is_file()
    assert (repo / "link").is_symlink()
    assert stat.S_IMODE(outside.stat().st_mode) == 0o444
`;
    const result = spawnSync('python3', ['-c', source], {
      encoding: 'utf8',
      env: { ...process.env, ENTRYPOINT: entrypoint, PYTHONDONTWRITEBYTECODE: '1' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });
});
