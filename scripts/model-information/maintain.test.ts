import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const {
  captureSources, loadCaptures, refreshImport, buildReport, selectPullRequest,
  reviewReasons, differences, inspectCatalogue, documentText, hash, json, facts,
  catalogueFacts, runtimeResolutionFacts, verifyCommittedTree,
} = require('./maintain.cjs');
const sources = require('./maintenance-sources.json');
const root = path.resolve(__dirname, '../..');
const rawFile = 'containers/api-proxy/models.dev.catalog.json';
const metadataFile = 'shared/model-information/imported/legacy-models-dev.metadata.json';
const snapshotFile = 'shared/model-information/imported/legacy-models-dev.snapshot.v1.json';
const targetFile = 'shared/model-information/sources/target.json';
const quote = 'Exact model fixture supports low and high effort with a context limit of 128000 tokens.';
const priced = (id = 'openai/fixture', prompt = '0.000001') => ({
  id, pricing: { prompt, completion: '0.000002' },
});
const catalog = (entries: unknown[] = [priced()]) =>
  Buffer.from(JSON.stringify({ data: entries, total_count: entries.length, links: { next: null } }));
const write = (cwd: string, file: string, bytes: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), bytes);
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const fakeFetch = (bytes = catalog()) => async (url: string) => new Response(
  url.includes('openrouter.ai') ? bytes : `<html><body>${quote}</body></html>`,
  { status: 200 },
);

