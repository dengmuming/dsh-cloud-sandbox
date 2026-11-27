/**
 * Pure directory-based workspace isolation policy (zero user attributes).
 *
 * Responsibilities:
 * - Canonicalize workspace and cwd paths via realpath (catching symlink traversal).
 * - Enforce `allowedBaseDirs` allowlist and reject sensitive host system directories / Docker socket.
 * - Compute deterministic `workspaceId = sha256(canonicalWorkspaceRoot).slice(0, 16)`.
 * - Resolve and validate read-only mounts (such as user/shared Skill directories).
 * - Map host paths <-> container paths in `'mirror'` or `'remap'` mode.
 */

import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path'
import type {
  BindMountSpec,
  HostMountPathStyle,
  PathMode,
  WorkspaceAccessMode,
  WorkspacePolicyConfig,
} from '../types.ts'
import { WorkspacePolicyError } from '../types.ts'
import {
  isDisallowedWindowsUncPath,
  isSensitiveWindowsOrWslPath,
  isWindowsDrivePath,
  normalizeWslMountPrefix,
  parseWslUncPath,
  toContainerPosixPath,
  windowsPathToWslPath,
} from './wsl-paths.ts'

const SENSITIVE_LINUX_PREFIXES = [
  '/etc',
  '/proc',
  '/sys',
  '/dev',
  '/run',
  '/var/run',
  '/boot',
  '/root',
] as const

const SENSITIVE_CREDENTIAL_SEGMENTS = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.gpg',
  '.kube',
  '.docker',
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
])

export interface ResolvedWorkspace {
  /** Deterministic, user-agnostic identifier derived from canonical workspaceRoot. */
  readonly workspaceId: string
  /** Canonical host path of the workspace root. */
  readonly hostWorkspaceRoot: string
  /** Canonical host path of the requested cwd (equals or sits inside hostWorkspaceRoot). */
  readonly hostCwd: string
  /** Container path corresponding to workspaceRoot. */
  readonly containerWorkspaceRoot: string
  /** Container path corresponding to cwd. */
  readonly containerCwd: string
  /** Validated bind mounts for the container (workspace mount + read-only mounts). */
  readonly mounts: readonly BindMountSpec[]
  /** Path mapping mode used for this resolution. */
  readonly pathMode: PathMode
  /** Map an allowed host path into its container path (returns undefined if outside mounts). */
  toContainerPath(hostPath: string): string | undefined
  /** Map a container path back to its host path (returns undefined if outside mounts). */
  toHostPath(containerPath: string): string | undefined
}

/** Normalize path separators to POSIX for consistent Linux container semantics. */
export function toPosixPath(p: string): string {
  return p.replaceAll('\\', '/')
}

/**
 * Resolve a host path to its canonical form by realpath-ing the deepest existing ancestor.
 * This catches symlinks along existing segments even when the leaf directory/file does not yet exist.
 */
export function canonicalizeHostPath(inputPath: string): string {
  if (typeof inputPath !== 'string' || inputPath.trim().length === 0) {
    throw new WorkspacePolicyError('path must be a non-empty string')
  }
  if (inputPath.includes('\0')) {
    throw new WorkspacePolicyError('path must not contain NUL bytes')
  }
  if (isDisallowedWindowsUncPath(inputPath)) {
    throw new WorkspacePolicyError(`refusing non-WSL Windows UNC/device path: ${JSON.stringify(inputPath)}`)
  }
  if (process.platform !== 'win32' && (isWindowsDrivePath(inputPath) || parseWslUncPath(inputPath))) {
    throw new WorkspacePolicyError(`Windows host paths require a Windows host; use a POSIX path: ${JSON.stringify(inputPath)}`)
  }
  if (!isAbsolute(inputPath) && !isWindowsDrivePath(inputPath) && !parseWslUncPath(inputPath)) {
    throw new WorkspacePolicyError(`path must be absolute: ${JSON.stringify(inputPath)}`)
  }
  const normalized = resolve(inputPath)
  const missingSegments: string[] = []
  let probe = normalized
  while (true) {
    try {
      const real = realpathSync(probe)
      if (missingSegments.length === 0) return real
      return resolve(real, ...missingSegments.reverse())
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new WorkspacePolicyError(`failed to resolve path ${JSON.stringify(inputPath)}: ${String(error)}`, { cause: error })
      }
      const parent = dirname(probe)
      if (parent === probe) return normalized
      missingSegments.push(probe.slice(parent.length).replace(/^[/\\]+/, ''))
      probe = parent
    }
  }
}

