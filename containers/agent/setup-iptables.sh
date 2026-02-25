#!/bin/bash
set -e

echo "[iptables] Setting up NAT redirection to Squid proxy..."
echo "[iptables] NOTE: Host-level DOCKER-USER chain handles egress filtering for all containers on this network"

# Function to check if an IP address is IPv6
is_ipv6() {
  local ip="$1"
  # Check if it contains a colon (IPv6 addresses always contain colons)
  [[ "$ip" == *:* ]]
}

# Function to validate an IPv4 address format (e.g., 172.17.0.1)
is_valid_ipv4() {
  local ip="$1"
  echo "$ip" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
}

# Function to check if ip6tables is available and functional
has_ip6tables() {
  if command -v ip6tables &>/dev/null && ip6tables -L -n &>/dev/null; then
    return 0
  else
    return 1
  fi
}

# Check ip6tables availability once at the start
IP6TABLES_AVAILABLE=false
if has_ip6tables; then
  IP6TABLES_AVAILABLE=true
  echo "[iptables] ip6tables is available"
else
  echo "[iptables] WARNING: ip6tables is not available, IPv6 rules will be skipped"
fi

# Get Squid proxy configuration from environment
SQUID_HOST="${SQUID_PROXY_HOST:-squid-proxy}"
SQUID_PORT="${SQUID_PROXY_PORT:-3128}"

echo "[iptables] Squid proxy: ${SQUID_HOST}:${SQUID_PORT}"

# Resolve Squid hostname to IP
# Use awk's NR to get first line to avoid host binary dependency in chroot mode
SQUID_IP=$(getent hosts "$SQUID_HOST" | awk 'NR==1 { print $1 }')
if [ -z "$SQUID_IP" ]; then
  echo "[iptables] ERROR: Could not resolve Squid proxy hostname: $SQUID_HOST"
  exit 1
fi
echo "[iptables] Squid IP resolved to: $SQUID_IP"

# Clear existing NAT rules (both IPv4 and IPv6)
iptables -t nat -F OUTPUT 2>/dev/null || true
if [ "$IP6TABLES_AVAILABLE" = true ]; then
  ip6tables -t nat -F OUTPUT 2>/dev/null || true
fi

# Allow localhost traffic (for stdio MCP servers)
echo "[iptables] Allow localhost traffic..."
iptables -t nat -A OUTPUT -o lo -j RETURN
iptables -t nat -A OUTPUT -d 127.0.0.0/8 -j RETURN
if [ "$IP6TABLES_AVAILABLE" = true ]; then
  ip6tables -t nat -A OUTPUT -o lo -j RETURN
  ip6tables -t nat -A OUTPUT -d ::1/128 -j RETURN
fi

# Bypass Squid for traffic to the container's own IP.
# Test frameworks often bind servers to 0.0.0.0 and connect via the non-loopback IP
# (e.g., 172.30.0.20). Without this rule, the DNAT redirect rules catch self-directed
# traffic and route it through Squid, which denies it with 403.
AGENT_IP=$(ip -4 addr show eth0 2>/dev/null | awk '/inet / { split($2,a,"/"); print a[1]; exit }')
if [ -n "$AGENT_IP" ] && is_valid_ipv4 "$AGENT_IP"; then
  echo "[iptables] Bypass Squid for self-directed traffic (agent IP: ${AGENT_IP})..."
  iptables -t nat -A OUTPUT -d "$AGENT_IP" -j RETURN
  iptables -A OUTPUT -p tcp -d "$AGENT_IP" -j ACCEPT
fi

# Get DNS servers from environment (default to Google DNS)
DNS_SERVERS="${AWF_DNS_SERVERS:-8.8.8.8,8.8.4.4}"
echo "[iptables] Configuring DNS rules for trusted servers: $DNS_SERVERS"

# Separate IPv4 and IPv6 DNS servers
IPV4_DNS_SERVERS=()
IPV6_DNS_SERVERS=()
IFS=',' read -ra DNS_ARRAY <<< "$DNS_SERVERS"
for dns_server in "${DNS_ARRAY[@]}"; do
  dns_server=$(echo "$dns_server" | tr -d ' ')
  if [ -n "$dns_server" ]; then
    if is_ipv6 "$dns_server"; then
      IPV6_DNS_SERVERS+=("$dns_server")
    else
      IPV4_DNS_SERVERS+=("$dns_server")
    fi
  fi
