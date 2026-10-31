import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid AWF release version');
const source = readFileSync(new URL('scripts/enclave-storage-helper.py', root), 'utf8');
mkdirSync(new URL('release/', root), { recursive: true });
writeFileSync(new URL('release/enclave-storage-helper.py', root),
  source.replace(/^VERSION = "[^"]+"$/m, `VERSION = "${version}"`), { mode: 0o644 });
