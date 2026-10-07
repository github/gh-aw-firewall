---
title: Playwright Testing with Local Services
description: Test in-sandbox servers, host services, and Docker Compose stacks through the firewall
---

Choose the address according to where the server runs:

| Server location | Browser URL |
| --- | --- |
| Same agent sandbox as Playwright | `http://127.0.0.1:3000` |
| Host-run Compose container attached to `awf-net` | `http://awf-compose-web:80` (container name and container port) |
| Runner host, with host access enabled | `http://host.docker.internal:3000` (host port, through Squid in topology mode) |

`localhost` inside the browser is the **sandbox's loopback**, not the runner's.
The standalone AWF CLI's `--allow-domains localhost` keyword configures host
access; it does **not** rewrite `page.goto()` URLs or Playwright's `baseURL`.
For gh-aw's usual in-sandbox development server, use loopback without enabling
host access.

## Host-run Docker Compose stack (topology attachment)

Attach only the trusted frontend container, not the whole stack. AWF adds a
second interface on `awf-net`; the frontend keeps its original Compose network
and can still reach its backend services there. The agent does not join the
Compose network. This recipe uses the Compose-managed Docker agent runtime,
not a microVM runtime.

Start this minimal stack **on the runner host before AWF starts**:

```yaml
# compose.yml
services:
  web:
    image: nginx:stable-alpine
    container_name: awf-compose-web
```

```bash
docker compose -f compose.yml up -d --wait
```

No published host port is needed. In an existing stack, give the frontend a
stable `container_name` and leave its Compose networks and backend configuration
unchanged. It must listen on its container interface (for example `0.0.0.0:80`),
not only its own loopback. Containers using `network_mode: host` or `none` cannot
be attached this way.

Prepare Playwright and its browser before entering the sandbox. For a project
with `@playwright/test` already installed, add:

```typescript
// tests/compose.spec.ts
import { test, expect } from '@playwright/test';

test('host-run frontend is reachable', async ({ page }) => {
  await page.goto('http://awf-compose-web:80');
  await expect(page).toHaveTitle('Welcome to nginx!');
});
```

```bash
awf --network-isolation \
  --topology-attach awf-compose-web \
  --allow-domains awf-compose-web \
  -- npx playwright test tests/compose.spec.ts

# After AWF exits, remove the host-run stack.
docker compose -f compose.yml down
```

Use the **Docker container name**, not the Compose service key (`web`) or a
host-published port. AWF attaches the existing container after creating
`awf-net` and installs its name-to-IP mapping in both the agent's chroot hosts
file and Squid's hosts file. Prefer the name over the dynamically assigned
`awf-net` IP; do not use the container's Compose-network IP. While AWF is running,
inspect the address with:

```bash
docker inspect --format '{{(index .NetworkSettings.Networks "awf-net").IPAddress}}' awf-compose-web
```

Keep the frontend name in the allowlist, including any additional browser-visible
asset/API names. In current AWF, attached peer names are also automatically
included in `NO_PROXY` and trusted Squid peer rules, so both direct clients and
clients that ignore `NO_PROXY` can reach them. Those peer rules permit **any
port**; `--allow-host-ports` does not restrict an attached peer. Attachment is a
trust grant, not a domain/port-isolated tunnel.

This is a **standalone AWF CLI** recipe. Its configuration file is:

```yaml
network:
  isolation: true
  topologyAttach: [awf-compose-web]
  allowDomains: [awf-compose-web]
```

The current gh-aw compiler-launched AWF handoff does not support arbitrary
`topologyAttach` entries: it attaches its managed peers (such as `awmg-mcpg` and
`awmg-cli-proxy`) and provides no workflow field for `awf-compose-web`. Starting
the stack in a host-side `steps:` block does not make it available to that AWF
run. Use this recipe only when the standalone AWF CLI consumes the configuration
directly; gh-aw needs compiler support for arbitrary attachments first.

:::caution
Only attach a frontend you trust. A dual-homed container can reach the agent
network, its Compose backends, and potentially the internet independently of
AWF. An arbitrary forward proxy, SSRF endpoint, or compromised frontend can
therefore become a firewall bypass. Do not execute untrusted PR-controlled
Compose files, images, entrypoints, or builds in privileged host steps with
secrets or the Docker socket. Use reviewed infrastructure and disposable test
data, and expose no generic forwarding endpoint. Keep the agent firewall
enabled: `sandbox.agent: false` removes its protection rather than fixing
connectivity.
:::

## Quick Start: Host Development Server

For a host development server, configure Playwright's URL and browser proxy
explicitly (the remaining host-access examples use this configuration):

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: {
    baseURL: 'http://host.docker.internal:3000',
    proxy: { server: process.env.HTTP_PROXY! },
  },
});
```

```bash
# Start your dev server on the host, listening on a Docker-reachable interface
# (e.g., npm run dev -- --host 0.0.0.0 on port 3000)

