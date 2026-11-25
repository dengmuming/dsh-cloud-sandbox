/**
 * Shared Linux Docker container pool & execution coordinator (`DockerRuntimePool`).
 *
 * Key properties:
 * - Strictly user-agnostic: keyed solely by canonical `workspaceId`.
 * - Can be instantiated once at Host root level and shared across multiple Cordis Contexts
 *   (e.g., multi-tenant cloud hosts) so concurrency & queuing apply globally across the host.
 * - Supports both `'warm'` per-workspace containers (millisecond `docker exec` + LRU/TTL reaping)
 *   and `'ephemeral'` per-task containers.
 * - Scrubs host credentials and `DSH_*` variables before passing env into containers.
 */

import { PassThrough, Readable, Writable } from 'node:stream'
import { DSH_ENV_PREFIX, SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalActivity,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type {
  ContainerLifecycleMode,
  DockerRuntimePoolConfig,
  FairSchedulerMetrics,
  HostMountPathStyle,
  WorkspaceAccessMode,
} from '../types.ts'
import { DockerSandboxError } from '../types.ts'
import { FairScheduler } from '../scheduler/fair-scheduler.ts'
import { WorkspacePolicy, type ResolvedWorkspace } from '../workspace/workspace-policy.ts'
import {
  LIFECYCLE_LABEL,
  MANAGED_LABEL,
  POOL_ID_LABEL,
  UnixSocketDockerClient,
  WORKSPACE_ID_LABEL,
  type ConcreteDockerTransport,
  type DockerClient,
} from './socket-client.ts'
import { DEFAULT_WINDOWS_DOCKER_PIPE, DEFAULT_WSL_DOCKER_SOCKET } from './wsl-bridge.ts'
import { BoundedStreamCollector } from './stream-collector.ts'

export interface ManagedContainer {
  readonly containerId: string
  readonly workspaceId: string
  readonly hostWorkspaceRoot: string
  readonly accessMode: WorkspaceAccessMode
}

const DEFAULT_CONTAINER_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const SIGNAL_NAME_BY_EXIT_OFFSET: Record<number, NodeJS.Signals> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  9: 'SIGKILL',
  15: 'SIGTERM',
}

function exitCodeToOutcome(exitCode: number | null): SubprocessOutcome {
  if (exitCode === null) return { exitCode: null, signal: 'SIGKILL' }
  if (exitCode > 128 && exitCode < 192) {
    const sig = SIGNAL_NAME_BY_EXIT_OFFSET[exitCode - 128]
    if (sig) return { exitCode: null, signal: sig }
  }
  return { exitCode, signal: null }
}

function isCollectMode(mode: unknown): mode is SubprocessCollect {
  return typeof mode === 'object' && mode !== null && 'maxBytes' in mode
}

/** Build a clean container environment array without leaking host credentials or host paths. */
export function buildContainerEnv(
  explicitEnv: Readonly<Record<string, string | undefined>> | undefined,
  options: { readonly defaultPath?: string; readonly envBlocklist?: readonly RegExp[] } = {},
): string[] {
  const base: Record<string, string> = {
    PATH: options.defaultPath ?? DEFAULT_CONTAINER_PATH,
    HOME: '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  }

  if (explicitEnv) {
    for (const [key, value] of Object.entries(explicitEnv)) {
      if (value === undefined) {
        delete base[key]
        continue
      }
      // Explicitly caller-supplied entries survive standard parent scrubbing unless matched by an operator blocklist.
      if (options.envBlocklist?.some(pattern => pattern.test(key))) {
        continue
      }
      base[key] = value
    }
  }

  return Object.entries(base).map(([k, v]) => `${k}=${v}`)
}

/** Strip host credentials & DSH_* from a generic env map before forwarding. */
export function scrubEnvMap(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if (SENSITIVE_ENV_PATTERN.test(k) || k.toUpperCase().startsWith(DSH_ENV_PREFIX)) continue
    out[k] = v
  }
  return out
}

