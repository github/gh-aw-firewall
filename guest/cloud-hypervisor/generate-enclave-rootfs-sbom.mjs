#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument list near ${key ?? '<end>'}`);
    }
    values[key.slice(2)] = value;
  }
  for (const required of [
    'role',
    'rootfs-tree',
    'rootfs',
    'output',
    'release-tag',
    'source-image',
    'source-image-digest',
    'source-date-epoch',
  ]) {
    if (!values[required]) throw new Error(`missing --${required}`);
  }
  if (!['script', 'agent'].includes(values.role)) throw new Error('invalid role');
  if (!/^[a-f0-9]{64}$/.test(values['source-image-digest'])) {
    throw new Error('source image digest must be lowercase SHA-256');
  }
  return values;
}

async function readOptional(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function parseDpkgStatus(contents) {
  return contents.trim().split(/\n\s*\n/).flatMap((record) => {
    const fields = Object.fromEntries(record.split('\n').flatMap((line) => {
      const separator = line.indexOf(':');
      return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1).trim()]] : [];
    }));
    if (!fields.Package || !fields.Version || fields.Status !== 'install ok installed') return [];
    return [{
      name: fields.Package,
      version: fields.Version,
      architecture: fields.Architecture,
      license: 'NOASSERTION',
    }];
  });
}

function parseApkInstalled(contents) {
  return contents.trim().split(/\n\s*\n/).flatMap((record) => {
    const fields = Object.fromEntries(record.split('\n').flatMap((line) => {
      const separator = line.indexOf(':');
      return separator === 1 ? [[line[0], line.slice(2)]] : [];
    }));
    if (!fields.P || !fields.V) return [];
    return [{
      name: fields.P,
      version: fields.V,
      architecture: fields.A,
      license: fields.L || 'NOASSERTION',
    }];
  });
}

function spdxId(name, index) {
  const normalized = name.replace(/[^A-Za-z0-9.-]/g, '-');
  return `SPDXRef-Package-${normalized}-${index}`;
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

const args = parseArguments(process.argv.slice(2));
const tree = path.resolve(args['rootfs-tree']);
const dpkgStatus = await readOptional(path.join(tree, 'var/lib/dpkg/status'));
const apkInstalled = await readOptional(path.join(tree, 'lib/apk/db/installed'));
const packages = [
  ...(dpkgStatus ? parseDpkgStatus(dpkgStatus) : []),
  ...(apkInstalled ? parseApkInstalled(apkInstalled) : []),
].sort((left, right) => (
  left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
));
if (packages.length === 0) {
  throw new Error(`no installed package inventory found for ${args.role} rootfs`);
}

const rootfsDigest = await sha256(args.rootfs);
const packageEntries = packages.map((item, index) => ({
  name: item.name,
  SPDXID: spdxId(item.name, index),
  versionInfo: item.version,
  downloadLocation: 'NOASSERTION',
  filesAnalyzed: false,
  licenseConcluded: 'NOASSERTION',
  licenseDeclared: item.license,
  copyrightText: 'NOASSERTION',
  ...(item.architecture ? { primaryPackagePurpose: 'LIBRARY', comment: `Architecture: ${item.architecture}` } : {}),
}));
const created = new Date(Number(args['source-date-epoch']) * 1000).toISOString();
const document = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: `awf-cloud-hypervisor-enclave-${args.role}-rootfs-x86_64`,
  documentNamespace:
    `https://github.com/github/gh-aw-firewall/cloud-hypervisor/enclave-${args.role}/`
    + `${args['release-tag']}/${rootfsDigest}`,
  creationInfo: {
    created,
    creators: ['Tool: guest/cloud-hypervisor/generate-enclave-rootfs-sbom.mjs'],
  },
  packages: [
    {
      name: `awf-cloud-hypervisor-enclave-${args.role}-rootfs`,
      SPDXID: 'SPDXRef-Rootfs',
      versionInfo: args['release-tag'],
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      checksums: [{ algorithm: 'SHA256', checksumValue: rootfsDigest }],
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'NOASSERTION',
      copyrightText: 'NOASSERTION',
    },
    {
      name: `awf-enclave-${args.role}-container-stage`,
      SPDXID: 'SPDXRef-SourceImage',
      versionInfo: args['source-image-digest'],
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      externalRefs: [{
        referenceCategory: 'OTHER',
        referenceType: 'container-image',
        referenceLocator: args['source-image'],
      }],
    },
    ...packageEntries,
  ],
  relationships: [
    {
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: 'SPDXRef-Rootfs',
    },
    {
      spdxElementId: 'SPDXRef-Rootfs',
      relationshipType: 'GENERATED_FROM',
      relatedSpdxElement: 'SPDXRef-SourceImage',
    },
    ...packageEntries.map((item) => ({
      spdxElementId: 'SPDXRef-Rootfs',
      relationshipType: 'CONTAINS',
      relatedSpdxElement: item.SPDXID,
    })),
  ],
};

await writeFile(args.output, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
