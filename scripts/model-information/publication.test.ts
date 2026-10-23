import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const { buildSnapshot } = require('./build-publication.cjs');
const { publish } = require('./publish.cjs');
const {
  json, digest, payload, inputPaths, dataBranch, pointerPath, readSnapshot, readPointer,
} = require('./publication-contract.cjs');
const root = path.resolve(__dirname, '../..');
const catalogue = require('../../shared/model-information/catalog.generated.json');
const evidence = {
  authority: 'maintained', source: 'reviewed fixture', revision: 'fixture',
  at: '2026-10-20T00:00:00Z', confidence: 'verified',
};
const fixture = () => ({
  schemaVersion: 1, catalogRevision: 'fixture', generatedAt: evidence.at,
  models: [{
    schemaVersion: 1,
    identity: { provider: 'copilot', rawId: 'example', lookupId: 'example', key: 'copilot/example' },
    lifecycle: { status: 'active' }, modelType: 'completion', provenance: evidence,
    tariffs: [{
      scope: { provider: 'copilot', channel: 'copilot-api' },
      currency: 'USD', unit: 'USD_PER_1M_TOKENS', tier: 'default',
      effectiveFrom: evidence.at, effectiveUntil: '2027-01-01T00:00:00Z',
      components: {
        input: { price: '0.123456789', provenance: evidence },
        output: { price: '0', provenance: evidence },
        cacheWrite: { price: { unavailable: true }, provenance: evidence },
      }, provenance: evidence,
    }],
    harnesses: [{
      scope: { provider: 'copilot', channel: 'copilot-cli' }, name: 'copilot-cli',
      scheme: 'semver', minimum: '1.2.3', excludedRanges: ['>=2.0.0 <2.0.1'],
      reason: 'fixture compatibility floor', provenance: evidence,
    }],
  }],
});
const time = '2026-10-22T23:00:00Z';

