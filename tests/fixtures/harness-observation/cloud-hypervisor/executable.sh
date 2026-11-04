#!/bin/sh
set -eu
case "$(env)" in *awf-ch-fixture-secret-must-not-leak*) exit 90 ;; esac
phase=command
if [ "${1:-}" = --version ]; then phase=probe; fi
context_directory=${FIXTURE_DIRECTORY:-/workspace}
{
  id -u
  id -g
  pwd -P
  printf '%s\n' "$PATH" "$HOME" "$FIXTURE_ENV" "$AWF_RUNTIME"
} >"$context_directory/$phase-context"
if [ "$phase" = probe ]; then
  case "$FIXTURE_MODE" in
    valid) printf '%s\n' "$FIXTURE_VERSION" 'token=discard-this-ch-metadata' ;;
    malformed) echo 'discard-this-ch-output'; echo 'discard-this-ch-stderr' >&2 ;;
    failed) echo 'discard-this-ch-error' >&2; exit 7 ;;
    overflow) printf '%5000s\n' x ;;
    boundary)
      size=$((${#0} + 1 + ${#FIXTURE_VERSION} + 1))
      printf '%s\n' "$FIXTURE_VERSION"
      printf "%$((4096 - size - 1))s\n" x
      ;;
    over-boundary)
      size=$((${#0} + 1 + ${#FIXTURE_VERSION} + 1))
      printf '%s\n' "$FIXTURE_VERSION"
      printf "%$((4097 - size - 1))s\n" x
      ;;
    timeout|cancel) sleep 30 ;;
    *) exit 99 ;;
  esac
else
  printf 'fixture-ch-command-output\n'
  printf 'fixture-ch-command-stderr\n' >&2
  exit 23
fi
