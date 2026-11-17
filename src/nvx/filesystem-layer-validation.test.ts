import * as path from 'path';
import {
  assertContained,
  assertNonRootIdentity,
  assertSourceDateEpoch,
  assertUuid,
  normalizeExcludedPaths,
  normalizeScratchBytes,
  NVX_MIN_SCRATCH_BYTES,
} from './filesystem-layer-validation';
import * as builder from './filesystem-builder';
import * as validation from './filesystem-layer-validation';

describe('NVX filesystem layer validation', () => {
  it('preserves the original builder exports', () => {
    expect(builder.normalizeScratchBytes).toBe(normalizeScratchBytes);
    expect(builder.normalizeNvxLayerSymlinkTarget).toBe(validation.normalizeNvxLayerSymlinkTarget);
    expect(builder.NVX_MIN_SCRATCH_BYTES).toBe(NVX_MIN_SCRATCH_BYTES);
    expect(builder.NVX_DEFAULT_MAX_SCRATCH_BYTES).toBe(validation.NVX_DEFAULT_MAX_SCRATCH_BYTES);
    expect(builder.NVX_LAYER_ROLES).toBe(validation.NVX_LAYER_ROLES);
  });

  it('normalizes, sorts, and deduplicates exclusions', () => {
    expect(normalizeExcludedPaths(['z/', './a', 'a', 'dir/../b']))
      .toEqual(['a', 'b', 'z']);
  });

  it.each(['', '/absolute', '../outside', 'dir/../../outside', 'bad\0path'])(
    'rejects unsafe exclusion %j',
    (value) => expect(() => normalizeExcludedPaths([value])).toThrow(/NVX excluded path/),
  );

  it('accepts contained paths but rejects parents and sibling-prefix paths', () => {
    const root = path.resolve('/tmp', 'nvx-layer');
    expect(() => assertContained(root, root, 'test')).not.toThrow();
    expect(() => assertContained(root, path.join(root, 'child'), 'test')).not.toThrow();
    expect(() => assertContained(root, path.dirname(root), 'test')).toThrow(/escapes/);
    expect(() => assertContained(root, `${root}-sibling`, 'test')).toThrow(/escapes/);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid source epoch %s',
    (value) => expect(() => assertSourceDateEpoch(value)).toThrow(/SOURCE_DATE_EPOCH/),
  );

  it('validates scratch identity and UUID boundaries', () => {
    expect(() => assertSourceDateEpoch(0)).not.toThrow();
    expect(() => assertNonRootIdentity(1, 0xffff_ffff)).not.toThrow();
    for (const value of [0, -1, 1.5, NaN, Infinity, 0x1_0000_0000]) {
      expect(() => assertNonRootIdentity(value, 1)).toThrow(/non-root UID:GID/);
      expect(() => assertNonRootIdentity(1, value)).toThrow(/non-root UID:GID/);
    }
    expect(() => assertUuid('11111111-2222-4333-8444-555555555555', 'test')).not.toThrow();
    expect(() => assertUuid('not-a-uuid', 'test')).toThrow(/canonical lowercase UUID/);
  });
});
