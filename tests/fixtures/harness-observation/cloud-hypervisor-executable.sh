#!/bin/sh
set -eu
phase=command
if [ "${1:-}" = --version ]; then phase=probe; fi
{
  id -u
  id -g
  pwd
  printf '%s\n' "$PATH" "$HOME" "${AWF_RUNTIME:-}" "${FIXTURE_ENV:-}" "${FIXTURE_LOGIN:-missing}"
  cat /proc/sys/kernel/random/boot_id
} >"$FIXTURE_DIRECTORY/$phase-context"
if [ "$phase" = probe ]; then
  case "$FIXTURE_MODE" in
    valid) printf '%s\n' "$FIXTURE_VERSION" 'token=discard-this-fixture-metadata' ;;
    malformed) echo 'discard-this-fixture-output'; echo 'discard-this-fixture-stderr' >&2 ;;
    failed) echo 'discard-this-fixture-error' >&2; exit 7 ;;
    oversized)
      # The resolver already emitted "$0\n". Include that prefix in the
      # exact 4097-byte transport output, ending on a newline.
      printf '1.2.3\n'
      remaining=$((4097 - ${#0} - 1 - 6))
      printf "%$((remaining - 1))s\n" x
      ;;
    timeout) sleep 30 ;;
    *) exit 99 ;;
  esac
else
  printf 'fixture-command-output\n'
  printf 'fixture-command-stderr\n' >&2
  exit 23
fi
