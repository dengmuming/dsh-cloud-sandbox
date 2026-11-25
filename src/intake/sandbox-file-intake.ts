/**
 * Sandbox file intake plugin (`dsh-cloud-sandbox/intake`).
 *
 * Bridges files into the active sandbox workspace without exposing global cross-tenant storage
 * or unapproved host directories:
 *
 * - **Channel A — Per-session uploaded attachment staging (`stageSessionAttachments`, Cloud & Local)**:
 *   Observes `session/event` (`user/message` with `type: 'file'` attachments) and stages ONLY that
 *   session's uploaded files from `ctx.attachments` into `<workspaceRoot>/.dsh-uploads/<filename>`.
 *   This eliminates any need to mount a global shared `$DSH_HOME/attachments` directory, keeping
 *   multi-tenant cloud deployments strictly isolated per workspace.
 *
 * - **Channel B — User-approved host file import (`enableHostFileImport`, Local interactive only)**:
 *   Registers the `sandbox_import_file` tool on `ctx.tools`. Before copying any host file into
 *   `<workspaceRoot>/.dsh-uploads/`, it strictly validates every path against sensitive system and
 *   credential denylists, verifies regular-file type and size limits, and requires explicit
 *   interactive user confirmation via `ctx.approval.request()`. Disabled in cloud deployments.
 */

import { createWriteStream, existsSync, lstatSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { copyFile, mkdir, rename, rm } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { DockerRuntimePool } from '../docker/runtime-pool.ts'
import { DockerSandboxError, WorkspacePolicyError } from '../types.ts'
import { canonicalizeHostPath, isPathContained } from '../workspace/workspace-policy.ts'

export interface SandboxFileIntakeConfig {
  /** Relative subdirectory inside the workspace where staged/imported files are stored. Default: `'.dsh-uploads'`. */
  readonly uploadsDir?: string
  /**
   * Automatically stage files uploaded in a session's user messages (`type: 'file'`) into that
   * session's `<workspaceRoot>/<uploadsDir>/`. Safe for both cloud multi-tenant and local deployments.
   * Default: `true`.
   */
  readonly stageSessionAttachments?: boolean
  /**
   * Register the approval-gated `sandbox_import_file` tool for copying user-approved local host files
   * into `<workspaceRoot>/<uploadsDir>/`. MUST stay `false` in multi-tenant cloud deployments.
   * Default: `false`.
   */
  readonly enableHostFileImport?: boolean
  /** Maximum bytes allowed for a single imported host file. Default: 100 MiB. */
  readonly maxFileBytes?: number
  /** Maximum aggregate bytes allowed in one `sandbox_import_file` call. Default: 256 MiB. */
  readonly maxTotalBytes?: number
  /** Maximum number of files imported in one `sandbox_import_file` call. Default: 32. */
  readonly maxFilesPerCall?: number
}

interface SubprocessWithPool {
  readonly pool?: DockerRuntimePool
}

interface FileAttachmentRefLike {
  readonly attachmentId?: string
  readonly name?: string
  readonly bytes?: number
}

interface AttachmentStoreLike {
  fileHostPath?: (ref: FileAttachmentRefLike) => string | undefined
  readFileStream?: (ref: FileAttachmentRefLike, signal?: AbortSignal) => AsyncIterable<Uint8Array>
}

interface WorkingDirectoryLike {
  get?: (session: unknown) => string | undefined
  ensure?: (agent: unknown, signal?: AbortSignal) => Promise<string>
}

interface ApprovalServiceLike {
  request: (req: {
    readonly agent: unknown
    readonly toolName: string
    readonly callId?: unknown
    readonly reason?: string
    readonly signal?: AbortSignal
  }) => Promise<string>
}

interface ToolRunContextLike {
  readonly callId?: unknown
  readonly agent?: { readonly session?: unknown }
  readonly signal?: AbortSignal
}

interface ToolsRegistryLike {
  register: (definition: Record<string, unknown>) => () => void
}

interface SessionLike {
  readonly header?: { readonly cwd?: string }
}

interface SessionEventLike {
  readonly type?: string
  readonly data?: {
    readonly content?: ReadonlyArray<{
      readonly type?: string
      readonly attachment?: FileAttachmentRefLike
    }>
  }
}

export interface ImportedSandboxFile {
  readonly source: string
  readonly workspacePath: string
  readonly containerPath: string
  readonly bytes: number
}

export interface SandboxImportResult {
  readonly imported: readonly ImportedSandboxFile[]
  readonly targetDir: string
  readonly containerTargetDir: string
}

const DEFAULT_UPLOADS_DIR = '.dsh-uploads'
const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_FILES_PER_CALL = 32
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu

/** Validate that `uploadsDir` is a clean relative subdirectory name inside a workspace. */
export function normalizeUploadsSubdir(uploadsDir: string | undefined): string {
  const raw = (uploadsDir ?? DEFAULT_UPLOADS_DIR).trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
  if (raw.length === 0) return DEFAULT_UPLOADS_DIR
  const segments = raw.split('/').filter(Boolean)
  if (segments.length === 0 || segments.some(s => s === '.' || s === '..' || s.includes('\0'))) {
    throw new WorkspacePolicyError(`invalid uploadsDir ${JSON.stringify(uploadsDir)}: must be a safe relative subdirectory`)
  }
  return segments.join('/')
}

/** Sanitize a leaf filename so it is safe on both POSIX and Windows filesystems. */
export function sanitizeLeafFilename(rawName: string | undefined): string {
  const leaf = rawName
    ? rawName.slice(Math.max(rawName.lastIndexOf('/'), rawName.lastIndexOf('\\')) + 1)
    : 'file'
  let clean = leaf
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/u, '')
  const dot = clean.indexOf('.')
  const stem = (dot < 0 ? clean : clean.slice(0, dot)).replace(/[. ]+$/u, '')
  if (WINDOWS_DEVICE_NAME.test(stem)) {
    clean = `_${clean}`
  }
  if (clean === '' || clean === '.' || clean === '..') return 'file'
  return clean.slice(0, 200)
}

