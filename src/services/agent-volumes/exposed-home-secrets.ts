import * as fs from 'fs';
import * as path from 'path';
import { CREDENTIAL_ENTRIES, HOME_FORBIDDEN_SUBDIRS, credentialFilesToHide } from '../../config/mount-policy';
import { homePreparationError } from '../../agent-home';
import { LocalSourceResolver, parseMount } from './mount-topology';

function relativeWithin(root: string, candidate: string): string | undefined {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    ? relative : undefined;
}

function realPathIfPresent(candidate: string): string | undefined {
  try {
    return fs.realpathSync(candidate);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw homePreparationError(candidate, error);
  }
}

/**
 * Translate home-sensitive paths through every host bind, including aliases.
 * Only inspect a sensitive path once a bind actually exposes it; the runner's
 * original home may be an unavailable root-squashed NFS mount when --home is used.
 */
export function buildExposedHomeSecretOverlays(
  homes: string[],
  volumes: string[],
  resolveSource: LocalSourceResolver,
  sessionStatePath: string,
  protectedRunnerHome?: string,
): string[] {
  const binds = volumes.flatMap((spec) => {
    const mount = parseMount(spec);
    if (!mount || !path.isAbsolute(mount.source) || mount.source === '/dev/null') return [];
    const source = resolveSource(mount.source);
    if (!source) return [];
    const lexical = path.resolve(source);
    // Resolving the bind source detects an explicitly mounted symlink into home.
    const canonical = realPathIfPresent(lexical);
    let reference: string | undefined;
    try {
      if (fs.lstatSync(lexical).isSymbolicLink()) {
        reference = path.resolve(path.dirname(lexical), fs.readlinkSync(lexical));
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw homePreparationError(lexical, error);
      }
    }
    return [{ ...mount, lexical, canonical, reference }];
  });
  const overlays = new Set<string>();
  for (const home of new Set(homes.map((value) => path.resolve(value)))) {
    const homeRoots = new Set([home]);
    for (const bind of binds) {
      if (!bind.canonical) continue;
      const suffix = relativeWithin(home, bind.lexical) ??
        (bind.reference === undefined ? undefined : relativeWithin(home, bind.reference));
      if (suffix === undefined) continue;
      let candidate = bind.canonical;
      for (const part of suffix.split(path.sep).filter(Boolean)) candidate = path.dirname(candidate);
      if (path.resolve(candidate, suffix) === bind.canonical) homeRoots.add(candidate);
    }

    if (protectedRunnerHome && home === path.resolve(protectedRunnerHome)) {
      const unmaskable = [
        ...HOME_FORBIDDEN_SUBDIRS,
        ...CREDENTIAL_ENTRIES.filter((entry) => entry.type === 'dir' && !entry.files?.length)
          .map((entry) => entry.path),
      ];
      for (const homeRoot of homeRoots) {
        for (const relative of unmaskable) {
          const secret = path.join(homeRoot, relative);
          const exposingBind = binds.find((bind) => [bind.lexical, bind.canonical, bind.reference].some((source) =>
            source !== undefined && (relativeWithin(source, secret) !== undefined ||
              relativeWithin(secret, source) !== undefined)));
          if (exposingBind) {
            throw new Error(
              `Cannot safely expose runner-home credential path ${secret} through ${exposingBind.source}; ` +
              'choose a narrower workspace, working directory, or custom mount',
            );
          }
        }
      }
    }
    for (const homeRoot of homeRoots) {
      const history = path.join(homeRoot, '.copilot/session-state');
      const nestedHistory = binds.find((bind) => [bind.lexical, bind.canonical, bind.reference].some((source) =>
        source !== undefined && source !== history && relativeWithin(history, source) !== undefined));
      if (nestedHistory) {
        throw new Error(`Cannot safely expose a subdirectory of Copilot session history: ${nestedHistory.source}`);
      }
    }
    const sensitive = [
      ...credentialFilesToHide().map((relative) => ({ file: path.join(home, relative), directory: false })),
      { file: path.join(home, '.copilot/session-state'), directory: true },
    ];
    for (const { file, directory } of sensitive) {
      // First identify lexical or canonical bind coverage without inspecting the
      // sensitive path. Only then resolve it to catch symlinked credentials.
      const candidates = [...homeRoots].map((root) => path.join(root, path.relative(home, file)));
      const exposed = binds.some((bind) => candidates.some((candidate) =>
        relativeWithin(bind.lexical, candidate) !== undefined ||
        (bind.reference !== undefined && relativeWithin(bind.reference, candidate) !== undefined) ||
        (bind.canonical !== undefined && relativeWithin(bind.canonical, candidate) !== undefined)));
      if (!exposed) continue;
      const exposedFile = candidates.find((candidate) => binds.some((bind) =>
        relativeWithin(bind.lexical, candidate) !== undefined ||
        (bind.reference !== undefined && relativeWithin(bind.reference, candidate) !== undefined) ||
        (bind.canonical !== undefined && relativeWithin(bind.canonical, candidate) !== undefined)));
      const canonicalFile = realPathIfPresent(exposedFile!);
      if (directory && !canonicalFile) continue;
      for (const bind of binds) {
        let relative: string | undefined;
        for (const candidate of candidates) {
          relative = relativeWithin(bind.lexical, candidate);
          if (relative === undefined && bind.reference) relative = relativeWithin(bind.reference, candidate);
          if (relative === undefined && bind.canonical) relative = relativeWithin(bind.canonical, candidate);
          if (relative !== undefined) break;
        }
        if (relative === undefined && bind.canonical && canonicalFile) {
          relative = relativeWithin(bind.canonical, canonicalFile);
        }
        if (relative === undefined) continue;
        const target = path.join(bind.target, relative);
        overlays.add(`${directory ? sessionStatePath : '/dev/null'}:${target}:${directory ? 'rw' : 'ro'}`);
      }
    }
  }
  return [...overlays];
}