/** Check whether `candidate` equals `base` or is a strict descendant of `base`. */
export function isPathContained(candidate: string, base: string): boolean {
  const rel = relative(base, candidate)
  if (rel === '') return true
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false
  return true
}

/** Compute stable 16-hex workspace identifier from canonical workspace path. */
export function computeWorkspaceId(canonicalWorkspaceRoot: string): string {
  return createHash('sha256').update(toPosixPath(canonicalWorkspaceRoot)).digest('hex').slice(0, 16)
}

function isSensitiveHostPath(canonicalPath: string, dockerSocketPath: string, wslMountPrefix: string): boolean {
  if (isSensitiveWindowsOrWslPath(canonicalPath, wslMountPrefix)) return true
  const rawPosix = toPosixPath(canonicalPath).replace(/\/+$/, '') || '/'
  const p = rawPosix.replace(/^[a-zA-Z]:/, '') || '/'
  if (p === '/') return true
  const socketPosix = toPosixPath(dockerSocketPath).replace(/\/+$/, '').replace(/^[a-zA-Z]:/, '')
  if (p === socketPosix || p.startsWith(`${socketPosix}/`) || socketPosix.startsWith(`${p}/`)) {
    return true
  }
  for (const prefix of SENSITIVE_LINUX_PREFIXES) {
    if (p === prefix || p.startsWith(`${prefix}/`)) return true
  }
  return false
}

export function isSensitiveCredentialPath(canonicalPath: string): boolean {
  const segments = toPosixPath(canonicalPath).split('/').filter(Boolean)
  for (const segment of segments) {
    if (SENSITIVE_CREDENTIAL_SEGMENTS.has(segment.toLowerCase())) {
      return true
    }
  }
  return false
}

export class WorkspacePolicy {
  private readonly allowedBases: readonly string[]
  private readonly resolveAllowedBaseDirsFn?: () => readonly string[]
  private readonly staticReadOnlyMounts: readonly string[]
  private readonly resolveReadOnlyMountsFn?: (workspaceRoot: string) => readonly string[]
  private readonly resolveWorkspaceRootFn?: (canonicalCwd: string) => string
  private readonly pathMode: PathMode
  private readonly dockerSocketPath: string
  private readonly containerWorkspacePath: string
  private readonly wslMountPrefix: string
  private readonly hostPathStyle: Exclude<HostMountPathStyle, 'auto'>

  constructor(config: WorkspacePolicyConfig) {
    const hasStaticBases = Array.isArray(config.allowedBaseDirs) && config.allowedBaseDirs.length > 0
    const hasDynamicBases = typeof config.resolveAllowedBaseDirs === 'function'
    if (!hasStaticBases && !hasDynamicBases) {
      throw new WorkspacePolicyError('workspace.allowedBaseDirs must contain at least one absolute directory')
    }
    this.dockerSocketPath = config.dockerSocketPath ?? '/var/run/docker.sock'
    this.pathMode = config.pathMode ?? 'mirror'
    this.wslMountPrefix = normalizeWslMountPrefix(config.wslMountPrefix ?? '/mnt')
    this.hostPathStyle = config.hostPathStyle && config.hostPathStyle !== 'auto'
      ? config.hostPathStyle
      : (process.platform === 'win32' ? 'win32-npipe' : 'posix')
    this.containerWorkspacePath = posix.normalize(config.containerWorkspacePath ?? '/workspace')
    if (!this.containerWorkspacePath.startsWith('/') || this.containerWorkspacePath === '/') {
      throw new WorkspacePolicyError(`containerWorkspacePath must be a non-root POSIX absolute path: ${JSON.stringify(this.containerWorkspacePath)}`)
    }

    const bases: string[] = []
    for (const dir of config.allowedBaseDirs ?? []) {
      const canonical = canonicalizeHostPath(dir)
      if (isSensitiveHostPath(canonical, this.dockerSocketPath, this.wslMountPrefix)) {
        throw new WorkspacePolicyError(`refusing sensitive host directory in allowedBaseDirs: ${JSON.stringify(dir)}`)
      }
      bases.push(canonical)
    }
    this.allowedBases = bases
    this.resolveAllowedBaseDirsFn = config.resolveAllowedBaseDirs

    const roMounts: string[] = []
    for (const mount of config.readOnlyMounts ?? []) {
      const canonical = canonicalizeHostPath(mount)
      if (isSensitiveHostPath(canonical, this.dockerSocketPath, this.wslMountPrefix)) {
        throw new WorkspacePolicyError(`refusing sensitive host directory in readOnlyMounts: ${JSON.stringify(mount)}`)
      }
      roMounts.push(canonical)
    }
    this.staticReadOnlyMounts = roMounts
    this.resolveReadOnlyMountsFn = config.resolveReadOnlyMounts
    this.resolveWorkspaceRootFn = config.resolveWorkspaceRoot
  }

