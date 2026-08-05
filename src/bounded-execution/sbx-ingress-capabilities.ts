import * as fs from 'fs';

export interface SbxIngressCapabilities {
  version: 1;
  query: string;
  probe: string;
}

interface SbxIngressCapabilityFileOps {
  open(path: string, flags: number, mode: number): number;
  write(fd: number, content: string): void;
  chmod(fd: number, mode: number): void;
  close(fd: number): void;
}

const defaultFileOps: SbxIngressCapabilityFileOps = {
  open: fs.openSync,
  write: fs.writeSync,
  chmod: fs.fchmodSync,
  close: fs.closeSync,
};

/**
 * Atomically creates an sbx ingress capability file without following symlinks.
 *
 * The explicit chmod hardens the final inode mode independently of the process
 * umask, and closing in finally ensures write/chmod failures do not leak the fd.
 */
export function writeSbxIngressCapabilitiesFile(
  capabilityPath: string,
  capabilities: SbxIngressCapabilities,
  fileOps: SbxIngressCapabilityFileOps = defaultFileOps,
): void {
  const fd = fileOps.open(
    capabilityPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fileOps.write(fd, JSON.stringify(capabilities));
    fileOps.chmod(fd, 0o600);
  } finally {
    fileOps.close(fd);
  }
}
