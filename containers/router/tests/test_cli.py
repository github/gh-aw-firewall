from __future__ import annotations

import io
import json
import shutil
import subprocess
import sys
import textwrap
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

import gh_aw_router.cli as cli
from gh_aw_router.cli import run

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def common_args() -> list[str]:
    return [
        "--routing-tables",
        str(PROJECT_ROOT / "routing"),
    ]


def load_request(command: str) -> dict[str, object]:
    return json.loads((PROJECT_ROOT / f"examples/{command}-request.json").read_bytes())


@pytest.mark.parametrize("command", ["classify", "route"])
def test_planning_commands_write_only_the_response(
    planning_payload: Callable[[str], dict[str, Any]], synthetic_table_path: Path, command: str
) -> None:
    request = planning_payload(command)
    stdout = io.StringIO()
    stderr = io.StringIO()

    status = run(
        ["--routing-tables", str(synthetic_table_path), command],
        stdin=io.StringIO(json.dumps(request)),
        stdout=stdout,
        stderr=stderr,
    )

    assert status == 0
    assert stderr.getvalue() == ""
    result = json.loads(stdout.getvalue())
    assert result["ranked_choices"] == request["models"]


@pytest.mark.parametrize("command", ["classify", "route"])
def test_cli_preserves_unicode_across_console_encodings(
    planning_payload: Callable[[str], dict[str, Any]], synthetic_table_path: Path, command: str
) -> None:
    request = planning_payload(command)
    text = "Fix the parser \u4fee\u590d"
    request["conversation"][0]["parts"] = [{"text": text}]
    request["models"][0]["id"] = "choice-\u4fee"
    stdin = io.TextIOWrapper(
        io.BytesIO(json.dumps(request, ensure_ascii=False).encode("utf-8")),
        encoding="cp1252",
        errors="replace",
    )
    output = io.BytesIO()
    stdout = io.TextIOWrapper(output, encoding="cp1252")
    stderr = io.StringIO()

    status = run(
        ["--routing-tables", str(synthetic_table_path), command],
        stdin=stdin,
        stdout=stdout,
        stderr=stderr,
    )
    stdout.flush()

    assert status == 0, stderr.getvalue()
    assert stderr.getvalue() == ""
    result = json.loads(output.getvalue())
    assert result["ranked_choices"] == request["models"]
    if command == "classify":
        assert text in result["prompt"]


def test_invalid_request_uses_stderr_and_nonzero_status(synthetic_table_path: Path) -> None:
    stdout = io.StringIO()
    stderr = io.StringIO()

    status = run(
        ["--routing-tables", str(synthetic_table_path), "route"],
        stdin=io.StringIO("{}"),
        stdout=stdout,
        stderr=stderr,
    )

    assert status == 2
    assert stdout.getvalue() == ""
    assert stderr.getvalue().startswith("invalid request:")


def test_missing_model_data_is_reported_separately_from_bad_requests(tmp_path: Path) -> None:
    stdout = io.StringIO()
    stderr = io.StringIO()

    status = run(
        [
            "--routing-tables",
            str(tmp_path / "routing.json"),
            "validate-data",
        ],
        stdout=stdout,
        stderr=stderr,
    )

    assert status == 2
    assert stdout.getvalue() == ""
    assert stderr.getvalue().startswith("invalid model data:")


def test_empty_routing_directory_is_reported_as_missing_data(tmp_path: Path) -> None:
    stderr = io.StringIO()

    status = run(["--routing-tables", str(tmp_path), "validate-data"], stderr=stderr)

    assert status == 2
    assert "holds no tables" in stderr.getvalue()


def test_validate_data_reports_the_loaded_table_summary() -> None:
    stdout = io.StringIO()
    stderr = io.StringIO()

    status = run([*common_args(), "validate-data"], stdout=stdout, stderr=stderr)

    assert status == 0
    assert stderr.getvalue() == ""
    summary = json.loads(stdout.getvalue())
    assert summary["repository"] == "global"
    assert summary["label_cells"] == 210
    assert summary["models"] > 0
    assert summary["profiles"] == [
        "cost-speed/balanced",
        "cost-speed/economy",
        "cost-speed/robust",
        "cost/balanced",
        "cost/economy",
        "cost/robust",
    ]


@pytest.mark.parametrize("command", ["route", "classify"])
@pytest.mark.parametrize("unsupported", [False, True])
def test_no_route_has_a_distinct_exit_status(
    planning_payload: Callable[[str], dict[str, Any]],
    synthetic_table_path: Path,
    unsupported: bool,
    command: str,
) -> None:
    request = planning_payload(command)
    request["models"] = [{"id": "unsupported", "model": "provider/unknown"}] if unsupported else []
    stdout = io.StringIO()
    stderr = io.StringIO()

    status = run(
        ["--routing-tables", str(synthetic_table_path), command],
        stdin=io.StringIO(json.dumps(request)),
        stdout=stdout,
        stderr=stderr,
    )

    assert status == 3
    assert stdout.getvalue() == ""
    assert stderr.getvalue().startswith("no route:")


