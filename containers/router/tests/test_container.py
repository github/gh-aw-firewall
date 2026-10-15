"""Opt-in acceptance tests for the built image and read-only table replacement."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import time
import tomllib
import uuid
import warnings
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from contract_corpus import contract_tables, load_cases, load_openapi, request_bytes, validate_case

from gh_aw_router import __version__

PROJECT_ROOT = Path(__file__).resolve().parents[1]
IMAGE_PLATFORM = "linux/amd64"
DOCKER_TIMEOUT_SECONDS = 120
BUILD_TIMEOUT_SECONDS = 600
HEALTH_TIMEOUT_SECONDS = 90
ALL_PROFILES = [
    {"goal": goal, "mode": mode}
    for goal in ("cost", "cost-speed")
    for mode in ("economy", "balanced", "robust")
]
pytestmark = pytest.mark.docker


@pytest.fixture(scope="module")
def image() -> Iterator[str]:
    if shutil.which("docker") is None:
        pytest.fail("--run-docker requires Docker on PATH and a running Linux daemon")
    _docker(["version"])
    supplied = os.environ.get("GH_AW_ROUTER_TEST_IMAGE")
    name = supplied or f"gh-aw-router-contract:{uuid.uuid4().hex}"
    openapi_sha256 = hashlib.sha256((PROJECT_ROOT / "openapi.yaml").read_bytes()).hexdigest()
    try:
        if not supplied:
            _docker(
                [
                    "build",
                    "--platform",
                    IMAGE_PLATFORM,
                    "--build-arg",
                    f"PIP_INDEX_URL={_package_index_url()}",
                    "--build-arg",
                    f"OPENAPI_SHA256={openapi_sha256}",
                    "--tag",
                    name,
                    ".",
                ],
                cwd=PROJECT_ROOT,
                timeout=BUILD_TIMEOUT_SECONDS,
            )
        details = json.loads(_docker(["image", "inspect", name]).stdout)[0]
        assert f"{details['Os']}/{details['Architecture']}" == IMAGE_PLATFORM
        assert details["Config"]["Labels"]["org.opencontainers.image.version"] == __version__
        assert (
            details["Config"]["Labels"]["io.github.gh-aw-router.openapi-sha256"] == openapi_sha256
        )
        yield name
    finally:
        if not supplied:
            _docker(["image", "rm", "--force", name], allow_failure=True)


def _package_index_url() -> str:
    """Use an explicit default project index or uv's public PyPI default."""
    project = tomllib.loads((PROJECT_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    indexes = project.get("tool", {}).get("uv", {}).get("index", [])
    return next(
        (index["url"] for index in indexes if index.get("default")),
        "https://pypi.org/simple",
    )


@pytest.mark.parametrize(
    ("configuration", "expected"),
    [
        ("", "https://pypi.org/simple"),
        ('[[tool.uv.index]]\nurl = "https://packages.example/simple"\n', "https://pypi.org/simple"),
        (
            '[[tool.uv.index]]\nurl = "https://packages.example/simple"\ndefault = true\n',
            "https://packages.example/simple",
        ),
    ],
)
def test_package_index_url_uses_default_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, configuration: str, expected: str
) -> None:
    (tmp_path / "pyproject.toml").write_text(configuration, encoding="utf-8")
    monkeypatch.setattr(f"{__name__}.PROJECT_ROOT", tmp_path)

    assert _package_index_url() == expected


@pytest.fixture
def network() -> Iterator[str]:
    name = f"gh-aw-router-{uuid.uuid4().hex}"
    try:
        _docker(["network", "create", "--internal", name])
        assert json.loads(_docker(["network", "inspect", name]).stdout)[0]["Internal"] is True
        yield name
    finally:
        _docker(["network", "rm", name], allow_failure=True)


@pytest.mark.parametrize(
    "configuration",
    ["bundled", "mounted", *sorted({tuple(case.get("profiles", ())) for case in load_cases()})],
    ids=lambda value: value if isinstance(value, str) else f"corpus-{','.join(value) or 'all'}",
)
def test_hardened_container(
    image: str,
    network: str,
    configuration: str | tuple[str, ...],
    tmp_path: Path,
) -> None:
    container = f"gh-aw-router-{uuid.uuid4().hex}"
    arguments = [
        "run",
        "--platform",
        IMAGE_PLATFORM,
        "--detach",
        "--name",
        container,
        "--network",
        network,
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=16m",  # noqa: S108
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--stop-timeout",
        "35",
    ]
    profiles = ALL_PROFILES
    cases = None
    if isinstance(configuration, tuple):
        tmp_path.chmod(0o755)
        tables = contract_tables()
        for name in configuration or tables:
            (tmp_path / name).write_bytes(tables[name])
        arguments.extend(
            [
                "--mount",
                f"type=bind,src={tmp_path},dst=/routing,readonly",
            ]
        )
        cases = [case for case in load_cases() if tuple(case.get("profiles", ())) == configuration]
    elif configuration == "mounted":
        profiles = [{"goal": "cost", "mode": "economy"}]
        table = PROJECT_ROOT / "routing" / "cost-economy.json"
        arguments.extend(
            [
                "--mount",
                f"type=bind,src={table},dst=/mnt/replacement.json,readonly",
                "--env",
                "GH_AW_ROUTER_ROUTING_TABLES=/mnt/replacement.json",
            ]
        )
    try:
        _docker([*arguments, image])
        _wait_until_healthy(container)
        _assert_hardening(container)
        if cases is None:
            _probe_http(image, container, network, profiles)
        else:
            _probe_corpus(image, container, network, cases)
        _docker(["stop", "--time", "35", container])
        state = json.loads(_docker(["inspect", container]).stdout)[0]["State"]
        assert state["ExitCode"] == 0
    finally:
        _docker(["rm", "--force", container], allow_failure=True)


def _wait_until_healthy(container: str) -> None:
    deadline = time.monotonic() + HEALTH_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        result = _docker(
            ["inspect", "--format", "{{.State.Status}} {{.State.Health.Status}}", container],
            timeout=10,
        )
        if result.stdout.strip() == "running healthy":
            return
        if result.stdout.startswith("exited "):
            break
        time.sleep(0.5)
    logs = _docker(["logs", container], allow_failure=True)
    health = _docker(
        ["inspect", "--format", "{{json .State.Health}}", container], allow_failure=True
    )
    pytest.fail(f"container did not become healthy\n{health.stdout}\n{logs.stdout}\n{logs.stderr}")


def _assert_hardening(container: str) -> None:
    details = json.loads(_docker(["inspect", container]).stdout)[0]
    assert details["Config"]["User"] == "10001:10001"
    assert details["Config"]["ExposedPorts"] == {"8737/tcp": {}}
    assert details["HostConfig"]["ReadonlyRootfs"] is True
    assert "ALL" in details["HostConfig"]["CapDrop"]
    assert "no-new-privileges" in details["HostConfig"]["SecurityOpt"]
    assert details["HostConfig"]["Tmpfs"] == {"/tmp": "rw,noexec,nosuid,size=16m"}  # noqa: S108
    assert len(details["NetworkSettings"]["Networks"]) == 1
    assert all(not mount["RW"] for mount in details["Mounts"])
    assert not details["HostConfig"]["PortBindings"]
    assert not any(details["NetworkSettings"]["Ports"].values())


@pytest.mark.parametrize(
    ("ports", "port_bindings", "valid"),
    [
        ({}, None, True),
        ({"8737/tcp": None}, {}, True),
        ({"8737/tcp": []}, {}, True),
        ({"8737/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8737"}]}, {}, False),
        ({"8737/tcp": None}, {"8737/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8737"}]}, False),
        (
            {"8737/tcp": None, "9000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "9000"}]},
            {},
            False,
        ),
    ],
    ids=["empty", "null", "empty-list", "published", "configured-binding", "other-port"],
)
def test_hardening_rejects_published_ports(
    monkeypatch: pytest.MonkeyPatch,
    ports: dict[str, list[dict[str, str]] | None],
    port_bindings: dict[str, list[dict[str, str]]] | None,
    valid: bool,
) -> None:
    details = {
        "Config": {"User": "10001:10001", "ExposedPorts": {"8737/tcp": {}}},
        "HostConfig": {
            "ReadonlyRootfs": True,
            "CapDrop": ["ALL"],
            "SecurityOpt": ["no-new-privileges"],
            "Tmpfs": {"/tmp": "rw,noexec,nosuid,size=16m"},  # noqa: S108
            "PortBindings": port_bindings,
        },
        "NetworkSettings": {"Ports": ports, "Networks": {"internal-test": {}}},
        "Mounts": [],
    }

    def inspect(arguments: list[str]) -> subprocess.CompletedProcess[str]:
        assert arguments == ["inspect", "test-container"]
        return subprocess.CompletedProcess(arguments, 0, json.dumps([details]), "")

    monkeypatch.setattr(f"{__name__}._docker", inspect)

    if valid:
        _assert_hardening("test-container")
    else:
        with pytest.raises(AssertionError):
            _assert_hardening("test-container")


