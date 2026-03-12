# Agentic Workflow Firewall

A network firewall for agentic workflows with domain whitelisting. This tool provides L7 (HTTP/HTTPS) egress control using [Squid proxy](https://www.squid-cache.org/) and Docker containers, restricting network access to a whitelist of approved domains for AI agents and their MCP servers.

> [!TIP]
> This project is a part of GitHub's explorations of [Agentic Workflows](https://github.com/github/gh-aw). For more background, check out the [project page](https://github.github.io/gh-aw/)! ✨

## What it does

- **L7 Domain Whitelisting**: Control HTTP/HTTPS traffic at the application layer
- **Host-Level Enforcement**: Uses iptables DOCKER-USER chain to enforce firewall on ALL containers
- **Chroot Mode**: Transparent access to host binaries (Python, Node.js, Go) while maintaining network isolation
- **API Proxy Sidecar**: Optional Node.js-based proxy for secure LLM API credential management (OpenAI Codex, Anthropic Claude) that routes through Squid

## Requirements

- **Docker**: 20.10+ with Docker Compose v2
- **Node.js**: 20.12.0+ (for building from source)
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
