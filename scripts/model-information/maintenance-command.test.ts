import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const { runMaintenanceCommand } = require('./maintenance-command.cjs') as {
  runMaintenanceCommand: (args: string[], spawn?: typeof spawnSync) => number;
};
const root = path.resolve(__dirname, '../..');
const maintain = path.join(__dirname, 'maintain.cjs');

describe('unattended model maintenance command boundary', () => {
  it.each([
    ['refresh-import', process.execPath, [maintain, 'refresh-import']],
    ['report', process.execPath, [maintain, 'report']],
    ['verify', process.execPath, [maintain, 'verify']],
    ['generate', 'npm', ['run', 'models:generate']],
    ['check', 'npm', ['run', 'models:check']],
    ['test', 'npm', ['test', '--', '--runInBand', 'scripts/model-information/',
      'scripts/ci/model-api-mapping-updater-workflow.test.ts',
      'src/copilot-model-catalog-sync.test.ts', 'src/model-information-contract.test.ts']],
    ['test-api-proxy', 'npm', ['--prefix', 'containers/api-proxy', 'test', '--',
      '--runInBand', 'models-dev-catalog.test.js', 'ai-credits-pricing-reference.test.js']],
  ] as [string, string, string[]][])('runs only the fixed %s invocation from the repository root',
    (operation, executable, args) => {
      const spawn = jest.fn().mockReturnValue({ status: 0 });
      expect(runMaintenanceCommand([operation], spawn)).toBe(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(executable, args, { cwd: root, stdio: 'inherit' });
    });

  it('rejects unsupported or extra arguments before spawning', () => {
    for (const args of [
      [], ['capture'], ['select-pr'], ['node'], ['npm'], ['__proto__'], ['constructor'],
      ['refresh-import', '--help'], ['generate', '--script-shell=unapproved'],
      ['test', '--updateSnapshot'], ['report; echo unapproved'],
    ]) {
      const spawn = jest.fn();
      expect(() => runMaintenanceCommand(args, spawn)).toThrow('Expected exactly one maintenance command');
      expect(spawn).not.toHaveBeenCalled();
    }
  });

  it('propagates validation failures without converting them into success', () => {
    expect(runMaintenanceCommand(['verify'], jest.fn().mockReturnValue({ status: 7 }))).toBe(7);
  });

  it('resolves the selected workspace independently of the staged entrypoint location', () => {
    const previous = process.env.GITHUB_WORKSPACE;
    const workspace = path.join(root, 'selected-maintenance-pr');
    const spawn = jest.fn().mockReturnValue({ status: 0 });
    try {
      process.env.GITHUB_WORKSPACE = workspace;
      jest.isolateModules(() => {
        require('./maintenance-command.cjs').runMaintenanceCommand(['refresh-import'], spawn);
      });
      expect(spawn).toHaveBeenCalledWith(process.execPath, [
        path.join(workspace, 'scripts/model-information/maintain.cjs'), 'refresh-import',
      ], { cwd: workspace, stdio: 'inherit' });
    } finally {
      if (previous === undefined) delete process.env.GITHUB_WORKSPACE;
      else process.env.GITHUB_WORKSPACE = previous;
    }
  });

  it('surfaces process startup errors, signals and missing exit status', () => {
    const error = new Error('npm not found');
    expect(() => runMaintenanceCommand(['test'], jest.fn().mockReturnValue({ error }))).toThrow(error);
    expect(() => runMaintenanceCommand(['test'], jest.fn().mockReturnValue({
      status: null, signal: 'SIGTERM',
    }))).toThrow('terminated by SIGTERM');
    expect(() => runMaintenanceCommand(['test'], jest.fn().mockReturnValue({
      status: null,
    }))).toThrow('returned no exit status');
  });
});
