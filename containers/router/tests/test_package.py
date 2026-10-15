from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tomllib
import zipfile
from importlib.metadata import metadata
from pathlib import Path
from urllib.parse import urlsplit

import pytest
import yaml
from contract_corpus import (
    export_archive,
    load_cases,
    request_bytes,
    source_identity,
    validate_case,
)
from fastapi.testclient import TestClient
from packaging.specifiers import SpecifierSet

import gh_aw_router
from gh_aw_router import cli
from gh_aw_router.http import create_app
from gh_aw_router.routing_table import DEFAULT_TABLE_DIRECTORY
from gh_aw_router.service import GhAwRouterService

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_package_metadata_matches_the_runtime() -> None:
    project = tomllib.loads((PROJECT_ROOT / "pyproject.toml").read_text(encoding="utf-8"))[
        "project"
    ]
    installed = metadata("gh-aw-router")
    dockerfile = (PROJECT_ROOT / "Dockerfile").read_text(encoding="utf-8")

    assert project["version"] == gh_aw_router.__version__
    assert f"ARG VERSION={project['version']}\n" in dockerfile
    assert installed["License-Expression"] == project["license"]
    assert installed["Requires-Python"].replace(" ", "") == project["requires-python"]
    image_python = _dockerfile_value(dockerfile, r"\nFROM python:(\d+\.\d+\.\d+)-")
    assert image_python in SpecifierSet(project["requires-python"])
    repository = "https://github.com/githubnext/gh-aw-router"
    assert project["urls"] == {
        "Homepage": repository,
        "Issues": f"{repository}/issues",
        "Repository": repository,
    }
    assert f'org.opencontainers.image.source="{repository}"' in dockerfile


@pytest.mark.parametrize("version", [gh_aw_router.__version__, "99.0.0"])
def test_image_version_must_match_runtime(version: str) -> None:
    dockerfile = (PROJECT_ROOT / "Dockerfile").read_text(encoding="utf-8")
    command = next(
        line.removeprefix("RUN ") for line in dockerfile.splitlines() if '"$VERSION"' in line
    )
    arguments = shlex.split(command)
    assert arguments[0] == "python"
    assert arguments[-1] == "$VERSION"
    result = subprocess.run(  # noqa: S603
        [sys.executable, *arguments[1:-1], version],
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
    )
    assert (result.returncode == 0) is (version == gh_aw_router.__version__)
    if result.returncode:
        assert "VERSION must match the package version" in result.stderr


