# Agentic Workflow Firewall

A network firewall for agentic workflows that restricts outbound HTTP/HTTPS to an allowlist of domains.

> [!TIP]
> This project is a part of GitHub's explorations of [Agentic Workflows](https://github.com/github/gh-aw). For more background, check out the [project page](https://github.github.io/gh-aw/)! ✨

## How it works

`awf` runs your command inside a Docker sandbox with three containers:

- **Squid proxy** — filters outbound traffic by domain allowlist
- **Agent** — runs your command; all HTTP/HTTPS is routed through Squid
- **API proxy sidecar** *(optional)* — holds LLM API keys so they never reach the agent process

## Requirements

- **Docker**: 20.10+ with Docker Compose v2
- **Node.js**: 20.19.0+ (for building from source)
- **OS**: Ubuntu 22.04+ or compatible Linux distribution

See [Compatibility](docs/compatibility.md) for full details on supported versions and tested configurations.

## Get started fast

```bash
curl -sSL https://raw.githubusercontent.com/github/gh-aw-firewall/main/install.sh | sudo bash
sudo awf --allow-domains github.com -- curl https://api.github.com
```

The `--` separator divides firewall options from the command to run.

## Explore the docs

- [Quick start](docs/quickstart.md) — install, verify, and run your first command
- [Usage guide](docs/usage.md) — CLI flags, domain allowlists, examples
- [AWF config schema](docs/awf-config.schema.json) — machine-readable JSON Schema for JSON/YAML configs (also published as a [versioned release asset](https://github.com/github/gh-aw-firewall/releases/latest/download/awf-config.schema.json) for IDE autocomplete)
- [AWF config spec](docs/awf-config-spec.md) — normative processing and precedence rules for tooling/compiler integration
- [Enterprise configuration](docs/enterprise-configuration.md) — GitHub Enterprise Cloud and Server setup
- [Chroot mode](docs/chroot-mode.md) — use host binaries with network isolation
- [API proxy sidecar](docs/api-proxy-sidecar.md) — secure credential management for LLM APIs
- [Authentication architecture](docs/authentication-architecture.md) — deep dive into token handling and credential isolation
- [SSL Bump](docs/ssl-bump.md) — HTTPS content inspection for URL path filtering
- [GitHub Actions](docs/github_actions.md) — CI/CD integration and MCP server setup
- [Environment variables](docs/environment.md) — passing environment variables to containers
- [Logging quick reference](docs/logging_quickref.md) and [Squid log filtering](docs/squid_log_filtering.md) — view and filter traffic
- [Security model](docs/security.md) — what the firewall protects and how
- [Architecture](docs/architecture.md) — how Squid, Docker, and iptables fit together
- [Compatibility](docs/compatibility.md) — supported Node.js, OS, and Docker versions
- [Troubleshooting](docs/troubleshooting.md) — common issues and fixes
- [Image verification](docs/image-verification.md) — cosign signature verification

## Development

- Install dependencies: `npm install`
- Run tests: `npm test`
- Build: `npm run build`

## Contributing

Contributions welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