  /** Collect static + dynamically resolved allowed base directories, strictly filtering out sensitive paths. */
  getEffectiveAllowedBaseDirs(): readonly string[] {
    if (!this.resolveAllowedBaseDirsFn) return this.allowedBases
    const merged = new Set<string>(this.allowedBases)
    for (const raw of this.resolveAllowedBaseDirsFn()) {
      if (typeof raw !== 'string' || raw.trim().length === 0) continue
      try {
        const canonical = canonicalizeHostPath(raw)
        if (isSensitiveHostPath(canonical, this.dockerSocketPath, this.wslMountPrefix)) continue
        merged.add(canonical)
      } catch {
        // Ignore unresolvable dynamic entries rather than widening access.
      }
    }
    return [...merged]
  }

  /**
   * Validate a user-approved host file or directory for a one-off read-only mount inside an
   * ephemeral container. Always rejects sensitive system paths and host credential stores.
   */
  validateApprovedReadOnlyPath(rawPath: string): string {
    const canonical = canonicalizeHostPath(rawPath)
    if (isSensitiveHostPath(canonical, this.dockerSocketPath, this.wslMountPrefix)) {
      throw new WorkspacePolicyError(`refusing sensitive host path even with approval: ${JSON.stringify(rawPath)}`)
    }
    if (isSensitiveCredentialPath(canonical)) {
      throw new WorkspacePolicyError(`refusing host credential path even with approval: ${JSON.stringify(rawPath)}`)
    }
    return canonical
  }

  /** Validate that a raw path is allowed under `allowedBaseDirs` (and optionally read-only mounts for reads). */
  assertPathAllowed(rawPath: string, options: { allowReadOnlyMounts?: boolean; workspaceRoot?: string } = {}): string {
    const canonical = canonicalizeHostPath(rawPath)
    if (isSensitiveHostPath(canonical, this.dockerSocketPath, this.wslMountPrefix)) {
      throw new WorkspacePolicyError(`access to sensitive host path is denied: ${JSON.stringify(rawPath)}`)
    }
    const effectiveBases = this.getEffectiveAllowedBaseDirs()
    if (effectiveBases.some(base => isPathContained(canonical, base))) {
      return canonical
    }
    if (options.allowReadOnlyMounts) {
      for (const ro of this.collectReadOnlyPaths(options.workspaceRoot)) {
        if (isPathContained(canonical, ro)) return canonical
      }
    }
    throw new WorkspacePolicyError(`path is outside allowed workspace directories: ${JSON.stringify(rawPath)}`)
  }

