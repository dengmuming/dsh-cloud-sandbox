/**
 * Public configuration, scheduling, mount, and error contracts for dsh-cloud-sandbox.
 * This module is strictly user-agnostic: all isolation and scheduling is keyed solely by workspace directory.
 */

export type PathMode = 'mirror' | 'remap'
export type ContainerLifecycleMode = 'warm' | 'ephemeral'
export type WorkspaceAccessMode = 'rw' | 'ro'

export interface BindMountSpec {
  /** Canonical absolute path on the Linux host. */
  readonly hostPath: string
  /** Absolute path inside the container. */
  readonly containerPath: string
  /** Whether the bind mount is read-only. */
  readonly readOnly: boolean
}

export interface WorkspacePolicyConfig {
  /**
   * Required allowlist of absolute host base directories under which workspaces may reside.
   * Any workspace path resolving outside these directories is rejected (fail-closed).
   */
  readonly allowedBaseDirs: readonly string[]
  /**
   * Optional static list of absolute host directories (e.g., shared Skill bundles)
   * mounted strictly read-only (`:ro`) into every sandbox container.
   */
  readonly readOnlyMounts?: readonly string[]
  /**
   * Optional callback returning additional read-only host paths (e.g., workspace-adjacent
   * Skill directories) for a given canonical workspace root. Always mounted `:ro`.
   */
  readonly resolveReadOnlyMounts?: (workspaceRoot: string) => readonly string[]
  /**
   * Optional callback mapping a subprocess `cwd` to its enclosing canonical workspace root.
   * Useful when a session runs commands in a subdirectory of a workspace so all subdirs share one container.
   */
  readonly resolveWorkspaceRoot?: (canonicalCwd: string) => string
  /**
   * Container path mapping strategy:
   * - `'mirror'` (default): host path === container path (zero path mismatch with DSH file/skill tools).
   * - `'remap'`: workspaceRoot maps to `/workspace`, read-only mounts map to `/mnt/ro/<index>`.
   */
  readonly pathMode?: PathMode
  /** Docker socket path on the host; always denied as a mount target. Default: `/var/run/docker.sock`. */
  readonly dockerSocketPath?: string
  /** Optional container path used for workspace root when `pathMode === 'remap'`. Default: `/workspace`. */
  readonly containerWorkspacePath?: string
}

export interface ContainerSecurityConfig {
  /** Non-root UID:GID inside the container. Default: `'1000:1000'`. */
  readonly user?: string
  /** Docker network mode. Default: `'none'` (offline, SSRF-safe). */
  readonly networkMode?: string
  /** CPU quota in fractional cores (converted to NanoCpus). Default: `2`. */
  readonly cpus?: number
  /** Memory limit in bytes. Default: `2 * 1024 * 1024 * 1024` (2 GiB). */
  readonly memoryBytes?: number
  /** Memory + swap limit in bytes. Default: equals `memoryBytes` (no swap). */
  readonly memorySwapBytes?: number
  /** Maximum PIDs inside the container (fork-bomb protection). Default: `256`. */
  readonly pidsLimit?: number
  /** Mount container root filesystem read-only. Default: `true`. */
  readonly readonlyRootfs?: boolean
  /** Tmpfs mount size for `/tmp` in megabytes. Default: `256`. */
  readonly tmpfsSizeMb?: number
  /** Mount `/tmp` with `noexec`. Default: `false` (allows Python/pip/compilers using `/tmp`; set `true` to harden further). */
  readonly tmpfsNoExec?: boolean
  /** Optional OCI runtime (e.g., `'runsc'` for gVisor or `'kata'`). */
  readonly runtime?: string
  /** Additional capabilities to drop (always includes `'ALL'`). */
  readonly capDrop?: readonly string[]
  /** Additional security opts (always includes `'no-new-privileges:true'`). */
  readonly securityOpt?: readonly string[]
}

export interface FairSchedulerConfig {
  /** Maximum live warm containers across the entire host. Default: `16`. */
  readonly maxActiveContainers?: number
  /** Maximum concurrent exec tasks across the entire host. Default: `8`. */
  readonly maxConcurrentTasks?: number
  /** Maximum concurrent exec tasks per workspace (anti-starvation cap). Default: `2`. */
  readonly maxConcurrencyPerWorkspace?: number
  /** Maximum queued tasks waiting across all workspaces. Default: `64`. */
  readonly maxQueueSize?: number
  /** Maximum milliseconds a task or container acquisition may wait in queue. Default: `60_000`. */
  readonly queueTimeoutMs?: number
  /** Idle TTL in milliseconds after which an unused warm container is automatically reaped. Default: `600_000` (10 min). */
  readonly idleTtlMs?: number
  /** Interval in milliseconds for the background idle container reaper. Default: `30_000`. */
  readonly reapIntervalMs?: number
  /** Maximum simultaneous interactive PTY terminals across the entire host. Default: `16`. */
  readonly maxTotalTerminals?: number
  /** Maximum simultaneous interactive PTY terminals per workspace. Default: `2`. */
  readonly maxTerminalsPerWorkspace?: number
}

