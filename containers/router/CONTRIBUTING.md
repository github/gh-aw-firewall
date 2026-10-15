# Contributing

Open an issue to discuss substantial changes before implementation. Keep pull requests focused
and include tests for changed behavior. Do not include credentials, private prompts, local
environments, or generated build output.

## Development

Use Python 3.12 and [uv](https://docs.astral.sh/uv/). Run commands from this project root.

```bash
uv sync --locked --dev
uv run ruff format --check .
uv run ruff check .
uv run ty check
uv run python -m pytest
```

Run heavyweight checks explicitly.

```bash
uv run python -m pytest --run-release -m release
uv run python -m pytest --run-docker -m docker
```

Release tests require uv and may download dependencies. They build source and wheel archives,
test an extracted source tree, and exercise a non-editable wheel installation. Docker tests
require a running Linux daemon. They build one image, exercise all six bundled profiles, and
check read-only replacement tables and the portable corpus on Linux amd64. Set
`GH_AW_ROUTER_TEST_IMAGE` to test an already-built image instead of building and removing one.
Neither group runs by default. The CI workflow is
configured to run both groups separately.

## Project layout

- `src/gh_aw_router/` contains request contracts, classification, table lookup, and CLI and HTTP adapters.
- `tests/` mirrors the runtime modules, with shared synthetic fixtures in `conftest.py`.
- `routing/` contains generated routing tables from training.
- `examples/` contains executable planning requests.
- `.github/` contains CI and dependency-update configuration.

## Code conventions

- Keep contracts in `contracts.py`, orchestration in `service.py`, and transport code in its adapter.
- Keep deterministic fallback rules in `heuristics.py` and classifier prompts in `classification.py`.
- Keep constants in the module that owns their meaning. Do not introduce a general constants module.
- Document public behavior, errors, defaults, and approximation limits rather than repeating types.
- Preserve exact offered model identities and explicit reasoning efforts.
- Add regressions to existing test modules where practical.
- Keep OpenAPI, examples, and integration documentation aligned with runtime behavior.

The committed `openapi.yaml` is the authoritative HTTP contract. It distinguishes requested
modes from published profiles and includes the classifier-output schema used by callers.
Update it alongside contract changes and extend the schema/runtime parity
tests in `tests/test_openapi.py`. Do not add a second generated public contract.

Use the shared synthetic table and request fixtures in `tests/conftest.py` for generic routing,
service, and transport tests. Reserve the bundled-table `service` fixture for release-data and
example integration checks so ranking refreshes do not affect unrelated behavior tests.

The HTTP contract follows the router release. There is no API-version request field or
negotiation layer. Review breaking changes with affected consumers, include migration notes,
and test the client, immutable image, OpenAPI document, and corpus as one release combination.
Keep the table format marker because files and mounts can change independently of the image.
Public contracts and table helpers are also used by the separate training package. Check those
callers when changing shared contracts.

The portable cases live in [tests/fixtures/routing-contract](tests/fixtures/routing-contract).
Keep complete requests and reviewed expected responses. Tests and the source-only exporter
must not derive expectations from the current service. Review classifier prompt changes as
contract fixture changes. Invalid non-null classifier output belongs in rejection cases;
caller-authorized degradation uses omitted or null classification.

Keep release publication and credentialed attestations in separately reviewed,
explicitly permissioned jobs. Do not execute untrusted PR code through `pull_request_target`.

## Dependencies and routing data

Use `uv add` or `uv lock` with public PyPI to change dependencies, then regenerate the
container dependency file. Clear local index overrides before generating committed locks.

```bash
uv export --locked --no-dev --no-emit-project --output-file requirements.lock
```

Commit both lock files. Do not put private package indexes or credentials in them. Never pass
credentials through Docker build arguments. Routing JSON files are generated offline. Do not
hand-edit rankings or add runtime dependencies on training tools.

Dependabot is configured for weekly updates to uv dependencies, Docker images, and GitHub Actions.
Python image updates stay on the supported minor release line, with patch and digest updates
enabled. Review package metadata, dependency locks, and CI coverage before changing that line.
After a dependency update, regenerate `requirements.lock` with the command above and include
it in the same pull request. The isolated release tests reject a stale export. Keep external
actions pinned to full commit SHAs when reviewing updates.

The CI workflow is configured to audit locked runtime dependencies with pip-audit, including
a weekly schedule to detect new advisories without a code change. Investigate failures before
merging.

Review [SECURITY.md](SECURITY.md) before reporting vulnerabilities and follow
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) in project discussions.