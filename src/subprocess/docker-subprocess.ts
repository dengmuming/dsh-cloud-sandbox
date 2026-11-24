/**
 * DSH `ctx.subprocess` capability seam provider backed by Linux Docker containers.
 *
 * Supports two composition patterns without any user-identity coupling:
 * 1. Standalone (vanilla DSH): pass `DockerRuntimePoolConfig`; this plugin creates & disposes its own pool.
 * 2. Shared Host Pool (multi-context cloud hosts): pass `{ pool: sharedPool }`; multiple isolated
 *    Cordis Contexts share one host-wide container pool and fair concurrency queue while each Context
 *    still cleans up only the processes/terminals it started upon fiber disposal.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SubprocessExecutableNotFoundError, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { DockerClient } from '../docker/socket-client.ts'
import { DockerRuntimePool } from '../docker/runtime-pool.ts'
import type { DockerRuntimePoolConfig, WorkspaceAccessMode } from '../types.ts'

export type DockerSubprocessConfig =
  | {
    /** Existing host-shared pool (e.g., owned by root Host across multiple Cordis Contexts). */
    readonly pool: DockerRuntimePool
    /** Whether disposing this Cordis Context should also dispose the shared pool. Default: `false`. */
    readonly ownPool?: boolean
  }
  | (DockerRuntimePoolConfig & {
    /** Optional injected DockerClient (primarily for deterministic unit/contract tests). */
    readonly dockerClient?: DockerClient
  })

function isPoolWrapper(config: DockerSubprocessConfig): config is { readonly pool: DockerRuntimePool; readonly ownPool?: boolean } {
  return 'pool' in config && config.pool instanceof DockerRuntimePool
}

const accessModeScope = new AsyncLocalStorage<WorkspaceAccessMode>()

export class DockerSubprocessRuntime extends SubprocessRuntime {
  readonly pool: DockerRuntimePool
  private readonly ownPool: boolean
  private readonly contextHandles = new Set<SubprocessHandle>()
  private readonly contextTerminals = new Set<SubprocessTerminalHandle>()

  constructor(ctx: Context, config: DockerSubprocessConfig) {
    super(ctx)
    if (isPoolWrapper(config)) {
      this.pool = config.pool
      this.ownPool = config.ownPool ?? false
    } else {
      const { dockerClient, ...poolConfig } = config
      this.pool = new DockerRuntimePool(poolConfig, dockerClient)
      this.ownPool = true
    }

    ctx.effect(() => {
      return async () => {
        await this.disposeContextHandles()
        if (this.ownPool) {
          await this.pool.dispose()
        }
      }
    }, 'dsh-cloud-sandbox: subprocess teardown')
  }

  /**
   * Run a synchronous or async callback with a scoped workspace access mode (`'ro'` or `'rw'`).
   * Used by `DockerShellExecutor` so `read-only` sandbox policy mounts the workspace read-only
   * without changing the upstream `SubprocessSpawnSpec` signature.
   */
  runWithAccessMode<T>(accessMode: WorkspaceAccessMode, fn: () => T): T {
    return accessModeScope.run(accessMode, fn)
  }

  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0) {
      throw new Error('dsh-cloud-sandbox: executable must be non-empty')
    }
    signal?.throwIfAborted()

    const isAbs = command.startsWith('/')
    if (!isAbs && (command.includes('/') || command.includes('\\'))) {
      throw new Error(
        `dsh-cloud-sandbox: command ${JSON.stringify(command)} is a relative path; use an absolute POSIX path or a bare PATH name`,
      )
    }
    if (isAbs) {
      return posix.normalize(command)
    }

    // Resolve bare executable names deterministically against container PATH semantics.
    // Common POSIX shells and tools live under /bin or /usr/bin inside the Linux runtime image.
    const pathValue = env?.PATH ?? this.pool.defaultPath
    const dirs = pathValue.split(':').filter(Boolean)
    if (dirs.length === 0) {
      throw new SubprocessExecutableNotFoundError(`executable ${JSON.stringify(command)} cannot be resolved: empty container PATH`)
    }
    // Well-known POSIX shells/utilities resolve cleanly to /usr/bin or /bin; otherwise return bare name
    // when standard PATH entries exist so the container's execvp resolves it inside the image.
    if (command === 'sh' || command === 'bash') {
      return command === 'bash' ? this.pool.defaultShell : '/bin/sh'
    }
    return posix.join(dirs.includes('/usr/bin') ? '/usr/bin' : (dirs[0] ?? '/usr/bin'), command)
  }

  async terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    signal?.throwIfAborted()
    return {
      platform: 'posix',
      defaultShell: this.pool.defaultShell,
    }
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const accessMode = accessModeScope.getStore() ?? 'rw'
    const handle = this.pool.spawn(spec, { accessMode })
    this.contextHandles.add(handle)
    void handle.done.finally(() => {
      this.contextHandles.delete(handle)
    })
    return handle
  }

  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const terminal = await this.pool.spawnTerminal(spec)
    this.contextTerminals.add(terminal)
    void terminal.done.finally(() => {
      this.contextTerminals.delete(terminal)
    })
    return terminal
  }

  private async disposeContextHandles(): Promise<void> {
    const handles = [...this.contextHandles]
    for (const handle of handles) {
      handle.terminate()
    }
    await Promise.allSettled(handles.map(h => Promise.all([h.done.catch(() => {}), h.waitForExit()])))
    this.contextHandles.clear()

    const terminals = [...this.contextTerminals]
    await Promise.allSettled(terminals.map(t => t.terminate()))
    this.contextTerminals.clear()
  }
}

export default DockerSubprocessRuntime
