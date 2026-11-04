#!/bin/bash
set -eu
phase=command
if [ "${1:-}" = --version ]; then phase=probe; fi
{
  id -u
  id -g
  printf '%s\n' "$PWD" "$PATH" "$HOME" "$USER" "$LOGNAME" "$FIXTURE_ENV" "${BASH_ENV:-}"
  if shopt -q login_shell; then echo login; else echo non-login; fi
} >"$FIXTURE_DIRECTORY/$phase-context"
if [ "$phase" = probe ]; then
  case "$FIXTURE_MODE" in
    valid) printf '%s\n' "$FIXTURE_VERSION" 'token=discard-this-fixture-metadata' ;;
    malformed) echo 'token=discard-this-fixture-output'; echo 'discard-this-fixture-stderr' >&2 ;;
    overflow) printf '%5000s\n' x ;;
    overflow-newline)
      printf '1.2.3\n'
      remaining=$((4097 - ${#0} - 1 - 6))
      printf "%$((remaining - 1))s\n" x
      ;;
    failed) echo 'discard-this-fixture-error' >&2; exit 7 ;;
    timeout) sleep 30 ;;
    *) exit 99 ;;
  esac
else
  printf 'fixture-command-output\n'
  printf 'fixture-command-stderr\n' >&2
  exit 23
fi
