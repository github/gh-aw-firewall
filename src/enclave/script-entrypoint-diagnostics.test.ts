import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

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
  it('bounds public streams without changing >1MiB seed, workspace, output, or file budgets', () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), '.public-script-capture-'));
    const source = String.raw`
import importlib.util
import os
from pathlib import Path
import resource
import sys
from unittest.mock import patch

root = Path(os.environ["ROOT"])
sys.path.insert(0, str(Path(os.environ["ENTRYPOINT"]).parent))
from public_debug_capture import PublicDebugCapture
spec = importlib.util.spec_from_file_location("script_entrypoint", os.environ["ENTRYPOINT"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
seed = root / "seed"
seed.mkdir()
(seed / "large.bin").write_bytes(b"x" * (2 * 1024 * 1024))
query = root / "query"
query.mkdir()
diagnostics = root / "diagnostics"
diagnostics.mkdir(mode=0o700)
for name in ("stdout.log", "stderr.log"):
    (diagnostics / name).touch(mode=0o600)
script = root / "script.py"
script.write_text('import sys\nfrom pathlib import Path\n'
                  'assert Path("repo/large.bin").stat().st_size == 2 * 1024 * 1024\n'
                  'Path("repo/workspace.bin").write_bytes(b"w" * (2 * 1024 * 1024))\n'
                  'Path("out").write_bytes(b"o" * (2 * 1024 * 1024))\n'
                  'Path("out").write_text("true")\n'
                  'print("x" * (2 * 1024 * 1024))\n'
                  'print("y" * (2 * 1024 * 1024), file=sys.stderr)\n')
module.SEED = seed
module.REPO = query / "repo"
module.OUTPUT = root / "out"
module.SCRIPT = str(script)
resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024, 16 * 1024 * 1024))
original_limit = resource.getrlimit(resource.RLIMIT_FSIZE)
real_link = Path.symlink_to
real_chdir = os.chdir
def link(self, target, *args, **kwargs):
    return real_link(query / "out" if str(self) == "/query/out" else self, target, *args, **kwargs)
with patch.object(module.Path, "symlink_to", link), \
     patch.object(module.os, "chdir", lambda directory: real_chdir(query if directory == "/query" else directory)), \
     patch("public_debug_capture.PublicDebugCapture", lambda: PublicDebugCapture(diagnostics)):
    capture = module.enable_public_capture()
    assert resource.getrlimit(resource.RLIMIT_FSIZE) == original_limit
    try:
        module.main()
    finally:
        capture.close()
assert resource.getrlimit(resource.RLIMIT_FSIZE) == original_limit
assert (query / "repo" / "workspace.bin").stat().st_size == 2 * 1024 * 1024
assert module.OUTPUT.read_text() == "true"
for name in ("stdout.log", "stderr.log"):
    assert (diagnostics / name).stat().st_size <= 1024 * 1024
assert b'"event":"capture-bound"' in (diagnostics / "stderr.log").read_bytes()
`;
    try {
      const result = spawnSync('python3', ['-c', source], {
        encoding: 'utf8', timeout: 10_000,
        env: {
          ...process.env, ROOT: root, ENTRYPOINT: entrypoint,
          AWF_ENCLAVE_DEBUG_PUBLIC: 'true', PYTHONDONTWRITEBYTECODE: '1',
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('does not wait indefinitely for descendants holding public capture pipes', () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), '.public-drain-capture-'));
    const source = String.raw`
import os
from pathlib import Path
import subprocess
import sys
import time
sys.path.insert(0, str(Path(os.environ["ENTRYPOINT"]).parent))
from public_debug_capture import PublicDebugCapture
root = Path(os.environ["ROOT"])
for name in ("stdout.log", "stderr.log"):
    (root / name).touch(mode=0o600)
capture = PublicDebugCapture(root)
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(5)"])
try:
    started = time.monotonic()
    capture.close()
    assert time.monotonic() - started < 2
    assert b'"event":"capture-drain","status":"unavailable"' in (root / "stderr.log").read_bytes()
finally:
    child.terminate()
    child.wait(timeout=2)
`;
    try {
      const result = spawnSync('python3', ['-c', source], {
        encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, ROOT: root, ENTRYPOINT: entrypoint, PYTHONDONTWRITEBYTECODE: '1' },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['open', 'reserve', 'pipe', 'redirect', 'thread'])(
    'restores output and continues canonical execution after capture initialization failure: %s', scenario => {
      const root = fs.mkdtempSync(path.join(process.cwd(), '.public-init-capture-'));
      const source = String.raw`
import os
from pathlib import Path
import sys
import threading
from unittest.mock import patch
sys.path.insert(0, str(Path(os.environ["ENTRYPOINT"]).parent))
import public_debug_capture as module
root = Path(os.environ["ROOT"])
for name in ("stdout.log", "stderr.log"):
    (root / name).touch(mode=0o600)
before = set(os.listdir("/proc/self/fd"))
real_capture = module.PublicDebugCapture
real_open, real_write, real_pipe, real_dup2 = os.open, os.write, os.pipe, os.dup2
real_start = threading.Thread.start
scenario = os.environ["SCENARIO"]
def opening(name, *args, **kwargs):
    if str(name) == "/awf/stderr.log":
        name = root / "stderr.log"
    elif scenario == "open" and str(name) == str(root / "stderr.log"):
        raise PermissionError(13, "PRIVATE_TOKEN")
    return real_open(name, *args, **kwargs)
def reserve(*args):
    raise OSError(28, "PRIVATE_TOKEN")
def pipe():
    if scenario == "pipe" and len(module_capture.streams) == 2:
        raise OSError(24, "PRIVATE_TOKEN")
    return real_pipe()
def redirect(source, destination, *args):
    if scenario == "redirect" and destination == 2 and source not in saved:
        raise OSError(5, "PRIVATE_TOKEN")
    return real_dup2(source, destination, *args)
def start(thread):
    if scenario == "thread" and len(module_capture.streams) == 2:
        raise RuntimeError("PRIVATE_TOKEN")
    return real_start(thread)
saved = set()
real_dup = os.dup
def duplicate(fd):
    result = real_dup(fd)
    saved.add(result)
    return result
def capture():
    global module_capture
    module_capture = real_capture.__new__(real_capture)
    real_capture.__init__(module_capture, root)
    return module_capture
with patch.object(module, "PublicDebugCapture", capture), \
     patch.object(os, "open", opening), \
     patch.object(os, "write", reserve if scenario == "reserve" else real_write), \
     patch.object(os, "pipe", pipe), patch.object(os, "dup", duplicate), \
     patch.object(os, "dup2", redirect), patch.object(threading.Thread, "start", start):
    assert module.enable_public_capture() is None
assert set(os.listdir("/proc/self/fd")) == before
print("canonical stdout")
print("canonical stderr", file=sys.stderr)
metadata = (root / "stderr.log").read_text()
assert "PRIVATE_TOKEN" not in metadata
assert '"event":"capture-io"' in metadata
`;
      try {
        const result = spawnSync('python3', ['-c', source], {
          encoding: 'utf8', timeout: 10_000,
          env: {
            ...process.env, ROOT: root, ENTRYPOINT: entrypoint, SCENARIO: scenario,
            AWF_ENCLAVE_DEBUG_PUBLIC: 'true', PYTHONDONTWRITEBYTECODE: '1',
          },
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('canonical stdout\n');
        expect(result.stderr).toBe('canonical stderr\n');
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  );
});
