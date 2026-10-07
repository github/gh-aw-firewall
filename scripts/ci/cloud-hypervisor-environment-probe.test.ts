import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as yaml from 'js-yaml';
import { validateSchema, validateValueAgainstSchema } from '../../src/bounded-execution/finite-schema';
import { validateWithSchema } from '../../src/schema-validator';

const directory = path.resolve(__dirname, '../../examples/enclave-environment-probe');

function python(args: string[]): string {
  return execFileSync('python3', ['-B', ...args], {
    cwd: directory, encoding: 'utf8', maxBuffer: 64 * 1024,
  });
}

describe('public Cloud Hypervisor environment probe (local, no KVM)', () => {
  it('passes Python fixtures and executes the actual result-file contract locally', () => {
    expect(python(['-m', 'unittest', '-q', 'test_probe'])).toBe('');
  });

  it('generates a finite public schema and validates real local observations', () => {
    const request = JSON.parse(python(['build-request.py']));
    expect(request.name).toBe('enclave_run_script');
    expect(request.arguments.privateRepo).toBe('github/gh-aw-firewall');
    expect(Object.keys(request.arguments).sort()).toEqual(['privateRepo', 'schema', 'script']);
    expect(request.arguments.script).toBe(fs.readFileSync(path.join(directory, 'probe.py'), 'utf8'));
    expect(Buffer.byteLength(request.arguments.script)).toBeLessThanOrEqual(16384);
    expect(Buffer.byteLength(JSON.stringify(request.arguments.schema))).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(request.arguments.schema)).not.toContain('"type":"string"');
    const validation = validateSchema(request.arguments.schema);
    expect(validation.valid).toBe(true);
    if (!validation.valid) throw new Error(validation.errors.join(', '));
    const encoded = python(['-c', 'import probe; print(probe.encode(probe.collect()))']).trim();
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(8192);
    expect(validateValueAgainstSchema(validation.schema, JSON.parse(encoded))).toBe(true);
    // Same shape for every expected unavailable observation, not missing fields.
    const unavailable = python(['-c', [
      'import probe',
      'from unittest.mock import patch',
      'import errno',
      'with patch("builtins.open", side_effect=PermissionError(errno.EACCES, "secret")):',
      ' print(probe.encode(probe.collect()))',
    ].join('\n')]).trim();
    expect(validateValueAgainstSchema(validation.schema, JSON.parse(unavailable))).toBe(true);
    expect(unavailable).not.toContain('secret');
  });

  it('ships a schema-valid config without changing AWF-owned isolation controls', () => {
    const config = yaml.load(fs.readFileSync(path.join(directory, 'awf.yaml'), 'utf8'));
    expect(validateWithSchema(config)).toEqual([]);
  });
});
