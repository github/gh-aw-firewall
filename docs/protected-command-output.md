# Protected command output capture

Use `--capture-command-output <directory>` to ask AWF to retain the command's
raw stdout and stderr for a trusted caller:

```sh
awf --capture-command-output "$RUNNER_TEMP/awf-capture-$GITHUB_RUN_ID" \
  --allow-domains github.com -- your-command
```

The directory must be an absolute path whose parent exists; the directory itself
must not already exist. AWF resolves symlinks and checks the candidate against agent-visible mounts,
including custom read-only mounts and Docker host-path-prefix translations.
It fails before starting the command if the directory could be exposed. A
caller must not assume that `$RUNNER_TEMP` or any other chosen path is private.

AWF creates `metadata.json` and one `.stdout.bin` and `.stderr.bin` file per
runtime attempt with private permissions. Capture is bounded to 64 MiB total by
default; `--capture-command-output-max-bytes <bytes>` can lower that limit.
Output continues to drain and appear on the usual console streams after the
limit is reached. Metadata reports observed and retained byte counts, truncation,
log-drain status, per-attempt exit/outcome, command outcome, console-presentation
failures, and teardown outcome. An interrupted capture records incomplete draining.
A capture is `complete` only when the command exit was observed, all
logs drained, no capture failure or truncation occurred, and teardown completed.
A nonzero command exit can still have a complete capture.

Stdout and stderr are saved separately. Byte order is preserved within each
stream and attempt; AWF does not claim a total order between the two streams.
Capture currently supports non-TTY Compose-managed runtimes (including Docker
and gVisor). TTY, external microVM runtimes, and configurations that expose a
Docker socket to the agent are rejected explicitly.

AWF leaves the raw files in the requested host directory and does not copy or
publish them. The caller owns parsing, provenance checks, redaction, and
publication. Captured bytes prove only what AWF observed; they do not make
guest-emitted claims authoritative. Treat the files as sensitive and apply the
caller’s retention policy.