describe('offline scheduled source maintenance', () => {
  let cwd: string;
  let evidence: string;
  let trustedEnvironment: Record<string, string | undefined>;
  beforeEach(async () => {
    trustedEnvironment = Object.fromEntries(
      ['TRUSTED_MAINTENANCE_BASE', 'TRUSTED_REVIEW_BASE', 'TRUSTED_VALIDATION_FILES']
        .map(key => [key, process.env[key]]),
    );
    for (const key of Object.keys(trustedEnvironment)) delete process.env[key];
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-model-maintenance-'));
    evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-model-evidence-'));
    await captureSources(evidence, fakeFetch());
    const capture = loadCaptures(evidence).find((item: { id: string }) => item.id === 'openrouter-models');
    const snapshot = inspectCatalogue(catalog(), capture).snapshot;
    const metadata = Object.fromEntries(
      ['source', 'revision', 'retrievedAt', 'sha256', 'license'].map(key => [key, snapshot[key]]),
    );
    write(cwd, rawFile, catalog());
    write(cwd, metadataFile, json(metadata));
    write(cwd, snapshotFile, json(snapshot));
    write(cwd, targetFile, json({ provenance: { confidence: 'verified', at: '2026-10-01T00:00:00Z' }, routing: [{ id: 'fixture', efforts: ['low'], context: 64000 }] }));
    git(cwd, 'init', '--quiet');
    git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'add', '.');
    git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
    fs.writeFileSync(path.join(evidence, 'base-revision'), git(cwd, 'rev-parse', 'HEAD'));
    fs.writeFileSync(path.join(evidence, 'review-base-revision'), git(cwd, 'rev-parse', 'HEAD'));
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(evidence, { recursive: true, force: true });
    for (const [key, value] of Object.entries(trustedEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const propose = (cwd: string, evidence: string) => {
    const before = Buffer.from(git(cwd, 'show', `HEAD:${targetFile}`));
    const after = fs.readFileSync(path.join(cwd, targetFile));
    fs.writeFileSync(path.join(evidence, 'proposal.json'), json({ changes: [{
      file: targetFile, beforeSha256: hash(before), afterSha256: hash(after),
      scope: 'OpenAI native fixture model only', summary: 'Documented effort/context drift',
      evidence: [{ source: 'openai-models', quote }],
    }] }));
  };

  it('captures URL, scope, exact bytes/hash, time and governed import counts', () => {
    const captures = loadCaptures(evidence);
    expect(captures).toHaveLength(sources.length);
    expect(captures.every((item: { status: string }) => item.status === 'ok')).toBe(true);
    expect(captures.find((item: { id: string }) => item.id === 'openrouter-models')).toMatchObject({
      sha256: hash(catalog()), url: 'https://openrouter.ai/api/v1/models',
      import: { accepted: 1, rejected: 0, collisions: [], excluded: [] },
      scope: expect.stringContaining('NOT native-provider'),
    });
    expect(fs.readFileSync(path.join(evidence, 'openai-models.txt'), 'utf8')).toBe(quote);
  });

  it('exports trusted hashes through the host environment file', async () => {
    const environmentFile = path.join(cwd, 'github-env');
    const previous = process.env.GITHUB_ENV;
    fs.writeFileSync(environmentFile, '');
    process.env.GITHUB_ENV = environmentFile;
    try {
      await captureSources(evidence, fakeFetch());
      const [entry] = fs.readFileSync(environmentFile, 'utf8').trim().split('\n');
      expect(entry.startsWith('TRUSTED_CAPTURES_JSON=')).toBe(true);
      expect(JSON.parse(entry.slice('TRUSTED_CAPTURES_JSON='.length)).sources).toHaveLength(sources.length);
    } finally {
      if (previous === undefined) delete process.env.GITHUB_ENV;
      else process.env.GITHUB_ENV = previous;
    }
  });

  it('rejects modified captures even when their writable manifest is rewritten to match', () => {
    const captures = JSON.parse(fs.readFileSync(path.join(evidence, 'captures.json'), 'utf8'));
    const source = captures.sources.find((item: { id: string }) => item.id === 'openai-models');
    const textPath = path.join(evidence, 'openai-models.txt');
    fs.writeFileSync(textPath, 'Fabricated official source evidence with a matching writable hash.');
    source.textSha256 = hash(fs.readFileSync(textPath));
    fs.writeFileSync(path.join(evidence, 'captures.json'), json(captures));
    expect(() => loadCaptures(evidence)).toThrow('hash mismatch');
  });

  it('requires a well-formed trusted capture manifest', () => {
    const manifest = process.env.TRUSTED_CAPTURES_JSON;
    delete process.env.TRUSTED_CAPTURES_JSON;
    expect(() => loadCaptures(evidence)).toThrow('TRUSTED_CAPTURES_JSON is required');
    process.env.TRUSTED_CAPTURES_JSON = '{';
    expect(() => loadCaptures(evidence)).toThrow('invalid JSON');
    process.env.TRUSTED_CAPTURES_JSON = manifest!;
  });

  it('decodes document entities once while retaining literal entity evidence', () => {
    expect(documentText(Buffer.from(
      '<p>&amp;lt;model&amp;gt; &amp;amp; &quot;exact&quot; &#39;quote&#39;&nbsp;&#160;&lt;literal&gt;</p>',
    ))).toBe('&lt;model&gt; &amp; "exact" \'quote\' <literal>');
  });

  it('uses private atomic captures without following pre-existing file symlinks', async () => {
    const sentinel = path.join(cwd, 'must-not-overwrite');
    fs.writeFileSync(sentinel, 'unchanged');
    fs.unlinkSync(path.join(evidence, 'openai-models.raw'));
    fs.symlinkSync(sentinel, path.join(evidence, 'openai-models.raw'));
    fs.chmodSync(evidence, 0o755);
    await captureSources(evidence, fakeFetch());
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('unchanged');
    expect(fs.lstatSync(path.join(evidence, 'openai-models.raw')).isSymbolicLink()).toBe(false);
    expect(fs.statSync(evidence).mode & 0o777).toBe(0o700);
    for (const file of fs.readdirSync(evidence).filter(name => /\.(raw|txt|json)$/.test(name))) {
      expect(fs.statSync(path.join(evidence, file)).mode & 0o777).toBe(0o600);
    }
    expect(fs.readdirSync(evidence).some(name => name.startsWith('.capture-'))).toBe(false);
    expect(loadCaptures(evidence)).toHaveLength(sources.length);
  });

  it('rejects a symlinked evidence directory or unsafe source ID before retrieval', async () => {
    const link = path.join(cwd, 'evidence-link');
    fs.symlinkSync(evidence, link, 'dir');
    const fetcher = jest.fn(fakeFetch());
    await expect(captureSources(link, fetcher)).rejects.toThrow('not a symlink');
    await expect(captureSources(evidence, fetcher, [{
      ...sources[0], id: '../outside-evidence',
    }])).rejects.toThrow('Unsafe capture source ID');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('is a true no-op across retrieval times, API formatting and decimal-equivalent prices', async () => {
    const oldRaw = fs.readFileSync(path.join(cwd, rawFile));
    const oldMetadata = fs.readFileSync(path.join(cwd, metadataFile));
    await captureSources(evidence, fakeFetch(Buffer.from(JSON.stringify({
      data: [{ ...priced('openai/fixture', '0.000001000'), description: 'new marketing copy' }],
      total_count: 1, links: { next: null },
    }, null, 4))));
    expect(refreshImport(cwd, evidence)).toBe(false);
    expect(fs.readFileSync(path.join(cwd, rawFile))).toEqual(oldRaw);
    expect(fs.readFileSync(path.join(cwd, metadataFile))).toEqual(oldMetadata);
    expect(buildReport(cwd, evidence)).toBeNull();
    expect(git(cwd, 'status', '--porcelain')).toBe('');
  });

  it('also blocks attempts to pin description-only capture churn outside the refresh helper', async () => {
    const bytes = catalog([{ ...priced(), description: 'Unchanged facts' }]);
    await captureSources(evidence, fakeFetch(bytes));
    const capture = loadCaptures(evidence).find((item: { id: string }) => item.id === 'openrouter-models');
    const snapshot = inspectCatalogue(bytes, capture).snapshot;
    write(cwd, rawFile, bytes);
    write(cwd, metadataFile, json(Object.fromEntries(
      ['source', 'revision', 'retrievedAt', 'sha256', 'license'].map(key => [key, snapshot[key]]),
    )));
    expect(() => buildReport(cwd, evidence)).toThrow('no material model facts');
  });

  it('pins material import changes and emits explicit source-disappearance review without retirement', async () => {
    await captureSources(evidence, fakeFetch(catalog([priced('openai/new-fixture', '0.0000005')])));
    expect(refreshImport(cwd, evidence)).toBe(true);
    const report = buildReport(cwd, evidence);
    expect(report.status).toBe('proposed-awaiting-human-review');
    expect(report.changes.map((item: { file: string }) => item.file)).toEqual([rawFile, metadataFile].sort());
    expect(report.runtimeConsumerEffects).toEqual([
      expect.objectContaining({ file: rawFile, changes: expect.any(Array) }),
    ]);
    expect(report.changes.find((item: { file: string }) => item.file === rawFile)).toMatchObject({
      addedModels: ['openai/new-fixture'], removedModels: ['openai/fixture'],
      reviewRequired: expect.arrayContaining(['source-or-record-disappearance-not-proof-of-retirement']),
    });
    const metadata = JSON.parse(fs.readFileSync(path.join(cwd, metadataFile), 'utf8'));
    expect(metadata.source).toBe('https://openrouter.ai/api/v1/models');
    expect(metadata.sha256).toBe(hash(fs.readFileSync(path.join(cwd, rawFile))));
    expect(metadata.license).toContain('no license rights inferred');
    expect(report.reviewRequired).toEqual(['All model-fact changes require human review; no auto-merge or publication.']);
    expect(report.roundingTolerance).toMatch(/Zero/);
    expect(fs.readFileSync(path.join(cwd, snapshotFile), 'utf8')).not.toContain('retired');
  });

  it('detects raw effort/context and threshold drift even when projected base token prices are unchanged', async () => {
    const bytes = catalog([{
      ...priced(), context_length: 128000, supported_parameters: ['reasoning'],
      pricing: { ...priced().pricing, overrides: [{ min_prompt_tokens: 64000, prompt: '0.000002' }] },
    }]);
    await captureSources(evidence, fakeFetch(bytes));
    expect(refreshImport(cwd, evidence)).toBe(true);
    expect(buildReport(cwd, evidence).changes[0].changes).toEqual(expect.arrayContaining([
      { pointer: '/data/@id=openai~1fixture/context', before: null, after: 128000 },
      { pointer: '/data/@id=openai~1fixture/parameters/0', before: null, after: 'reasoning' },
    ]));
  });

  it('tracks lookup aliases, normalized modality sets, and order-sensitive runtime pricing winners', async () => {
    const old = catalog([
      { ...priced('google/gemma-4-31b-it', '0'), canonical_slug: 'google/gemma-4-31b-it',
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
      { ...priced('openai/alias-competitor', '0.00000012'), canonical_slug: 'google/gemma-4-31b-it' },
    ]);
    const reversed = catalog([
      { ...priced('openai/alias-competitor', '0.00000012'), canonical_slug: 'google/gemma-4-31b-it' },
      { ...priced('google/gemma-4-31b-it', '0'), canonical_slug: 'google/gemma-4-31b-it',
        architecture: { input_modalities: ['image', 'text'], output_modalities: ['text'] } },
    ]);
    expect(catalogueFacts(old)).toEqual(catalogueFacts(reversed));
    expect(runtimeResolutionFacts(old)['@lookup=gemma-4-31b-it'].pricing.input).toBe(0);
    expect(runtimeResolutionFacts(reversed)['@lookup=gemma-4-31b-it'].pricing.input).toBe(0.12);

    await captureSources(evidence, fakeFetch(reversed));
    expect(refreshImport(cwd, evidence)).toBe(true);
    const report = buildReport(cwd, evidence);
    const changes = report.changes.find((item: { file: string }) => item.file === rawFile).changes;
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ pointer: expect.stringContaining('/canonicalSlug') }),
      expect.objectContaining({ pointer: expect.stringContaining('/inputModalities') }),
      expect.objectContaining({ pointer: expect.stringContaining('/runtimeResolution/@lookup=gemma-4-31b-it') }),
    ]));
    expect(report.changes.find((item: { file: string }) => item.file === rawFile).reviewRequired)
      .toContain('compatibility-contraction-and-scope');
    expect(report.runtimeConsumerEffects[0].changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ pointer: expect.stringContaining('/@lookup=gemma-4-31b-it/pricing') }),
    ]));
  });

  it('normalizes modality ordering but records modality-only and alias-only changes', async () => {
    const before = catalog([{
      ...priced(), architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    }]);
    const reordered = catalog([{
      ...priced(), architecture: { input_modalities: ['image', 'text'], output_modalities: ['text'] },
    }]);
    const changed = catalog([{
      ...priced(), canonical_slug: 'openai/fixture-alias',
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    }]);
    expect(catalogueFacts(before)).toEqual(catalogueFacts(reordered));
    await captureSources(evidence, fakeFetch(changed));
    expect(refreshImport(cwd, evidence)).toBe(true);
    expect(buildReport(cwd, evidence).changes.find((item: { file: string }) => item.file === rawFile).changes)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ pointer: expect.stringContaining('/canonicalSlug') }),
        expect.objectContaining({ pointer: expect.stringContaining('/inputModalities') }),
      ]));
  });

  it('requires evidence receipts for effort/context changes, including after agent commits', () => {
    const before = JSON.parse(fs.readFileSync(path.join(cwd, targetFile), 'utf8'));
    before.routing[0].efforts.push('high');
    before.routing[0].context = 128000;
    write(cwd, targetFile, json(before));
    expect(() => buildReport(cwd, evidence)).toThrow('missing source-aware proposal');
    propose(cwd, evidence);
    const report = buildReport(cwd, evidence);
    expect(report.changes[0].changes).toEqual(expect.arrayContaining([
      { pointer: '/routing/0/context', before: 64000, after: 128000 },
      { pointer: '/routing/0/efforts/1', before: null, after: 'high' },
    ]));
    expect(report.changes[0].reviewRequired).toContain('efforts-and-limits');
    write(cwd, 'shared/model-information/maintenance-report.json', json(report));
    git(cwd, 'add', '.');
    git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'proposal');
    expect(buildReport(cwd, evidence)).toEqual(report);
  });

  it('rejects metadata-only churn and unsupported or stale evidence receipts', () => {
    const original = fs.readFileSync(path.join(cwd, targetFile));
    const data = JSON.parse(original.toString());
    data.provenance.at = '2026-10-21T00:00:00Z';
    write(cwd, targetFile, json(data));
    expect(() => buildReport(cwd, evidence)).toThrow('timestamp-only churn');
    data.routing[0].context = 128000;
    write(cwd, targetFile, json(data));
    propose(cwd, evidence);
    const proposalPath = path.join(evidence, 'proposal.json');
    const proposal = JSON.parse(fs.readFileSync(proposalPath, 'utf8'));
    proposal.changes[0].evidence[0].quote = 'A fabricated claim not in the actually fetched provider page.';
    fs.writeFileSync(proposalPath, json(proposal));
    expect(() => buildReport(cwd, evidence)).toThrow('unsupported evidence quote');
    propose(cwd, evidence);
    write(cwd, targetFile, original);
    const further = JSON.parse(original.toString());
    further.routing[0].context = 256000;
    write(cwd, targetFile, json(further));
    expect(() => buildReport(cwd, evidence)).toThrow('exact before/after hashes');
  });

  it('treats confidence downgrade as material and equivalent decimal formatting as non-material', () => {
    const data = JSON.parse(fs.readFileSync(path.join(cwd, targetFile), 'utf8'));
    data.provenance.confidence = 'estimated';
    write(cwd, targetFile, json(data));
    propose(cwd, evidence);
    expect(buildReport(cwd, evidence).changes[0].reviewRequired).toContain('confidence-including-downgrade');
    expect(facts({ price: '1.0000' })).toEqual(facts({ price: '1' }));
    expect(facts({ price: '1.0000001' })).not.toEqual(facts({ price: '1' }));
  });

  it('keeps the cumulative pending PR diff while comparing new evidence against the existing head', () => {
    const data = JSON.parse(fs.readFileSync(path.join(cwd, targetFile), 'utf8'));
    data.routing[0].context = 128000;
    write(cwd, targetFile, json(data));
    propose(cwd, evidence);
    write(cwd, 'shared/model-information/maintenance-report.json', json(buildReport(cwd, evidence)));
    git(cwd, 'add', '.');
    git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'first update');
    fs.writeFileSync(path.join(evidence, 'base-revision'), git(cwd, 'rev-parse', 'HEAD'));
    expect(buildReport(cwd, evidence)).toBeNull();
    data.routing[0].efforts.push('high');
    write(cwd, targetFile, json(data));
    propose(cwd, evidence);
    const report = buildReport(cwd, evidence);
    expect(report.changes[0].changes.some((change: { pointer: string }) => change.pointer.endsWith('/context'))).toBe(false);
    expect(report.pendingSourceChanges[0].changes).toEqual(expect.arrayContaining([
      { pointer: '/routing/0/context', before: 64000, after: 128000 },
      { pointer: '/routing/0/efforts/1', before: null, after: 'high' },
    ]));
  });

  it('uses the maintenance PR merge base for cumulative source changes after independent main edits', () => {
    git(cwd, 'branch', 'maintenance');
    const original = JSON.parse(fs.readFileSync(path.join(cwd, targetFile), 'utf8'));
    const first = structuredClone(original);
    first.routing[0].context = 128000;
    write(cwd, targetFile, json(first));
    propose(cwd, evidence);
    write(cwd, 'shared/model-information/maintenance-report.json', json(buildReport(cwd, evidence)));
    git(cwd, 'add', '.');
    git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'pending update');
    const firstMaintenanceHead = git(cwd, 'rev-parse', 'HEAD').trim();
    git(cwd, 'switch', '-q', 'maintenance');
    write(cwd, targetFile, json({ ...original, routing: [{ ...original.routing[0], context: 512000 }] }));
    propose(cwd, evidence);
    git(cwd, 'add', '.');
    git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'main-only source edit');
    write(cwd, 'shared/model-information/sources/main-only.json', json({ models: [] }));
    git(cwd, 'add', '.');
    git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'main-only source addition');
    const reviewBase = git(cwd, 'rev-parse', 'HEAD').trim();
    git(cwd, 'switch', '-q', '-');
    expect(git(cwd, 'rev-parse', 'HEAD').trim()).toBe(firstMaintenanceHead);
    fs.writeFileSync(path.join(evidence, 'base-revision'), firstMaintenanceHead);
    fs.writeFileSync(path.join(evidence, 'review-base-revision'), reviewBase);
    const envBase = process.env.TRUSTED_MAINTENANCE_BASE;
    const envReview = process.env.TRUSTED_REVIEW_BASE;
    process.env.TRUSTED_MAINTENANCE_BASE = firstMaintenanceHead;
    process.env.TRUSTED_REVIEW_BASE = reviewBase;
    try {
      write(cwd, targetFile, json({ ...first, routing: [{ ...first.routing[0], efforts: ['low', 'high'] }] }));
      propose(cwd, evidence);
      const report = buildReport(cwd, evidence);
      expect(report.pendingSourceChanges).toHaveLength(1);
      expect(report.pendingSourceChangesBaseRevision).toBe(git(cwd, 'merge-base', firstMaintenanceHead, reviewBase).trim());
      expect(report.pendingSourceChanges[0].file).toBe(targetFile);
      expect(report.pendingSourceChanges[0].changes).toEqual(expect.arrayContaining([
        { pointer: '/routing/0/context', before: 64000, after: 128000 },
      ]));
    } finally {
      if (envBase === undefined) delete process.env.TRUSTED_MAINTENANCE_BASE;
      else process.env.TRUSTED_MAINTENANCE_BASE = envBase;
      if (envReview === undefined) delete process.env.TRUSTED_REVIEW_BASE;
      else process.env.TRUSTED_REVIEW_BASE = envReview;
    }
  });

  it('permits host-restored config only when it exactly matches the trusted main tree', () => {
    const configPath = '.github/workflows/host-restored.yml';
    git(cwd, 'branch', 'maintenance');
    write(cwd, configPath, 'trusted config\n');
    git(cwd, 'add', '.');
    git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'main config');
    const trustedMain = git(cwd, 'rev-parse', 'HEAD').trim();
    git(cwd, 'switch', '-q', 'maintenance');
    fs.writeFileSync(path.join(evidence, 'base-revision'), git(cwd, 'rev-parse', 'HEAD'));
    const envReview = process.env.TRUSTED_REVIEW_BASE;
    process.env.TRUSTED_REVIEW_BASE = trustedMain;
    try {
      write(cwd, configPath, 'trusted config\n');
      expect(buildReport(cwd, evidence)).toBeNull();
      write(cwd, configPath, 'agent-edited config\n');
      expect(() => buildReport(cwd, evidence)).toThrow('Out-of-scope change');
    } finally {
      if (envReview === undefined) delete process.env.TRUSTED_REVIEW_BASE;
      else process.env.TRUSTED_REVIEW_BASE = envReview;
    }
  });

  it('requires a clean committed tree for the final verifier', () => {
    write(cwd, 'untracked.txt', 'uncommitted');
    expect(() => verifyCommittedTree(cwd)).toThrow('clean committed tree');
    git(cwd, 'clean', '-fdq');
    git(cwd, 'checkout', '--', '.');
    expect(() => verifyCommittedTree(cwd)).not.toThrow();
  });

  it('reads committed canonical blobs larger than execFileSync’s default buffer', async () => {
    const bytes = catalog([{
      ...priced('openai/large-fixture', '0.0000010001'),
      description: 'x'.repeat(2 * 1024 * 1024),
    }]);
    await captureSources(evidence, fakeFetch(bytes));
    expect(refreshImport(cwd, evidence)).toBe(true);
    expect(buildReport(cwd, evidence).changes.find((item: { file: string }) => item.file === rawFile).changes)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ pointer: expect.stringContaining('/openai~1large-fixture') }),
      ]));
  });

  it('rejects generated-only and out-of-scope authoring', () => {
    write(cwd, 'docs/model-api-mapping.json', '{}');
    expect(() => buildReport(cwd, evidence)).toThrow('without a canonical source');
    write(cwd, 'src/cli.ts', 'unrelated change');
    expect(() => buildReport(cwd, evidence)).toThrow('Out-of-scope change');
  });

  it('surfaces failed and partial coverage with affected sources and preserves prior facts', async () => {
    const before = fs.readFileSync(path.join(cwd, rawFile));
    const captures = await captureSources(evidence, async (url: string) => {
      if (url.includes('openrouter.ai')) return new Response('not found', { status: 404 });
      return fakeFetch()(url);
    });
    expect(captures.find((item: { id: string }) => item.id === 'openrouter-models')).toMatchObject({
      status: 'failed', errors: [expect.stringContaining('HTTP 404')],
    });
    expect(() => refreshImport(cwd, evidence)).toThrow('openrouter-models');
    expect(() => buildReport(cwd, evidence)).toThrow('Incomplete source coverage');
    expect(fs.readFileSync(path.join(cwd, rawFile))).toEqual(before);
    const capturePath = path.join(evidence, 'captures.json');
    fs.writeFileSync(capturePath, json({ sources: captures.slice(1) }));
    expect(() => loadCaptures(evidence)).toThrow('copilot-models');
  });

  it('fails on empty/challenge pages, invalid catalogues and tampered bytes rather than refreshing', async () => {
    const captures = await captureSources(evidence, async (url: string) =>
      url.includes('openrouter.ai')
        ? fakeFetch(catalog([priced('openai/fixture', '-1')]))(url)
        : new Response('<title>Just a moment</title>challenge '.repeat(10), { status: 200 }));
    expect(captures.every((item: { status: string }) => item.status === 'failed')).toBe(true);
    await captureSources(evidence, fakeFetch());
    fs.appendFileSync(path.join(evidence, 'openai-models.raw'), 'tampered');
    expect(() => loadCaptures(evidence)).toThrow('hash mismatch');
  });

  it('records known routing exclusions but rejects normalized collisions and malformed prices', () => {
    const capture = { url: 'https://openrouter.ai/api/v1/models', sha256: hash(catalog()), retrievedAt: '2026-10-21T00:00:00Z' };
    expect(inspectCatalogue(catalog([
      priced(), priced('~openai/latest'),
      { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
      { id: 'nvidia/switchyard', pricing: { prompt: '-1', completion: '-1' } },
    ]), capture)).toMatchObject({
      snapshot: { accepted: 1, rejected: 3 }, excluded: ['~openai/latest', 'openrouter/auto', 'nvidia/switchyard'],
    });
    expect(() => inspectCatalogue(catalog([priced('openai/a.b'), priced('openai/a-b')]), capture)).toThrow('ambiguous');
    expect(() => inspectCatalogue(catalog([priced(), priced('openai/bad', '-1')]), capture)).toThrow('rejected=1');
    expect(() => inspectCatalogue(Buffer.from(JSON.stringify({ data: [priced()] })), capture)).toThrow('fresh API captures require');
    expect(() => inspectCatalogue(Buffer.from(JSON.stringify({
      data: [priced()], total_count: 2, links: { next: null },
    })), capture)).toThrow('Incomplete catalogue coverage');
    expect(() => inspectCatalogue(Buffer.from(JSON.stringify({
      data: [priced()], total_count: 1, links: {},
    })), capture)).toThrow('Incomplete catalogue coverage');
  });

  it('keys model-array drift by exact identity rather than shuffled positions', () => {
    const first = { id: 'openai/a', context: 128000 };
    const second = { id: 'openai/b', context: 256000 };
    expect(differences({ data: [first, second] }, { data: [second, first] })).toEqual([]);
    expect(differences({ data: [first, second] }, { data: [first] })).toEqual([
      { pointer: '/data/@id=openai~1b', before: second, after: null },
    ]);
  });

  it.each([
    ['/tariffs/0/components/input/price', '2', '1', 'pricing-including-decreases-and-expiry'],
    ['/lifecycle/status', 'active', 'retired', 'lifecycle-retirement-replacement'],
    ['/availability/0/fact/state', 'supported', 'unsupported', 'compatibility-contraction-and-scope'],
    ['/provenance/confidence', 'verified', 'estimated', 'confidence-including-downgrade'],
    ['/models/0', { id: 'missing' }, undefined, 'source-or-record-disappearance-not-proof-of-retirement'],
  ])('requires explicit review for high-impact drift at %s', (pointer, before, after, reason) => {
    const changes = differences({ value: before }, { value: after }).map((change: object) => ({ ...change, pointer }));
    expect(reviewReasons(changes)).toEqual(expect.arrayContaining(['human-review-required', reason]));
  });

  it.each([
    ['/models/@id=vendor~1expiration-price/expiration', '2027-01-01', null, 'lifecycle-retirement-replacement'],
    ['/models/@id=vendor~1max-limit/maxCompletion', 32000, 16000, 'efforts-and-limits'],
    ['/models/@id=vendor~1tools/parameters', ['tools'], [], 'compatibility-contraction-and-scope'],
    ['/models/@id=vendor~1reasoning-price/tariffs/0/components/input/price', '2', '1', 'pricing-including-decreases-and-expiry'],
  ])('classifies review gates by field path rather than model ID: %s', (pointer, before, after, reason) => {
    const reasons = reviewReasons([{ pointer, before, after }]);
    expect(reasons).toContain(reason);
    if (pointer.includes('reasoning-price')) expect(reasons).not.toContain('efforts-and-limits');
  });

  it('deduplicates open PRs by exact ownership boundaries, and fails on competing PRs', () => {
    const pr = {
      number: 42, title: 'chore: refresh canonical model sources',
      headRefName: 'automation/model-source-maintenance-123', baseRefName: 'main', isCrossRepository: false,
    };
    expect(selectPullRequest([])).toBeNull();
    expect(selectPullRequest([{ ...pr, title: 'Unrelated', headRefName: 'unrelated' }, pr])).toEqual(pr);
    expect(selectPullRequest([{ ...pr, isCrossRepository: true }])).toBeNull();
    expect(() => selectPullRequest([{ ...pr, baseRefName: 'release' }])).toThrow('identity changed');
    expect(() => selectPullRequest([{ ...pr, title: 'Human-edited title' }])).toThrow('identity changed');
    expect(() => selectPullRequest([pr, { ...pr, number: 43 }])).toThrow('Multiple maintenance PRs');
    expect(() => selectPullRequest(Array(1000).fill(pr))).toThrow('Incomplete PR coverage');
  });

  it('selects the trusted PR without loading import tooling or requiring installed dependencies', () => {
    for (const file of ['maintain.cjs', 'maintenance-sources.json']) {
      write(cwd, `scripts/model-information/${file}`,
        fs.readFileSync(path.join(root, 'scripts/model-information', file)));
    }
    const pulls = path.join(evidence, 'pulls.json');
    const selected = {
      number: 42, title: 'chore: refresh canonical model sources',
      headRefName: 'automation/model-source-maintenance-123', baseRefName: 'main', isCrossRepository: false,
    };
    const args = [path.join(cwd, 'scripts/model-information/maintain.cjs'), 'select-pr', pulls];
    fs.writeFileSync(pulls, json([selected]));
    expect(JSON.parse(execFileSync(process.execPath, args, { cwd, encoding: 'utf8' }))).toEqual(selected);
    fs.writeFileSync(pulls, '[]');
    expect(JSON.parse(execFileSync(process.execPath, args, { cwd, encoding: 'utf8' }))).toBeNull();
  });
});

