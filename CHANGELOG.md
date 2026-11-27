# Changelog

All notable changes to `dsh-cloud-sandbox` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Distribute compiled plugins through npm and GitHub Release archives only; remove the precompiled `dist` branch and `dist-v*` tags. Select the latest stable release from published GitHub Releases without depending on Git build refs.

### Fixed
- Allow up to five minutes for npm registry processing before failing public-release verification.

## [0.2.3] - 2026-11-27

### Fixed
- Wait for the exact npm version, `latest` tag, and downloadable archive to match the GitHub Release before reporting successful publication; bypass stale registry responses during verification and retry checks.

## [0.2.2] - 2026-11-27

### Added
- Public package repository, author, homepage, issue tracker, and npm publishing metadata for plugin discovery.
- Optional npm trusted publishing in the Release workflow, reusing the verified GitHub Release archive and checking immutable npm versions by integrity before retrying.

### Fixed
- Document installed-package Docker build paths for Windows CMD, PowerShell, and Linux/WSL2, including profile selection, source-checkout context, and image verification. Localized plugin details select the matching README.

## [0.2.1] - 2026-11-27

### Added
- GitHub Actions CI for branch pushes and pull requests, plus source-tag releases that run all checks, upload a precompiled `.tgz`, and publish immutable `dist-v*` tags. The `dist` branch tracks the newest stable release.

### Fixed
- Reject Windows drive and WSL UNC host paths on non-Windows hosts before POSIX resolution, so Windows paths cannot be interpreted as local relative paths. CI checks both Linux and Windows.
- Canonicalize Windows DOS drive aliases with native realpath, matching DSH filesystem target identities and keeping workspace access and IDs consistent across aliases.

## [0.2.0] - 2026-11-27

### Added
- **Preinstalled `pip3` & Document/Data Python Libraries (`Dockerfile`, `src/docker/runtime-pool.ts`, `src/subprocess/docker-subprocess.ts`)**:
  - Preinstalled `python3-pip` (`pip3`) and common PDF/Office/data libraries (`pymupdf`, `pdfplumber`, `pypdf`, `openpyxl`, `python-docx`, `python-pptx`, `pillow`, `pandas`, `pyyaml`) in the default runtime image.
  - Configured `PYTHONUSERBASE=/tmp/.local`, `PIP_USER=1`, `PIP_BREAK_SYSTEM_PACKAGES=1`, `/tmp/.local/bin` on default container `PATH`, and `security.tmpfsSizeMb` in `DockerSubprocessRuntime.Config` so runtime `pip3 install` works under `ReadonlyRootfs: true`.
- **Cloud No-LAN Public-Egress Deployment Scripts (`deploy/`)**:
  - Added `deploy/setup-public-egress-network.sh`, `deploy/teardown-public-egress-network.sh`, and `deploy/README.md` to provision a hardened Linux Docker bridge (`dsh-sandbox-public`) that blocks RFC1918 LANs, cloud metadata (`169.254.169.254`), host ports, and container-to-container traffic (`enable_icc=false`) while allowing public Internet access.
- **Environment-Aware Bundle Networking (`cordis.patch.yml`)**:
  - Added `DSH_SANDBOX_NETWORK_MODE` support: defaults local Desktop/Web bundle sessions to `bridge` while keeping `DSH_SANDBOX_CLOUD_MODE=1` and the low-level SDK fail-closed on `networkMode: 'none'`.

## [0.1.0] - 2026-11-27