export class DockerRuntimePool {
  readonly poolId: string
  readonly lifecycle: ContainerLifecycleMode
  policy: WorkspacePolicy
  readonly defaultShell: string
  readonly defaultPath: string
  private activeTransport: ConcreteDockerTransport

  private readonly config: DockerRuntimePoolConfig
  private readonly hasInjectedClient: boolean
  private docker: DockerClient
  private readonly scheduler: FairScheduler<ManagedContainer>
  private readonly liveHandles = new Set<{ terminate(): void; done: Promise<unknown> }>()
  private readonly liveTerminals = new Set<SubprocessTerminalHandle>()
  private disposed = false

  constructor(config: DockerRuntimePoolConfig, dockerClient?: DockerClient) {
    if (!config.image || config.image.trim().length === 0) {
      throw new Error('dsh-cloud-sandbox: config.image must be a non-empty Docker image name')
    }
    this.config = config
    this.hasInjectedClient = dockerClient !== undefined
    this.poolId = config.poolId ?? 'default'
    this.lifecycle = config.lifecycle ?? 'warm'
    this.defaultShell = config.defaultShell ?? '/bin/bash'
    this.defaultPath = config.defaultPath ?? DEFAULT_CONTAINER_PATH
    this.activeTransport = resolveInitialTransport(config)
    this.policy = this.buildWorkspacePolicy(this.activeTransport)
    this.docker = dockerClient ?? new UnixSocketDockerClient({
      transport: this.activeTransport,
      socketPath: config.socketPath,
      wsl: config.wsl,
    })
    this.scheduler = new FairScheduler<ManagedContainer>({
      config: config.scheduler,
      onEvent: config.onSchedulerEvent,
      onEvictContainer: async (_wsId, container) => {
        await this.destroyContainerSafe(container.containerId)
      },
    })
  }

  /** Active Docker transport selected for this pool (`'unix'`, `'npipe'`, or `'wsl'`). */
  get transport(): ConcreteDockerTransport {
    return this.activeTransport
  }

  private buildWorkspacePolicy(transport: ConcreteDockerTransport): WorkspacePolicy {
    const inferredStyle: HostMountPathStyle = transport === 'wsl'
      ? 'wsl'
      : transport === 'npipe'
        ? 'win32-npipe'
        : 'posix'
    const socketPath = this.config.workspace.dockerSocketPath
      ?? this.config.socketPath
      ?? (transport === 'npipe' ? DEFAULT_WINDOWS_DOCKER_PIPE : (this.config.wsl?.socketPath ?? DEFAULT_WSL_DOCKER_SOCKET))
    return new WorkspacePolicy({
      ...this.config.workspace,
      wslMountPrefix: this.config.workspace.wslMountPrefix ?? this.config.wsl?.mountPrefix,
      hostPathStyle: this.config.workspace.hostPathStyle && this.config.workspace.hostPathStyle !== 'auto'
        ? this.config.workspace.hostPathStyle
        : inferredStyle,
      dockerSocketPath: socketPath,
    })
  }

  /**
   * Verify Docker daemon reachability and sweep stale orphan containers belonging to this poolId.
   * On Windows with `transport: 'auto'` (and no explicit `wsl` config), probes Docker Desktop
   * named pipe first and transparently falls back to the WSL2 Unix-socket bridge if unavailable.
   */
  async initialize(signal?: AbortSignal): Promise<void> {
    this.assertNotDisposed()
    try {
      await this.docker.ping(signal)
    } catch (primaryError) {
      const canFallbackToWsl = !this.hasInjectedClient
        && process.platform === 'win32'
        && (this.config.transport ?? 'auto') === 'auto'
        && this.activeTransport === 'npipe'

      if (!canFallbackToWsl) {
        throw primaryError
      }

      const wslClient = new UnixSocketDockerClient({
        transport: 'wsl',
        socketPath: this.config.wsl?.socketPath ?? DEFAULT_WSL_DOCKER_SOCKET,
        wsl: this.config.wsl,
      })
      try {
        await wslClient.ping(signal)
      } catch (wslError) {
        throw new DockerSandboxError(
          'DOCKER_UNAVAILABLE',
          `Docker daemon unavailable on Windows named pipe (${DEFAULT_WINDOWS_DOCKER_PIPE}) and WSL2 fallback: ${wslError instanceof Error ? wslError.message : String(wslError)}`,
          { cause: wslError },
        )
      }
      this.docker = wslClient
      this.activeTransport = 'wsl'
      this.policy = this.buildWorkspacePolicy('wsl')
    }

    if (this.config.sweepOrphansOnStart !== false) {
      await this.sweepOrphanContainers(signal)
    }
  }

