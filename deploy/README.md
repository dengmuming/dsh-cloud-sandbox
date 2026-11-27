# Cloud Public-Egress Network Setup (No-LAN Bridge)

This directory provides ready-to-use Linux host scripts for running `dsh-cloud-sandbox` in multi-tenant cloud environments where containers need **public Internet access** (for `pip3 install`, `npm install`, `git clone`, public REST APIs) while keeping **internal LAN, cloud metadata, host ports, and peer containers strictly unreachable**.

## What `setup-public-egress-network.sh` Enforces

1. **Dedicated bridge (`dsh-sandbox-public` / `dsh-sbx-pub`)** with `com.docker.network.bridge.enable_icc=false` so containers belonging to different workspaces cannot talk to each other.
2. **`DOCKER-USER` egress firewall** dropping all traffic to:
   - Cloud metadata & link-local (`169.254.0.0/16`, `fe80::/10`)
   - Private RFC1918 LANs (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
   - Carrier-grade NAT (`100.64.0.0/10`) & IPv6 ULA (`fc00::/7`)
   - Loopback (`127.0.0.0/8`, `::1/128`) & multicast/reserved ranges
3. **Host `INPUT` isolation** dropping connections from containers to services listening on the Docker host (allowing only DNS on the bridge gateway).
4. **Public Internet allowed** for all remaining public destinations.

## Usage

```bash
# 1. Provision the network and iptables rules on your Linux cloud host
sudo bash deploy/setup-public-egress-network.sh

# 2. Launch DSH in cloud lockdown mode pointing at the hardened network
export DSH_SANDBOX_CLOUD_MODE=1
export DSH_SANDBOX_ALLOWED_DIRS=/srv/dsh/workspaces
export DSH_SANDBOX_NETWORK_MODE=dsh-sandbox-public
```

Or in programmatic `createDockerRuntimePool(...)`:

```ts
const dockerPool = createDockerRuntimePool({
  image: 'dsh-cloud-sandbox-runtime:latest',
  workspace: { allowedBaseDirs: ['/srv/dsh/workspaces'] },
  security: {
    networkMode: 'dsh-sandbox-public',
    tmpfsSizeMb: 512,
  },
})
```

> **Persistence note**: `iptables` rules do not persist across host reboots automatically. Persist them with `iptables-persistent` / `netfilter-persistent save` or invoke `setup-public-egress-network.sh` from a systemd oneshot unit before DSH starts.

## Teardown

```bash
sudo bash deploy/teardown-public-egress-network.sh
```
