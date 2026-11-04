#!/bin/sh
set -eu

harness=${0##*/}
mode=${0%/*}
mode=${mode##*/}
printf 'NVX-FIXTURE-CONTEXT: uid=%s gid=%s cwd=%s\n' "$(id -u)" "$(id -g)" "$PWD"
printf 'NVX-FIXTURE-ENV: path=%s home=%s user=%s logname=%s\n' "$PATH" "$HOME" "${USER:-}" "${LOGNAME:-}"

if [ "${1:-}" != --version ]; then
  echo NVX-FIXTURE-COMMAND
  echo NVX-FIXTURE-COMMAND-STDERR >&2
  exit 23
fi

case "$mode" in
  valid)
    case "$harness" in
      copilot) echo '1.2.3' ;;
      claude) echo '1.2.3 (Claude Code)' ;;
      codex) echo 'codex-cli 1.2.3' ;;
      *) exit 99 ;;
    esac
    ;;
  malformed) echo 'not-a-version' ;;
  failed) echo NVX-FIXTURE-VERSION-FAILED >&2; exit 7 ;;
  overflow) printf '%5000s\n' '' | tr ' ' x ;;
  timeout) sleep 300 ;;
  *) exit 99 ;;
esac