function allocateTargetFilePath(targetDir: string, leafName: string, stableTag?: string): string {
  const safeLeaf = sanitizeLeafFilename(leafName)
  const ext = extname(safeLeaf)
  const stem = ext ? safeLeaf.slice(0, -ext.length) : safeLeaf

  const primary = join(targetDir, safeLeaf)
  if (!existsSync(primary)) return primary

  if (stableTag) {
    const tagged = join(targetDir, `${stem}-${stableTag}${ext}`)
    if (!existsSync(tagged)) return tagged
  }

  for (let i = 2; i <= 10_000; i++) {
    const candidate = join(targetDir, `${stem}-${i}${ext}`)
    if (!existsSync(candidate)) return candidate
  }
  return join(targetDir, `${stem}-${randomBytes(4).toString('hex')}${ext}`)
}

async function copyFileAtomic(sourcePath: string, destPath: string): Promise<void> {
  const tmpPath = `${destPath}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await copyFile(sourcePath, tmpPath)
    await rename(tmpPath, destPath)
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {})
    throw error
  }
}

async function writeStreamAtomic(chunks: AsyncIterable<Uint8Array>, destPath: string): Promise<number> {
  const tmpPath = `${destPath}.${randomBytes(4).toString('hex')}.tmp`
  let totalBytes = 0
  const out = createWriteStream(tmpPath, { mode: 0o644 })
  try {
    for await (const chunk of chunks) {
      totalBytes += chunk.byteLength
      if (!out.write(chunk)) {
        await new Promise<void>((resolveDrain, rejectDrain) => {
          out.once('drain', resolveDrain)
          out.once('error', rejectDrain)
        })
      }
    }
    await new Promise<void>((resolveClose, rejectClose) => {
      out.once('finish', resolveClose)
      out.once('error', rejectClose)
      out.end()
    })
    renameSync(tmpPath, destPath)
    return totalBytes
  } catch (error) {
    out.destroy()
    try { rmSync(tmpPath, { force: true }) } catch {}
    throw error
  }
}

function extractDigestTag(attachmentId: string | undefined): string | undefined {
  if (!attachmentId) return undefined
  const match = /sha256:([a-f0-9]{8})/i.exec(attachmentId)
  return match?.[1]
}

const SandboxFileIntakeConfigSchema = z.object({
  uploadsDir: z.string().default(DEFAULT_UPLOADS_DIR).description('Relative subdirectory inside each workspace for staged/imported files'),
  stageSessionAttachments: z.boolean().default(true).description('Automatically copy files uploaded in a session into that session workspace .dsh-uploads/ directory'),
  enableHostFileImport: z.boolean().default(false).description('Enable the user-approval-gated sandbox_import_file tool for local host files (keep false for multi-tenant cloud deployments)'),
  maxFileBytes: z.number().min(1024).default(DEFAULT_MAX_FILE_BYTES).description('Maximum size in bytes per imported host file'),
  maxTotalBytes: z.number().min(1024).default(DEFAULT_MAX_TOTAL_BYTES).description('Maximum aggregate bytes per sandbox_import_file call'),
  maxFilesPerCall: z.number().min(1).max(128).default(DEFAULT_MAX_FILES_PER_CALL).description('Maximum number of host files per sandbox_import_file call'),
})

export class SandboxFileIntake {
  static inject = ['subprocess']
  static Config = SandboxFileIntakeConfigSchema

  private readonly uploadsSubdir: string
  private readonly stageSessionAttachments: boolean
  private readonly enableHostFileImport: boolean
  private readonly maxFileBytes: number
  private readonly maxTotalBytes: number
  private readonly maxFilesPerCall: number
  private readonly stagedKeys = new Set<string>()
  private readonly inflightTasks = new Set<Promise<void>>()

  constructor(private readonly ctx: Context, config: SandboxFileIntakeConfig = {}) {
    this.uploadsSubdir = normalizeUploadsSubdir(config.uploadsDir)
    this.stageSessionAttachments = config.stageSessionAttachments ?? true
    this.enableHostFileImport = config.enableHostFileImport ?? false
    this.maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.maxTotalBytes = config.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
    this.maxFilesPerCall = config.maxFilesPerCall ?? DEFAULT_MAX_FILES_PER_CALL

    if (this.stageSessionAttachments) {
      ctx.on('session/event' as never, ((session: SessionLike, event: SessionEventLike) => {
        this.handleSessionEvent(session, event)
      }) as never)
    }

    if (this.enableHostFileImport) {
      ctx.inject(['tools'] as never, (scope: Context) => {
        const tools = (scope as unknown as { get?: (name: string) => unknown }).get?.('tools') as ToolsRegistryLike | undefined
        if (!tools || typeof tools.register !== 'function') return
        const unregister = tools.register(this.buildImportToolDefinition())
        scope.effect(() => unregister, 'dsh-cloud-sandbox: unregister sandbox_import_file tool')
      })
    }

    ctx.effect(() => async () => {
      await Promise.allSettled([...this.inflightTasks])
    }, 'dsh-cloud-sandbox: file intake teardown')
  }

  private getPool(): DockerRuntimePool | undefined {
    const sub = (this.ctx as unknown as { get?: (name: string) => unknown }).get?.('subprocess') as SubprocessWithPool | undefined
    return sub?.pool
  }

  private resolveSessionWorkspaceDir(session: SessionLike): string | undefined {
    const wd = (this.ctx as unknown as { get?: (name: string) => unknown }).get?.('workingDirectory') as WorkingDirectoryLike | undefined
    const fromService = wd?.get?.(session)
    if (typeof fromService === 'string' && fromService.trim().length > 0) return fromService
    const fromHeader = session?.header?.cwd
    if (typeof fromHeader === 'string' && fromHeader.trim().length > 0) return fromHeader
    return undefined
  }

  private handleSessionEvent(session: SessionLike, event: SessionEventLike): void {
    if (event?.type !== 'user/message') return
    const parts = event.data?.content
    if (!Array.isArray(parts) || parts.length === 0) return

    const fileRefs: FileAttachmentRefLike[] = []
    for (const part of parts) {
      if (part?.type === 'file' && part.attachment && typeof part.attachment.attachmentId === 'string') {
        fileRefs.push(part.attachment)
      }
    }
    if (fileRefs.length === 0) return

    const task: Promise<void> = this.stageAttachmentsForSession(session, fileRefs)
      .then(() => undefined)
      .catch((error) => {
        this.ctx.logger.warn('dsh-cloud-sandbox: failed to stage session file attachment: %s', String(error))
      })
    this.inflightTasks.add(task)
    void task.finally(() => {
      this.inflightTasks.delete(task)
    })
  }

  /**
   * Stage uploaded session attachments into that session's own workspace `<uploadsDir>/`.
   * Never reads or exposes files belonging to other sessions.
   */
  async stageAttachmentsForSession(
    session: SessionLike,
    refs: readonly FileAttachmentRefLike[],
  ): Promise<string[]> {
    const pool = this.getPool()
    const attachments = (this.ctx as unknown as { get?: (name: string) => unknown }).get?.('attachments') as AttachmentStoreLike | undefined
    if (!pool || !attachments) return []

    const workspaceDir = this.resolveSessionWorkspaceDir(session)
    if (!workspaceDir) return []

    let resolved
    try {
      resolved = pool.resolveWorkspace(workspaceDir, 'rw')
    } catch {
      return []
    }

    const targetDir = join(resolved.hostWorkspaceRoot, this.uploadsSubdir)
    await mkdir(targetDir, { recursive: true })
    const canonicalTargetDir = canonicalizeHostPath(targetDir)
    if (!isPathContained(canonicalTargetDir, resolved.hostWorkspaceRoot)) {
      throw new WorkspacePolicyError(`uploads directory escapes workspace root: ${JSON.stringify(targetDir)}`)
    }

    const stagedPaths: string[] = []
    for (const ref of refs) {
      if (!ref.attachmentId) continue
      const dedupeKey = `${resolved.workspaceId}:${ref.attachmentId}:${ref.name ?? ''}`
      if (this.stagedKeys.has(dedupeKey)) continue

      const destPath = allocateTargetFilePath(
        canonicalTargetDir,
        ref.name ?? 'attachment',
        extractDigestTag(ref.attachmentId),
      )

      const hostSource = attachments.fileHostPath?.(ref)
      if (hostSource && existsSync(hostSource)) {
        await copyFileAtomic(hostSource, destPath)
      } else if (typeof attachments.readFileStream === 'function') {
        await writeStreamAtomic(attachments.readFileStream(ref), destPath)
      } else {
        continue
      }

      this.stagedKeys.add(dedupeKey)
      stagedPaths.push(destPath)
    }
    return stagedPaths
  }

  private buildImportToolDefinition(): Record<string, unknown> {
    const uploadsSubdir = this.uploadsSubdir
    return {
      name: 'sandbox_import_file',
      description:
        `Import one or more existing host files from outside the sandbox workspace (for example, Downloads or Desktop) `
        + `into the current workspace's "${uploadsSubdir}/" directory as safe copies after explicit user approval. `
        + `Use this tool whenever the user asks to analyze or process local files that are not already visible in the workspace, `
        + `instead of asking the user to manually copy files or run batch scripts. `
        + `Sensitive system directories and credential stores are always denied.`,
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute host file paths to import into the sandbox workspace (regular files only, max 32 files).',
          },
          reason: {
            type: 'string',
            description: 'Short human-readable explanation shown in the user approval dialog.',
          },
        },
        required: ['paths', 'reason'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            imported: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  source: { type: 'string' },
                  workspacePath: { type: 'string' },
                  containerPath: { type: 'string' },
                  bytes: { type: 'number' },
                },
                required: ['source', 'workspacePath', 'containerPath', 'bytes'],
                additionalProperties: false,
              },
            },
            targetDir: { type: 'string' },
            containerTargetDir: { type: 'string' },
          },
          required: ['imported', 'targetDir', 'containerTargetDir'],
          additionalProperties: false,
        },
        render: (_args: unknown, value: unknown) => {
          const result = value as SandboxImportResult
          const lines = [
            `Imported ${result.imported.length} file(s) into ${result.containerTargetDir}:`,
            ...result.imported.map(item => `- ${item.containerPath} (${item.bytes} bytes, from ${item.source})`),
          ]
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      execute: async (rawArgs: unknown, exec: ToolRunContextLike): Promise<SandboxImportResult> => {
        return this.executeHostFileImport(rawArgs, exec)
      },
    }
  }

  /**
   * Execute an approval-gated import of regular non-sensitive host files into the active workspace's
   * `<uploadsDir>/`. Exposed publicly for deterministic unit/contract testing.
   */
  async executeHostFileImport(rawArgs: unknown, exec: ToolRunContextLike): Promise<SandboxImportResult> {
    exec.signal?.throwIfAborted()
    if (!this.enableHostFileImport) {
      throw new DockerSandboxError('HOST_IMPORT_DISABLED', 'host file import is disabled by sandbox policy')
    }

    const pool = this.getPool()
    if (!pool) {
      throw new DockerSandboxError('DOCKER_UNAVAILABLE', 'DockerSubprocessRuntime pool is unavailable')
    }

    const args = rawArgs as { paths?: unknown; reason?: unknown } | null
    if (!args || !Array.isArray(args.paths) || args.paths.length === 0) {
      throw new Error('sandbox_import_file: paths must be a non-empty array of absolute file paths')
    }
    if (args.paths.length > this.maxFilesPerCall) {
      throw new Error(`sandbox_import_file: too many files (${args.paths.length} > max ${this.maxFilesPerCall})`)
    }
    const reason = typeof args.reason === 'string' && args.reason.trim().length > 0
      ? args.reason.trim()
      : 'Import host files into sandbox workspace'

    // 1. Validate EVERY requested path BEFORE prompting the user (fail-closed on sensitive paths/directories/oversized files).
    const validated: Array<{ raw: string; canonical: string; size: number; leafName: string }> = []
    const seenCanonical = new Set<string>()
    let aggregateBytes = 0

    for (const item of args.paths) {
      if (typeof item !== 'string' || item.trim().length === 0) {
        throw new Error('sandbox_import_file: every path must be a non-empty string')
      }
      const trimmed = item.trim()
      if (!isAbsolute(trimmed) && !/^[a-zA-Z]:[/\\]/.test(trimmed)) {
        throw new WorkspacePolicyError(`sandbox_import_file: path must be absolute: ${JSON.stringify(trimmed)}`)
      }
      const canonical = pool.validateApprovedReadOnlyPath(trimmed)
      if (seenCanonical.has(canonical)) continue
      seenCanonical.add(canonical)

      let info
      try {
        info = statSync(canonical)
      } catch (error) {
        throw new WorkspacePolicyError(
          `sandbox_import_file: host file not found or unreadable: ${JSON.stringify(trimmed)}`,
          { cause: error },
        )
      }
      if (!info.isFile()) {
        throw new WorkspacePolicyError(
          `sandbox_import_file: only regular files may be imported (not directories or special files): ${JSON.stringify(trimmed)}`,
        )
      }
      if (info.size > this.maxFileBytes) {
        throw new WorkspacePolicyError(
          `sandbox_import_file: file ${JSON.stringify(trimmed)} (${info.size} bytes) exceeds maxFileBytes (${this.maxFileBytes})`,
        )
      }
      aggregateBytes += info.size
      if (aggregateBytes > this.maxTotalBytes) {
        throw new WorkspacePolicyError(
          `sandbox_import_file: total batch size (${aggregateBytes} bytes) exceeds maxTotalBytes (${this.maxTotalBytes})`,
        )
      }
      validated.push({
        raw: trimmed,
        canonical,
        size: info.size,
        leafName: basename(canonical),
      })
    }

    // 2. Resolve and validate the destination sandbox workspace root.
    const wd = (this.ctx as unknown as { get?: (name: string) => unknown }).get?.('workingDirectory') as WorkingDirectoryLike | undefined
    const workspaceDir = exec.agent && typeof wd?.ensure === 'function'
      ? await wd.ensure(exec.agent, exec.signal)
      : (exec.agent?.session ? this.resolveSessionWorkspaceDir(exec.agent.session as SessionLike) : undefined)

    if (!workspaceDir) {
      throw new WorkspacePolicyError('sandbox_import_file: cannot determine active session workspace directory')
    }
    const resolved = pool.resolveWorkspace(workspaceDir, 'rw')

    // 3. Require explicit interactive user approval via DSH `ctx.approval` (fail-closed if unavailable).
    const approval = (this.ctx as unknown as { get?: (name: string) => unknown }).get?.('approval') as ApprovalServiceLike | undefined
    if (!approval || typeof approval.request !== 'function' || !exec.agent) {
      throw new DockerSandboxError(
        'HOST_IMPORT_APPROVAL_UNAVAILABLE',
        'sandbox_import_file requires an interactive user approval service',
      )
    }

    const fileListSummary = validated.map(v => v.raw).join(', ')
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: 'sandbox_import_file',
      ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
      reason: `Import ${validated.length} host file(s) into sandbox "${this.uploadsSubdir}/": ${fileListSummary} — ${reason}`,
      ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
    })
    if (outcome !== 'allowed-once') {
      throw new DockerSandboxError(
        'HOST_IMPORT_DENIED',
        `user did not approve importing host files into sandbox (outcome: ${outcome})`,
      )
    }

    exec.signal?.throwIfAborted()

    // 4. Copy approved files safely into `<workspaceRoot>/<uploadsSubdir>/`.
    const targetDir = join(resolved.hostWorkspaceRoot, this.uploadsSubdir)
    mkdirSync(targetDir, { recursive: true })
    const canonicalTargetDir = canonicalizeHostPath(targetDir)
    if (!isPathContained(canonicalTargetDir, resolved.hostWorkspaceRoot)) {
      throw new WorkspacePolicyError(`sandbox_import_file: target directory escapes workspace root: ${JSON.stringify(targetDir)}`)
    }

    const imported: ImportedSandboxFile[] = []
    for (const entry of validated) {
      exec.signal?.throwIfAborted()
      // Re-verify right before copy to narrow TOCTOU window.
      const rechecked = pool.validateApprovedReadOnlyPath(entry.raw)
      const st = lstatSync(rechecked)
      if (!st.isFile()) {
        throw new WorkspacePolicyError(`sandbox_import_file: source changed to non-regular file: ${JSON.stringify(entry.raw)}`)
      }

      const destPath = allocateTargetFilePath(canonicalTargetDir, entry.leafName)
      const destCanonicalParent = canonicalizeHostPath(resolve(destPath, '..'))
      if (!isPathContained(destCanonicalParent, resolved.hostWorkspaceRoot)) {
        throw new WorkspacePolicyError(`sandbox_import_file: destination escapes workspace root: ${JSON.stringify(destPath)}`)
      }

      await copyFileAtomic(rechecked, destPath)
      const containerPath = resolved.toContainerPath(destPath) ?? destPath
      const relFromWorkspace = relative(resolved.hostWorkspaceRoot, destPath)
      imported.push({
        source: entry.raw,
        workspacePath: relFromWorkspace,
        containerPath,
        bytes: st.size,
      })
    }

    const containerTargetDir = resolved.toContainerPath(canonicalTargetDir) ?? canonicalTargetDir
    return {
      imported,
      targetDir: this.uploadsSubdir,
      containerTargetDir,
    }
  }
}

export const sandboxFileIntakePlugin = {
  name: 'SandboxFileIntake',
  inject: SandboxFileIntake.inject,
  Config: SandboxFileIntake.Config,
  apply(ctx: Context, config: SandboxFileIntakeConfig): void {
    new SandboxFileIntake(ctx, config)
  },
}

export default sandboxFileIntakePlugin
