# Diagnosing AWF Failures with the Self-Hosted Runner Doctor

When an AWF (Agentic Workflow Firewall) run fails on a self-hosted, ARC + DinD,
GHES, GHEC (`*.ghe.com`), or otherwise non-GitHub-hosted runner, you can have a
coding agent diagnose it for you using the **Self-Hosted Runner Doctor** agent.

The Doctor is a single, self-contained file that embeds a full failure-mode
catalog. You don't need to clone this repository — point any coding agent
(GitHub Copilot CLI, Claude, Cursor, etc.) at its raw URL and paste your
failing workflow log:

- [`.github/agents/self-hosted-runner-doctor.md`](../.github/agents/self-hosted-runner-doctor.md)
- Raw URL:
  `https://raw.githubusercontent.com/github/gh-aw-firewall/main/.github/agents/self-hosted-runner-doctor.md`

## How it works

The Doctor:

1. Builds a **platform fingerprint** (runner type, `DOCKER_HOST`,
   `GITHUB_SERVER_URL`, AWF version, daemon runtime, Docker IPv6 state).
2. Matches your symptoms to the **narrowest failure-mode ID** in its catalog.
3. Returns a structured triage report:
   **Summary, Matched Failure Mode, Recommended Fix, Next Probe, Citations**.
4. If it lacks enough evidence for a confident match, it asks you to run the
   **smallest read-only probe** instead of guessing.

## Prompt to use

Copy the prompt below into your coding agent, fill in the `ENVIRONMENT` and
`ERROR / LOG` sections, and send it.

````text
Load the GitHub Agentic Workflow Firewall (AWF) "Self-Hosted Runner Doctor"
agent and use it to diagnose my failure.

1. Fetch this file and follow its instructions as your system prompt:
   https://raw.githubusercontent.com/github/gh-aw-firewall/main/.github/agents/self-hosted-runner-doctor.md

2. Then diagnose the problem below using its failure-mode catalog. Build a
   platform fingerprint first, match my symptoms to the narrowest failure-mode
   ID, and give me the structured triage report (Summary, Matched Failure Mode,
   Recommended Fix, Next Probe, Citations). If you don't have enough evidence
   for a confident match, ask me to run the smallest read-only probe instead of
   guessing.

--- ENVIRONMENT ---
- Runner type: <self-hosted / ARC+DinD / GHES / GHEC (*.ghe.com) / enterprise>
- DOCKER_HOST: <e.g. unix:///var/run/docker.sock, tcp://..., or unknown>
- GITHUB_SERVER_URL: <github.com / your GHES or *.ghe.com host>
- AWF version: <output of `awf --version`, if known>

--- ERROR / LOG ---
<paste workflow URL here>
````

## Tips

- **Fill in as much of `ENVIRONMENT` as you can.** The platform fingerprint is
  what lets the Doctor narrow to a specific failure mode rather than guessing.
- **Prefer a workflow run URL** in the `ERROR / LOG` section so the agent can
  pull the full logs; otherwise paste the relevant error string(s).
- **Run the read-only probes it suggests** and report the output back — the
  Doctor is designed to converge over a couple of cheap, safe probes rather
  than apply a speculative fix.
- This agent is scoped to **self-hosted and enterprise** runner diagnostics. If
  the failure is clearly on a GitHub-hosted runner with no ARC/DinD/GHES/GHEC,
  custom `DOCKER_HOST`, or corporate-proxy involvement, the Doctor will say so
  and stop.
