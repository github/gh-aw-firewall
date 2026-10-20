export interface LegacySnapshotMetadata {
  /** Description of the committed source; do not claim an unverified upstream origin. */
  source: string;
  /** Pinned revision, e.g. the Git blob ID of the committed input. */
  revision: string;
  /** Independently verified retrieval time, not a guessed upstream fetch date. */
  retrievedAt: string;
  /** SHA-256 of the exact input bytes. */
  sha256: string;
  /** License or explicit usage/unknown-license note. */
  license: string;
}

export declare const IMPORTER_VERSION: string;
/** Git blob ID and SHA-256 of the committed legacy snapshot (not upstream metadata). */
export declare const BUNDLED_GIT_BLOB: string;
export declare const BUNDLED_SHA256: string;
/** Git commit time of the bundled copy; the upstream retrieval time is unknown. */
export declare const BUNDLED_COMMIT_TIMESTAMP: string;
/** Reproducible committed-source import. retrievedAt is explicitly repository capture time, not upstream retrieval. */
export declare function importPinnedLegacySnapshot(): ReturnType<typeof importLegacySnapshot>;
export declare function importLegacySnapshot(bytes: Buffer, metadata: LegacySnapshotMetadata): {
  schemaVersion: number;
  source: string;
  revision: string;
  retrievedAt: string;
  importerVersion: string;
  sha256: string;
  license: string;
  accepted: number;
  rejected: number;
  collisions: string[];
  models: unknown[];
};
