import os
import shlex
import subprocess
import sys


READ_COMMANDS = {
    "gist": {"list", "view"},
    "issue": {"list", "status", "view"},
    "pr": {"checks", "diff", "list", "status", "view"},
    "release": {"list", "view"},
    "repo": {"list", "view"},
    "run": {"list", "view"},
    "search": {"code", "commits", "issues", "prs", "repos"},
    "workflow": {"list", "view"},
}
BLOCKED_FLAGS = {"--admin", "--confirm", "--delete"}


def parse_arguments(value):
    try:
        return shlex.split(value)
    except ValueError as error:
        raise ValueError(f"Unable to parse gh arguments: {error}") from error


def validate_arguments(arguments):
    if not arguments:
        raise ValueError("A read-only gh command is required.")

    if any(argument in BLOCKED_FLAGS for argument in arguments):
        raise ValueError("Mutating gh flags are not allowed.")

    command = arguments[0]
    if command == "status":
        return
    if command == "api":
        validate_api_arguments(arguments[1:])
        return
    if command not in READ_COMMANDS or len(arguments) < 2:
        raise ValueError(f"gh {command} is not an allowed read-only command.")
    if arguments[1] not in READ_COMMANDS[command]:
        raise ValueError(f"gh {command} {arguments[1]} is not an allowed read-only command.")


def validate_api_arguments(arguments):
    method = None
    has_fields = False
    endpoint_seen = False
    index = 0

    while index < len(arguments):
        argument = arguments[index]
        if argument in ("-X", "--method"):
            index += 1
            if index == len(arguments):
                raise ValueError("gh api method flag requires a value.")
            method = arguments[index].upper()
            if method != "GET":
                raise ValueError("Only GET requests are allowed for gh api.")
        elif argument.startswith("--method="):
            method = argument.partition("=")[2].upper()
            if method != "GET":
                raise ValueError("Only GET requests are allowed for gh api.")
        elif argument.startswith("-X") and len(argument) > 2:
            method = argument[2:].upper()
            if method != "GET":
                raise ValueError("Only GET requests are allowed for gh api.")
        elif argument in ("--hostname", "--input", "-H", "--header") or argument.startswith(
            ("--hostname=", "--input=", "--header=")
        ):
            raise ValueError(f"gh api {argument.split('=', 1)[0]} is not allowed.")
        elif argument in ("-f", "-F", "--field", "--raw-field"):
            has_fields = True
        elif argument.startswith(("-f", "-F")) and len(argument) > 2:
            has_fields = True
        elif argument.startswith(("--field=", "--raw-field=")):
            has_fields = True
        elif not argument.startswith("-"):
            endpoint_seen = True
        index += 1

    if not endpoint_seen:
        raise ValueError("gh api requires an endpoint.")
    if has_fields and method != "GET":
        raise ValueError("gh api fields require an explicit GET method.")


def main():
    input_args = sys.argv[1] if len(sys.argv) == 2 else ""
    try:
        arguments = parse_arguments(input_args)
        validate_arguments(arguments)
    except ValueError as error:
        print(f"Refusing request: {error}", file=sys.stderr)
        return 2

    print(f"gh {shlex.join(arguments)}")
    environment = os.environ.copy()
    environment["GH_TOKEN"] = environment.pop("GH_AW_GH_TOKEN", "")
    return subprocess.run(["gh", *arguments], env=environment, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
