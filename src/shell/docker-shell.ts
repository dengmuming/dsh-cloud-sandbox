/**
 * Policy-aware `ctx.shell` executor for Docker sandboxed execution.
 *
 * Extends `@deepseek-ai/dsh-bash-local` so all upstream timeout, output truncation,
 * spill recovery, and background job mechanics stay intact, while enforcing:
 * - `ctx.sandboxPolicy` resolution (`read-only` vs `workspace-write`)
 * - Fail-closed refusal of `danger-full-access` escalations by default (`allowDangerFullAccess: false`)
 * - Container-level `:ro` workspace mounting when running under `read-only` policy
 * - Accurate `result.sandbox` denial detection for EROFS / permission failures
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LocalBashExecutor, type Config as LocalBashConfig } from '@deepseek-ai/dsh-bash-local'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { DockerSandboxError, WorkspacePolicyError } from '../types.ts'
import type { WorkspaceAccessMode } from '../types.ts'
import { canonicalizeHostPath, isPathContained } from '../workspace/workspace-policy.ts'

export interface DockerShellConfig extends LocalBashConfig {
  /**
   * Whether `danger-full-access` policy escalations are permitted.
   * Default: `false` (cloud multi-tenant deployments should fail-closed and never bypass container confinement).
   */
  allowDangerFullAccess?: boolean
  /** Fallback sandbox mode when `ctx.sandboxPolicy` is not mounted. Default: `'workspace-write'`. */
  defaultSandboxMode?: SandboxMode
}

const READ_ONLY_DENIAL_PATTERNS = [
  'read-only file system',
  'erofs',
  'permission denied',
  'operation not permitted',
] as const

function matchesReadOnlyDenial(exitCode: number | null, stderr: string): boolean {
  if (exitCode === null || exitCode === 0) return false
  const lower = stderr.toLowerCase()
  return READ_ONLY_DENIAL_PATTERNS.some(sig => lower.includes(sig))
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
    allowDangerFullAccess: z.boolean().default(false),
    defaultSandboxMode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const).default('workspace-write'),
  }) as unknown as typeof LocalBashExecutor.Config

  private readonly allowDangerFullAccess: boolean
  private readonly fallbackMode: SandboxMode
  private readonly modeByProcess = new Map<ShellProcess, SandboxMode>()

  constructor(ctx: Context, config: DockerShellConfig) {
    super(ctx, config)
    this.allowDangerFullAccess = config.allowDangerFullAccess ?? false
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

    if (mode === 'danger-full-access' && !this.allowDangerFullAccess) {
      throw new DockerSandboxError(
        'SANDBOX_ESCALATION_DENIED',
        'sandbox mode "danger-full-access" is disabled by DockerShellExecutor policy',
      )
    }

    // Prevent cross-workspace escape when multiple workspaces share one allowedBaseDirs root.
    if (mode !== 'danger-full-access' && policy.workspaceRoot) {
      const canonicalRoot = canonicalizeHostPath(policy.workspaceRoot)
      const canonicalWorkdir = canonicalizeHostPath(spec.workdir)
      if (!isPathContained(canonicalWorkdir, canonicalRoot)) {
        throw new WorkspacePolicyError(
          `workdir ${JSON.stringify(spec.workdir)} is outside active sandbox workspaceRoot ${JSON.stringify(policy.workspaceRoot)}`,
        )
      }
    }

    const accessMode: WorkspaceAccessMode = mode === 'read-only' ? 'ro' : 'rw'
    const subprocess = this.ctx.subprocess as unknown as {
      runWithAccessMode?: <T>(mode: WorkspaceAccessMode, fn: () => T) => T
    }
    const runExecute = () => this.executeArgv(
      spec,
      ['bash', '-c', spec.command],
      (proc) => {
        this.modeByProcess.set(proc, mode)
      },
    )

    const execution = typeof subprocess.runWithAccessMode === 'function'
      ? await subprocess.runWithAccessMode(accessMode, runExecute)
      : await runExecute()

    const originalResult = execution.result.bind(execution)
    let decorated: Promise<ShellRunResult> | undefined
    execution.result = () => {
      decorated ??= originalResult().then((result) => ({
        ...result,
        sandbox: {
          mode,
          denied: mode === 'read-only' && matchesReadOnlyDenial(result.exitCode, result.stderr.text),
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
    const mode = this.modeByProcess.get(proc)
    if (mode !== undefined) {
      this.modeByProcess.delete(proc)
      proc.sandbox = {
        mode,
        denied: !providerRejected && mode === 'read-only' && matchesReadOnlyDenial(proc.exitCode, stderr),
        enforcement: 'full',
      }
    }
    super.onProcessDone(proc, stderr, providerRejected, providerError)
  }
}

export default DockerShellExecutor