def test_parser_requires_explicit_data_paths_outside_a_checkout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(cli, "CHECKOUT_ROOT", tmp_path)
    for name in ("GH_AW_ROUTER_ROUTING_TABLES",):
        monkeypatch.delenv(name, raising=False)

    with pytest.raises(SystemExit) as error:
        cli.build_parser().parse_args(["validate-data"])

    assert error.value.code == 2
    message = capsys.readouterr().err
    assert "--routing-tables" in message


def test_bind_defaults_to_loopback_with_explicit_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GH_AW_ROUTER_BIND", raising=False)
    assert cli.build_parser().parse_args([*common_args(), "serve"]).bind == "127.0.0.1:8737"
    monkeypatch.setenv("GH_AW_ROUTER_BIND", "localhost:9000")
    assert cli.build_parser().parse_args([*common_args(), "serve"]).bind == "localhost:9000"
    assert (
        cli.build_parser().parse_args([*common_args(), "serve", "--bind", "0.0.0.0:8737"]).bind
        == "0.0.0.0:8737"
    )


def test_serve_bounds_concurrency_and_idle_connections(
    monkeypatch: pytest.MonkeyPatch, synthetic_table_path: Path
) -> None:
    import uvicorn

    captured: dict[str, object] = {}
    monkeypatch.setattr(uvicorn, "run", lambda _app, **kwargs: captured.update(kwargs))

    status = run(
        ["--routing-tables", str(synthetic_table_path), "serve", "--bind", "127.0.0.1:9999"],
    )

    assert status == 0
    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == 9999
    assert captured["limit_concurrency"] == cli.MAX_CONCURRENT_REQUESTS
    assert captured["timeout_keep_alive"] == cli.KEEP_ALIVE_SECONDS


def test_parser_exposes_package_version(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as error:
        cli.build_parser().parse_args(["--version"])

    assert error.value.code == 0
    assert capsys.readouterr().out == "gh-aw-router 0.1.3\n"


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("127.0.0.1:1", ("127.0.0.1", 1)),
        ("::1:65535", ("::1", 65_535)),
    ],
)
def test_parse_bind_accepts_hosts_and_valid_port_bounds(
    value: str,
    expected: tuple[str, int],
) -> None:
    assert cli._parse_bind(value) == expected


@pytest.mark.parametrize(
    "value",
    ["localhost", ":8737", "localhost:0", "localhost:65536", "localhost:not-a-port"],
)
def test_parse_bind_rejects_missing_hosts_and_invalid_ports(value: str) -> None:
    with pytest.raises(ValueError, match="bind must"):
        cli._parse_bind(value)


def test_serving_needs_only_lookup_table(tmp_path: Path) -> None:
    shutil.copyfile(PROJECT_ROOT / "routing/cost-robust.json", tmp_path / "routing.json")
    requests = {}
    for command in ("classify", "route"):
        requests[command] = load_request(command)
    script = textwrap.dedent("""
        import importlib.abc
        import io
        import json
        import sys
        from pathlib import Path

        class RejectOfflineImports(importlib.abc.MetaPathFinder):
            def find_spec(self, fullname, path, target=None):
                if fullname.startswith("gh_aw_router_training") or fullname in {
                    "gh_aw_router.catalogue", "gh_aw_router.fit",
                    "gh_aw_router.numerics", "gh_aw_router.training",
                    "gh_aw_router.snapshots", "gh_aw_router.cell_training",
                }:
                    raise AssertionError(f"serving imported {fullname}")

        sys.meta_path.insert(0, RejectOfflineImports())
        from fastapi.testclient import TestClient
        from gh_aw_router.cli import run
        from gh_aw_router.http import create_app
        from gh_aw_router.service import GhAwRouterService

        requests = json.load(sys.stdin)
        for command, request in requests.items():
            output, errors = io.StringIO(), io.StringIO()
            status = run(
                ["--routing-tables", "routing.json", command],
                stdin=io.StringIO(json.dumps(request)), stdout=output, stderr=errors,
            )
            assert status == 0, errors.getvalue()
            assert json.loads(output.getvalue())["ranked_choices"]
        with TestClient(create_app(GhAwRouterService.load(Path("routing.json")))) as client:
            assert client.get("/healthz").status_code == 204
            assert client.get("/capabilities").status_code == 200
            for command, request in requests.items():
                assert client.post(f"/{command}", json=request).status_code == 200
    """)
    result = subprocess.run(  # noqa: S603
        [sys.executable, "-c", script],
        cwd=tmp_path,
        input=json.dumps(requests),
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