def test_dependency_lock_uses_public_pypi() -> None:
    project = tomllib.loads((PROJECT_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    lock = tomllib.loads((PROJECT_ROOT / "uv.lock").read_text(encoding="utf-8"))

    assert "index" not in project["tool"]["uv"]
    for package in lock["package"]:
        if package["name"] == project["project"]["name"]:
            assert package["source"] == {"editable": "."}
            continue
        assert package["source"] == {"registry": "https://pypi.org/simple"}
        artifacts = [*package.get("wheels", [])]
        if "sdist" in package:
            artifacts.append(package["sdist"])
        for artifact in artifacts:
            url = urlsplit(artifact["url"])
            assert url.scheme == "https"
            assert url.netloc == "files.pythonhosted.org"
            assert not url.query


def test_dockerfile_matches_the_service_contract(
    service: GhAwRouterService, monkeypatch: pytest.MonkeyPatch
) -> None:
    dockerfile = (PROJECT_ROOT / "Dockerfile").read_text(encoding="utf-8")
    tables = _dockerfile_value(dockerfile, r"GH_AW_ROUTER_ROUTING_TABLES=(\S+)")
    port = _dockerfile_value(dockerfile, r"\nEXPOSE (\d+)\n")
    health = urlsplit(_dockerfile_value(dockerfile, r"urlopen\('([^']+)'"))

    assert f"COPY {DEFAULT_TABLE_DIRECTORY.as_posix()} {tables}\n" in dockerfile
    assert f'"--bind", "0.0.0.0:{port}"' in dockerfile
    assert "\nUSER 10001:10001\n" in dockerfile
    assert health.port == int(port)
    assert health.path in {getattr(route, "path", "") for route in create_app(service).routes}

    monkeypatch.setenv("GH_AW_ROUTER_ROUTING_TABLES", tables)
    assert cli.build_parser().parse_args(["validate-data"]).routing_tables == Path(tables)


def _dockerfile_value(dockerfile: str, pattern: str) -> str:
    match = re.search(pattern, dockerfile)
    assert match, pattern
    return match.group(1)


def test_release_ci_pins_actions_and_covers_dependency_ecosystems() -> None:
    workflow = yaml.safe_load((PROJECT_ROOT / ".github/workflows/ci.yml").read_bytes())
    assert workflow["permissions"] == {"contents": "read"}
    assert workflow["on"]["schedule"]
    assert {"checks", "container", "advisories"} <= workflow["jobs"].keys()
    assert "image-security" not in workflow["jobs"]
    for job in workflow["jobs"].values():
        for step in job["steps"]:
            if "uses" in step:
                assert re.fullmatch(r"[^@]+@[0-9a-f]{40}", step["uses"])
    dependabot = yaml.safe_load((PROJECT_ROOT / ".github/dependabot.yml").read_bytes())
    assert {item["package-ecosystem"] for item in dependabot["updates"]} == {
        "github-actions",
        "uv",
        "docker",
    }
    docker_updates = next(
        item for item in dependabot["updates"] if item["package-ecosystem"] == "docker"
    )
    assert docker_updates.get("ignore") == [
        {
            "dependency-name": "python",
            "update-types": ["version-update:semver-major", "version-update:semver-minor"],
        }
    ]


def test_package_declares_inline_type_information() -> None:
    package_directory = Path(gh_aw_router.__file__).parent

    assert (package_directory / "py.typed").is_file()


def test_documentation_links_stay_inside_the_project() -> None:
    documents = PROJECT_ROOT.glob("*.md")
    for document in documents:
        for target in re.findall(r"\]\(([^)]+)\)", document.read_text(encoding="utf-8")):
            if ":" in target or target.startswith("#"):
                continue
            path = (document.parent / target.split("#", 1)[0]).resolve()
            assert path.is_relative_to(PROJECT_ROOT), (document, target)
            assert path.exists(), (document, target)


@pytest.mark.parametrize("newline", [b"\n", b"\r\n"], ids=["lf", "crlf"])
def test_contract_archive_is_reproducible_and_replays_reviewed_cases(
    tmp_path: Path, newline: bytes
) -> None:
    attachment = b"# Synthetic integration contract\n\nContract revision: `test/v1`.\n".replace(
        b"\n", newline
    )
    contract = tmp_path / "contract.md"
    contract.write_bytes(attachment)
    checksum = hashlib.sha256(attachment).hexdigest()
    exported = export_archive(contract, checksum, development=True)
    assert exported == export_archive(contract, checksum, development=True)
    assert exported[4:8] == bytes(4)
    with tarfile.open(fileobj=io.BytesIO(exported), mode="r:gz") as archive:
        assert archive.getnames() == sorted(archive.getnames())
        files = {}
        for entry in archive.getmembers():
            assert entry.isfile()
            assert (entry.uid, entry.gid, entry.uname, entry.gname, entry.mtime) == (
                0,
                0,
                "",
                "",
                0,
            )
            assert entry.mode == 0o644
            stream = archive.extractfile(entry)
            assert stream is not None
            files[entry.name] = stream.read()
    manifest = json.loads(files.pop("manifest.json"))
    assert manifest["archive_format"] == 1
    assert manifest["router_version"] == gh_aw_router.__version__
    assert manifest["routing_table_schema"] == 5
    assert manifest["source"]["development"] is True
    assert manifest["integration_contract_revision"] == "test/v1"
    assert manifest["files"] == {
        name: hashlib.sha256(data).hexdigest() for name, data in files.items()
    }
    assert files["integration-contract.md"] == attachment
    assert files["openapi.yaml"] == (PROJECT_ROOT / "openapi.yaml").read_text(
        encoding="utf-8"
    ).encode("utf-8")
    assert len([name for name in files if name.startswith("tables/")]) == 6
    openapi = yaml.safe_load(files["openapi.yaml"])
    cases = json.loads(files["cases.json"])
    originals = {case["id"]: case for case in load_cases()}
    assert len(cases) == len(originals)
    for case in cases:
        assert request_bytes(case) == request_bytes(originals[case["id"]])
        assert "response_file" not in case
        tables = tmp_path / case["id"]
        tables.mkdir()
        for name in case.get(
            "profiles",
            [name.removeprefix("tables/") for name in files if name.startswith("tables/")],
        ):
            (tables / name).write_bytes(files[f"tables/{name}"])
        with TestClient(create_app(GhAwRouterService.load(tables))) as client:
            response = client.request(
                case["method"],
                case["path"],
                content=request_bytes(case),
                headers=case.get("headers", {"content-type": "application/json"}),
            )
        validate_case(case, response.status_code, response.content, openapi)


def test_contract_archive_rejects_wrong_attachment_identity(tmp_path: Path) -> None:
    contract = tmp_path / "contract.md"
    contract.write_bytes(b"unidentified attachment")
    with pytest.raises(ValueError, match="checksum"):
        export_archive(contract, "0" * 64, development=True)
    with pytest.raises(ValueError, match="revision"):
        export_archive(
            contract, hashlib.sha256(contract.read_bytes()).hexdigest(), development=True
        )


def test_contract_archive_requires_explicit_development_provenance(tmp_path: Path) -> None:
    assert source_identity(tmp_path, development=True) == {
        "sha": None,
        "dirty": None,
        "development": True,
    }
    with pytest.raises(ValueError, match="clean, identified"):
        source_identity(tmp_path, development=False)


@pytest.mark.skipif(shutil.which("git") is None, reason="Git required for source provenance test")
def test_contract_archive_distinguishes_clean_and_dirty_source(tmp_path: Path) -> None:
    _run(["git", "init", "--quiet", str(tmp_path)], tmp_path)
    _run(
        [
            "git",
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "--message",
            "Synthetic source",
        ],
        tmp_path,
    )
    expected = _run(["git", "rev-parse", "HEAD"], tmp_path).stdout.strip()
    assert source_identity(tmp_path, development=False) == {
        "sha": expected,
        "dirty": False,
        "development": False,
    }
    (tmp_path / "untracked.txt").write_text("changed", encoding="utf-8")
    with pytest.raises(ValueError, match="clean, identified"):
        source_identity(tmp_path, development=False)
    assert source_identity(tmp_path, development=True) == {
        "sha": expected,
        "dirty": True,
        "development": True,
    }


@pytest.mark.release
def test_runtime_lock_export_is_current(tmp_path: Path) -> None:
    result = _run(
        [
            "uv",
            "export",
            "--project",
            str(PROJECT_ROOT),
            "--locked",
            "--no-dev",
            "--no-emit-project",
            "--no-header",
        ],
        tmp_path,
    )
    committed = (PROJECT_ROOT / "requirements.lock").read_text(encoding="utf-8")
    expected = "\n".join(line for line in committed.splitlines() if not line.startswith("#"))
    assert result.stdout.strip() == expected.strip()


@pytest.fixture(scope="module")
def release_artifacts(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Path]:
    if shutil.which("uv") is None:
        pytest.fail("--run-release requires uv on PATH")
    tmp_path = tmp_path_factory.mktemp("release-artifacts")
    distribution = tmp_path / "dist"
    _run(["uv", "build", str(PROJECT_ROOT), "--out-dir", str(distribution)], tmp_path)
    wheel = next(distribution.glob("*.whl"))
    archive = next(distribution.glob("*.tar.gz"))
    with zipfile.ZipFile(wheel) as package:
        names = package.namelist()
        assert "gh_aw_router/py.typed" in names
        assert any(name.endswith("/licenses/LICENSE") for name in names)
        assert not any(name.startswith(("routing/", "tests/")) for name in names)
    with tarfile.open(archive) as source:
        names = source.getnames()
        forbidden = {".venv", ".git", "__pycache__", ".pytest_cache", ".ruff_cache", "dist"}
        assert not any(forbidden.intersection(Path(name).parts) for name in names)
        source.extractall(tmp_path / "source", filter="data")
    extracted = next((tmp_path / "source").iterdir())
    for filename in (
        ".gitignore",
        ".gitattributes",
        ".github/workflows/ci.yml",
        "CONTRIBUTING.md",
        "SECURITY.md",
        "CODE_OF_CONDUCT.md",
        "README.md",
        "tests/contract_corpus.py",
        "tests/fixtures/routing-contract/classify-response.json",
        "tests/fixtures/routing-contract/route.json",
        "routing/cost-balanced.json",
        "routing/cost-speed-robust.json",
    ):
        assert (extracted / filename).is_file(), filename
    assert not (extracted / "docs").exists()
    return extracted, wheel


@pytest.mark.release
def test_isolated_source(release_artifacts: tuple[Path, Path], tmp_path: Path) -> None:
    extracted, _ = release_artifacts
    _run(
        ["uv", "run", "--directory", str(extracted), "--locked", "python", "-m", "pytest", "-q"],
        tmp_path,
    )


@pytest.mark.release
def test_isolated_wheel(release_artifacts: tuple[Path, Path], tmp_path: Path) -> None:
    extracted, wheel = release_artifacts
    environment = tmp_path / "wheel-env"
    _run(["uv", "venv", "--python", sys.executable, str(environment)], tmp_path)
    interpreter = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    _run(
        [
            "uv",
            "pip",
            "install",
            "--python",
            str(interpreter),
            "--require-hashes",
            "--requirement",
            str(extracted / "requirements.lock"),
        ],
        tmp_path,
    )
    _run(["uv", "pip", "install", "--python", str(interpreter), "--no-deps", str(wheel)], tmp_path)
    _run(["uv", "pip", "check", "--python", str(interpreter)], tmp_path)
    tables = str(extracted / "routing")
    command = [str(interpreter), "-I", "-m", "gh_aw_router", "--routing-tables", tables]
    summary = json.loads(_run([*command, "validate-data"], tmp_path).stdout)
    assert summary["label_cells"] == 210
    assert len(summary["profiles"]) == 6
    for operation in ("classify", "route"):
        example = str(extracted / "examples" / f"{operation}-request.json")
        result = _run([*command, operation, "--input", example], tmp_path)
        assert json.loads(result.stdout)["ranked_choices"]


def _run(arguments: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    for name in (
        "PYTHONPATH",
        "VIRTUAL_ENV",
        "UV_PROJECT_ENVIRONMENT",
        "GH_AW_ROUTER_ROUTING_TABLES",
    ):
        environment.pop(name, None)
    result = subprocess.run(  # noqa: S603
        arguments,
        cwd=cwd,
        env=environment,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=300,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return result
