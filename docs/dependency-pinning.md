# Reproducible build tools

## Container base images

The base images used by AWF containers are pinned to multi-platform OCI index digests while retaining their readable version tags. Dependabot checks each container directory weekly for Docker updates, including digest changes. The agent images' `BASE_IMAGE` build argument remains overridable; its default is pinned.

## npm CLI installs

The release binary builder and Copilot CLI installations use exact npm dependencies in lockfiles and install with `npm ci`. Update these package versions through their manifests and lockfiles.

The four workflows below are a narrow exception for transitive npm reproducibility. gh-aw emits the engine CLI installs from workflow configuration, but does not currently provide an npm lockfile input for those installs. Each workflow pins its engine version in source, and the generated lock records the exact top-level version; npm still resolves that package's transitive dependencies at run time.

- `smoke-gemini.md`
- `smoke-codex.md` (including its version-pinned Playwright CLI)
- `smoke-cloud-hypervisor-codex.md`
- `secret-digger-codex.md`

Update engine or tool versions in the source workflow and regenerate its `.lock.yml` with the repository's gh-aw compiler and postprocessor. Do not edit generated lock files directly.
