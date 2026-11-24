# Security Policy

## Threat Model

`dsh-cloud-sandbox` is designed for cloud deployments where untrusted prompts and user-supplied **Skills** (`SKILL.md` + scripts/resources) execute shell commands, Python/Node scripts, and terminal sessions inside isolated workspaces on a shared Linux host.

### What Is Isolated

- **Arbitrary command & script execution (`ctx.subprocess` / `ctx.shell`)**: Executed inside a hardened Linux Docker container scoped strictly to the resolved `workspaceRoot` and explicitly configured read-only mounts (such as Skill directories).
- **Host filesystem boundary**: Only `workspaceRoot` (under `allowedBaseDirs`) and configured `:ro` mounts are bind-mounted. Sensitive host directories (`/`, `/etc`, `/proc`, `/sys`, `/dev`, `/run`, `/var/run`, `/var/run/docker.sock`) are unconditionally rejected, and symlink traversal is blocked via canonical path resolution.
- **Host secrets & credentials**: Parent environment variables matching `/KEY|PASSWORD|SECRET|TOKEN/i` or `DSH_*` are stripped before container execution.
- **Resource exhaustion & noisy neighbors**: Enforced via Docker cgroups (`NanoCpus`, `Memory`, `MemorySwap`, `PidsLimit`, bounded `/tmp` tmpfs) combined with host-wide container and task concurrency limits and per-workspace fair queuing.
- **Network & SSRF**: Containers default to `NetworkMode: 'none'`. If you opt into a custom Docker bridge network, configure firewall/egress rules to block host interfaces, RFC1918 private networks, and cloud instance metadata (`169.254.169.254`).

### Explicit Non-Goals (Deployment Responsibilities)

- **DSH JavaScript Plugins (`dsh-plugin-manager`)**: Installing third-party npm plugins executes JS inside the DSH Node.js host process itself. Multi-tenant cloud deployments MUST disable plugin installation for unprivileged users and only allow Skill bundles.
- **Docker Daemon Trust Boundary**: The DSH host process requires access to `/var/run/docker.sock` (or a rootless Docker socket). Never mount the Docker socket into any sandbox container, and run the host service under a dedicated unprivileged account where possible (e.g., rootless Docker or hardened socket proxy).
- **Kernel Isolation**: Standard Docker shares the Linux host kernel. For hostile multi-tenant workloads requiring stronger kernel isolation, configure `runtime: 'runsc'` (gVisor) or Kata Containers via the plugin's `security.runtime` option.

## Reporting a Vulnerability

Please do not open public GitHub issues for security vulnerabilities. Report suspected vulnerabilities privately to the repository maintainers with reproduction steps and affected versions.