describe('versioned publication producer', () => {
  it('publishes only maintained pricing/harness facts, not assembled or staged authority', () => {
    const bytes = buildSnapshot(catalogue, 'a'.repeat(40), time);
    const snapshot = readSnapshot(bytes);
    expect(snapshot.models.length).toBeGreaterThan(0);
    for (const model of snapshot.models) {
      expect(Object.keys(model).every(key => ['identity', 'tariffs', 'harnesses', 'provenance'].includes(key))).toBe(true);
      expect(Object.keys(model.identity).sort()).toEqual(['key', 'lookupId', 'provider', 'rawId']);
      const original = catalogue.models.find((item: { identity: { key: string } }) =>
        item.identity.key === model.identity.key);
      expect(original.provenance.authority).toBe('maintained');
      expect(model.tariffs).toEqual(original.tariffs);
      expect(model.harnesses).toEqual(original.harnesses);
    }
    expect(snapshot.models.some((model: { identity: { key: string } }) =>
      model.identity.key === 'copilot/gemini-3.8-flash')).toBe(false);
    expect(snapshot.models.every((model: { identity: { provider: string } }) =>
      model.identity.provider === 'copilot')).toBe(true);
  });

  it('preserves exact decimals, unknown components, scopes, dates and harness evidence', () => {
    const result = readSnapshot(buildSnapshot(fixture(), 'a'.repeat(40), time));
    expect(result.models[0].tariffs).toEqual(fixture().models[0].tariffs);
    expect(result.models[0].harnesses).toEqual(fixture().models[0].harnesses);
    expect(result.observedAt).toBe('2026-10-20T00:00:00.000Z');
    expect(result.effectiveFrom).toBe('2026-10-22T23:00:00.000Z');
    expect(result.sha256).toBe(digest(json(payload(result))));
  });

  it('is deterministic and does not create revisions from build/source timestamps', () => {
    const first = buildSnapshot(fixture(), 'a'.repeat(40), time);
    expect(buildSnapshot(fixture(), 'a'.repeat(40), time)).toBe(first);
    const later = readSnapshot(buildSnapshot(fixture(), 'b'.repeat(40), '2026-10-23T00:00:00Z'));
    expect(later.revision).toBe(readSnapshot(first).revision);
    const reordered = fixture();
    reordered.models[0].tariffs[0].components.input.price = '1';
    expect(readSnapshot(buildSnapshot(reordered, 'a'.repeat(40), time)).revision)
      .not.toBe(later.revision);
  });

  it('does not derive feed changes from availability, routing or catalogue capture timestamps', () => {
    const first = fixture();
    const second = {
      ...fixture(), generatedAt: '2026-10-21T00:00:00Z',
      models: fixture().models.map(model => ({
        ...model,
        availability: [{ scope: { provider: 'copilot', channel: 'copilot-cli' },
          fact: { state: 'supported', provenance: evidence } }],
        reasoning: { support: 'supported', rawEfforts: ['high'], selectableEfforts: ['high'],
          mode: 'optional', provenance: evidence },
      })),
    };
    expect(buildSnapshot(second, 'a'.repeat(40), time)).toBe(buildSnapshot(first, 'a'.repeat(40), time));
  });

  it('rejects malformed canonical records, dates, scope, missing evidence and empty projection', () => {
    const invalidPrice = fixture();
    invalidPrice.models[0].tariffs[0].components.input.price = '-1';
    expect(() => buildSnapshot(invalidPrice, 'a'.repeat(40), time)).toThrow();
    const invalidScope = fixture();
    invalidScope.models[0].tariffs[0].scope.provider = 'openai';
    expect(() => buildSnapshot(invalidScope, 'a'.repeat(40), time)).toThrow(/Cross-provider/);
    const invalidHarness = fixture();
    invalidHarness.models[0].harnesses[0].scope.provider = 'openai';
    expect(() => buildSnapshot(invalidHarness, 'a'.repeat(40), time)).toThrow(/Cross-provider harness/);
    const badEvidence = fixture();
    badEvidence.models[0].tariffs[0].provenance = { ...evidence, revision: '' };
    expect(() => buildSnapshot(badEvidence, 'a'.repeat(40), time)).toThrow();
    expect(() => buildSnapshot(fixture(), 'not-a-sha', time)).toThrow(/source commit/);
    expect(() => buildSnapshot(fixture(), 'a'.repeat(40), 'invalid')).toThrow();
    expect(() => buildSnapshot({ ...fixture(), models: [] }, 'a'.repeat(40), time)).toThrow(/no reviewed/);
  });

  it('rejects tampered/unknown envelopes, pointer paths, versions and noncanonical bytes', () => {
    const bytes = buildSnapshot(fixture(), 'a'.repeat(40), time);
    for (const update of [{ schemaVersion: 2 }, { extra: true }, { revision: '0'.repeat(64) }]) {
      expect(() => readSnapshot(json({ ...JSON.parse(bytes), ...update }))).toThrow();
    }
    expect(() => readSnapshot(`${bytes}\n`)).toThrow();
    expect(() => readPointer(json({
      schemaVersion: 1, revision: 'a'.repeat(64), sourceCommit: 'a'.repeat(40),
      snapshot: '../untrusted', sha256: 'b'.repeat(64),
    }))).toThrow();
  });
});