  /** Remove any containers carrying this pool's management labels (e.g., left over from a prior crash). */
  async sweepOrphanContainers(signal?: AbortSignal): Promise<number> {
    const existing = await this.docker.listContainers(
      { [MANAGED_LABEL]: 'true', [POOL_ID_LABEL]: this.poolId },
      signal,
    )
    let removed = 0
    for (const item of existing) {
      await this.destroyContainerSafe(item.id)
      removed += 1
    }
    return removed
  }

  /** Return live container pool, concurrency, and queue metrics. */
  getMetrics(): FairSchedulerMetrics {
    return this.scheduler.getMetrics()
  }

  /** Reap idle warm containers immediately (also triggered automatically on `reapIntervalMs`). */
  reapIdleContainers(): Promise<number> {
    return this.scheduler.reapIdleContainers()
  }

  /** Resolve a host path/cwd using the workspace policy. */
  resolveWorkspace(
    cwd: string,
    accessMode: WorkspaceAccessMode = 'rw',
    extraReadOnlyMounts?: readonly string[],
  ): ResolvedWorkspace {
    return this.policy.resolveForExecution(cwd, accessMode, extraReadOnlyMounts)
  }

  /** Validate a user-approved host path for a one-off ephemeral read-only mount. */
  validateApprovedReadOnlyPath(rawPath: string): string {
    return this.policy.validateApprovedReadOnlyPath(rawPath)
  }

  /**
   * Spawn one managed process inside the Docker container corresponding to `spec.cwd`.
   * Returns a live `SubprocessHandle` synchronously, honoring DSH's `ctx.subprocess` contract.
   */
  spawn(
    spec: SubprocessSpawnSpec,
    options: {
      accessMode?: WorkspaceAccessMode
      ephemeral?: boolean
      extraReadOnlyMounts?: readonly string[]
    } = {},
  ): SubprocessHandle {
    this.assertNotDisposed()
    spec.signal?.throwIfAborted()
    if (!Array.isArray(spec.argv) || spec.argv.length === 0 || !spec.argv[0]) {
      throw new Error('dsh-cloud-sandbox: spec.argv must contain at least an executable name')
    }
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0) {
      throw new Error(`dsh-cloud-sandbox: spec.graceMs must be positive finite, got ${String(spec.graceMs)}`)
    }

    const accessMode: WorkspaceAccessMode = options.accessMode ?? 'rw'
    const hasExtraRoMounts = Array.isArray(options.extraReadOnlyMounts) && options.extraReadOnlyMounts.length > 0
    const useEphemeral = this.lifecycle === 'ephemeral'
      || accessMode === 'ro'
      || options.ephemeral === true
      || hasExtraRoMounts
    const resolved = this.policy.resolveForExecution(spec.cwd, accessMode, options.extraReadOnlyMounts)

    const stdinPass = spec.stdio.stdin === 'pipe' ? new PassThrough() : undefined
    const stdoutPipe = spec.stdio.stdout === 'pipe' ? new PassThrough() : undefined
    const stderrPipe = spec.stdio.stderr === 'pipe' ? new PassThrough() : undefined
    const stdoutCollector = isCollectMode(spec.stdio.stdout)
      ? new BoundedStreamCollector(spec.stdio.stdout, this.config.spillDir)
      : undefined
    const stderrCollector = isCollectMode(spec.stdio.stderr)
      ? new BoundedStreamCollector(spec.stdio.stderr, this.config.spillDir)
      : undefined

