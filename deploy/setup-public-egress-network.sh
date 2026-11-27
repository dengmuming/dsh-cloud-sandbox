#!/usr/bin/env bash
# Provision a hardened Linux Docker bridge network for dsh-cloud-sandbox that:
#   - Allows public Internet egress (for pip3/npm install, git clone, public APIs)
#   - Disables container-to-container east-west communication (enable_icc=false)
#   - Blocks ALL private LAN ranges, cloud metadata (169.254.169.254), loopback,
#     carrier-grade NAT, IPv6 ULA/link-local, and direct access to host ports.
#
# Usage (run as root on the Linux Docker host):
#   sudo bash deploy/setup-public-egress-network.sh
#
# Then launch DSH in cloud mode using:
#   DSH_SANDBOX_CLOUD_MODE=1 DSH_SANDBOX_NETWORK_MODE=dsh-sandbox-public

set -euo pipefail

NETWORK_NAME="${DSH_SANDBOX_PUBLIC_NETWORK:-dsh-sandbox-public}"
BRIDGE_NAME="${DSH_SANDBOX_PUBLIC_BRIDGE:-dsh-sbx-pub}"
SUBNET_V4="${DSH_SANDBOX_PUBLIC_SUBNET:-172.30.0.0/16}"
GATEWAY_V4="${DSH_SANDBOX_PUBLIC_GATEWAY:-172.30.0.1}"
CHAIN_FWD="DSH_SANDBOX_EGRESS"
CHAIN_IN="DSH_SANDBOX_HOST_IN"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "ERROR: please run as root (e.g. sudo bash $0)" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker CLI not found" >&2
  exit 1
fi

if ! command -v iptables >/dev/null 2>&1; then
  echo "ERROR: iptables not found" >&2
  exit 1
fi

# 1. Create dedicated Docker bridge network with ICC (container-to-container) disabled.
if ! docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  docker network create \
    --driver bridge \
    --subnet "$SUBNET_V4" \
    --gateway "$GATEWAY_V4" \
    -o "com.docker.network.bridge.name=$BRIDGE_NAME" \
    -o "com.docker.network.bridge.enable_icc=false" \
    -o "com.docker.network.bridge.enable_ip_masquerade=true" \
    "$NETWORK_NAME"
  echo "Created Docker network: $NETWORK_NAME (bridge=$BRIDGE_NAME, subnet=$SUBNET_V4, icc=false)"
else
  echo "Docker network already exists: $NETWORK_NAME"
fi

# 2. Configure idempotent IPv4 DOCKER-USER egress filter chain (block LAN + metadata, allow public).
iptables -N "$CHAIN_FWD" 2>/dev/null || true
iptables -F "$CHAIN_FWD"

# Allow established return flows.
iptables -A "$CHAIN_FWD" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN

# Block cloud metadata / link-local, loopback, RFC1918 private networks, CGNAT, and multicast.
for cidr in \
  169.254.0.0/16 \
  127.0.0.0/8 \
  10.0.0.0/8 \
  172.16.0.0/12 \
  192.168.0.0/16 \
  100.64.0.0/10 \
  224.0.0.0/4 \
  240.0.0.0/4
do
  iptables -A "$CHAIN_FWD" -d "$cidr" -j DROP
done

# Allow remaining public Internet destinations.
iptables -A "$CHAIN_FWD" -j RETURN

# Hook chain into DOCKER-USER at position 1 (idempotent).
if ! iptables -C DOCKER-USER -i "$BRIDGE_NAME" -j "$CHAIN_FWD" 2>/dev/null; then
  iptables -I DOCKER-USER 1 -i "$BRIDGE_NAME" -j "$CHAIN_FWD"
fi

# 3. Block containers from reaching services listening on the Docker host itself.
iptables -N "$CHAIN_IN" 2>/dev/null || true
iptables -F "$CHAIN_IN"
iptables -A "$CHAIN_IN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
# Permit Docker's embedded DNS resolver on the bridge gateway only if host DNS forwarding is used.
iptables -A "$CHAIN_IN" -d "$GATEWAY_V4" -p udp --dport 53 -j ACCEPT
iptables -A "$CHAIN_IN" -d "$GATEWAY_V4" -p tcp --dport 53 -j ACCEPT
iptables -A "$CHAIN_IN" -j DROP

if ! iptables -C INPUT -i "$BRIDGE_NAME" -j "$CHAIN_IN" 2>/dev/null; then
  iptables -I INPUT 1 -i "$BRIDGE_NAME" -j "$CHAIN_IN"
fi

# 4. Also harden IPv6 if ip6tables is available.
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -N "$CHAIN_FWD" 2>/dev/null || true
  ip6tables -F "$CHAIN_FWD"
  ip6tables -A "$CHAIN_FWD" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  for cidr6 in ::1/128 fc00::/7 fe80::/10 ff00::/8; do
    ip6tables -A "$CHAIN_FWD" -d "$cidr6" -j DROP
  done
  ip6tables -A "$CHAIN_FWD" -j RETURN
  if ip6tables -L DOCKER-USER >/dev/null 2>&1; then
    if ! ip6tables -C DOCKER-USER -i "$BRIDGE_NAME" -j "$CHAIN_FWD" 2>/dev/null; then
      ip6tables -I DOCKER-USER 1 -i "$BRIDGE_NAME" -j "$CHAIN_FWD"
    fi
  fi
fi

echo "Hardened public-egress network ready."
echo "Configure dsh-cloud-sandbox with: DSH_SANDBOX_CLOUD_MODE=1 DSH_SANDBOX_NETWORK_MODE=$NETWORK_NAME"
