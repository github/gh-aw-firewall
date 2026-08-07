---
name: Smoke Bounded Agents gVisor
description: End-to-end smoke test for finite-schema gVisor bounded-agent enclaves
on:
  schedule: every 12h
  workflow_dispatch:
permissions:
  contents: read
  copilot-requests: write
env:
  GH_TOKEN: ${{ github.token }}
engine:
  id: copilot
  version: 1.0.34
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
network:
  allowed:
    - defaults
    - github
tools:
  github:
    toolsets: [context]
    allowed: []
sandbox:
  agent:
    id: awf
    version: v0.28.0
    args:
      - --build-local
steps:
  - name: Build unreleased AWF
    run: |
      npm ci
      npm run build
pre-agent-steps:
  - name: Install gVisor
    run: |
      set -euo pipefail
      arch="$(uname -m)"
      url="https://storage.googleapis.com/gvisor/releases/release/20250707.0/${arch}"
      curl -fsSL "${url}/runsc" -o "$RUNNER_TEMP/runsc"
      curl -fsSL "${url}/runsc.sha512" -o "$RUNNER_TEMP/runsc.sha512"
      (cd "$RUNNER_TEMP" && sha512sum -c runsc.sha512)
      sudo install -m 755 "$RUNNER_TEMP/runsc" /usr/local/bin/runsc
      sudo runsc install
      sudo systemctl restart docker
      docker info --format '{{json .Runtimes}}' | grep -F '"runsc"'
  - name: Replace release bootstrap with current AWF build
    run: |
      mkdir -p "$HOME/.local/bin"
      cat > "$HOME/.local/bin/configure-bounded-agent.cjs" <<'NODE'
      const fs = require("fs");
      const [file, runtime] = process.argv.slice(2);
      if (!file || !runtime) {
        throw new Error("usage: configure-bounded-agent.cjs <config> <runtime>");
      }
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      config.apiProxy = { ...(config.apiProxy || {}), targets: { copilot: {} } };
      config.boundedAgents = {
        enabled: true,
        privateRepos: [{ repo: "github/gh-aw", sensitivity: "internal" }],
        runtime,
        engine: "copilot",
        profile: "openai",
        model: "gpt-4o-mini",
        timeout: 540,
        memoryLimit: "512m"
      };
      fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      NODE
      cat > "$HOME/.local/bin/awf" <<'SH'
      #!/bin/bash
      set -euo pipefail
      config_path=""
      args=("$@")
      for ((index = 0; index < ${#args[@]}; index++)); do
        if [[ "${args[$index]}" == "--config" && $((index + 1)) -lt ${#args[@]} ]]; then
          config_path="${args[$((index + 1))]}"
          break
        fi
      done
      if [[ -z "$config_path" ]]; then
        echo "bounded-agent smoke wrapper requires --config" >&2
        exit 2
      fi
      node "$HOME/.local/bin/configure-bounded-agent.cjs" "$config_path" gvisor
      exec node "$GITHUB_WORKSPACE/dist/cli.js" "$@"
      SH
      chmod +x "$HOME/.local/bin/awf"
safe-outputs:
  threat-detection:
    enabled: false
timeout-minutes: 30
strict: false
concurrency:
  group: smoke-bounded-agents-gvisor
  cancel-in-progress: false
post-steps:
  - name: Validate gVisor bounded-agent invocation
    if: always()
    env:
      AUDIT_LOG: /tmp/gh-aw/sandbox/firewall/audit/bounded-agent.jsonl
      TELEMETRY_LOG: /tmp/gh-aw/sandbox/firewall/audit/bounded-agent-runtime.jsonl
      OUTPUTS_FILE: ${{ steps.set-runtime-paths.outputs.GH_AW_SAFE_OUTPUTS }}
    run: |
      node - "$AUDIT_LOG" "$TELEMETRY_LOG" "$OUTPUTS_FILE" <<'NODE'
      const fs = require("fs");
      const [auditPath, telemetryPath, outputsPath] = process.argv.slice(2);
      const read = (file) => fs.readFileSync(file, "utf8").trim().split("\n")
        .filter(Boolean).map((line) => JSON.parse(line));
      const invocations = read(auditPath).filter((record) =>
        record.kind === "invocation" && record.sensitivity === "internal");
      if (invocations.length !== 1) {
        throw new Error(`expected one successful bounded-agent invocation, found ${invocations.length}`);
      }
      const successes = read(telemetryPath).filter((record) =>
        record.primaryBackend === "docker" &&
        record.boundedAgentBackend === "gvisor" &&
        record.lifecycleClass === "invocation" &&
        record.category === "success");
      if (successes.length !== 1) {
        throw new Error(`expected one successful gVisor telemetry record, found ${successes.length}`);
      }
      const outputs = fs.readFileSync(outputsPath, "utf8");
      if (!outputs.includes('"noop"') || !outputs.includes("PASS")) {
        throw new Error("agent did not report PASS through noop");
      }
      NODE
---

# Smoke Test: gVisor Bounded Agent

Use the generated `bounded-agent` skill exactly once to answer this boolean
question about `github/gh-aw`: does the repository root contain a `go.mod`
file?

Use a boolean schema. Do not use GitHub tools, network requests, shell commands,
or the current checkout to answer. The test passes only when a fresh gVisor
enclave returns `true`.

Call `noop` with `PASS true` only when the result is true. Otherwise call
`safeoutputs-missing_data`. Never report failure through `noop`.
