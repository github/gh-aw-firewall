'use strict';

const fs = require('fs');
const path = require('path');

function readDiagnosticFile(file, maxBytes = 16 * 1024 * 1024, requireStable = false) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY
      | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('Live enclave diagnostic is not a regular file');
    if (stat.size > maxBytes) {
      throw new Error('Live enclave diagnostic file exceeded the scan bound');
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const bytes = fs.readSync(descriptor, buffer, size, buffer.length - size, null);
      if (bytes === 0) break;
      size += bytes;
    }
    if (size > maxBytes) {
      throw new Error('Live enclave diagnostic file exceeded the scan bound');
    }
    if (requireStable) {
      const after = fs.fstatSync(descriptor);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
          || after.ctimeMs !== stat.ctimeMs || size !== stat.size) {
        throw new Error('Live enclave diagnostic file changed during inspection');
      }
    }
    return buffer.subarray(0, size);
  } catch (error) {
    if (error.code) throw new Error('Could not inspect live enclave diagnostic file');
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function scanTextDirectory(directory, sentinel, found) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error('Could not inspect live enclave diagnostic output');
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      scanTextDirectory(file, sentinel, found);
    } else if (entry.isFile() && /\.(?:json|jsonl|log|txt)$/i.test(entry.name)) {
      if (readDiagnosticFile(file).includes(Buffer.from(sentinel, 'utf8'))) found.value = true;
    }
  }
}

function assertNoSentinelLeak(directories, logContents, sentinel) {
  if (logContents.some((content) => content.includes(sentinel))) {
    throw new Error('Synthetic enclave output sentinel escaped into a captured log');
  }
  const found = { value: false };
  for (const directory of directories) scanTextDirectory(directory, sentinel, found);
  if (found.value) {
    throw new Error('Synthetic enclave output sentinel escaped into audit or diagnostic files');
  }
}

module.exports = {
  readDiagnosticFile,
  scanTextDirectory,
  assertNoSentinelLeak,
};
