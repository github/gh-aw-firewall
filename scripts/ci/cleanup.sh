#!/bin/bash
set -e

# cleanup.sh
# Cleans up Docker containers, networks, and temporary files from awf
#
# Usage: ./cleanup.sh

echo "==========================================="
echo "Cleaning up awf resources"
echo "==========================================="

# First, explicitly remove containers by name (handles orphaned containers)
echo "Removing awf containers by name..."
docker rm -f awf-squid awf-agent awf-api-proxy 2>/dev/null || true

# Cleanup diagnostic test containers
echo "Stopping docker compose services..."
docker compose -f /tmp/awf-*/docker-compose.yml down -v 2>/dev/null || true

# Clean up host-level iptables rules
echo "Cleaning up host-level iptables rules..."
# Remove FW_WRAPPER chain references from DOCKER-USER
if iptables -t filter -L DOCKER-USER -n 2>/dev/null | grep -q FW_WRAPPER; then
  echo "  - Removing FW_WRAPPER rules from DOCKER-USER chain..."
  # Find line numbers in reverse order
  iptables -t filter -L DOCKER-USER -n --line-numbers | grep FW_WRAPPER | awk '{print $1}' | sort -rn | while read -r line_num; do
    iptables -t filter -D DOCKER-USER "$line_num" 2>/dev/null || true
  done
fi
# Flush and remove FW_WRAPPER chain
if iptables -t filter -L FW_WRAPPER -n 2>/dev/null; then
  echo "  - Removing FW_WRAPPER chain..."
  iptables -t filter -F FW_WRAPPER 2>/dev/null || true
  iptables -t filter -X FW_WRAPPER 2>/dev/null || true
fi

# Remove awf-net network
echo "Removing awf-net network..."
docker network rm awf-net 2>/dev/null || true

# Prune containers
echo "Pruning unused containers..."
docker container prune -f

# Optionally prune networks to fix "Pool overlaps" errors
echo "Pruning unused networks..."
docker network prune -f

# Remove temporary work directories
echo "Removing temporary work directories..."
rm -rf /tmp/awf-* || true

echo "✓ Cleanup complete"
echo "==========================================="