    const internalAbort = new AbortController()
    let activeContainerId: string | undefined
    let activeExecId: string | undefined
    let activeStreamDestroy: (() => void) | undefined
    let ephemeralContainerId: string | undefined
    let terminateStarted = false
    let exited = false
    let resolveRangeExit!: () => void
    const rangeExited = new Promise<void>((resolve) => {
      resolveRangeExit = resolve
    })

    const onExternalAbort = (): void => {
      terminate()
    }
    spec.signal?.addEventListener('abort', onExternalAbort, { once: true })

    const terminate = (): void => {
      if (terminateStarted || exited) return
      terminateStarted = true
      internalAbort.abort(spec.signal?.reason ?? new Error('terminated'))
      void this.terminateExecRange({
        containerId: activeContainerId,
        execId: activeExecId,
        ephemeralContainerId,
        graceMs: spec.graceMs,
        destroyStream: activeStreamDestroy,
      })
    }

    const mappedArgv = this.mapArgvPaths(spec.argv, resolved)
    const envList = buildContainerEnv(spec.env, {
      defaultPath: this.defaultPath,
      envBlocklist: this.config.envBlocklist,
    })

    const done: Promise<SubprocessOutcome> = (async () => {
      const lease = await this.scheduler.acquireTaskSlot(resolved.workspaceId, internalAbort.signal)
      let ephemeralSlot: { release(): void } | undefined
      let container: ManagedContainer | undefined
      try {
        internalAbort.signal.throwIfAborted()

        if (useEphemeral) {
          ephemeralSlot = await this.scheduler.acquireEphemeralContainerSlot(resolved.workspaceId, internalAbort.signal)
          const cid = await this.createAndStartContainer(resolved, accessMode, 'ephemeral', internalAbort.signal)
          ephemeralContainerId = cid
          container = {
            containerId: cid,
            workspaceId: resolved.workspaceId,
            hostWorkspaceRoot: resolved.hostWorkspaceRoot,
            accessMode,
          }
        } else {
          container = await this.ensureHealthyWarmContainer(resolved, internalAbort.signal)
        }

        activeContainerId = container.containerId
        internalAbort.signal.throwIfAborted()

        const execId = await this.docker.execCreate(
          {
            containerId: container.containerId,
            cmd: mappedArgv,
            workingDir: resolved.containerCwd,
            env: envList,
            attachStdin: spec.stdio.stdin !== 'ignore',
            attachStdout: true,
            attachStderr: true,
            tty: false,
            user: this.config.security?.user,
          },
          internalAbort.signal,
        )
        activeExecId = execId

        const stream = await this.docker.execStart(execId, { tty: false }, internalAbort.signal)
        activeStreamDestroy = () => stream.destroy()

        if (terminateStarted) {
          void this.terminateExecRange({
            containerId: activeContainerId,
            execId: activeExecId,
            ephemeralContainerId,
            graceMs: spec.graceMs,
            destroyStream: activeStreamDestroy,
          })
        }

        // Wire stdin only when AttachStdin is true; never half-close socket when stdin is 'ignore'.
        if (spec.stdio.stdin === 'pipe' && stdinPass) {
          stdinPass.pipe(stream.stdin)
        } else if (typeof spec.stdio.stdin === 'object' && 'data' in spec.stdio.stdin) {
          stream.stdin.end(spec.stdio.stdin.data)
        }

        // Wire stdout and stderr with explicit end tracking so all buffered bytes drain before `done` settles.
        const stdoutDone = new Promise<void>((resolveOut) => {
          stream.stdout.on('data', (chunk: Buffer) => {
            if (stdoutPipe) stdoutPipe.write(chunk)
            else if (stdoutCollector) stdoutCollector.append(chunk)
            else if (spec.stdio.stdout === 'inherit') process.stdout.write(chunk)
          })
          stream.stdout.once('end', () => {
            stdoutPipe?.end()
            stdoutCollector?.finish()
            resolveOut()
          })
          stream.stdout.once('close', () => resolveOut())
          stream.stdout.once('error', () => resolveOut())
        })

        const stderrDone = new Promise<void>((resolveErr) => {
          stream.stderr.on('data', (chunk: Buffer) => {
            if (stderrPipe) stderrPipe.write(chunk)
            else if (stderrCollector) stderrCollector.append(chunk)
            else if (spec.stdio.stderr === 'inherit') process.stderr.write(chunk)
          })
          stream.stderr.once('end', () => {
            stderrPipe?.end()
            stderrCollector?.finish()
            resolveErr()
          })
          stream.stderr.once('close', () => resolveErr())
          stream.stderr.once('error', () => resolveErr())
        })

        // Wait for stream close AND full stdout/stderr drain.
        await stream.closed
        await Promise.race([
          Promise.all([stdoutDone, stderrDone]),
          delay(Math.min(spec.graceMs, 5_000)),
        ])
        stdoutPipe?.end()
        stderrPipe?.end()
        stdoutCollector?.finish()
        stderrCollector?.finish()

        const inspect = await this.waitForExecSettlement(execId, Math.min(spec.graceMs, 2_000), terminateStarted)

        if (terminateStarted && inspect.exitCode === 0) {
          return { exitCode: null, signal: 'SIGTERM' }
        }
        return exitCodeToOutcome(inspect.exitCode)
      } finally {
        exited = true
        spec.signal?.removeEventListener('abort', onExternalAbort)
        stdoutPipe?.end()
        stderrPipe?.end()
        stdoutCollector?.finish()
        stderrCollector?.finish()
        if (ephemeralContainerId) {
          await this.destroyContainerSafe(ephemeralContainerId)
        }
        ephemeralSlot?.release()
        lease.release()
        resolveRangeExit()
      }
    })()

