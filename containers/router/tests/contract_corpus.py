"""Source-only helpers for the portable routing contract corpus."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import re
import shutil
import subprocess
import tarfile
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator

from gh_aw_router import __version__
from gh_aw_router.contracts import RoutingGoal, RoutingMode, TaskType
from gh_aw_router.routing_table import PROFILES, all_labels, label_key, profile_filename

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CORPUS_DIRECTORY = Path(__file__).parent / "fixtures" / "routing-contract"
CONTRACT_CHOICES = ("github-copilot/router-fast", "github-copilot/router-reasoning:medium")


def json_bytes(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode("utf-8")


def synthetic_table_document(
    choices: tuple[str, str] = ("provider/fast", "provider/reasoning:medium"),
) -> dict[str, Any]:
    return {
        "schema_version": 5,
        "profile": {"goal": "cost", "mode": "balanced"},
        "repository": "global",
        "classification_choices": list(choices),
        "rankings": [
            {
                "applies_to": [label_key(labels) for labels in all_labels()],
                "choices": list(choices),
            }
        ],
    }


def contract_tables() -> dict[str, bytes]:
    tables = {}
    for profile in PROFILES:
        document = synthetic_table_document(CONTRACT_CHOICES)
        document["profile"] = profile.model_dump(mode="json")
        groups: dict[tuple[str, ...], list[str]] = {}
        for labels in all_labels():
            reasoning_first = profile.mode is RoutingMode.ROBUST or (
                profile.mode is RoutingMode.BALANCED and labels.task_type is TaskType.FIX
            )
            if profile.goal is RoutingGoal.COST_SPEED:
                reasoning_first = not reasoning_first
            choices = CONTRACT_CHOICES[::-1] if reasoning_first else CONTRACT_CHOICES
            groups.setdefault(choices, []).append(label_key(labels))
        document["rankings"] = [
            {"applies_to": keys, "choices": list(choices)} for choices, keys in groups.items()
        ]
        tables[profile_filename(profile)] = json_bytes(document)
    return tables


def load_cases() -> list[dict[str, Any]]:
    cases = []
    for file in sorted(CORPUS_DIRECTORY.glob("*.json")):
        document = json.loads(file.read_bytes())
        if isinstance(document, list):
            for case in document:
                if "response_file" in case:
                    case["response"] = json.loads(
                        (CORPUS_DIRECTORY / case.pop("response_file")).read_bytes()
                    )
                cases.append(case)
    return cases


def request_bytes(case: dict[str, Any]) -> bytes:
    if "request_body" in case:
        return case["request_body"].encode("utf-8")
    if "raw_request" in case:
        return case["raw_request"].encode("utf-8")
    return json_bytes(case["request"]) if "request" in case else b""


def validate_case(case: dict[str, Any], status: int, body: bytes, openapi: dict[str, Any]) -> None:
    if status != case["status"]:
        raise AssertionError(f"{case['id']}: expected HTTP {case['status']}, got {status}")
    if status == 204:
        if body:
            raise AssertionError(f"{case['id']}: readiness response must have no body")
        return
    response = json.loads(body)
    schema = (
        "Error"
        if status >= 400
        else {
            "/route": "RouteResponse",
            "/classify": "ClassifyResponse",
            "/capabilities": "ServiceCapabilities",
        }[case["path"]]
    )
    validator = Draft202012Validator(
        {"$ref": f"#/components/schemas/{schema}", "components": openapi["components"]}
    )
    validator.validate(response)
    validator.validate(case["response"])
    if status >= 400:
        if response["code"] != case["response"]["code"]:
            raise AssertionError(f"{case['id']}: unexpected error code {response['code']}")
    elif response != case["response"]:
        raise AssertionError(f"{case['id']}: response differs from the reviewed fixture")


def load_openapi() -> dict[str, Any]:
    return yaml.safe_load((PROJECT_ROOT / "openapi.yaml").read_bytes())


def source_identity(root: Path, *, development: bool) -> dict[str, Any]:
    git = shutil.which("git")
    source_sha = None
    dirty = None
    if git is not None and (root / ".git").exists():
        revision = subprocess.run(  # noqa: S603
            [git, "rev-parse", "HEAD"],
            cwd=root,
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
        status = subprocess.run(  # noqa: S603
            [git, "status", "--porcelain=v1", "--untracked-files=all"],
            cwd=root,
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
        source_sha = revision.stdout.strip()
        dirty = bool(status.stdout)
    if not development and (source_sha is None or dirty is not False):
        raise ValueError("release provenance requires a clean, identified Git checkout")
    return {"sha": source_sha, "dirty": dirty, "development": development}


def export_archive(
    integration_contract: Path,
    integration_contract_sha256: str,
    *,
    development: bool = False,
) -> bytes:
    attachment = integration_contract.read_bytes()
    if hashlib.sha256(attachment).hexdigest() != integration_contract_sha256:
        raise ValueError("integration contract checksum does not match")
    revision = re.search(
        r"^Contract revision: `([A-Za-z0-9/._-]+)`\.\r?$",
        attachment.decode("utf-8"),
        re.MULTILINE,
    )
    if revision is None:
        raise ValueError("integration contract must declare its revision")
    source = source_identity(PROJECT_ROOT, development=development)
    cases = load_cases()
    for case in cases:
        case["request_body"] = request_bytes(case).decode("utf-8")
    files = {
        "README.md": (PROJECT_ROOT / "README.md").read_text(encoding="utf-8").encode("utf-8"),
        "cases.json": json_bytes(cases),
        "openapi.yaml": (PROJECT_ROOT / "openapi.yaml").read_text(encoding="utf-8").encode("utf-8"),
        "integration-contract.md": attachment,
        **{f"tables/{name}": data for name, data in contract_tables().items()},
    }
    files["manifest.json"] = json_bytes(
        {
            "archive_format": 1,
            "router_version": __version__,
            "routing_table_schema": 5,
            "source": source,
            "integration_contract_revision": revision.group(1),
            "files": {
                name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())
            },
        }
    )
    output = io.BytesIO()
    with (
        gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0) as compressed,
        tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive,
    ):
        for name, data in sorted(files.items()):
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            entry.mode = 0o644
            archive.addfile(entry, io.BytesIO(data))
    return output.getvalue()


def main() -> None:
    parser = argparse.ArgumentParser(description="Export reviewed routing contract fixtures.")
    parser.add_argument("--integration-contract", type=Path, required=True)
    parser.add_argument("--integration-contract-sha256", required=True)
    parser.add_argument("--development", action="store_true", help="Mark non-release provenance.")
    parser.add_argument("--output", type=Path, default=Path("dist/routing-contract.tar.gz"))
    arguments = parser.parse_args()
    try:
        archive = export_archive(
            arguments.integration_contract,
            arguments.integration_contract_sha256,
            development=arguments.development,
        )
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.error(str(error))
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_bytes(archive)
    print(
        json.dumps(
            {"archive": str(arguments.output), "sha256": hashlib.sha256(archive).hexdigest()}
        )
    )


if __name__ == "__main__":
    main()
