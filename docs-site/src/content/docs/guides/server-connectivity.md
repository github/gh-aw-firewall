---
title: Server Connectivity
description: Connect to HTTP, HTTPS, and gRPC servers through the firewall.
---

The firewall controls **outbound** traffic from clients inside awf to external servers. This guide covers connecting to HTTP, HTTPS, and gRPC servers.

## HTTP/HTTPS servers

Clients inside awf can connect to any whitelisted domain over HTTP or HTTPS.

```bash
# Connect to HTTPS server
sudo awf --allow-domains api.example.com -- \
  curl https://api.example.com/data

# Connect to HTTP server (non-TLS)
sudo awf --allow-domains 'http://legacy.example.com' -- \
  curl http://legacy.example.com/api
```

:::tip
Use `https://` or `http://` prefix to restrict a domain to a specific protocol.
:::

## gRPC servers

gRPC connections work through the firewall when using standard ports.

### gRPC over HTTPS (port 443)

```bash
# gRPC with TLS on standard HTTPS port
sudo awf --allow-domains grpc.example.com -- \
  grpcurl grpc.example.com:443 myservice.Service/Method
```

### gRPC-web over HTTP/HTTPS

```bash
# gRPC-web uses standard HTTP/HTTPS ports
sudo awf --allow-domains api.example.com -- \
  grpcurl -plaintext api.example.com:80 myservice.Service/Method
```

:::note
The firewall only allows ports 80 (HTTP) and 443 (HTTPS). Non-standard gRPC ports like 50051 are blocked.
:::

## Connecting to host services

Use `host.docker.internal` to connect from inside awf to services running on your host machine:

```bash
# Connect through Squid to a host listener reachable on the Docker gateway
awf --enable-host-access --allow-host-ports 3000 \
  --allow-domains host.docker.internal -- \
  'curl --noproxy "" --proxy "$HTTP_PROXY" http://host.docker.internal:3000/api'
```

:::tip
`--enable-host-access` installs Docker's `host-gateway` mapping in Squid.
The current CLI also auto-enables host access for an exact `host.docker.internal`
allowlist entry; it is itself a host-access grant. If you see `503 ERR_DNS_FAIL`,
check Squid's `/etc/hosts` mapping and the effective host-access config rather
than relying on upstream DNS to resolve this Docker-only name.
The host listener must not bind only to `127.0.0.1`; in topology mode clients
must use the HTTP proxy because the agent has no direct host route.
:::

For a host-run Docker Compose stack, prefer
[attaching its trusted frontend to `awf-net`](/gh-aw-firewall/guides/playwright-testing#host-run-docker-compose-stack-topology-attachment).
Use its container name and container port while retaining the Compose backend
network; no host-published port is needed.

## Server inside, client outside

To run a server inside awf that accepts external connections, use `--keep-containers` and connect via Docker:

```bash
# Start server inside awf (stays running)
sudo awf --allow-domains example.com --keep-containers -- \
  python3 -m http.server 8080 &

# Connect from host using docker exec
docker exec awf-agent curl http://localhost:8080
```

:::caution
The firewall is designed for egress control. For production server hosting, consider running servers outside the firewall.
:::

## Bidirectional communication

A server that accepts requests and makes outbound calls to whitelisted domains:

```bash
# API gateway that proxies to backend
sudo awf --allow-domains backend.example.com --keep-containers -- \
  node gateway.js

# Gateway can:
# - Accept connections on its internal port
# - Make outbound requests only to backend.example.com
```

## Debugging connectivity

```bash
# Keep containers running for inspection
sudo awf --allow-domains example.com --keep-containers -- sleep 60

# Test connectivity from inside
docker exec awf-agent curl -v https://example.com

# Check Squid logs for blocked requests
sudo grep "TCP_DENIED" /tmp/squid-logs-*/access.log

# View all traffic
awf logs --format pretty
```

## See also

- [Domain Filtering](/gh-aw-firewall/guides/domain-filtering) - Allowlists, blocklists, wildcards
- [CLI Reference](/gh-aw-firewall/reference/cli-reference) - All options
