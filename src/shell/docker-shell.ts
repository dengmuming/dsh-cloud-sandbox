/**
 * Policy-aware `ctx.shell` executor for Docker sandboxed execution.
 *
 * Extends `@deepseek-ai/dsh-bash-local` so all upstream timeout, output truncation,
 * spill recovery, and background job mechanics stay intact, while enforcing:
 * - `ctx.sandboxPolicy` resolution (`read-only` vs `workspace-write`)
 * - Fail-closed refusal of `danger-full-access` escalations by default (`allowDangerFullAccess: false`)
 * - Optional interactive approval handoff (`allowApprovedHostReadOnly: true`): when DSH's
 *   `ctx.approval` explicitly approves one command (`danger-full-access`), mounts ONLY the
 *   non-sensitive host file(s)/directories referenced by that command strictly read-only (`:ro`)
 *   into a one-shot ephemeral hardened container (never executing on the host and never
 *   exposing sensitive system/credential paths).
 * - Automatic Windows/host -> container POSIX path translation for mounted workspace, attachments,
 *   Skills, and approved read-only files so Linux tools inside Docker open them directly.
 * - Accurate `result.sandbox` denial detection for EROFS / permission / unmounted host-path failures.
 */

import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LocalBashExecutor, type Config as LocalBashConfig } from '@deepseek-ai/dsh-bash-local'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { ResolvedWorkspace } from '../workspace/workspace-policy.ts'
import type { SubprocessExecutionOptions } from '../subprocess/docker-subprocess.ts'
import type { DockerRuntimePool } from '../docker/runtime-pool.ts'
import { DockerSandboxError, WorkspacePolicyError } from '../types.ts'
import type { WorkspaceAccessMode } from '../types.ts'
import { createServiceHandoffPlugin } from '../cordis/service-handoff.ts'
import { canonicalizeHostPath, isPathContained, toPosixPath } from '../workspace/workspace-policy.ts'
import { isWindowsDrivePath, parseWslUncPath } from '../workspace/wsl-paths.ts'

export interface DockerShellConfig extends LocalBashConfig {
  /**
   * Whether `danger-full-access` policy escalations are permitted unconditionally.
   * Default: `false` (cloud multi-tenant deployments should fail-closed and never bypass container confinement).
   */
  allowDangerFullAccess?: boolean
  /**
   * Interactive approval mode for host files outside the workspace.
   * When `true` (and `allowDangerFullAccess` is `false`), a command explicitly approved via DSH's
   * `ctx.approval` (`sandboxPolicy.mode === 'danger-full-access'`) still runs inside a hardened
   * ephemeral Linux Docker container, mounting ONLY the validated non-sensitive host files/dirs
   * referenced in that command strictly read-only (`:ro`).
   * Default: `false` (strict fail-closed for headless/cloud hosts).
   */
  allowApprovedHostReadOnly?: boolean
  /** Fallback sandbox mode when `ctx.sandboxPolicy` is not mounted. Default: `'workspace-write'`. */
  defaultSandboxMode?: SandboxMode
}

interface DockerSubprocessBridge {
  readonly pool?: DockerRuntimePool
  runWithAccessMode?: <T>(mode: WorkspaceAccessMode, fn: () => T) => T
  runWithExecutionOptions?: <T>(options: SubprocessExecutionOptions, fn: () => T) => T
}

interface ProcessSandboxContext {
  readonly mode: SandboxMode
  readonly hasUnmountedHostPaths: boolean
}

const READ_ONLY_DENIAL_PATTERNS = [
  'read-only file system',
  'erofs',
  'permission denied',
  'operation not permitted',
] as const

const UNMOUNTED_HOST_PATH_ERROR_PATTERNS = [
  'no such file or directory',
  'cannot open',
  'cannot access',
  'file not found',
  'filenotfounderror',
  'enoent',
  'does not exist',
] as const