    const handle: SubprocessHandle = {
      stdin: stdinPass as Writable | undefined,
      stdout: stdoutPipe as Readable | undefined,
      stderr: stderrPipe as Readable | undefined,
      control: undefined,
      collected: {
        ...(stdoutCollector ? { stdout: stdoutCollector } : {}),
        ...(stderrCollector ? { stderr: stderrCollector } : {}),
      },
      done,
      terminate,
      waitForExit: async (waitSignal?: AbortSignal): Promise<boolean> => {
        if (exited) return true
        if (waitSignal?.aborted) return false
        return new Promise<boolean>((resolve) => {
          const onWaitAbort = (): void => resolve(false)
          waitSignal?.addEventListener('abort', onWaitAbort, { once: true })
          void rangeExited.then(() => {
            waitSignal?.removeEventListener('abort', onWaitAbort)
            resolve(true)
          })
        })
      },
    }

    const tracked = { terminate, done }
    this.liveHandles.add(tracked)
    void done.finally(() => {
      this.liveHandles.delete(tracked)
    })

    return handle
  }

  /**
   * Allocate an interactive PTY session inside the workspace container.
   * Uses the dedicated terminal quota (never consumes short-lived exec task slots).
   */
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    this.assertNotDisposed()
    spec.signal?.throwIfAborted()
    if (!Array.isArray(spec.argv) || spec.argv.length === 0 || !spec.argv[0]) {
      throw new Error('dsh-cloud-sandbox: terminal spec.argv must be non-empty')
    }

    const resolved = this.policy.resolveForExecution(spec.cwd, 'rw')
    const termLease = this.scheduler.acquireTerminalSlot(resolved.workspaceId)

    try {
      const container = await this.ensureHealthyWarmContainer(resolved, spec.signal)
      const mappedArgv = this.mapArgvPaths(spec.argv, resolved)
      const envList = buildContainerEnv(
        { ...spec.env, TERM: spec.terminalType || 'xterm-256color' },
        { defaultPath: this.defaultPath, envBlocklist: this.config.envBlocklist },
      )

      const execId = await this.docker.execCreate(
        {
          containerId: container.containerId,
          cmd: mappedArgv,
          workingDir: resolved.containerCwd,
          env: envList,
          attachStdin: true,
          attachStdout: true,
          attachStderr: true,
          tty: true,
          user: this.config.security?.user,
        },
        spec.signal,
      )

      const stream = await this.docker.execStart(execId, { tty: true }, spec.signal)
      await this.docker.execResize(execId, spec.cols, spec.rows).catch(() => {})
      const initialInspect = await this.docker.execInspect(execId).catch(() => ({
        id: execId,
        running: true,
        exitCode: null,
        pid: 0,
      }))

      const output = new PassThrough()
      const ttyStream = stream.ttyOutput ?? stream.stdout
      ttyStream.pipe(output)

      let revision = 0
      let closed = false
      let terminating: Promise<void> | undefined

      const done: Promise<SubprocessOutcome> = stream.closed.then(async () => {
        closed = true
        output.end()
        const finalInspect = await this.docker.execInspect(execId).catch(() => ({
          id: execId,
          running: false,
          exitCode: 0,
          pid: initialInspect.pid,
        }))
        termLease.release()
        return exitCodeToOutcome(finalInspect.exitCode)
      })

      const handle: SubprocessTerminalHandle = {
        pid: initialInspect.pid,
        output,
        done,
        write: async (data: string) => {
          if (closed) throw new Error('terminal session is closed')
          revision += 1
          await new Promise<void>((resolve, reject) => {
            stream.stdin.write(data, 'utf8', (err) => (err ? reject(err) : resolve()))
          })
        },
        resize: async (cols: number, rows: number) => {
          if (closed) return
          await this.docker.execResize(execId, cols, rows)
        },
        inspectForeground: async (): Promise<SubprocessTerminalForeground | undefined> => {
          if (closed) return undefined
          const info = await this.docker.execInspect(execId).catch(() => undefined)
          if (!info || !info.running || info.pid <= 0) return undefined
          return { processGroupId: info.pid, inputWaiting: false }
        },
        inspectActivity: async (): Promise<SubprocessTerminalActivity> => {
          return { state: 'unknown', revision }
        },
        signalForeground: async (sig: SubprocessTerminalSignal): Promise<number> => {
          if (closed) throw new Error('terminal session is closed')
          const info = await this.docker.execInspect(execId)
          if (info.pid > 0) {
            await this.sendSignalInContainer(container.containerId, info.pid, sig)
          }
          revision += 1
          return info.pid
        },
        terminate: async () => {
          if (terminating) return terminating
          terminating = (async () => {
            try {
              await this.terminateExecRange({
                containerId: container.containerId,
                execId,
                graceMs: spec.graceMs,
                destroyStream: () => stream.destroy(),
              })
              await done.catch(() => {})
            } finally {
              termLease.release()
            }
          })()
          return terminating
        },
      }

      this.liveTerminals.add(handle)
      void done.finally(() => {
        this.liveTerminals.delete(handle)
      })
      return handle
    } catch (error) {
      termLease.release()
      throw error
    }
  }

  /** Dispose all running tasks, terminals, warm containers, and timers. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    for (const handle of this.liveHandles) {
      handle.terminate()
    }
    await Promise.allSettled([...this.liveHandles].map(h => h.done))
    this.liveHandles.clear()

    await Promise.allSettled([...this.liveTerminals].map(t => t.terminate()))
    this.liveTerminals.clear()

    const containers = this.scheduler.listContainers()
    this.scheduler.dispose()

    await Promise.allSettled(containers.map(c => this.destroyContainerSafe(c.container.containerId)))
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new DockerSandboxError('POOL_DISPOSED', 'DockerRuntimePool has been disposed')
    }
  }

  private async ensureHealthyWarmContainer(
    resolved: ResolvedWorkspace,
    signal?: AbortSignal,
  ): Promise<ManagedContainer> {
    const container = await this.scheduler.ensureContainer(
      resolved.workspaceId,
      async () => {
        const containerId = await this.createAndStartContainer(resolved, 'rw', 'warm', signal)
        return {
          containerId,
          workspaceId: resolved.workspaceId,
          hostWorkspaceRoot: resolved.hostWorkspaceRoot,
          accessMode: 'rw',
        }
      },
      signal,
    )

    const status = await this.docker.inspectContainer(container.containerId, signal).catch(() => undefined)
    if (status?.running) {
      return container
    }

    // Warm container crashed or was externally removed: invalidate and recreate once.
    this.scheduler.invalidateContainer(resolved.workspaceId, container)
    await this.destroyContainerSafe(container.containerId)

    return this.scheduler.ensureContainer(
      resolved.workspaceId,
      async () => {
        const containerId = await this.createAndStartContainer(resolved, 'rw', 'warm', signal)
        return {
          containerId,
          workspaceId: resolved.workspaceId,
          hostWorkspaceRoot: resolved.hostWorkspaceRoot,
          accessMode: 'rw',
        }
      },
      signal,
    )
  }

  private async createAndStartContainer(
    resolved: ResolvedWorkspace,
    accessMode: WorkspaceAccessMode,
    lifecycle: ContainerLifecycleMode,
    signal?: AbortSignal,
  ): Promise<string> {
    const containerId = await this.docker.createContainer(
      {
        image: this.config.image,
        cmd: ['sleep', 'infinity'],
        workingDir: resolved.containerWorkspaceRoot,
        mounts: resolved.mounts,
        security: this.config.security,
        labels: {
          [MANAGED_LABEL]: 'true',
          [POOL_ID_LABEL]: this.poolId,
          [WORKSPACE_ID_LABEL]: resolved.workspaceId,
          [LIFECYCLE_LABEL]: `${lifecycle}:${accessMode}`,
        },
      },
      signal,
    )
    try {
      await this.docker.startContainer(containerId, signal)
      return containerId
    } catch (error) {
      await this.destroyContainerSafe(containerId)
      throw error
    }
  }

  private mapArgvPaths(argv: readonly string[], resolved: ResolvedWorkspace): string[] {
    if (argv.length === 0) return []
    const isRipgrep = isHostRipgrepBinary(argv[0] ?? '')
    const needsPathMapping = resolved.pathMode !== 'mirror'
      || resolved.hostWorkspaceRoot !== resolved.containerWorkspaceRoot

    if (!isRipgrep && !needsPathMapping) {
      return [...argv]
    }

    let seenDoubleDash = false
    return argv.map((arg, index) => {
      if (index === 0 && isRipgrep) {
        return 'rg'
      }
      if (isRipgrep) {
        if (!seenDoubleDash) {
          if (arg === '--') {
            seenDoubleDash = true
          }
          return arg
        }
        const mapped = resolved.toContainerPath(arg)
        if (mapped) return mapped
        // Relative Windows paths passed after `--` (e.g. `src\index.ts`) need POSIX separators inside Linux `rg`.
        if (arg.includes('\\') && !arg.startsWith('-')) {
          return arg.replaceAll('\\', '/')
        }
        return arg
      }
      return resolved.toContainerPath(arg) ?? arg
    })
  }

  private async terminateExecRange(params: {
    containerId: string | undefined
    execId: string | undefined
    ephemeralContainerId?: string
    graceMs: number
    destroyStream?: () => void
  }): Promise<void> {
    if (params.ephemeralContainerId) {
      await this.docker.killContainer(params.ephemeralContainerId, 'SIGTERM').catch(() => {})
      await delay(Math.min(params.graceMs, 3_000))
      await this.docker.killContainer(params.ephemeralContainerId, 'SIGKILL').catch(() => {})
      params.destroyStream?.()
      return
    }

    if (params.containerId && params.execId) {
      const info = await this.docker.execInspect(params.execId).catch(() => undefined)
      if (info && info.running && info.pid > 0) {
        await this.sendSignalInContainer(params.containerId, info.pid, 'SIGTERM').catch(() => {})
        await delay(Math.min(params.graceMs, 3_000))
        const after = await this.docker.execInspect(params.execId).catch(() => undefined)
        if (after?.running && after.pid > 0) {
          await this.sendSignalInContainer(params.containerId, after.pid, 'SIGKILL').catch(() => {})
        }
      }
    }
    params.destroyStream?.()
  }

  private async waitForExecSettlement(
    execId: string,
    maxWaitMs: number,
    terminated: boolean,
  ): Promise<{ running: boolean; exitCode: number | null }> {
    const deadline = Date.now() + Math.max(50, maxWaitMs)
    let backoffMs = 10
    while (true) {
      const inspect = await this.docker.execInspect(execId).catch(() => undefined)
      if (!inspect) {
        return { running: false, exitCode: terminated ? 143 : 1 }
      }
      if (!inspect.running || inspect.exitCode !== null) {
        return { running: inspect.running, exitCode: inspect.exitCode }
      }
      if (Date.now() >= deadline) {
        return { running: inspect.running, exitCode: inspect.exitCode }
      }
      await delay(backoffMs)
      backoffMs = Math.min(backoffMs * 2, 100)
    }
  }

  private async sendSignalInContainer(containerId: string, pid: number, sig: string): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      throw new Error(`dsh-cloud-sandbox: refusing to signal invalid container pid ${String(pid)}`)
    }
    const cleanSig = sig.replace(/^SIG/, '')
    if (!/^(INT|TERM|KILL|TSTP|HUP)$/.test(cleanSig)) {
      throw new Error(`dsh-cloud-sandbox: unsupported container signal ${JSON.stringify(sig)}`)
    }
    const helperExecId = await this.docker.execCreate({
      containerId,
      cmd: ['/bin/sh', '-c', `kill -s ${cleanSig} -- -${pid} 2>/dev/null || kill -s ${cleanSig} ${pid} 2>/dev/null || true`],
      workingDir: '/tmp',
      env: [`PATH=${this.defaultPath}`],
      attachStdin: false,
      attachStdout: false,
      attachStderr: false,
      tty: false,
      user: this.config.security?.user,
    })
    const stream = await this.docker.execStart(helperExecId, { tty: false })
    await stream.closed
  }

  private async destroyContainerSafe(containerId: string): Promise<void> {
    await this.docker.stopContainer(containerId, 2).catch(() => {})
    await this.docker.removeContainer(containerId, true).catch(() => {})
  }
}

function resolveInitialTransport(config: DockerRuntimePoolConfig): ConcreteDockerTransport {
  if (config.transport && config.transport !== 'auto') {
    return config.transport
  }
  if (process.platform !== 'win32') {
    return 'unix'
  }
  return config.wsl !== undefined ? 'wsl' : 'npipe'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref()
  })
}

const HOST_RIPGREP_PATTERN = /(?:^|[\\/])(?:[^\\/]*-)?rg(?:\.exe)?$/i

/**
 * Return true when an executable path refers to a host-side ripgrep binary
 * (such as `@vscode/ripgrep`'s `rg`/`rg.exe` or a packaged `*-rg(.exe)` sidecar)
 * that should be executed using the Linux container's preinstalled `rg`.
 */
export function isHostRipgrepBinary(executable: string): boolean {
  if (!executable) return false
  const hasPathOrWinExt = executable.includes('/') || executable.includes('\\') || /\.exe$/i.test(executable)
  return hasPathOrWinExt && HOST_RIPGREP_PATTERN.test(executable)
}

/** Factory helper for creating a host-shared `DockerRuntimePool` (for multi-context cloud hosts). */
export function createDockerRuntimePool(
  config: DockerRuntimePoolConfig,
  dockerClient?: DockerClient,
): DockerRuntimePool {
  return new DockerRuntimePool(config, dockerClient)
}