### Added
- **Workspace Policy (`src/workspace/workspace-policy.ts`)**: Pure directory-based isolation (no user identity) with canonical `realpath` resolution, `allowedBaseDirs` allowlist, symlink-escape rejection, sensitive system path denylist, `:ro` extra/skill mount resolver, and `mirror` / `remap` container path mapping.
- **Two-Tier Fair Concurrency Scheduler (`src/scheduler/fair-scheduler.ts`)**: Separate container-slot pool (`maxActiveContainers` + idle LRU eviction), execution task pool (`maxConcurrentTasks` + `maxConcurrencyPerWorkspace`), per-workspace round-robin fair queuing, dedicated terminal quotas, `maxQueueSize` fast-fail, `queueTimeoutMs`, `AbortSignal` cancellation, and live metrics/events.
- **Linux Docker Engine Socket Client (`src/docker/socket-client.ts`)**: Dependency-free HTTP-over-Unix-Socket (`/var/run/docker.sock`) client with hardened container defaults (`CapDrop: ALL`, `no-new-privileges`, `ReadonlyRootfs`, bounded `/tmp` tmpfs with explicit `exec` unless `tmpfsNoExec: true`, CPU/memory/PIDs quotas, default `network=none`), Docker multiplexed stdout/stderr frame demuxer, and raw PTY stream support.
- **Windows + WSL2 Support (`src/workspace/wsl-paths.ts`, `src/docker/wsl-bridge.ts`)**:
  - Multi-transport Docker client (`transport: 'auto' | 'unix' | 'npipe' | 'wsl'`) supporting native Linux Unix sockets, Windows Docker Desktop WSL2 named pipes (`\\.\pipe\docker_engine`), and dependency-free Windows-to-WSL2 `wsl.exe` Unix-socket Duplex bridging (`socat` → `python3` → `node` fallback).
  - Automatic Windows drive (`D:\...`) and WSL UNC (`\\wsl.localhost\<distro>\...`, `\\wsl$\<distro>\...`) path conversion into POSIX container/WSL paths, plus structured `HostConfig.Mounts` on Windows named pipes and strict rejection of non-WSL SMB shares, bare drive roots, `C:\Windows`, and WSL Docker Desktop internal mounts.
- **DSH Output Stream Collector (`src/docker/stream-collector.ts`)**: Implements `@deepseek-ai/dsh-subprocess` offset-based `SubprocessOutputReader` with bounded tail retention and optional spill-file recovery.
- **Shared Container Pool (`src/docker/runtime-pool.ts`)**: Supports both warm per-workspace containers (with idle TTL reaping and automatic crash recovery) and ephemeral per-task containers, host ripgrep (`rg.exe` / `@vscode/ripgrep`) → container `rg` path translation for `glob`/`grep`, plus label-scoped orphan container cleanup on startup/shutdown.
- **DSH Capability Seam Plugins**:
  - `DockerSubprocessRuntime` (`ctx.subprocess`) supporting both standalone DSH and multi-context shared-pool cloud hosts, Schemastery `Config` schema, dynamic `ctx.workspaceRegistry` allowlisting (`trustRegisteredWorkspaces`), and automatic `:ro` user Skill directory mounting (`mountUserSkills`).
  - `DockerShellExecutor` (`ctx.shell`) integrating `ctx.sandboxPolicy` (`read-only` / `workspace-write`) with fail-closed escalation blocking and opt-in user-approved ephemeral `:ro` host-file mounting (`allowApprovedHostReadOnly`).
  - `WorkspaceFencedFileSystem` (`ctx.fs`) providing strict read+write directory containment for standalone DSH deployments.
  - `SandboxFileIntake` (`dsh-cloud-sandbox/intake`) providing per-session uploaded attachment staging into `<workspaceRoot>/.dsh-uploads/` and an interactive `ctx.approval`-gated `sandbox_import_file` tool (disabled under `DSH_SANDBOX_CLOUD_MODE=1`).
- **DSH Plugin Manager Bundle (`cordis.patch.yml`, `icon.svg`, `locale/*.json`, `src/cordis/service-handoff.ts`)**:
  - Declared `dsh.bundle.patch`, `engines.dsh` (`>=0.2.1-rc.2 <1.0.0`), peer compatibility for `@deepseek-ai/cordis` (`^4.0.5`) and `@deepseek-ai/schemastery` (`^3.18.5`), icon, and English/Chinese plugin metadata.
  - Added Cordis live hot-reload service-handoff wrappers so replacement providers wait for disposing predecessors instead of colliding on service registration.
- **Default Runtime Image (`Dockerfile`)**: Hardened non-root Debian Bookworm Linux image with `bash`, `git`, `ripgrep`, `python3`, and `nodejs`.
- **Repository Governance & Documentation**: `README.md`, `README.zh.md`, `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE` (Apache-2.0), and comprehensive unit/contract test suite.