def _probe_http(
    image: str,
    container: str,
    network: str,
    profiles: list[dict[str, str]],
) -> None:
    script = f"""
import json
import urllib.error
import urllib.request

base = 'http://{container}:8737'

def get(path):
    with urllib.request.urlopen(base + path, timeout=5) as response:
        return response.status, response.read()

def post(path, body):
    request = urllib.request.Request(
        base + path, data=json.dumps(body).encode(),
        headers={{'content-type': 'application/json'}}, method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)

status, _ = get('/healthz')
assert status == 204
status, data = get('/capabilities')
assert status == 200
capabilities = json.loads(data)
assert capabilities['version'] == {__version__!r}
assert capabilities['routing_profiles'] == {profiles!r}
model = capabilities['execution_catalogue']['models'][0]
choice = {{'id': 'offered', 'model': model['model']}}
if model['efforts']:
    choice['effort'] = model['efforts'][0]
request = {{
    'conversation': [{{'role': 'user', 'parts': [{{'text': 'Fix this function'}}]}}],
    'models': [choice],
}}
status, classified = post('/classify', request)
assert status == 200 and classified['ranked_choices'] == [choice]
for profile in {profiles!r}:
    status, routed = post('/route', dict(request, objective=profile))
    assert status == 200 and routed['ranked_choices'] == [choice], (profile, routed)
request['objective'] = {profiles[0]!r}
status, no_route = post('/route', dict(request, models=[]))
assert status == 422 and no_route['code'] == 'no_route'
del request['conversation']
status, invalid = post('/route', request)
assert status == 422 and invalid['code'] == 'invalid_json'
"""
    _run_probe(image, network, script)


