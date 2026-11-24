/**
 * Pure Windows <-> WSL2 <-> Linux container path conversion and security validation utilities.
 *
 * Handles:
 * - Windows drive paths (`D:\work\ws1`, `d:/work/ws1`) <-> WSL2 mount paths (`/mnt/d/work/ws1`)
 * - WSL UNC paths (`\\wsl.localhost\<distro>\home\dev\ws1`, `\\wsl$\<distro>\...`) <-> Linux paths (`/home/dev/ws1`)
 * - Rejection of arbitrary non-WSL SMB UNC shares (`\\server\share`) and sensitive Windows/WSL roots
 *   (`C:\`, `C:\Windows`, `\\.\pipe\docker_engine`, `/mnt/c`, `/mnt/wsl/docker-desktop`)
 */

import { posix } from 'node:path'
import { WorkspacePolicyError } from '../types.ts'

const WINDOWS_DRIVE_RE = /^([a-zA-Z]):(?:[\\/](.*))?$/
const WSL_UNC_RE = /^[/\\]{2}(?:wsl\.localhost|wsl\$)[/\\]([^/\\]+)(?:[/\\](.*))?$/i
const GENERIC_UNC_RE = /^[/\\]{2}[^/\\]+[/\\][^/\\]+/
const WINDOWS_NPIPE_RE = /^[/\\]{2}\.[/\\]pipe[/\\]/i

export interface ParsedWslUncPath {
  readonly distro: string
  readonly linuxPath: string
}

/** Test whether `input` is a Windows drive-qualified path (e.g., `C:\foo` or `D:/bar`). */
export function isWindowsDrivePath(input: string): boolean {
  return WINDOWS_DRIVE_RE.test(input)
}

/** Parse a Windows WSL UNC path (`\\wsl.localhost\<distro>\...` or `\\wsl$\<distro>\...`). */
export function parseWslUncPath(input: string): ParsedWslUncPath | undefined {
  const match = WSL_UNC_RE.exec(input)
  if (!match) return undefined
  const distro = match[1]
  if (!distro) return undefined
  const rest = (match[2] ?? '').replaceAll('\\', '/').replace(/^\/+/, '')
  const linuxPath = rest.length === 0 ? '/' : posix.normalize(`/${rest}`)
  return { distro, linuxPath }
}

/** Test whether `input` is a non-WSL UNC network share (e.g., `\\fileserver\share`) or device pipe. */
export function isDisallowedWindowsUncPath(input: string): boolean {
  if (WINDOWS_NPIPE_RE.test(input)) return true
  if (parseWslUncPath(input)) return false
  return GENERIC_UNC_RE.test(input)
}

/** Normalize WSL mount prefix (default `/mnt`) to a clean POSIX absolute prefix without trailing slash. */
export function normalizeWslMountPrefix(mountPrefix = '/mnt'): string {
  const normalized = posix.normalize(mountPrefix.replaceAll('\\', '/')).replace(/\/+$/, '')
  if (!normalized.startsWith('/') || normalized === '/') {
    throw new WorkspacePolicyError(`wslMountPrefix must be a non-root POSIX absolute path: ${JSON.stringify(mountPrefix)}`)
  }
  return normalized
}

/**
 * Convert a Windows path (`D:\work\ws1`, `\\wsl.localhost\Ubuntu\home\dev\ws1`) or POSIX path
 * into a canonical Linux WSL2 path (`/mnt/d/work/ws1`, `/home/dev/ws1`).
 */
export function windowsPathToWslPath(inputPath: string, mountPrefix = '/mnt'): string {
  if (isDisallowedWindowsUncPath(inputPath)) {
    throw new WorkspacePolicyError(`refusing non-WSL Windows UNC/device path: ${JSON.stringify(inputPath)}`)
  }

  const unc = parseWslUncPath(inputPath)
  if (unc) {
    return unc.linuxPath
  }

  const driveMatch = WINDOWS_DRIVE_RE.exec(inputPath)
  if (driveMatch) {
    const drive = driveMatch[1]!.toLowerCase()
    const rest = (driveMatch[2] ?? '').replaceAll('\\', '/').replace(/^\/+/, '')
    const prefix = normalizeWslMountPrefix(mountPrefix)
    return rest.length === 0 ? `${prefix}/${drive}` : posix.normalize(`${prefix}/${drive}/${rest}`)
  }

  const normalized = posix.normalize(inputPath.replaceAll('\\', '/'))
  if (!normalized.startsWith('/')) {
    throw new WorkspacePolicyError(`cannot convert non-absolute path to WSL path: ${JSON.stringify(inputPath)}`)
  }
  return normalized
}