  /** Resolve a requested execution `cwd` into a complete, mount-validated `ResolvedWorkspace`. */
  resolveForExecution(
    cwd: string,
    accessMode: WorkspaceAccessMode = 'rw',
    extraReadOnlyMounts?: readonly string[],
  ): ResolvedWorkspace {
    const canonicalCwd = this.assertPathAllowed(cwd)
    this.assertExistingDirectoryOrSafe(canonicalCwd)

    const effectiveBases = this.getEffectiveAllowedBaseDirs()
    let hostWorkspaceRoot = canonicalCwd
    if (this.resolveWorkspaceRootFn) {
      const candidateRoot = canonicalizeHostPath(this.resolveWorkspaceRootFn(canonicalCwd))
      if (isSensitiveHostPath(candidateRoot, this.dockerSocketPath, this.wslMountPrefix)) {
        throw new WorkspacePolicyError(`resolved workspace root is a sensitive host path: ${JSON.stringify(candidateRoot)}`)
      }
      if (!effectiveBases.some(base => isPathContained(candidateRoot, base))) {
        throw new WorkspacePolicyError(`resolved workspace root escapes allowedBaseDirs: ${JSON.stringify(candidateRoot)}`)
      }
      if (!isPathContained(canonicalCwd, candidateRoot)) {
        throw new WorkspacePolicyError(`cwd ${JSON.stringify(canonicalCwd)} is not inside resolved workspace root ${JSON.stringify(candidateRoot)}`)
      }
      hostWorkspaceRoot = candidateRoot
    }

    const workspaceId = computeWorkspaceId(hostWorkspaceRoot)
    const roPaths = this.collectReadOnlyPaths(hostWorkspaceRoot)
    if (extraReadOnlyMounts) {
      for (const extra of extraReadOnlyMounts) {
        roPaths.push(this.validateApprovedReadOnlyPath(extra))
      }
    }

    const mounts: BindMountSpec[] = []
    const containerWorkspaceRoot = this.pathMode === 'mirror'
      ? toContainerPosixPath(hostWorkspaceRoot, this.wslMountPrefix)
      : this.containerWorkspacePath

    mounts.push({
      hostPath: hostWorkspaceRoot,
      dockerHostPath: this.formatDockerHostPath(hostWorkspaceRoot),
      containerPath: containerWorkspaceRoot,
      readOnly: accessMode === 'ro',
    })

    const seenHost = new Set<string>([hostWorkspaceRoot])
    let roIndex = 0
    for (const roHost of roPaths) {
      if (seenHost.has(roHost)) continue
      seenHost.add(roHost)
      const containerPath = this.pathMode === 'mirror'
        ? toContainerPosixPath(roHost, this.wslMountPrefix)
        : posix.join('/mnt/ro', String(roIndex++))
      mounts.push({
        hostPath: roHost,
        dockerHostPath: this.formatDockerHostPath(roHost),
        containerPath,
        readOnly: true,
      })
    }

    const mountsByHostLongest = [...mounts].sort((a, b) => b.hostPath.length - a.hostPath.length)
    const mountsByContainerLongest = [...mounts].sort((a, b) => b.containerPath.length - a.containerPath.length)

    const toContainerPath = (targetHost: string): string | undefined => {
      let canonical: string
      try {
        canonical = canonicalizeHostPath(targetHost)
      } catch {
        return undefined
      }
      for (const mount of mountsByHostLongest) {
        if (isPathContained(canonical, mount.hostPath)) {
          const rel = relative(mount.hostPath, canonical)
          return rel === '' ? mount.containerPath : posix.join(mount.containerPath, toPosixPath(rel))
        }
      }
      return undefined
    }

    const toHostPath = (containerPath: string): string | undefined => {
      const normalized = posix.normalize(toPosixPath(containerPath))
      for (const mount of mountsByContainerLongest) {
        const base = mount.containerPath.replace(/\/+$/, '') || '/'
        if (normalized === base) return mount.hostPath
        if (normalized.startsWith(`${base}/`)) {
          const rel = normalized.slice(base.length + 1)
          return resolve(mount.hostPath, rel)
        }
      }
      return undefined
    }

    const containerCwd = toContainerPath(canonicalCwd)
    if (!containerCwd) {
      throw new WorkspacePolicyError(`failed to map cwd ${JSON.stringify(canonicalCwd)} into container mount`)
    }

    return {
      workspaceId,
      hostWorkspaceRoot,
      hostCwd: canonicalCwd,
      containerWorkspaceRoot,
      containerCwd,
      mounts,
      pathMode: this.pathMode,
      toContainerPath,
      toHostPath,
    }
  }

  private formatDockerHostPath(canonicalHostPath: string): string {
    if (this.hostPathStyle === 'wsl') {
      return windowsPathToWslPath(canonicalHostPath, this.wslMountPrefix)
    }
    if (this.hostPathStyle === 'posix') {
      return toPosixPath(canonicalHostPath)
    }
    return canonicalHostPath
  }

  private collectReadOnlyPaths(workspaceRoot?: string): string[] {
    const result: string[] = [...this.staticReadOnlyMounts]
    if (workspaceRoot && this.resolveReadOnlyMountsFn) {
      for (const raw of this.resolveReadOnlyMountsFn(workspaceRoot)) {
        const canonical = canonicalizeHostPath(raw)
        if (isSensitiveHostPath(canonical, this.dockerSocketPath, this.wslMountPrefix)) {
          throw new WorkspacePolicyError(`refusing sensitive host path from resolveReadOnlyMounts: ${JSON.stringify(raw)}`)
        }
        result.push(canonical)
      }
    }
    return result
  }

  private assertExistingDirectoryOrSafe(canonicalPath: string): void {
    try {
      const info = lstatSync(canonicalPath)
      if (!info.isDirectory()) {
        throw new WorkspacePolicyError(`workspace cwd must be a directory: ${JSON.stringify(canonicalPath)}`)
      }
    } catch (error) {
      if (error instanceof WorkspacePolicyError) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        throw new WorkspacePolicyError(`workspace directory does not exist: ${JSON.stringify(canonicalPath)}`)
      }
      throw new WorkspacePolicyError(`cannot inspect workspace directory ${JSON.stringify(canonicalPath)}: ${String(error)}`, { cause: error })
    }
  }
}