export type SchedulerEvent =
  | { readonly type: 'task_queued'; readonly workspaceId: string; readonly queueDepth: number; readonly position: number }
  | { readonly type: 'task_started'; readonly workspaceId: string; readonly waitedMs: number; readonly runningTasks: number }
  | { readonly type: 'task_finished'; readonly workspaceId: string; readonly runningTasks: number }
  | { readonly type: 'task_rejected'; readonly workspaceId: string; readonly reason: 'queue_full' | 'queue_timeout' | 'aborted' }
  | { readonly type: 'container_evicted'; readonly workspaceId: string; readonly reason: 'lru' | 'idle_ttl' }

export interface FairSchedulerMetrics {
  readonly activeContainers: number
  readonly idleContainers: number
  readonly runningTasks: number
  readonly queuedTasks: number
  readonly queuedContainerWaiters: number
  readonly activeTerminals: number
  readonly workspaces: Readonly<Record<string, {
    readonly hasContainer: boolean
    readonly runningTasks: number
    readonly queuedTasks: number
    readonly activeTerminals: number
    readonly lastUsedAt: number
  }>>
}

export interface DockerRuntimePoolConfig {
  /** Docker image for sandbox containers (e.g., `'dsh-cloud-sandbox-runtime:latest'`). */
  readonly image: string
  /** Linux Docker Engine Unix socket path. Default: `'/var/run/docker.sock'`. */
  readonly socketPath?: string
  /** Stable identifier for this pool used in container labels for orphan cleanup. Default: `'default'`. */
  readonly poolId?: string
  /** Container lifecycle mode: `'warm'` (per-workspace reuse) or `'ephemeral'` (per-task). Default: `'warm'`. */
  readonly lifecycle?: ContainerLifecycleMode
  /** Workspace allowlist, read-only Skill mounts, and path mapping rules. */
  readonly workspace: WorkspacePolicyConfig
  /** Hardened container security and cgroup resource limits. */
  readonly security?: ContainerSecurityConfig
  /** Two-tier container/task concurrency limits and fair queuing settings. */
  readonly scheduler?: FairSchedulerConfig
  /** Default container shell for `terminalEnvironment()`. Default: `'/bin/bash'`. */
  readonly defaultShell?: string
  /** Default PATH inside the container for executable resolution. */
  readonly defaultPath?: string
  /** Environment variable names always stripped even if present in parent env. */
  readonly envBlocklist?: readonly RegExp[]
  /** Optional container startup timeout in milliseconds. Default: `30_000`. */
  readonly startTimeoutMs?: number
  /** Optional observer callback for scheduling/queue telemetry. */
  readonly onSchedulerEvent?: (event: SchedulerEvent) => void
  /** Optional spill directory on the host for bounded collect-mode overflow files. */
  readonly spillDir?: string
  /** Remove stale containers labeled by this `poolId` during `initialize()`. Default: `true`. */
  readonly sweepOrphansOnStart?: boolean
}

export type DockerSandboxErrorCode =
  | 'WORKSPACE_POLICY_DENIED'
  | 'QUEUE_FULL'
  | 'QUEUE_TIMEOUT'
  | 'TERMINAL_QUOTA_EXCEEDED'
  | 'DOCKER_TRANSPORT_ERROR'
  | 'DOCKER_UNAVAILABLE'
  | 'POOL_DISPOSED'
  | 'SANDBOX_ESCALATION_DENIED'

export class DockerSandboxError extends Error {
  readonly code: DockerSandboxErrorCode

  constructor(code: DockerSandboxErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DockerSandboxError'
    this.code = code
  }
}

export class WorkspacePolicyError extends DockerSandboxError {
  constructor(message: string, options?: ErrorOptions) {
    super('WORKSPACE_POLICY_DENIED', message, options)
    this.name = 'WorkspacePolicyError'
  }
}

export class QueueFullError extends DockerSandboxError {
  readonly queueSize: number

  constructor(queueSize: number) {
    super('QUEUE_FULL', `sandbox execution queue is full (${queueSize} pending tasks); retry later`)
    this.name = 'QueueFullError'
    this.queueSize = queueSize
  }
}

export class QueueTimeoutError extends DockerSandboxError {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super('QUEUE_TIMEOUT', `timed out after ${timeoutMs}ms waiting for a sandbox execution slot`)
    this.name = 'QueueTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export class DockerTransportError extends DockerSandboxError {
  readonly statusCode?: number

  constructor(message: string, statusCode?: number, options?: ErrorOptions) {
    super('DOCKER_TRANSPORT_ERROR', message, options)
    this.name = 'DockerTransportError'
    this.statusCode = statusCode
  }
}
