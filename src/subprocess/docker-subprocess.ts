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
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SubprocessExecutableNotFoundError, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { DockerClient } from '../docker/socket-client.ts'
import { DockerRuntimePool, isHostRipgrepBinary } from '../docker/runtime-pool.ts'
import { createServiceHandoffPlugin } from '../cordis/service-handoff.ts'
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

export interface SubprocessExecutionOptions {
  readonly accessMode?: WorkspaceAccessMode
  readonly ephemeral?: boolean
  readonly extraReadOnlyMounts?: readonly string[]
}

interface WorkspaceRegistryLike {
  list?: () => ReadonlyArray<{ readonly path?: string }>
}

function isPoolWrapper(config: DockerSubprocessConfig): config is { readonly pool: DockerRuntimePool; readonly ownPool?: boolean } {
  return 'pool' in config && config.pool instanceof DockerRuntimePool
}

function resolveDshHomeDir(ctx: Context): string {
  const resolver = (ctx as unknown as { dshHomePath?: (subpath: string) => string }).dshHomePath
  if (typeof resolver === 'function') {
    const probe = resolver('attachments')
    return join(probe, '..')
  }
  const envHome = process.env.DSH_HOME?.trim()
  if (envHome) return envHome
  return join(homedir(), '.dsh')
}

function collectRegisteredWorkspacePaths(ctx: Context): string[] {
  const registry = (ctx as unknown as { get?: (name: string) => unknown }).get?.('workspaceRegistry') as WorkspaceRegistryLike | undefined
  if (!registry || typeof registry.list !== 'function') return []
  try {
    const items = registry.list()
    if (!Array.isArray(items)) return []
    const paths: string[] = []
    for (const item of items) {
      if (typeof item?.path === 'string' && item.path.trim().length > 0 && existsSync(item.path)) {
        paths.push(item.path)
      }
    }
    return paths
  } catch {
    return []
  }
}

function collectDefaultReadOnlyMounts(
  ctx: Context,
  options: { mountAttachments?: boolean; mountUserSkills?: boolean },
): string[] {
  const mounts: string[] = []
  const dshHome = resolveDshHomeDir(ctx)
  if (options.mountAttachments) {
    const attachmentsDir = join(dshHome, 'attachments')
    if (existsSync(attachmentsDir)) {
      mounts.push(attachmentsDir)
    }
  }
  if (options.mountUserSkills) {
    for (const candidate of [join(homedir(), '.agents', 'skills'), join(dshHome, 'skills')]) {
      if (existsSync(candidate)) {
        mounts.push(candidate)
      }
    }
  }
  return mounts
}

const executionOptionsScope = new AsyncLocalStorage<SubprocessExecutionOptions>()