describe('credential-free data branch publication', () => {
  let directory: string;
  let work: string;
  let remote: string;
  let savedEnvironment: NodeJS.ProcessEnv;
  let serial: number;
  const git = (cwd: string, ...args: string[]) => execFileSync('git',
    cwd === remote ? ['--git-dir', remote, ...args] : args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const head = () => git(work, 'rev-parse', 'HEAD');
  const remoteHead = () => git(remote, 'rev-parse', `refs/heads/${dataBranch}`);
  const show = (file: string) => execFileSync('git', ['--git-dir', remote, 'show', `${dataBranch}:${file}`], {
    cwd: remote, encoding: 'utf8',
  });
  const source = (eligible = true) => {
    fs.writeFileSync(path.join(work, eligible ? 'scripts/model-information/input.json' : 'unrelated'), String(++serial));
    git(work, 'add', '.');
    git(work, 'commit', '--quiet', '-m', `fixture ${serial}`);
    git(work, 'push', '--quiet', 'origin', 'main');
    return head();
  };
  const snapshot = (sha = head(), price = '1') => {
    const data = fixture();
    data.models[0].tariffs[0].components.input.price = price;
    return buildSnapshot(data, sha, time);
  };
  const run = (bytes = snapshot(), sha = head(), expectedDigest = digest(bytes)) =>
    publish({ cwd: work, bytes, sourceCommit: sha, expectedDigest });
  beforeEach(() => {
    savedEnvironment = process.env;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-publication-test-'));
    process.env = {
      PATH: savedEnvironment.PATH, HOME: directory,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    };
    work = path.join(directory, 'work');
    remote = path.join(directory, 'remote.git');
    fs.mkdirSync(work);
    git(directory, 'init', '--bare', '--quiet', remote);
    git(work, 'init', '--quiet', '-b', 'main');
    fs.mkdirSync(path.join(work, 'scripts/model-information'), { recursive: true });
    git(work, 'remote', 'add', 'origin', remote);
    serial = 0;
    source();
  });
  afterEach(() => {
    process.env = savedEnvironment;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('bootstraps an orphan data branch, atomically exposing complete bytes and pointer', () => {
    const bytes = snapshot();
    expect(run(bytes)).toMatch(/^published/);
    const pointer = readPointer(show(pointerPath));
    expect(pointer.sourceCommit).toBe(head());
    expect(show(pointer.snapshot)).toBe(bytes);
    expect(pointer.sha256).toBe(digest(bytes));
    expect(git(remote, 'rev-list', '--count', dataBranch)).toBe('1');
    expect(git(remote, 'ls-tree', '-r', '--name-only', dataBranch).split('\n').sort())
      .toEqual([pointerPath, pointer.snapshot].sort());
    expect(git(work, 'status', '--porcelain')).toBe('');
  });

  it('treats retries and identical data from a newer source as no-ops', () => {
    run();
    const before = remoteHead();
    expect(run()).toBe('unchanged');
    source();
    expect(run()).toBe('unchanged');
    expect(remoteHead()).toBe(before);
  });

  it('retains immutable history and reuses existing bytes on a reviewed rollback', () => {
    const first = snapshot();
    run(first);
    const initial = readPointer(show(pointerPath));
    source();
    run(snapshot(head(), '2'));
    expect(show(initial.snapshot)).toBe(first);
    source();
    const sameDataNewSource = snapshot();
    expect(sameDataNewSource).not.toBe(first);
    expect(run(sameDataNewSource)).toMatch(/^published/);
    const pointer = readPointer(show(pointerPath));
    expect(pointer.sourceCommit).toBe(head());
    expect(pointer.snapshot).toBe(initial.snapshot);
    expect(show(initial.snapshot)).toBe(first);
    expect(pointer.sha256).toBe(digest(first));
  });

  it('skips out-of-order runs including intermediate revisions after a no-op', () => {
    run();
    const before = remoteHead();
    const intermediateSource = source();
    const intermediate = snapshot(intermediateSource, '2');
    source();
    expect(run()).toBe('unchanged');
    expect(run(intermediate, intermediateSource)).toMatch(/^superseded/);
    expect(remoteHead()).toBe(before);
  });

  it('does not skip an eligible commit just because unrelated main changes followed', () => {
    const sha = head();
    const bytes = snapshot();
    source(false);
    expect(run(bytes, sha)).toMatch(/^published/);
  });

  it('rejects divergent/untrusted source, artifact mismatch and conflicting same-source output', () => {
    const bytes = snapshot();
    expect(() => run(bytes, head(), '0'.repeat(64))).toThrow(/Artifact digest/);
    expect(() => run(bytes, 'b'.repeat(40))).toThrow(/event SHA/);
    run(bytes);
    expect(() => run(snapshot(head(), '2'))).toThrow(/different catalogue/);
    git(work, 'checkout', '--quiet', '-b', 'untrusted');
    fs.writeFileSync(path.join(work, 'untrusted'), 'fixture');
    git(work, 'add', '.');
    git(work, 'commit', '--quiet', '-m', 'untrusted');
    expect(() => run()).toThrow(/not on trusted main/);
  });

  it('never overwrites a corrupt immutable revision and preserves the last pointer', () => {
    run();
    const sha = source();
    const bytes = snapshot(sha, '2');
    const next = readSnapshot(bytes);
    const parent = remoteHead();
    const staging = path.join(directory, 'staging');
    git(directory, 'clone', '--quiet', '--branch', dataBranch, remote, staging);
    const file = path.join(staging, `snapshots/v1/${next.revision}.json`);
    fs.writeFileSync(file, 'corrupt');
    git(staging, 'add', '.');
    git(staging, 'commit', '--quiet', '-m', 'corrupt fixture');
    git(staging, 'push', '--quiet');
    const before = remoteHead();
    expect(before).not.toBe(parent);
    expect(() => run(bytes)).toThrow();
    expect(remoteHead()).toBe(before);
  });

  it('preserves the previous complete state on push failure, and retries a transient failure', () => {
    run();
    source();
    const bytes = snapshot(head(), '2');
    const before = remoteHead();
    const hook = path.join(remote, 'hooks/pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(() => run(bytes)).toThrow(/push failed/);
    expect(remoteHead()).toBe(before);
    fs.writeFileSync(hook, `#!/bin/sh\nif [ ! -f '${directory}/rejected' ]; then\n touch '${directory}/rejected'\n exit 1\nfi\nexit 0\n`, { mode: 0o755 });
    expect(run(bytes)).toMatch(/^published/);
    expect(readPointer(show(pointerPath)).sha256).toBe(digest(bytes));
  });

  it('leaves no data branch behind if first publication fails', () => {
    fs.writeFileSync(path.join(remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(() => run()).toThrow(/push failed/);
    expect(git(work, 'ls-remote', '--heads', 'origin', `refs/heads/${dataBranch}`)).toBe('');
  });

  it('rejects an existing incomplete branch rather than silently replacing it', () => {
    git(work, 'push', '--quiet', 'origin', `HEAD:refs/heads/${dataBranch}`);
    const before = remoteHead();
    expect(() => run()).toThrow(/no usable v1 pointer/);
    expect(remoteHead()).toBe(before);
  });

  it('fails closed on fetch failure instead of interpreting it as missing data', () => {
    run();
    const before = remoteHead();
    git(work, 'remote', 'set-url', 'origin', path.join(directory, 'missing.git'));
    expect(() => run()).toThrow();
    expect(remoteHead()).toBe(before);
  });

  it('handles competing first publishers with a normal push and reuses the winner', () => {
    const bytes = snapshot();
    const record = readSnapshot(bytes);
    const competing = path.join(directory, 'competing');
    fs.mkdirSync(competing);
    git(competing, 'init', '--quiet', '-b', dataBranch);
    git(competing, 'remote', 'add', 'origin', remote);
    const file = `snapshots/v1/${record.revision}.json`;
    for (const [name, content] of [
      [file, bytes],
      [pointerPath, json({ schemaVersion: 1, revision: record.revision,
        sourceCommit: head(), snapshot: file, sha256: digest(bytes) })],
    ]) {
      fs.mkdirSync(path.dirname(path.join(competing, name)), { recursive: true });
      fs.writeFileSync(path.join(competing, name), content);
    }
    git(competing, 'add', '.');
    git(competing, 'commit', '--quiet', '-m', 'competing fixture');
    const winner = git(competing, 'rev-parse', 'HEAD');
    const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
if [ "$1" = push ] && [ ! -f '${directory}/raced' ]; then
  touch '${directory}/raced'
  '${realGit}' -C '${competing}' push --quiet origin '${dataBranch}' || exit 1
fi
exec '${realGit}' "$@"
`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    expect(run(bytes)).toBe('unchanged');
    expect(remoteHead()).toBe(winner);
    expect(show(file)).toBe(bytes);
  });

  it('checks stale projections and exact checkout source before creating any artifact', () => {
    for (const name of [
      'scripts/model-information', 'shared/model-information', 'src/model-information.compat.generated.json',
      'docs/model-api-mapping.json', 'containers/api-proxy/models.dev.catalog.json',
      'containers/api-proxy/model-information.pricing.generated.json',
      'containers/api-proxy/model-information.retired.generated.json',
      'containers/api-proxy/ai-credits-pricing-reference.json',
      'containers/api-proxy/model-api-mapping.json',
    ]) {
      fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
      fs.cpSync(path.join(root, name), path.join(work, name), { recursive: true });
    }
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(work, 'node_modules'), 'dir');
    const output = path.join(directory, 'snapshot.json');
    const command = path.join(work, 'scripts/model-information/build-publication.cjs');
    const invoke = (sha = head()) => spawnSync(process.execPath, [command, output], {
      cwd: work, env: { ...process.env, GITHUB_SHA: sha }, encoding: 'utf8',
    });
    expect(invoke('a'.repeat(40)).stderr).toContain('Checkout must equal');
    expect(fs.existsSync(output)).toBe(false);
    expect(invoke().status).toBe(0);
    expect(readSnapshot(fs.readFileSync(output)).sourceCommit).toBe(head());
    fs.unlinkSync(output);
    fs.writeFileSync(path.join(work, 'containers/api-proxy/model-information.pricing.generated.json'), '{}\n');
    const stale = invoke();
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain('stale; run npm run models:generate');
    expect(fs.existsSync(output)).toBe(false);
  });

  it('rejects non-main/noncanonical workflow entry before any remote operation', () => {
    const command = path.join(__dirname, 'publish.cjs');
    const invoke = (extra: NodeJS.ProcessEnv) => spawnSync(process.execPath, [command, 'unused.json'], {
      cwd: work, env: { ...process.env, ...extra }, encoding: 'utf8',
    });
    const trusted = {
      GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main',
      GITHUB_REPOSITORY: 'github/gh-aw-firewall',
    };
    for (const update of [
      { GITHUB_EVENT_NAME: 'pull_request' },
      { GITHUB_REF: 'refs/heads/untrusted' },
      { GITHUB_REPOSITORY: 'untrusted/repository' },
    ]) {
      expect(invoke({ ...trusted, ...update }).stderr).toContain('requires trusted repository main push');
    }
    expect(invoke(trusted).stderr).toContain('Untrusted publication origin');
    expect(git(work, 'ls-remote', '--heads', 'origin', `refs/heads/${dataBranch}`)).toBe('');
  });
});

describe('trusted publication workflow graph', () => {
  it('gates writes behind exact-source read-only validation with no dispatch/release/runtime hooks', () => {
    const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/publish-model-catalogue.yml'), 'utf8')) as {
      on: { push: { branches: string[]; paths: string[] } };
      permissions: object;
      concurrency: { group: string; 'cancel-in-progress': boolean };
      jobs: Record<string, {
        needs?: string; if: string; permissions?: object;
        steps: Array<{ uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> }>;
      }>;
    };
    expect(Object.keys(workflow.on)).toEqual(['push']);
    expect(workflow.on.push.branches).toEqual(['main']);
    expect(workflow.on.push.paths).toEqual(inputPaths);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    const { build, publish: writer } = workflow.jobs;
    expect(writer.needs).toBe('build');
    expect(writer.permissions).toEqual({ contents: 'write' });
    for (const job of [build, writer]) {
      expect(job.if).toContain("github.repository == 'github/gh-aw-firewall'");
      expect(job.if).toContain("github.ref == 'refs/heads/main'");
      expect(job.if).toContain("github.event_name == 'push'");
      expect(job.steps[0].with?.ref).toBe('${{ github.sha }}');
      for (const step of job.steps.filter(step => step.uses)) {
        expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
      }
    }
    expect(build.steps[0].with?.['persist-credentials']).toBe(false);
    expect(build.steps.some(step => step.run === 'npm ci --ignore-scripts')).toBe(true);
    expect(build.steps.some(step => step.run?.includes('build-publication.cjs'))).toBe(true);
    expect(writer.steps.filter(step => step.run).map(step => step.run)).toEqual([
      'node scripts/model-information/publish.cjs "$RUNNER_TEMP/model-catalogue/snapshot.json"',
    ]);
    expect(writer.steps[writer.steps.length - 1].env).toEqual({ SNAPSHOT_SHA256: '${{ needs.build.outputs.sha256 }}' });
    expect(fs.readFileSync(path.join(__dirname, 'publish.cjs'), 'utf8'))
      .not.toMatch(/--force|workflow_dispatch|npm |checkout/);
  });
});
