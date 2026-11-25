# AGENTS.md

Engineering guide for AI coding agents and human contributors working on `dsh-cloud-sandbox`.

## Project Identity

`dsh-cloud-sandbox` is a standalone, user-agnostic Linux Docker execution-sandbox plugin for **DeepSeek Harness (`@deepseek-ai/dsh`)** (`>=0.2.1-rc.2`).

Its single responsibility is to isolate agent subprocesses, terminals, and workspace-scoped file access inside hardened Linux Docker containers while enforcing host-wide concurrency limits and per-workspace fair queuing for multi-tenant cloud deployments.

## Non-Negotiable Architectural Invariants

1. **Zero User Identity Inside This Module**
   - This package MUST NEVER model user IDs, accounts, sessions, auth tokens, or tenant tables.
   - The sole isolation unit is a canonicalized working directory (`workspaceRoot`) and its deterministic digest (`workspaceId = sha256(canonicalPath)`).
   - Upper-layer multi-tenant cloud hosts own authentication and directory allocation; they share one `DockerRuntimePool` across multiple isolated Cordis `Context` instances.

2. **DSH Capability Seam First**
   - Implement upstream DSH contracts directly (`@deepseek-ai/dsh-subprocess`, `@deepseek-ai/dsh-shell`, `@deepseek-ai/dsh-fs`, `@deepseek-ai/dsh-sandbox-policy`).
   - Do NOT fork or copy DSH internal logic when a capability seam exists.
   - Keep `@deepseek-ai/*` packages in `peerDependencies` so the plugin works cleanly with both upstream `@deepseek-ai/dsh` (`0.2.2-rc.5+`) and custom forks (`0.2.1-rc.2+`).

3. **Fail-Closed Security Boundary**
   - Never silently fall back to host execution when Docker is unavailable or when a path violates workspace policy.
   - Every container MUST be created with:
     - `CapDrop: ['ALL']`
     - `SecurityOpt: ['no-new-privileges:true']`
     - `ReadonlyRootfs: true` + bounded `Tmpfs` for `/tmp`
     - Non-root `User`
     - `NetworkMode: 'none'` by default (explicit opt-in required for custom networks)
     - Explicit `NanoCpus`, `Memory`, `MemorySwap`, and `PidsLimit`
   - Never mount sensitive host system directories (`/`, `/etc`, `/proc`, `/sys`, `/dev`, `/run`, `/var/run`) or `/var/run/docker.sock`.
   - Always scrub host credentials (`KEY|PASSWORD|SECRET|TOKEN` and `DSH_*`) before passing environment variables into a container.
   - Skill directories mounted via `readOnlyMounts` / `resolveReadOnlyMounts` MUST always be mounted `:ro`.

4. **Fair Multi-Tenant Scheduling**
   - Container slots (`maxActiveContainers`) and execution task slots (`maxConcurrentTasks` / `maxConcurrencyPerWorkspace`) are strictly separated.
   - Interactive PTY terminals (`spawnTerminal`) use dedicated terminal quotas and MUST NOT starve short-lived `exec` tasks.
   - Waiting queues MUST schedule round-robin across `workspaceId` (fair queuing), never pure FIFO that lets one noisy workspace starve others.
   - `AbortSignal` cancellation MUST remove queued waiters immediately and release acquired slots without leaks.

5. **Zero External Runtime Dependencies**
   - Communicate with Docker Engine over Linux Unix socket (`/var/run/docker.sock`), Windows Docker Desktop named pipe (`\\.\pipe\docker_engine`), or Windows-to-WSL2 `wsl.exe` Duplex socket bridge using Node.js built-ins (`node:http`, `node:child_process`, `node:stream`).
   - Keep the production dependency footprint minimal and auditable.

## Repository Layout

```text
src/
  types.ts                      Public config, mount, security, WSL, metrics, and error contracts
  workspace/
    workspace-policy.ts         Canonicalization, allowedBaseDirs allowlist, symlink guard, path mapping
    wsl-paths.ts                Windows drive / WSL UNC <-> WSL2 POSIX path conversion & denylist
  scheduler/
    fair-scheduler.ts           Two-tier container/task scheduler, per-workspace fair queue, LRU eviction
  docker/
    socket-client.ts            Native HTTP-over-Socket/NPipe/WSL Docker Engine API + stream demuxer
    wsl-bridge.ts               Dependency-free Windows -> WSL2 Unix-socket Duplex bridge via wsl.exe
    stream-collector.ts         DSH SubprocessOutputReader (bounded tail ring + optional spill file)
    runtime-pool.ts             DockerRuntimePool orchestrating containers, exec, PTY, TTL, orphan sweep
  cordis/
    service-handoff.ts          Cordis live hot-reload service handoff helper
  subprocess/
    docker-subprocess.ts        ctx.subprocess provider (extends @deepseek-ai/dsh-subprocess)
  shell/
    docker-shell.ts             Optional ctx.shell executor enforcing sandboxPolicy without escalation
  fs/
    workspace-fenced-fs.ts      Optional ctx.fs strict read+write workspace fence for vanilla DSH
  intake/
    sandbox-file-intake.ts      Per-session attachment staging + approval-gated host file import tool
  index.ts                      Cordis plugin exports & shared pool factory
tests/                          Unit and contract tests (runs on any OS via mock DockerClient)
Dockerfile                      Default hardened Debian Linux sandbox runtime image
```

## Development Commands

```bash
pnpm install        # Install dev/peer tooling
pnpm run typecheck  # Strict TypeScript check across src/ and tests/
pnpm run test       # Run Vitest unit & DSH seam contract tests
pnpm run build      # Emit ESM JS + .d.ts to dist/
pnpm run check      # Full verification: typecheck + test + build
```

## Coding & Contribution Rules

- TypeScript ESM (`NodeNext`), strict mode with `noUncheckedIndexedAccess` and `noImplicitOverride`.
- Keep modules cleanly separated so `scheduler/` and `workspace/` remain 100% unit-testable without a live Docker daemon.
- Every change to scheduling, path validation, or Docker security flags MUST include regression tests.
- Update `CHANGELOG.md` under `[Unreleased]` for all user-visible behavior or API changes.
- Keep secrets, real credentials, and host-specific absolute paths out of source files and test fixtures.
