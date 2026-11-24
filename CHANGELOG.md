# Changelog

All notable changes to `dsh-cloud-sandbox` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