done

echo "[iptables]   IPv4 DNS servers: ${IPV4_DNS_SERVERS[*]:-none}"
echo "[iptables]   IPv6 DNS servers: ${IPV6_DNS_SERVERS[*]:-none}"

# Allow DNS queries ONLY to trusted IPv4 DNS servers (prevents DNS exfiltration)
for dns_server in "${IPV4_DNS_SERVERS[@]}"; do
  echo "[iptables] Allow DNS to trusted IPv4 server: $dns_server"
  iptables -t nat -A OUTPUT -p udp -d "$dns_server" --dport 53 -j RETURN
  iptables -t nat -A OUTPUT -p tcp -d "$dns_server" --dport 53 -j RETURN
done

# Allow DNS queries ONLY to trusted IPv6 DNS servers
if [ "$IP6TABLES_AVAILABLE" = true ]; then
  for dns_server in "${IPV6_DNS_SERVERS[@]}"; do
    echo "[iptables] Allow DNS to trusted IPv6 server: $dns_server"
    ip6tables -t nat -A OUTPUT -p udp -d "$dns_server" --dport 53 -j RETURN
    ip6tables -t nat -A OUTPUT -p tcp -d "$dns_server" --dport 53 -j RETURN
  done
elif [ ${#IPV6_DNS_SERVERS[@]} -gt 0 ]; then
  echo "[iptables] WARNING: IPv6 DNS servers configured but ip6tables not available"
fi

# Allow DNS to Docker's embedded DNS server (127.0.0.11) for container name resolution
echo "[iptables] Allow DNS to Docker embedded DNS (127.0.0.11)..."
iptables -t nat -A OUTPUT -p udp -d 127.0.0.11 --dport 53 -j RETURN
iptables -t nat -A OUTPUT -p tcp -d 127.0.0.11 --dport 53 -j RETURN

# Allow return traffic to trusted IPv4 DNS servers
echo "[iptables] Allow traffic to trusted DNS servers..."
for dns_server in "${IPV4_DNS_SERVERS[@]}"; do
  iptables -t nat -A OUTPUT -d "$dns_server" -j RETURN
done

# Allow return traffic to trusted IPv6 DNS servers
if [ "$IP6TABLES_AVAILABLE" = true ]; then
  for dns_server in "${IPV6_DNS_SERVERS[@]}"; do
    ip6tables -t nat -A OUTPUT -d "$dns_server" -j RETURN
  done
fi

# Allow traffic to Squid proxy itself (prevent redirect loop)
echo "[iptables] Allow traffic to Squid proxy (${SQUID_IP}:${SQUID_PORT})..."
iptables -t nat -A OUTPUT -d "$SQUID_IP" -j RETURN

# Note: API auth proxy traffic to Squid IP on ports 10000-10002 is already allowed
# by the rule above (iptables -t nat -A OUTPUT -d "$SQUID_IP" -j RETURN)

# Bypass Squid for host.docker.internal when host access is enabled.
# MCP gateway traffic to host.docker.internal gets DNAT'd to Squid,
# where Squid fails with "Invalid URL" because rmcp sends relative URLs.
# The NAT RETURN prevents DNAT to Squid (which would crash on MCP traffic).
# The FILTER ACCEPT is restricted to allowed ports only (80, 443, and --allow-host-ports).
if [ -n "$AWF_ENABLE_HOST_ACCESS" ]; then
  HOST_GATEWAY_IP=$(getent hosts host.docker.internal | awk 'NR==1 { print $1 }')
  if [ -n "$HOST_GATEWAY_IP" ] && is_valid_ipv4 "$HOST_GATEWAY_IP"; then
    echo "[iptables] Allow direct traffic to host gateway (${HOST_GATEWAY_IP}) - bypassing Squid..."
    # NAT: skip DNAT to Squid for all traffic to host gateway (prevents Squid crash)
    iptables -t nat -A OUTPUT -d "$HOST_GATEWAY_IP" -j RETURN
    # FILTER: only allow standard ports (80, 443) to host gateway
    iptables -A OUTPUT -p tcp -d "$HOST_GATEWAY_IP" --dport 80 -j ACCEPT
    iptables -A OUTPUT -p tcp -d "$HOST_GATEWAY_IP" --dport 443 -j ACCEPT
    # FILTER: also allow user-specified ports from --allow-host-ports
    if [ -n "$AWF_ALLOW_HOST_PORTS" ]; then
      IFS=',' read -ra HOST_PORTS <<< "$AWF_ALLOW_HOST_PORTS"
      for port_spec in "${HOST_PORTS[@]}"; do
        port_spec=$(echo "$port_spec" | xargs)
        echo "[iptables]   Allow host gateway port $port_spec"
        iptables -A OUTPUT -p tcp -d "$HOST_GATEWAY_IP" --dport "$port_spec" -j ACCEPT
      done
    fi
  elif [ -n "$HOST_GATEWAY_IP" ]; then
    echo "[iptables] WARNING: host.docker.internal resolved to invalid IP '${HOST_GATEWAY_IP}', skipping host gateway bypass"
  else
    echo "[iptables] WARNING: host.docker.internal could not be resolved, skipping host gateway bypass"
  fi

  # Also bypass Squid for the container's default network gateway.
  # Codex resolves host.docker.internal to this IP (172.30.0.1 on the AWF network)
  # instead of the Docker bridge gateway (172.17.0.1). Without this bypass,
  # MCP Streamable HTTP traffic goes through Squid, which crashes on SSE connections.
  NETWORK_GATEWAY_IP=$(route -n 2>/dev/null | awk '/^0\.0\.0\.0/ { print $2; exit }')
  if [ -n "$NETWORK_GATEWAY_IP" ] && is_valid_ipv4 "$NETWORK_GATEWAY_IP" && [ "$NETWORK_GATEWAY_IP" != "$HOST_GATEWAY_IP" ]; then
    echo "[iptables] Allow direct traffic to network gateway (${NETWORK_GATEWAY_IP}) - bypassing Squid..."
    iptables -t nat -A OUTPUT -d "$NETWORK_GATEWAY_IP" -j RETURN
    iptables -A OUTPUT -p tcp -d "$NETWORK_GATEWAY_IP" --dport 80 -j ACCEPT
    iptables -A OUTPUT -p tcp -d "$NETWORK_GATEWAY_IP" --dport 443 -j ACCEPT
    if [ -n "$AWF_ALLOW_HOST_PORTS" ]; then
      IFS=',' read -ra NET_GW_PORTS <<< "$AWF_ALLOW_HOST_PORTS"
      for port_spec in "${NET_GW_PORTS[@]}"; do
        port_spec=$(echo "$port_spec" | xargs)
        iptables -A OUTPUT -p tcp -d "$NETWORK_GATEWAY_IP" --dport "$port_spec" -j ACCEPT
      done
    fi
  elif [ -n "$NETWORK_GATEWAY_IP" ] && ! is_valid_ipv4 "$NETWORK_GATEWAY_IP"; then
    echo "[iptables] WARNING: network gateway resolved to invalid IP '${NETWORK_GATEWAY_IP}', skipping"
  fi
fi

# Block dangerous ports at NAT level (defense-in-depth with Squid ACL filtering)
# These ports are explicitly blocked to prevent access to sensitive services
# even if Squid ACL filtering fails. The ports RETURN from NAT (not redirected)
# and are then blocked by the DROP rule in the OUTPUT filter chain.
echo "[iptables] Configuring NAT blacklist for dangerous ports..."

# Dangerous ports list - matches DANGEROUS_PORTS in squid-config.ts
DANGEROUS_PORTS=(
  22      # SSH
  23      # Telnet
  25      # SMTP (mail)
  110     # POP3 (mail)
  143     # IMAP (mail)
  445     # SMB (file sharing)
  1433    # MS SQL Server
  1521    # Oracle DB
  3306    # MySQL
  3389    # RDP (Windows Remote Desktop)
  5432    # PostgreSQL
  6379    # Redis
  27017   # MongoDB
  27018   # MongoDB sharding
  28017   # MongoDB web interface
)

# Add NAT RETURN rules for each dangerous port
# This prevents these ports from being redirected to Squid
# They will be dropped by the OUTPUT filter chain's final DROP rule
for port in "${DANGEROUS_PORTS[@]}"; do
  iptables -t nat -A OUTPUT -p tcp --dport "$port" -j RETURN
done
echo "[iptables] NAT blacklist applied for ${#DANGEROUS_PORTS[@]} dangerous ports"

# Redirect standard HTTP/HTTPS ports to Squid
# This provides defense-in-depth: iptables enforces port policy, Squid enforces domain policy
echo "[iptables] Redirect HTTP (80) and HTTPS (443) to Squid..."
iptables -t nat -A OUTPUT -p tcp --dport 80 -j DNAT --to-destination "${SQUID_IP}:${SQUID_PORT}"
iptables -t nat -A OUTPUT -p tcp --dport 443 -j DNAT --to-destination "${SQUID_IP}:${SQUID_PORT}"

# If user specified additional ports via --allow-host-ports, redirect those too
if [ -n "$AWF_ALLOW_HOST_PORTS" ]; then
  echo "[iptables] Redirect user-specified ports to Squid..."

  # Parse comma-separated port list
  IFS=',' read -ra PORTS <<< "$AWF_ALLOW_HOST_PORTS"

  for port_spec in "${PORTS[@]}"; do
    # Remove leading/trailing spaces
    port_spec=$(echo "$port_spec" | xargs)

    if [[ $port_spec == *"-"* ]]; then
      # Port range (e.g., "3000-3010")
      echo "[iptables]   Redirect port range $port_spec to Squid..."
      # For port ranges, use --dport with range syntax (without multiport)
      iptables -t nat -A OUTPUT -p tcp --dport "$port_spec" -j DNAT --to-destination "${SQUID_IP}:${SQUID_PORT}"
    else
      # Single port (e.g., "3000")
      echo "[iptables]   Redirect port $port_spec to Squid..."
      iptables -t nat -A OUTPUT -p tcp --dport "$port_spec" -j DNAT --to-destination "${SQUID_IP}:${SQUID_PORT}"
    fi
  done
else
  echo "[iptables] No additional ports specified (only 80, 443 allowed)"
fi

# OUTPUT filter chain rules (defense-in-depth with NAT rules)
# These rules apply AFTER NAT translation
echo "[iptables] Configuring OUTPUT filter chain rules..."

# Allow localhost traffic
iptables -A OUTPUT -o lo -j ACCEPT

# Allow DNS queries to trusted servers
for dns_server in "${IPV4_DNS_SERVERS[@]}"; do
  iptables -A OUTPUT -p udp -d "$dns_server" --dport 53 -j ACCEPT
  iptables -A OUTPUT -p tcp -d "$dns_server" --dport 53 -j ACCEPT
done

# Allow DNS to Docker's embedded DNS server
iptables -A OUTPUT -p udp -d 127.0.0.11 --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp -d 127.0.0.11 --dport 53 -j ACCEPT

# Allow traffic to Squid proxy (after NAT redirection)
iptables -A OUTPUT -p tcp -d "$SQUID_IP" -j ACCEPT

# Note: API auth proxy traffic to Squid IP on ports 10000-10002 is already allowed
# by the rule above (iptables -A OUTPUT -p tcp -d "$SQUID_IP" -j ACCEPT)

# Drop all other TCP traffic (default deny policy)
# This ensures that only explicitly allowed ports can be accessed
echo "[iptables] Drop all non-redirected TCP traffic (default deny)..."
iptables -A OUTPUT -p tcp -j DROP

echo "[iptables] NAT rules applied successfully"
echo "[iptables] Current IPv4 NAT OUTPUT rules:"
iptables -t nat -L OUTPUT -n -v
if [ "$IP6TABLES_AVAILABLE" = true ]; then
  echo "[iptables] Current IPv6 NAT OUTPUT rules:"
  ip6tables -t nat -L OUTPUT -n -v
else
  echo "[iptables] (ip6tables NAT not available)"
fi