const DockerSubprocessConfigSchema = z.object({
  image: z.string().default('dsh-cloud-sandbox-runtime:latest').description('Linux Docker runtime image used for sandbox containers'),
  transport: z.union(['auto', 'unix', 'npipe', 'wsl'] as const).default('auto').description('Docker Engine transport (auto, unix, npipe, or wsl)'),
  lifecycle: z.union(['warm', 'ephemeral'] as const).default('warm').description('Container reuse mode (warm per workspace or ephemeral per command)'),
  workspace: z.object({
    allowedBaseDirs: z.array(z.string()).default([]).description('Allowed host base directories that may be mounted as sandbox workspaces'),
    readOnlyMounts: z.array(z.string()).default([]).description('Additional host directories mounted strictly read-only (:ro) into every container'),
    pathMode: z.union(['mirror', 'remap'] as const).default('mirror').description('Container path mapping mode (mirror or remap)'),
    containerWorkspacePath: z.string().default('/workspace').description('Workspace mount point inside the container when pathMode is remap'),
    trustRegisteredWorkspaces: z.boolean().default(false).description('Automatically allow workspace folders registered in DSH workspaceRegistry'),
    mountAttachments: z.boolean().default(false).description('Mount DSH uploaded chat attachments ($DSH_HOME/attachments) read-only inside containers'),
    mountUserSkills: z.boolean().default(false).description('Mount existing user Skill directories (~/.agents/skills, ~/.dsh/skills) read-only inside containers'),
  }).default({
    allowedBaseDirs: [],
    readOnlyMounts: [],
    pathMode: 'mirror',
    containerWorkspacePath: '/workspace',
    trustRegisteredWorkspaces: false,
    mountAttachments: false,
    mountUserSkills: false,
  }),
  scheduler: z.object({
    maxActiveContainers: z.number().min(1).default(16).description('Maximum concurrent warm containers across the host'),
    maxConcurrentTasks: z.number().min(1).default(8).description('Maximum concurrent command executions across the host'),
    maxConcurrencyPerWorkspace: z.number().min(1).default(2).description('Maximum concurrent command executions per workspace'),
    maxQueueSize: z.number().min(0).default(64).description('Maximum waiting executions before fast-failing'),
    queueTimeoutMs: z.number().min(1000).default(60_000).description('Maximum wait time in milliseconds before a queued command times out'),
    idleTtlMs: z.number().min(1000).default(600_000).description('Idle TTL in milliseconds before reaping an unused warm container'),
  }).default({
    maxActiveContainers: 16,
    maxConcurrentTasks: 8,
    maxConcurrencyPerWorkspace: 2,
    maxQueueSize: 64,
    queueTimeoutMs: 60_000,
    idleTtlMs: 600_000,
  }),
  security: z.object({
    networkMode: z.string().default('none').description('Docker network mode (default: none for offline isolation)'),
    cpus: z.number().min(0.1).default(2).description('CPU cores limit per container'),
    pidsLimit: z.number().min(16).default(256).description('Maximum process count per container'),
    user: z.string().default('1000:1000').description('Non-root UID:GID inside the container'),
  }).default({
    networkMode: 'none',
    cpus: 2,
    pidsLimit: 256,
    user: '1000:1000',
  }),
})

export class DockerSubprocessRuntime extends SubprocessRuntime {
  static Config = DockerSubprocessConfigSchema

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
      const { dockerClient, ...rawPoolConfig } = config
      const workspace = rawPoolConfig.workspace
      const userResolveAllowed = workspace.resolveAllowedBaseDirs
      const userResolveRo = workspace.resolveReadOnlyMounts

      const resolveAllowedBaseDirs = workspace.trustRegisteredWorkspaces || userResolveAllowed
        ? (): readonly string[] => [
          ...(userResolveAllowed ? userResolveAllowed() : []),
          ...(workspace.trustRegisteredWorkspaces ? collectRegisteredWorkspacePaths(ctx) : []),
        ]
        : undefined

      const resolveReadOnlyMounts = workspace.mountAttachments || workspace.mountUserSkills || userResolveRo
        ? (workspaceRoot: string): readonly string[] => [
          ...(userResolveRo ? userResolveRo(workspaceRoot) : []),
          ...collectDefaultReadOnlyMounts(ctx, {
            mountAttachments: workspace.mountAttachments,
            mountUserSkills: workspace.mountUserSkills,
          }),
        ]
        : undefined

      const poolConfig: DockerRuntimePoolConfig = {
        ...rawPoolConfig,
        workspace: {
          ...workspace,
          ...(resolveAllowedBaseDirs ? { resolveAllowedBaseDirs } : {}),
          ...(resolveReadOnlyMounts ? { resolveReadOnlyMounts } : {}),
        },
      }
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
    return this.runWithExecutionOptions({ accessMode }, fn)
  }

  /**
   * Run a synchronous or async callback with scoped container execution options
   * (access mode, ephemeral isolation, and validated extra read-only host mounts).
   */
  runWithExecutionOptions<T>(options: SubprocessExecutionOptions, fn: () => T): T {
    return executionOptionsScope.run(options, fn)
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

    if (isHostRipgrepBinary(command)) {
      return '/usr/bin/rg'
    }

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
    const scoped = executionOptionsScope.getStore()
    const handle = this.pool.spawn(spec, {
      accessMode: scoped?.accessMode ?? 'rw',
      ephemeral: scoped?.ephemeral,
      extraReadOnlyMounts: scoped?.extraReadOnlyMounts,
    })
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

export const dockerSubprocessPlugin = createServiceHandoffPlugin({
  name: 'DockerSubprocessRuntime',
  serviceName: 'subprocess',
  Config: DockerSubprocessRuntime.Config,
  instantiate: (ctx, config: DockerSubprocessConfig) => new DockerSubprocessRuntime(ctx, config),
})

export default dockerSubprocessPlugin
