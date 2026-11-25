/**
 * Optional strict read+write workspace-fenced `ctx.fs` provider for standalone DSH deployments.
 *
 * Unlike `@deepseek-ai/dsh-fs-sandbox` (which allows arbitrary host reads to pass through),
 * `WorkspaceFencedFileSystem` fences EVERY read, listing, watch, and mutation strictly to
 * `allowedBaseDirs` (and configured `readOnlyMounts` for reads only), rejecting symlink escapes
 * and sensitive host paths.
 *
 * Note: Cloud hosts that already mount their own strict workspace-fenced `ctx.fs` provider do not need
 * this plugin; they only need `DockerSubprocessRuntime` (+ optional `DockerShellExecutor`).
 */

import { readdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {
  FsDeleteOutcome,
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsMoveOutcome,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { LocalFileSystem, type Config as LocalFsConfig } from '@deepseek-ai/dsh-fs-local'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { WorkspacePolicyConfig } from '../types.ts'
import { createServiceHandoffPlugin } from '../cordis/service-handoff.ts'
import { WorkspacePolicy, canonicalizeHostPath, isPathContained } from '../workspace/workspace-policy.ts'

export interface WorkspaceFencedFsConfig extends LocalFsConfig, Partial<WorkspacePolicyConfig> {
  /** Whether `danger-full-access` bypasses write fencing. Default: `false`. */
  readonly allowDangerFullAccess?: boolean
}

export class WorkspaceFencedFileSystem extends LocalFileSystem {
  static override Config: z<WorkspaceFencedFsConfig> = z.any() as unknown as z<WorkspaceFencedFsConfig>

  private readonly policy: WorkspacePolicy
  private readonly allowDangerFullAccess: boolean
  private readonly defaultCwd: string

  constructor(ctx: Context, config: WorkspaceFencedFsConfig) {
    const allowedBaseDirs = config.allowedBaseDirs ?? []
    const defaultCwd = config.cwd ?? allowedBaseDirs[0] ?? process.cwd()
    super(ctx, { cwd: defaultCwd, diffBasisMaxBytes: config.diffBasisMaxBytes ?? 10 * 1024 * 1024 })
    this.policy = new WorkspacePolicy({ ...config, allowedBaseDirs })
    this.allowDangerFullAccess = config.allowDangerFullAccess ?? false
    this.defaultCwd = defaultCwd
  }

  override get sandboxMode(): SandboxMode {
    const policyService = this.ctx.get('sandboxPolicy') as SandboxPolicyService | undefined
    return policyService?.defaultMode ?? 'workspace-write'
  }

  private assertRawPath(
    rawPath: string,
    cwd?: string,
    mutation = false,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): string {
    const base = cwd ?? this.defaultCwd
    const absolute = isAbsolute(rawPath) ? rawPath : resolve(base, rawPath)
    let canonical: string
    try {
      canonical = this.policy.assertPathAllowed(absolute, {
        allowReadOnlyMounts: !mutation,
        workspaceRoot: sandboxPolicy?.workspaceRoot ?? base,
      })
    } catch (error) {
      throw new FsError(
        error instanceof Error ? error.message : 'path is outside allowed workspace',
        'FS_SANDBOX_DENIED',
      )
    }

    // When a per-call or session sandboxPolicy defines a workspaceRoot, also prevent
    // crossing into sibling workspaces under the same allowedBaseDirs root.
    const policyService = this.ctx.get('sandboxPolicy') as SandboxPolicyService | undefined
    const effective = sandboxPolicy ?? policyService?.resolve()
    if (effective?.workspaceRoot && effective.mode !== 'danger-full-access') {
      const canonicalRoot = canonicalizeHostPath(effective.workspaceRoot)
      const inWorkspace = isPathContained(canonical, canonicalRoot)
      if (!inWorkspace) {
        if (mutation) {
          throw new FsError(
            `cannot modify "${rawPath}": path is outside active workspaceRoot`,
            'FS_SANDBOX_DENIED',
          )
        }
        // Reads outside active workspaceRoot are allowed ONLY if explicitly in read-only mounts (e.g., Skills).
        try {
          const insideAnyAllowedBase = this.policy.assertPathAllowed(canonical, { allowReadOnlyMounts: false })
          if (insideAnyAllowedBase) {
            throw new FsError(
              `cannot read "${rawPath}": path belongs to another workspace outside active workspaceRoot`,
              'FS_SANDBOX_DENIED',
            )
          }
        } catch (err) {
          if (err instanceof FsError) throw err
          // Not inside allowedBaseDirs, meaning assertPathAllowed above accepted it via readOnlyMounts!
        }
      }
    }
    return canonical
  }

  private assertTarget(target: FsTarget, mutation = false, sandboxPolicy?: SandboxExecutionPolicy): void {
    if (mutation) {
      const policyService = this.ctx.get('sandboxPolicy') as SandboxPolicyService | undefined
      const effective = sandboxPolicy ?? policyService?.resolve()
      if (effective?.mode === 'read-only') {
        throw new FsError(
          `cannot modify "${target.displayPath}": file access denied under read-only mode`,
          'FS_SANDBOX_DENIED',
        )
      }
      if (effective?.mode === 'danger-full-access' && !this.allowDangerFullAccess) {
        throw new FsError(
          `cannot modify "${target.displayPath}": danger-full-access is disabled`,
          'FS_SANDBOX_DENIED',
        )
      }
    }
    const keyPath = String(target.targetKey)
    if (!isAbsolute(keyPath) || !isAbsolute(target.displayPath)) {
      throw new FsError('path is outside allowed workspace', 'FS_SANDBOX_DENIED')
    }
    this.assertRawPath(keyPath, undefined, mutation, sandboxPolicy)
    this.assertRawPath(target.displayPath, undefined, mutation, sandboxPolicy)
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    this.assertRawPath(path, opts?.cwd, false)
    const target = await super.resolve(path, opts)
    this.assertTarget(target, false)
    return target
  }

  override processPath(target: FsTarget): string {
    this.assertTarget(target, false)
    return super.processPath(target)
  }

  override processPathFromHostPath(hostPath: string): string | undefined {
    try {
      this.assertRawPath(hostPath, undefined, false)
      return super.processPathFromHostPath(hostPath)
    } catch {
      return undefined
    }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal) {
    this.assertRawPath(path, opts?.cwd, false)
    return super.lstat(path, opts, signal)
  }

  override async stat(target: FsTarget, signal?: AbortSignal) {
    this.assertTarget(target, false)
    return super.stat(target, signal)
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    this.assertTarget(target, false)
    const content = await super.readText(target, signal)
    this.assertTarget(target, false)
    return content
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    this.assertTarget(target, false)
    const source = await super.streamText(target, signal)
    const check = () => this.assertTarget(target, false)
    return (async function* () {
      for await (const chunk of source) {
        check()
        yield chunk
      }
    })()
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    this.assertTarget(target, false)
    const bytes = await super.readBytes(target, signal, maxBytes)
    this.assertTarget(target, false)
    return bytes
  }

  override async readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    this.assertTarget(target, false)
    return super.readByteRange(target, range, signal)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    this.assertTarget(target, false)
    const entries: FsDirEntry[] = []
    const dirPath = String(target.targetKey)
    for (const entry of readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted()
      if (!entry.isFile() && !entry.isDirectory()) continue
      const childPath = join(dirPath, entry.name)
      try {
        this.assertRawPath(childPath, undefined, false)
      } catch {
        continue
      }
      const child = await this.resolve(childPath, signal === undefined ? {} : { signal })
      const info = await this.stat(child, signal)
      if (info) {
        entries.push({
          name: entry.name,
          type: info.type,
          target: child,
          version: info.version,
          ...(info.size === undefined ? {} : { size: info.size }),
        })
      }
    }
    this.assertTarget(target, false)
    return entries
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    this.assertTarget(target, true, sandboxPolicy)
    return super.writeText(target, content, expected, signal)
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    this.assertTarget(target, true, sandboxPolicy)
    return super.editText(target, edit, expected, signal)
  }

  override async patchText(
    target: FsTarget,
    hunks: Parameters<LocalFileSystem['patchText']>[1],
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    this.assertTarget(target, true, sandboxPolicy)
    return super.patchText(target, hunks, expected, signal)
  }

  override async deleteFile(
    target: FsTarget,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsDeleteOutcome> {
    this.assertTarget(target, true, sandboxPolicy)
    return super.deleteFile(target, expected, signal)
  }

  override async moveFile(
    source: FsTarget,
    destination: FsTarget,
    options: Parameters<LocalFileSystem['moveFile']>[2],
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsMoveOutcome> {
    this.assertTarget(source, true, sandboxPolicy)
    this.assertTarget(destination, true, sandboxPolicy)
    return super.moveFile(source, destination, options, signal)
  }

  override async watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal) {
    this.assertTarget(target, false)
    return super.watch(
      target,
      (error) => {
        try {
          this.assertTarget(target, false)
        } catch (failure) {
          changed(failure instanceof Error ? failure : new Error('file access denied'))
          return
        }
        changed(error)
      },
      signal,
    )
  }
}

export const workspaceFencedFsPlugin = createServiceHandoffPlugin({
  name: 'WorkspaceFencedFileSystem',
  serviceName: 'fs',
  Config: WorkspaceFencedFileSystem.Config,
  instantiate: (ctx, config: WorkspaceFencedFsConfig) => new WorkspaceFencedFileSystem(ctx, config),
})

export default workspaceFencedFsPlugin
