"""Command-line adapter for the standalone planning service."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING

from pydantic import BaseModel

from gh_aw_router import __version__
from gh_aw_router.contracts import ClassifyRequest, PlanningRequest, RouteRequest, decode_request
from gh_aw_router.routing import NoRouteError
from gh_aw_router.routing_table import DEFAULT_TABLE_DIRECTORY
from gh_aw_router.service import GhAwRouterService

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence
    from typing import TextIO

CHECKOUT_ROOT = Path(__file__).resolve().parents[2]
LOG_LEVELS = ("critical", "error", "warning", "info", "debug", "trace")
MIN_PORT = 1
MAX_PORT = 65_535
# Peak buffered body memory is this bound multiplied by the HTTP body limit.
MAX_CONCURRENT_REQUESTS = 64
KEEP_ALIVE_SECONDS = 5


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line argument parser."""
    parser = argparse.ArgumentParser(
        prog="gh-aw-router",
        description="Standalone gh-aw-router classification planning and routing",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    _add_data_path_argument(
        parser,
        "--routing-tables",
        "GH_AW_ROUTER_ROUTING_TABLES",
        CHECKOUT_ROOT / DEFAULT_TABLE_DIRECTORY,
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    classify = subparsers.add_parser("classify", help="create a classification call plan")
    classify.add_argument("--input", type=Path, help="request JSON file, otherwise stdin")

    route = subparsers.add_parser("route", help="rank model candidates")
    route.add_argument("--input", type=Path, help="request JSON file, otherwise stdin")

    subparsers.add_parser("validate-data", help="validate the compiled routing tables")

    serve = subparsers.add_parser("serve", help="run the private HTTP service")
    serve.add_argument("--bind", default=os.environ.get("GH_AW_ROUTER_BIND", "127.0.0.1:8737"))
    serve.add_argument(
        "--log-level",
        choices=LOG_LEVELS,
        default=os.environ.get("GH_AW_ROUTER_LOG_LEVEL", "info"),
    )
    return parser


def run(
    argv: Sequence[str] | None = None,
    *,
    stdin: TextIO = sys.stdin,
    stdout: TextIO = sys.stdout,
    stderr: TextIO = sys.stderr,
) -> int:
    """Run one command and return its process exit status."""
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        service = GhAwRouterService.load(args.routing_tables)
    except (OSError, ValueError) as error:
        print(f"invalid model data: {error}", file=stderr)
        return 2
    try:
        _COMMANDS[args.command](args, service, stdin, stdout)
    except NoRouteError as error:
        print(f"no route: {error}", file=stderr)
        return 3
    # Every remaining planning and decoding failure subclasses ValueError.
    except (OSError, ValueError) as error:
        print(f"invalid request: {error}", file=stderr)
        return 2
    return 0


def main() -> None:
    """Run the CLI and exit with its status."""
    raise SystemExit(run())


def _validate_data(
    _args: argparse.Namespace,
    service: GhAwRouterService,
    _stdin: TextIO,
    stdout: TextIO,
) -> None:
    table = service.primary_table
    _write_json(
        {
            "profiles": sorted(service.routing_tables),
            "repository": table.document.repository,
            "label_cells": len(table.cells),
            "models": len({pair.model for pair in table.pairs}),
        },
        stdout,
    )


def _classify(
    args: argparse.Namespace,
    service: GhAwRouterService,
    stdin: TextIO,
    stdout: TextIO,
) -> None:
    request = _read_request(ClassifyRequest, args.input, stdin)
    _write_model(service.classify(request), stdout)


def _route(
    args: argparse.Namespace,
    service: GhAwRouterService,
    stdin: TextIO,
    stdout: TextIO,
) -> None:
    request = _read_request(RouteRequest, args.input, stdin)
    _write_model(service.route(request), stdout)


def _serve(
    args: argparse.Namespace,
    service: GhAwRouterService,
    _stdin: TextIO,
    _stdout: TextIO,
) -> None:
    import uvicorn

    from gh_aw_router.http import create_app

    host, port = _parse_bind(args.bind)
    uvicorn.run(
        create_app(service),
        host=host,
        port=port,
        log_level=args.log_level,
        limit_concurrency=MAX_CONCURRENT_REQUESTS,
        timeout_keep_alive=KEEP_ALIVE_SECONDS,
    )


_COMMANDS: dict[str, Callable[[argparse.Namespace, GhAwRouterService, TextIO, TextIO], None]] = {
    "validate-data": _validate_data,
    "classify": _classify,
    "route": _route,
    "serve": _serve,
}


def _read_request[RequestModel: PlanningRequest](
    model: type[RequestModel],
    path: Path | None,
    stdin: TextIO,
) -> RequestModel:
    if path is not None:
        return decode_request(model, path.read_bytes())
    # Read bytes so piped JSON is decoded as UTF-8 rather than the console locale.
    buffer = getattr(stdin, "buffer", None)
    return decode_request(model, stdin.read() if buffer is None else buffer.read())


def _write_model(model: BaseModel, output: TextIO) -> None:
    _write_json(model.model_dump(mode="json", exclude_none=True), output)


def _write_json(value: dict[str, object], output: TextIO) -> None:
    output.write(json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n")


def _parse_bind(value: str) -> tuple[str, int]:
    try:
        host, raw_port = value.rsplit(":", 1)
        port = int(raw_port)
    except ValueError as error:
        raise ValueError("bind must use HOST:PORT syntax") from error
    if not host or not MIN_PORT <= port <= MAX_PORT:
        raise ValueError("bind must contain a host and port from 1 through 65535")
    return host, port


def _add_data_path_argument(
    parser: argparse.ArgumentParser,
    option: str,
    environment_variable: str,
    checkout_default: Path,
) -> None:
    default = _path_setting(environment_variable, checkout_default)
    parser.add_argument(
        option,
        type=Path,
        default=default,
        required=default is None,
        metavar="PATH",
        help=f"can also be set with {environment_variable}",
    )


def _path_setting(name: str, checkout_default: Path) -> Path | None:
    value = os.environ.get(name)
    if value:
        return Path(value)
    return checkout_default if checkout_default.exists() else None
