#!/usr/bin/env bash
# Remove the iptables rules and Docker network created by setup-public-egress-network.sh.

set -euo pipefail

NETWORK_NAME="${DSH_SANDBOX_PUBLIC_NETWORK:-dsh-sandbox-public}"
BRIDGE_NAME="${DSH_SANDBOX_PUBLIC_BRIDGE:-dsh-sbx-pub}"
CHAIN_FWD="DSH_SANDBOX_EGRESS"
CHAIN_IN="DSH_SANDBOX_HOST_IN"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "ERROR: please run as root (e.g. sudo bash $0)" >&2
  exit 1
fi

if command -v iptables >/dev/null 2>&1; then
  while iptables -C DOCKER-USER -i "$BRIDGE_NAME" -j "$CHAIN_FWD" 2>/dev/null; do
    iptables -D DOCKER-USER -i "$BRIDGE_NAME" -j "$CHAIN_FWD"
  done
  iptables -F "$CHAIN_FWD" 2>/dev/null || true
  iptables -X "$CHAIN_FWD" 2>/dev/null || true

  while iptables -C INPUT -i "$BRIDGE_NAME" -j "$CHAIN_IN" 2>/dev/null; do
    iptables -D INPUT -i "$BRIDGE_NAME" -j "$CHAIN_IN"
  done
  iptables -F "$CHAIN_IN" 2>/dev/null || true
  iptables -X "$CHAIN_IN" 2>/dev/null || true
fi

if command -v ip6tables >/dev/null 2>&1; then
  while ip6tables -C DOCKER-USER -i "$BRIDGE_NAME" -j "$CHAIN_FWD" 2>/dev/null; do
    ip6tables -D DOCKER-USER -i "$BRIDGE_NAME" -j "$CHAIN_FWD"
  done
  ip6tables -F "$CHAIN_FWD" 2>/dev/null || true
  ip6tables -X "$CHAIN_FWD" 2>/dev/null || true
fi

if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  docker network rm "$NETWORK_NAME"
fi

echo "Removed network $NETWORK_NAME and associated firewall rules."