// Matches quoted or unquoted Windows drive paths (`C:\...`, `D:/...`), WSL UNC paths, and POSIX absolute paths.
const QUOTED_HOST_PATH_RE = /(["'])((?:[a-zA-Z]:[/\\]|\\\\wsl(?:\.localhost|\$)\\|\/)[^"'\r\n]+?)\1/g
const UNQUOTED_WIN_PATH_RE = /(?:^|[\s=:(;,])([a-zA-Z]:[/\\][^\s"'`<>|;()&]+)/g
const UNQUOTED_POSIX_PATH_RE = /(?:^|[\s=:(;,])(\/(?:[A-Za-z0-9._@+-]+\/)+[A-Za-z0-9._@+-]+)/g

function matchesAnyPattern(exitCode: number | null, stderr: string, patterns: readonly string[]): boolean {
  if (exitCode === null || exitCode === 0) return false
  const lower = stderr.toLowerCase()
  return patterns.some(sig => lower.includes(sig))
}

function isSandboxDenied(ctx: ProcessSandboxContext, exitCode: number | null, stderr: string): boolean {
  if (ctx.mode === 'read-only' && matchesAnyPattern(exitCode, stderr, READ_ONLY_DENIAL_PATTERNS)) {
    return true
  }
  if (ctx.hasUnmountedHostPaths && matchesAnyPattern(exitCode, stderr, UNMOUNTED_HOST_PATH_ERROR_PATTERNS)) {
    return true
  }
  return false
}

/**
 * Extract absolute host paths explicitly mentioned in a shell command that actually exist on disk.
 * Returns raw + canonical pairs for path validation and container path rewriting.
 */
export function extractExistingHostPathsFromCommand(command: string): Array<{ raw: string; canonical: string }> {
  const rawCandidates = new Set<string>()

  for (const match of command.matchAll(QUOTED_HOST_PATH_RE)) {
    const candidate = match[2]?.trim()
    if (candidate) rawCandidates.add(candidate)
  }
  for (const match of command.matchAll(UNQUOTED_WIN_PATH_RE)) {
    const candidate = match[1]?.replace(/[.,;:!?]+$/, '')
    if (candidate) rawCandidates.add(candidate)
  }
  if (process.platform !== 'win32') {
    for (const match of command.matchAll(UNQUOTED_POSIX_PATH_RE)) {
      const candidate = match[1]?.replace(/[.,;:!?]+$/, '')
      if (candidate) rawCandidates.add(candidate)
    }
  }

  const found: Array<{ raw: string; canonical: string }> = []
  const seenRaw = new Set<string>()
  for (const raw of rawCandidates) {
    if (seenRaw.has(raw)) continue
    seenRaw.add(raw)
    if (!isWindowsDrivePath(raw) && !parseWslUncPath(raw) && !raw.startsWith('/')) continue
    try {
      if (!existsSync(raw)) continue
      const canonical = canonicalizeHostPath(raw)
      found.push({ raw, canonical })
    } catch {
      // Ignore syntactically invalid or inaccessible paths.
    }
  }
  return found
}

/**
 * Rewrite host paths inside a shell command string to their mounted container POSIX paths
 * when the host path differs from its container path (e.g., Windows `C:\...` -> `/mnt/c/...`
 * or `remap` mode `/host/ws/...` -> `/workspace/...`).
 */
export function rewriteMountedHostPathsInCommand(command: string, resolved: ResolvedWorkspace): string {
  const replacements: Array<{ from: string; to: string }> = []
  const seen = new Set<string>()

  const addReplacement = (from: string, to: string): void => {
    if (!from || from === to || seen.has(from)) return
    seen.add(from)
    replacements.push({ from, to })
  }

  for (const mount of resolved.mounts) {
    if (mount.hostPath === mount.containerPath) continue
    addReplacement(mount.hostPath, mount.containerPath)
    const posixHost = toPosixPath(mount.hostPath)
    if (posixHost !== mount.hostPath) {
      addReplacement(posixHost, mount.containerPath)
    }
  }

  for (const { raw, canonical } of extractExistingHostPathsFromCommand(command)) {
    const containerPath = resolved.toContainerPath(canonical)
    if (containerPath && raw !== containerPath) {
      addReplacement(raw, containerPath)
    }
  }

  if (replacements.length === 0) return command
  // Longest-prefix first so nested paths don't get partially rewritten by parent mount prefixes.
  replacements.sort((a, b) => b.from.length - a.from.length)

  let rewritten = command
  for (const { from, to } of replacements) {
    if (rewritten.includes(from)) {
      rewritten = rewritten.split(from).join(to)
    }
    // Also handle case-insensitive Windows drive letters (e.g. `c:\...` vs `C:\...`).
    if (isWindowsDrivePath(from)) {
      const toggled = (from[0] === from[0]?.toUpperCase() ? from[0]?.toLowerCase() : from[0]?.toUpperCase()) + from.slice(1)
      if (rewritten.includes(toggled)) {
        rewritten = rewritten.split(toggled).join(to)
      }
    }
  }
  return rewritten
}

export class DockerShellExecutor extends LocalBashExecutor {
  static override inject = ['subprocess']

  static override Config: typeof LocalBashExecutor.Config = z.object({
    cwd: z.string().volatile(),
    timeoutMs: z.number().default(120_000).volatile(),
    maxTimeoutMs: z.number().default(600_000).volatile(),
    maxOutputBytes: z.number().default(64_000).volatile(),
    maxSpillBytes: z.number().default(64 * 1024 * 1024).volatile(),
    graceMs: z.number().default(3_000).volatile(),
    allowDangerFullAccess: z.boolean().default(false).description('Allow unrestricted sandbox escalation (keep false for hardened sandboxes)'),
    allowApprovedHostReadOnly: z.boolean().default(false).description('When user approves a host-file command via DSH approval prompt, mount only those validated non-sensitive host paths read-only into an ephemeral container'),
    defaultSandboxMode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const).default('workspace-write').description('Fallback sandbox mode when ctx.sandboxPolicy is absent'),
  }) as unknown as typeof LocalBashExecutor.Config

  private readonly allowDangerFullAccess: boolean
  private readonly allowApprovedHostReadOnly: boolean
  private readonly fallbackMode: SandboxMode
  private readonly contextByProcess = new Map<ShellProcess, ProcessSandboxContext>()

  constructor(ctx: Context, config: DockerShellConfig) {
    super(ctx, config)
    this.allowDangerFullAccess = config.allowDangerFullAccess ?? false
    this.allowApprovedHostReadOnly = config.allowApprovedHostReadOnly ?? false
    this.fallbackMode = config.defaultSandboxMode ?? 'workspace-write'
  }

  private resolvePolicy(request?: ShellExecRequest): SandboxExecutionPolicy {
    if (request?.sandboxPolicy) return request.sandboxPolicy
    const policyService = this.ctx.get('sandboxPolicy') as SandboxPolicyService | undefined
    if (policyService) return policyService.resolve()
    return {
      mode: this.fallbackMode,
      workspaceRoot: request?.workdir ?? this.config.cwd.get() ?? process.cwd(),
    }
  }

  override get sandboxMode(): SandboxMode {
    const policyService = this.ctx.get('sandboxPolicy') as SandboxPolicyService | undefined
    return policyService?.defaultMode ?? this.fallbackMode
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    const base = super.resolve(request)
    return {
      ...base,
      sandboxPolicy: this.resolvePolicy(request),
    }
  }

  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const policy = spec.sandboxPolicy ?? this.resolvePolicy({ command: spec.command, workdir: spec.workdir })
    const mode = policy.mode

    if (mode === 'danger-full-access' && !this.allowDangerFullAccess && !this.allowApprovedHostReadOnly) {
      throw new DockerSandboxError(
        'SANDBOX_ESCALATION_DENIED',
        'sandbox mode "danger-full-access" is disabled by DockerShellExecutor policy',
      )
    }

    const subprocess = this.ctx.subprocess as unknown as DockerSubprocessBridge
    const pool = subprocess.pool
    let effectiveWorkdir = spec.workdir
    let approvedHostReadOnlyMounts: string[] | undefined

    if (mode === 'danger-full-access' && !this.allowDangerFullAccess && this.allowApprovedHostReadOnly) {
      // User explicitly approved this single command via DSH's approval prompt.
      // Never fall back to host execution: instead mount ONLY the validated non-sensitive
      // referenced host files/directories read-only (:ro) into a one-shot ephemeral container.
      const candidates = new Set<string>()
      for (const item of extractExistingHostPathsFromCommand(spec.command)) {
        candidates.add(item.canonical)
      }
      if (policy.workspaceRoot) {
        const canonicalRoot = canonicalizeHostPath(policy.workspaceRoot)
        const canonicalWorkdir = canonicalizeHostPath(spec.workdir)
        if (!isPathContained(canonicalWorkdir, canonicalRoot)) {
          candidates.add(canonicalWorkdir)
          // Run the ephemeral container anchored at the session workspace so workspace writes stay confined there.
          effectiveWorkdir = policy.workspaceRoot
        }
      }

      if (pool) {
        const baseResolved = pool.resolveWorkspace(effectiveWorkdir, 'rw')
        const extraMounts: string[] = []
        for (const candidate of candidates) {
          if (baseResolved.toContainerPath(candidate)) continue
          extraMounts.push(pool.validateApprovedReadOnlyPath(candidate))
        }
        if (extraMounts.length > 0) {
          approvedHostReadOnlyMounts = extraMounts
        }
      }
    } else if (mode !== 'danger-full-access' && policy.workspaceRoot) {
      // Prevent cross-workspace escape when multiple workspaces share one allowedBaseDirs root.
      const canonicalRoot = canonicalizeHostPath(policy.workspaceRoot)
      const canonicalWorkdir = canonicalizeHostPath(spec.workdir)
      if (!isPathContained(canonicalWorkdir, canonicalRoot)) {
        throw new WorkspacePolicyError(
          `workdir ${JSON.stringify(spec.workdir)} is outside active sandbox workspaceRoot ${JSON.stringify(policy.workspaceRoot)}`,
        )
      }
    }

    const accessMode: WorkspaceAccessMode = mode === 'read-only' ? 'ro' : 'rw'
    let commandForContainer = spec.command
    let hasUnmountedHostPaths = false

    if (pool) {
      const resolved = pool.resolveWorkspace(effectiveWorkdir, accessMode, approvedHostReadOnlyMounts)
      commandForContainer = rewriteMountedHostPathsInCommand(spec.command, resolved)
      if (mode !== 'danger-full-access') {
        const referenced = extractExistingHostPathsFromCommand(spec.command)
        hasUnmountedHostPaths = referenced.some(({ canonical }) => !resolved.toContainerPath(canonical))
      }
    }

    const effectiveSpec: ShellExecSpec = effectiveWorkdir === spec.workdir
      ? spec
      : { ...spec, workdir: effectiveWorkdir }
    const sandboxCtx: ProcessSandboxContext = { mode, hasUnmountedHostPaths }

    const runExecute = () => this.executeArgv(
      effectiveSpec,
      ['bash', '-c', commandForContainer],
      (proc) => {
        this.contextByProcess.set(proc, sandboxCtx)
      },
    )

    const execOptions: SubprocessExecutionOptions = {
      accessMode,
      ...(approvedHostReadOnlyMounts ? { ephemeral: true, extraReadOnlyMounts: approvedHostReadOnlyMounts } : {}),
    }

    const execution = typeof subprocess.runWithExecutionOptions === 'function'
      ? await subprocess.runWithExecutionOptions(execOptions, runExecute)
      : typeof subprocess.runWithAccessMode === 'function'
        ? await subprocess.runWithAccessMode(accessMode, runExecute)
        : await runExecute()

    const originalResult = execution.result.bind(execution)
    let decorated: Promise<ShellRunResult> | undefined
    execution.result = () => {
      decorated ??= originalResult().then((result) => ({
        ...result,
        sandbox: {
          mode,
          denied: isSandboxDenied(sandboxCtx, result.exitCode, result.stderr.text),
          enforcement: 'full',
        },
      }))
      return decorated
    }

    return execution
  }

  protected override onProcessDone(
    proc: ShellProcess,
    stderr: string,
    providerRejected: boolean,
    providerError?: unknown,
  ): void {
    const sandboxCtx = this.contextByProcess.get(proc)
    if (sandboxCtx !== undefined) {
      this.contextByProcess.delete(proc)
      proc.sandbox = {
        mode: sandboxCtx.mode,
        denied: !providerRejected && isSandboxDenied(sandboxCtx, proc.exitCode, stderr),
        enforcement: 'full',
      }
    }
    super.onProcessDone(proc, stderr, providerRejected, providerError)
  }
}

export const dockerShellPlugin = createServiceHandoffPlugin({
  name: 'DockerShellExecutor',
  serviceName: 'shell',
  inject: DockerShellExecutor.inject,
  Config: DockerShellExecutor.Config,
  instantiate: (ctx, config: DockerShellConfig) => new DockerShellExecutor(ctx, config),
})

export default dockerShellPlugin
