# The entrypoint rebuilds PATH after BASH_ENV, invalidating Bash's hash table.
# Reapply the fixture's explicit shell pin before subsequent commands.
set -T
trap 'hash -p "$FIXTURE_PINNED_BINARY" copilot' DEBUG