# Run Playwright tests through the firewall
sudo awf --allow-domains localhost,playwright.dev -- npx playwright test
```

The `localhost` keyword configures AWF's host mapping and development ports.
Tests can then navigate using relative paths such as `page.goto('/')`.

## What the localhost Keyword Does

When you include `localhost` in `--allow-domains`, awf automatically:

1. **Enables host access** - Activates `--enable-host-access` flag
2. **Maps the allowlist entry to host.docker.internal** - Does not rewrite browser URLs
3. **Allows development ports** - Opens common dev ports: 3000, 3001, 4000, 4200, 5000, 5173, 8000, 8080, 8081, 8888, 9000, 9090

Your tests must use `http://host.docker.internal:<port>` to reach the host.
The server must listen on an address reachable from Docker, not only `127.0.0.1`.

## Protocol Prefixes

The `localhost` keyword preserves HTTP/HTTPS protocol prefixes:

```bash
# HTTP only
sudo awf --allow-domains http://localhost -- npx playwright test

# HTTPS only
sudo awf --allow-domains https://localhost -- npx playwright test

# Both HTTP and HTTPS (default)
sudo awf --allow-domains localhost -- npx playwright test
```

## Custom Port Configuration

Override the default port list with `--allow-host-ports`:

```bash
# Allow only specific ports
sudo awf \
  --allow-domains localhost \
  --allow-host-ports 3000,8080 \
  -- npx playwright test

# Allow a port range
sudo awf \
  --allow-domains localhost \
  --allow-host-ports 3000,8080-8090 \
  -- npx playwright test
```

:::note
Port ranges must avoid dangerous ports (SSH, databases, etc.). See the [security model](/gh-aw-firewall/concepts/security-model) for details.
:::

## Example: Testing a Next.js App

```bash
# Terminal 1: Start Next.js dev server
npm run dev
# Server runs on http://localhost:3000

# Terminal 2: Run Playwright tests through firewall
sudo awf \
  --allow-domains localhost,vercel.app,next.js.org \
  -- npx playwright test
```

Set Playwright's `baseURL` to `http://host.docker.internal:3000`; the tests can
also fetch from `vercel.app` and `next.js.org`.

## Example: Testing a React App with External APIs

```bash
# Start React dev server on port 3000
npm start

# Run tests with access to localhost and external APIs
sudo awf \
  --allow-domains localhost,api.github.com,cdn.example.com \
  -- npx playwright test
```

## Without the localhost Keyword

Before the `localhost` keyword, you had to manually configure host access:

```bash
# Old way (still works)
sudo awf \
  --enable-host-access \
  --allow-domains host.docker.internal \
  --allow-host-ports 3000,8080 \
  -- npx playwright test
```

The `localhost` keyword eliminates this boilerplate.

## Security Considerations

:::caution
The `localhost` keyword enables access to services running on your host machine. Only use it for trusted workloads like local testing and development.
:::

When `localhost` is specified:
- Containers can access ANY service on the specified ports on your host machine
- This includes local databases, development servers, and other services
- This is safe for local development but should not be used in production

## Troubleshooting

### "Connection refused" errors

If Playwright can't connect to your local server:

1. **Verify server is running:** Check that your dev server is actually running on the host
2. **Check the port:** Ensure the port is in the allowed list (default: 3000, 3001, 4000, 4200, 5000, 5173, 8000, 8080, 8081, 8888, 9000, 9090)
3. **Use custom ports:** If using a different port, specify it with `--allow-host-ports`

### "Host not found" errors

If you see DNS resolution errors:

- Use the attached container name for a Compose frontend, or
  `host.docker.internal` for a host service, not the browser's `localhost`.
- For `503 ERR_DNS_FAIL` from Squid on `host.docker.internal`, enable
  `--enable-host-access` and verify the effective config and Squid's `/etc/hosts`.
  This flag adds Docker's `host-gateway` mapping, which Squid consults before
  upstream DNS. The current CLI also auto-enables host access for an exact
  `host.docker.internal` allowlist entry (with or without an HTTP/HTTPS prefix)
  or its `localhost` keyword. Those entries are themselves host-access grants;
  only `localhost` also supplies default development ports. Upstream DNS cannot
  resolve the Docker-only hostname.
- Specify the host-published port with `--allow-host-ports` and allow
  `host.docker.internal`. In topology mode, the agent has no direct host route;
  the HTTP client/browser must use Squid. For Playwright Test, explicitly
  configure `use.proxy: { server: process.env.HTTP_PROXY! }` for this host-service
  path; proxy environment variables alone are not a browser proxy configuration.
  A loopback-only published port such as `127.0.0.1:8080:80` is not reachable via
  the host gateway. Prefer topology attachment instead of broadening host exposure.
- On ARC/DinD, `host-gateway` refers to the Docker daemon's host, not necessarily
  the runner container. Start and attach the Compose stack on the same daemon
  AWF uses.

### Server binds to 127.0.0.1 only

Some dev servers bind only to 127.0.0.1. To make them accessible from Docker containers:

```bash
# Bind to 0.0.0.0 instead of 127.0.0.1
npm run dev -- --host 0.0.0.0

# Or for Vite/Vue
npm run dev -- --host

# Or for Next.js
npm run dev -- -H 0.0.0.0
```

## See Also

- [Server Connectivity](/gh-aw-firewall/guides/server-connectivity) - Connecting to HTTP, HTTPS, and gRPC servers
- [Security Model](/gh-aw-firewall/concepts/security-model) - Understanding the firewall's security guarantees
- [CLI Reference](/gh-aw-firewall/reference/cli-reference) - All command-line options