/**
 * Convert a Linux WSL2 path back to a Windows host path:
 * - `/mnt/d/work/ws1` -> `D:\work\ws1`
 * - `/home/dev/ws1` (when `distro` is supplied) -> `\\wsl.localhost\<distro>\home\dev\ws1`
 */
export function wslPathToWindowsPath(
  wslPath: string,
  options: { readonly mountPrefix?: string; readonly distro?: string } = {},
): string | undefined {
  const normalized = posix.normalize(wslPath.replaceAll('\\', '/'))
  if (!normalized.startsWith('/')) return undefined

  const prefix = normalizeWslMountPrefix(options.mountPrefix ?? '/mnt')
  const driveRe = new RegExp(`^${escapeRegExp(prefix)}/([a-zA-Z])(?:/(.*))?$`)
  const match = driveRe.exec(normalized)
  if (match) {
    const drive = match[1]!.toUpperCase()
    const rest = match[2] ?? ''
    return rest.length === 0 ? `${drive}:\\` : `${drive}:\\${rest.replaceAll('/', '\\')}`
  }

  if (options.distro) {
    const rel = normalized.replace(/^\/+/, '').replaceAll('/', '\\')
    return rel.length === 0
      ? `\\\\wsl.localhost\\${options.distro}`
      : `\\\\wsl.localhost\\${options.distro}\\${rel}`
  }

  return undefined
}

/**
 * Convert any host path (Linux POSIX, Windows drive, or WSL UNC) into a guaranteed
 * valid Linux container POSIX absolute path (always starting with `/`, never containing `:`).
 */
export function toContainerPosixPath(hostPath: string, mountPrefix = '/mnt'): string {
  return windowsPathToWslPath(hostPath, mountPrefix)
}

/**
 * Detect sensitive Windows or WSL2 host paths that must never be mounted into a sandbox container:
 * - Entire Windows drive roots (`C:\`, `D:\`, `/mnt/c`, `/mnt/d`)
 * - Windows OS directories (`C:\Windows`, `/mnt/c/Windows`)
 * - Windows named pipes (`\\.\pipe\...`)
 * - WSL2 Docker Desktop internal mounts (`/mnt/wsl/docker-desktop*`)
 */
export function isSensitiveWindowsOrWslPath(rawOrCanonicalPath: string, mountPrefix = '/mnt'): boolean {
  if (WINDOWS_NPIPE_RE.test(rawOrCanonicalPath)) return true
  if (isDisallowedWindowsUncPath(rawOrCanonicalPath)) return true

  let wslPosix: string
  try {
    wslPosix = windowsPathToWslPath(rawOrCanonicalPath, mountPrefix).replace(/\/+$/, '') || '/'
  } catch {
    return true
  }

  const lower = wslPosix.toLowerCase()
  const prefixLower = normalizeWslMountPrefix(mountPrefix).toLowerCase()

  // Reject bare `/mnt` or bare drive root `/mnt/<drive>` (e.g., C:\ or D:\).
  if (lower === prefixLower) return true
  if (new RegExp(`^${escapeRegExp(prefixLower)}/[a-z]$`).test(lower)) return true

  // Reject Windows system folder on any drive (`/mnt/<drive>/windows`).
  if (new RegExp(`^${escapeRegExp(prefixLower)}/[a-z]/windows(?:/|$)`).test(lower)) return true

  // Reject WSL internal Docker Desktop sockets/mounts.
  if (
    lower === `${prefixLower}/wsl`
    || lower.startsWith(`${prefixLower}/wsl/docker-desktop`)
  ) {
    return true
  }

  return false
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