def _probe_corpus(image: str, container: str, network: str, cases: list[dict[str, Any]]) -> None:
    requests = [
        {
            "id": case["id"],
            "method": case["method"],
            "path": case["path"],
            "body": request_bytes(case).decode("utf-8"),
            "headers": case.get("headers", {"content-type": "application/json"}),
        }
        for case in cases
    ]
    script = f"""
import json
import urllib.error
import urllib.request

results = []
for case in {requests!r}:
    request = urllib.request.Request(
        'http://{container}:8737' + case['path'], data=case['body'].encode('utf-8') or None,
        method=case['method'], headers=case['headers'],
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            status, body = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, body = error.code, error.read()
    results.append({{'id': case['id'], 'status': status, 'body': body.decode('utf-8')}})
print(json.dumps(results))
"""
    results = json.loads(_run_probe(image, network, script))
    openapi = load_openapi()
    for case, result in zip(cases, results, strict=True):
        assert case["id"] == result["id"]
        validate_case(case, result["status"], result["body"].encode("utf-8"), openapi)


def _run_probe(image: str, network: str, script: str) -> str:
    probe = f"gh-aw-router-probe-{uuid.uuid4().hex}"
    try:
        return _docker(
            [
                "run",
                "--platform",
                IMAGE_PLATFORM,
                "--rm",
                "--name",
                probe,
                "--network",
                network,
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--entrypoint",
                "python",
                image,
                "-c",
                script,
            ]
        ).stdout
    finally:
        _docker(["rm", "--force", probe], allow_failure=True)


def _docker(
    arguments: list[str],
    *,
    cwd: Path | None = None,
    timeout: float = DOCKER_TIMEOUT_SECONDS,
    allow_failure: bool = False,
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(  # noqa: S603
            ["docker", *arguments],  # noqa: S607
            cwd=cwd,
            check=False,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        if not allow_failure:
            raise RuntimeError(f"Docker {arguments[0]} failed or exceeded {timeout:g}s") from error
        warnings.warn(f"Docker cleanup failed: {error}", RuntimeWarning, stacklevel=2)
        return subprocess.CompletedProcess(arguments, 1, "", str(error))
    if result.returncode != 0 and not allow_failure:
        raise RuntimeError(f"Docker {arguments[0]} failed\n{result.stdout}\n{result.stderr}")
    return result
