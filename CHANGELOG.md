# Changelog

All notable changes to `dsh-cloud-sandbox` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **DSH Plugin Manager Bundle Declaration (`cordis.patch.yml`, `icon.svg`, `locale/*.json`)**:
  - Declared `dsh.bundle.patch` (`./cordis.patch.yml`), `engines.dsh` (`>=0.2.1-rc.2 <1.0.0`), icon, and English/Chinese plugin metadata so `dsh-cloud-sandbox` can be installed directly via DSH's Plugin Manager UI or `dsh plugin add`.
  - Added Cordis live hot-reload service-handoff wrappers (`src/cordis/service-handoff.ts`) so `dsh-cloud-sandbox/subprocess`, `dsh-cloud-sandbox/shell`, and `dsh-cloud-sandbox/fs` cleanly wait for a disposing predecessor service provider (whose `_unload()` is blocked on slow dependents under Cordis 4.x) instead of failing with `service "<name>" has been registered`, while remaining fail-closed against active duplicate providers.
  - Added Schemastery `Config` schema on `DockerSubprocessRuntime` (`dsh-cloud-sandbox/subprocess`) for DSH Settings UI editing, dynamic `ctx.workspaceRegistry` allowlisting (`trustRegisteredWorkspaces`), automatic `:ro` mounting of user Skill directories (`mountUserSkills`), host ripgrep (`rg.exe` / `@vscode/ripgrep`) -> container `rg` translation for `glob`/`grep`, and opt-in user-approved one-shot ephemeral `:ro` host-file mounting (`allowApprovedHostReadOnly`) in `DockerShellExecutor`.
  - Added `dsh-cloud-sandbox/intake` (`src/intake/sandbox-file-intake.ts`): per-session uploaded file staging into `<workspaceRoot>/.dsh-uploads/` (avoiding cross-tenant global `$DSH_HOME/attachments` mounts), plus an interactive `ctx.approval`-gated `sandbox_import_file` tool (disabled under `DSH_SANDBOX_CLOUD_MODE=1`) for copying user-approved non-sensitive local host files safely into the sandbox workspace.
- **Windows + WSL2 Support (`src/workspace/wsl-paths.ts`, `src/docker/wsl-bridge.ts`)**:
  - Multi-transport Docker client (`transport: 'auto' | 'unix' | 'npipe' | 'wsl'`) supporting native Linux Unix sockets, Windows Docker Desktop WSL2 named pipes (`\\.\pipe\docker_engine`), and dependency-free Windows-to-WSL2 `wsl.exe` Unix-socket Duplex bridging (`socat` → `python3` → `node` fallback).
  - Automatic Windows drive (`D:\...`) and WSL UNC (`\\wsl.localhost\<distro>\...`, `\\wsl$\<distro>\...`) path conversion into POSIX container/WSL paths, plus structured `HostConfig.Mounts` on Windows named pipes and strict rejection of non-WSL SMB shares, bare drive roots, `C:\Windows`, and WSL Docker Desktop internal mounts.

## [0.1.0] - 2026-11-24

### Added
- **Workspace Policy (`src/workspace/workspace-policy.ts`)**: Pure directory-based isolation (no user identity) with canonical `realpath` resolution, `allowedBaseDirs` allowlist, symlink-escape rejection, sensitive system path denylist, `:ro` extra/skill mount resolver, and `mirror` / `remap` container path mapping.
- **Two-Tier Fair Concurrency Scheduler (`src/scheduler/fair-scheduler.ts`)**: Separate container-slot pool (`maxActiveContainers` + idle LRU eviction), execution task pool (`maxConcurrentTasks` + `maxConcurrencyPerWorkspace`), per-workspace round-robin fair queuing, dedicated terminal quotas, `maxQueueSize` fast-fail, `queueTimeoutMs`, `AbortSignal` cancellation, and live metrics/events.
- **Linux Docker Engine Socket Client (`src/docker/socket-client.ts`)**: Dependency-free HTTP-over-Unix-Socket (`/var/run/docker.sock`) client with hardened container defaults (`CapDrop: ALL`, `no-new-privileges`, `ReadonlyRootfs`, bounded `/tmp` tmpfs, CPU/memory/PIDs quotas, default `network=none`), Docker multiplexed stdout/stderr frame demuxer, and raw PTY stream support.
- **DSH Output Stream Collector (`src/docker/stream-collector.ts`)**: Implements `@deepseek-ai/dsh-subprocess` offset-based `SubprocessOutputReader` with bounded tail retention and optional spill-file recovery.
- **Shared Container Pool (`src/docker/runtime-pool.ts`)**: Supports both warm per-workspace containers (with idle TTL reaping and automatic crash recovery) and ephemeral per-task containers, plus label-scoped orphan container cleanup on startup/shutdown.
- **DSH Capability Seam Plugins**:
  - `DockerSubprocessRuntime` (`ctx.subprocess`) supporting both standalone DSH and multi-context shared-pool cloud hosts.
  - `DockerShellExecutor` (`ctx.shell`) integrating `ctx.sandboxPolicy` (`read-only` / `workspace-write`) with fail-closed escalation blocking.
  - `WorkspaceFencedFileSystem` (`ctx.fs`) providing strict read+write directory containment for standalone DSH deployments.
- **Default Runtime Image (`Dockerfile`)**: Hardened non-root Debian Bookworm Linux image with `bash`, `git`, `ripgrep`, `python3`, and `nodejs`.
- **Repository Governance & Documentation**: `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE` (Apache-2.0), and comprehensive unit/contract test suite.