describe('governed source-to-generated validation', () => {
  it('regenerates a changed import from pinned bytes/metadata and rejects stale or corrupted projections', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-model-compiler-'));
    try {
      for (const directory of ['scripts/model-information', 'shared/model-information']) {
        fs.cpSync(path.join(root, directory), path.join(cwd, directory), { recursive: true });
      }
      fs.symlinkSync(path.join(root, 'node_modules'), path.join(cwd, 'node_modules'), 'dir');
      fs.mkdirSync(path.join(cwd, 'src'));
      fs.mkdirSync(path.join(cwd, 'docs'));
      write(cwd, rawFile, fs.readFileSync(path.join(root, rawFile)));
      const args = [path.join(cwd, 'scripts/model-information/compile.cjs')];
      execFileSync(process.execPath, args);
      const original = fs.readFileSync(path.join(cwd, snapshotFile));
      const data = JSON.parse(fs.readFileSync(path.join(cwd, rawFile), 'utf8'));
      data.data[0].pricing.prompt = '0.000011';
      const bytes = Buffer.from(JSON.stringify(data));
      write(cwd, rawFile, bytes);
      const metadata = JSON.parse(fs.readFileSync(path.join(cwd, metadataFile), 'utf8'));
      metadata.sha256 = hash(bytes);
      metadata.revision = metadata.sha256;
      write(cwd, metadataFile, json(metadata));
      expect(() => execFileSync(process.execPath, [...args, '--check'], { stdio: 'pipe' })).toThrow();
      execFileSync(process.execPath, args);
      expect(fs.readFileSync(path.join(cwd, snapshotFile))).not.toEqual(original);
      expect(execFileSync(process.execPath, [...args, '--check'], { encoding: 'utf8' })).toContain('Checked');
      write(cwd, 'docs/model-api-mapping.json', '{}');
      expect(() => execFileSync(process.execPath, [...args, '--check'], { stdio: 'pipe' })).toThrow();
      fs.appendFileSync(path.join(cwd, rawFile), 'corrupt');
      expect(() => execFileSync(process.execPath, args, { stdio: 'pipe' })).toThrow();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
