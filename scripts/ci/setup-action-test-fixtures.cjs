#!/usr/bin/env node
// Test-only transport/verifier fixtures for the real composite action. Never
// installed by action.yml or published as part of a release.
const { execFileSync } = require('node:child_process');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'awf-action-fixtures-'));
const version = 'v1.2.3';
const assets = path.join(directory, 'assets');
const bin = path.join(directory, 'bin');
fs.mkdirSync(assets);
fs.mkdirSync(bin);
const source = path.join(directory, 'fixture.c');
fs.writeFileSync(source, '#include <stdio.h>\nint main(void) { puts("awf fixture v1.2.3"); return 0; }\n');
execFileSync('cc', [source, '-o', path.join(assets, 'awf-linux-x64')], { stdio: 'inherit' });
const images = ['squid', 'agent', 'agent-act', 'api-proxy', 'router', 'cli-proxy',
  'enclave-script', 'enclave-agent', 'enclave-mcp-server'];
const hash = value => createHash('sha256').update(value).digest('hex');
fs.writeFileSync(path.join(assets, 'containers.txt'),
  images.map(image => `ghcr.io/github/gh-aw-firewall/${image}@sha256:${hash(image)}\n`).join(''));
fs.writeFileSync(path.join(assets, 'checksums.txt'), ['awf-linux-x64', 'containers.txt']
  .map(name => `${hash(fs.readFileSync(path.join(assets, name)))}  ${name}\n`).join(''));
fs.writeFileSync(path.join(assets, 'release-identity.txt'),
  `${hash(fs.readFileSync(path.join(assets, 'checksums.txt')))}  refs/tags/${version}\n`);
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
fs.writeFileSync(path.join(directory, 'public.pem'), publicKey.export({ format: 'pem', type: 'spki' }));
for (const name of fs.readdirSync(assets)) {
  fs.writeFileSync(path.join(directory, `${name}.sig`), sign(null, fs.readFileSync(path.join(assets, name)), privateKey));
}
const prefix = `#!/usr/bin/env node\nconst directory=${JSON.stringify(directory)};\n`;
const tools = {
  gh: `
const fs=require('node:fs'),path=require('node:path'),{verify}=require('node:crypto');
const args=process.argv.slice(2);
if (args.join(' ')==='attestation verify --help') {
  console.log('--signer-workflow --deny-self-hosted-runners'); process.exit(0);
}
if (args.join(' ')==='api repos/github/gh-aw-firewall/releases/latest --jq .tag_name') {
  console.log('${version}'); process.exit(0);
}
if (args[0]!=='attestation' || args[1]!=='verify') throw Error('Unexpected gh invocation');
const required={
  '--hostname':'github.com',
  '--repo':'github/gh-aw-firewall',
  '--signer-workflow':'github/gh-aw-firewall/.github/workflows/release.yml',
  '--cert-oidc-issuer':'https://token.actions.githubusercontent.com',
};
for (const [flag,value] of Object.entries(required)) {
  const index=args.indexOf(flag);
  if(index<0 || args[index+1]!==value) throw Error('Missing provenance constraint '+flag);
}
if(!args.includes('--deny-self-hosted-runners')) throw Error('Self-hosted signers must be denied');
const name=path.basename(args[2]).replace(/\\.download$/, '');
if(!['awf-linux-x64','checksums.txt','release-identity.txt','containers.txt'].includes(name))
  throw Error('Unexpected provenance subject');
if(!verify(null,fs.readFileSync(args[2]),fs.readFileSync(path.join(directory,'public.pem')),
  fs.readFileSync(path.join(directory,name+'.sig')))) throw Error('Fixture signature verification failed');
fs.appendFileSync(path.join(directory,'verified.log'),name+'\\n');
`,
  curl: `
const fs=require('node:fs'),path=require('node:path');
let output,url;
const args=process.argv.slice(2);
for(let i=0;i<args.length;i++) {
  if(args[i]==='-o') output=args[++i];
  else if(args[i]==='-H') i++;
  else if(args[i].startsWith('https://')) url=args[i];
}
if(url==='https://api.github.com/repos/github/gh-aw-firewall/releases/latest') {
  console.log(JSON.stringify({tag_name:'${version}'})); process.exit(0);
}
const prefix='https://github.com/github/gh-aw-firewall/releases/download/${version}/';
if(!url || !url.startsWith(prefix) || !output) throw Error('Unexpected fixture download');
const name=url.slice(prefix.length);
if(!['awf-linux-x64','checksums.txt','containers.txt','release-identity.txt'].includes(name))
  throw Error('Unexpected fixture asset');
fs.copyFileSync(path.join(directory,'assets',name),output);
`,
  docker: `
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
const manifest=fs.readFileSync(path.join(directory,'assets/containers.txt'),'utf8').trim().split('\\n');
if(args.length!==2 || args[0]!=='pull' || !manifest.slice(0,2).includes(args[1]))
  throw Error('Only authenticated squid/agent digest pulls are allowed');
fs.appendFileSync(path.join(directory,'pulled.log'),args[1]+'\\n');
`,
};
for (const [name, script] of Object.entries(tools)) {
  fs.writeFileSync(path.join(bin, name), prefix + script, { mode: 0o755 });
}
fs.appendFileSync(process.env.GITHUB_PATH, `${bin}\n`);
fs.appendFileSync(process.env.GITHUB_ENV,
  `AWF_ACTION_FIXTURE_DIR=${directory}\nAWF_ACTION_FIXTURE_VERSION=${version}\n`);
console.log(`Created signed, isolated action fixtures at ${directory}`);
