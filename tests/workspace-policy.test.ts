import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspacePolicy, WorkspacePolicyError, computeWorkspaceId } from '../src/index.ts'

describe('WorkspacePolicy', () => {
  let rootDir: string
  let workspacesDir: string
  let wsA: string
  let wsSub: string
  let skillsDir: string
  let outsideDir: string

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'dsh-cloud-ws-'))
    workspacesDir = join(rootDir, 'workspaces')
    wsA = join(workspacesDir, 'project-a')
    wsSub = join(wsA, 'src')
    skillsDir = join(rootDir, 'skills')
    outsideDir = join(rootDir, 'secret-runtime')
    mkdirSync(wsSub, { recursive: true })
    mkdirSync(skillsDir, { recursive: true })
    mkdirSync(outsideDir, { recursive: true })
    writeFileSync(join(outsideDir, 'credentials.json'), '{"token":"secret"}')
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('rejects empty allowedBaseDirs and sensitive Linux system paths', () => {
    expect(() => new WorkspacePolicy({ allowedBaseDirs: [] })).toThrow(WorkspacePolicyError)
    expect(() => new WorkspacePolicy({ allowedBaseDirs: ['/etc'] })).toThrow(WorkspacePolicyError)
    expect(() => new WorkspacePolicy({ allowedBaseDirs: ['/var/run'] })).toThrow(WorkspacePolicyError)
    expect(() => new WorkspacePolicy({ allowedBaseDirs: ['/'] })).toThrow(WorkspacePolicyError)
  })

  it('resolves allowed workspaces deterministically and rejects paths outside allowlist', () => {
    const policy = new WorkspacePolicy({
      allowedBaseDirs: [workspacesDir],
      readOnlyMounts: [skillsDir],
    })

    const resolved1 = policy.resolveForExecution(wsA)
    const resolved2 = policy.resolveForExecution(wsA)
    expect(resolved1.workspaceId).toBe(resolved2.workspaceId)
    expect(resolved1.workspaceId).toBe(computeWorkspaceId(resolved1.hostWorkspaceRoot))
    expect(resolved1.mounts).toHaveLength(2)
    expect(resolved1.mounts[0]?.readOnly).toBe(false)
    expect(resolved1.mounts[1]?.readOnly).toBe(true)

    expect(() => policy.resolveForExecution(outsideDir)).toThrow(WorkspacePolicyError)
    expect(() => policy.resolveForExecution(join(wsA, '..', '..', 'secret-runtime'))).toThrow(WorkspacePolicyError)
  })

  it('blocks symlink escapes pointing outside allowedBaseDirs', () => {
    const escapeLink = join(wsA, 'escape-link')
    try {
      symlinkSync(outsideDir, escapeLink, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      // Skip symlink creation assertion only if OS disallows unprivileged symlinks.
      return
    }

    const policy = new WorkspacePolicy({ allowedBaseDirs: [workspacesDir] })
    expect(() => policy.resolveForExecution(escapeLink)).toThrow(WorkspacePolicyError)
    expect(() => policy.assertPathAllowed(join(escapeLink, 'credentials.json'))).toThrow(WorkspacePolicyError)
  })

  it('supports collapsing subdirectories to a shared workspace root and dynamic :ro skill mounts', () => {
    const policy = new WorkspacePolicy({
      allowedBaseDirs: [workspacesDir],
      resolveWorkspaceRoot: () => wsA,
      resolveReadOnlyMounts: () => [skillsDir],
    })

    const resolved = policy.resolveForExecution(wsSub, 'ro')
    expect(resolved.hostWorkspaceRoot).toBe(resolved.toHostPath(resolved.containerWorkspaceRoot))
    expect(resolved.mounts[0]?.readOnly).toBe(true)
    expect(resolved.mounts[1]?.readOnly).toBe(true)
  })

  it('supports remap pathMode with bidirectional host <-> container translation', () => {
    const policy = new WorkspacePolicy({
      allowedBaseDirs: [workspacesDir],
      readOnlyMounts: [skillsDir],
      resolveWorkspaceRoot: () => wsA,
      pathMode: 'remap',
      containerWorkspacePath: '/workspace',
    })

    const resolved = policy.resolveForExecution(wsSub)
    expect(resolved.containerWorkspaceRoot).toBe('/workspace')
    expect(resolved.containerCwd).toBe('/workspace/src')
    expect(resolved.mounts[1]?.containerPath).toBe('/mnt/ro/0')
    expect(resolved.toContainerPath(join(skillsDir, 'my-skill', 'run.py'))).toBe('/mnt/ro/0/my-skill/run.py')
    expect(resolved.toHostPath('/workspace/src/main.ts')).toBe(join(resolved.hostWorkspaceRoot, 'src', 'main.ts'))
    expect(resolved.toContainerPath(outsideDir)).toBeUndefined()
  })
})
