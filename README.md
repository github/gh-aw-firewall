# Agentic Workflow Firewall

A network firewall for agentic workflows. `awf` wraps any command in a Docker-based sandbox that enforces L7 (HTTP/HTTPS) domain whitelisting via [Squid proxy](https://www.squid-cache.org/), while giving the agent transparent access to the host filesystem.

> [!TIP]
> This project is a part of GitHub's explorations of [Agentic Workflows](https://github.com/github/gh-aw). For more background, check out the [project page](https://github.github.io/gh-aw/)! ✨

## How it works

`awf` runs three Docker containers for each invocation:

- **Squid proxy** — enforces domain allowlist filtering; all HTTP/HTTPS traffic is transparently redirected here via iptables DNAT
- **Agent** — runs your command inside a chroot of the host filesystem, with network egress restricted to allowed domains only
- **API proxy sidecar** *(optional, `--enable-api-proxy`)* — keeps LLM API keys (OpenAI, Anthropic, Copilot) outside the agent; the agent calls the sidecar without credentials and the sidecar injects the real key before forwarding through Squid

The Squid proxy and agent containers are always required and start together. The API proxy sidecar is only started when explicitly enabled.

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
