import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  WorkspacePolicy,
  WorkspacePolicyError,
  buildHardenedContainerPayload,
  buildWslBridgeCommand,
  createDockerRuntimePool,
  isDisallowedWindowsUncPath,
  isSensitiveWindowsOrWslPath,
  parseWslUncPath,
  toContainerPosixPath,
  windowsPathToWslPath,
  wslPathToWindowsPath,
  type DockerClient,
  type DockerContainerCreateRequest,
  type DockerExecCreateRequest,
  type DockerExecStream,
} from '../src/index.ts'

describe('Windows & WSL2 path translation and security guardrails', () => {
  it('converts Windows drive paths and WSL UNC paths to Linux WSL paths and back', () => {
    expect(windowsPathToWslPath('D:\\work\\project-a')).toBe('/mnt/d/work/project-a')
    expect(windowsPathToWslPath('c:/Users/dev/ws')).toBe('/mnt/c/Users/dev/ws')
    expect(windowsPathToWslPath('D:\\work\\ws', '/host')).toBe('/host/d/work/ws')

    expect(parseWslUncPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\ws')).toEqual({
      distro: 'Ubuntu-24.04',
      linuxPath: '/home/dev/ws',
    })
    expect(parseWslUncPath('\\\\wsl$\\Ubuntu\\srv\\workspaces\\a')).toEqual({
      distro: 'Ubuntu',
      linuxPath: '/srv/workspaces/a',
    })
    expect(windowsPathToWslPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\ws')).toBe('/home/dev/ws')
    expect(toContainerPosixPath('D:\\work\\ws1')).toBe('/mnt/d/work/ws1')

    expect(wslPathToWindowsPath('/mnt/d/work/ws1')).toBe('D:\\work\\ws1')
    expect(wslPathToWindowsPath('/home/dev/ws1', { distro: 'Ubuntu-24.04' })).toBe(
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\ws1',
    )
  })

  it('rejects non-WSL UNC SMB shares, named pipes, drive roots, and Windows system paths', () => {
    expect(isDisallowedWindowsUncPath('\\\\fileserver\\share\\secret')).toBe(true)
    expect(isDisallowedWindowsUncPath('\\\\.\\pipe\\docker_engine')).toBe(true)
    expect(isDisallowedWindowsUncPath('\\\\wsl.localhost\\Ubuntu\\home\\dev')).toBe(false)

    expect(() => windowsPathToWslPath('\\\\fileserver\\share\\secret')).toThrow(WorkspacePolicyError)
    expect(isSensitiveWindowsOrWslPath('C:\\')).toBe(true)
    expect(isSensitiveWindowsOrWslPath('D:\\')).toBe(true)
    expect(isSensitiveWindowsOrWslPath('/mnt/c')).toBe(true)
    expect(isSensitiveWindowsOrWslPath('C:\\Windows')).toBe(true)
    expect(isSensitiveWindowsOrWslPath('C:\\Windows\\System32')).toBe(true)
    expect(isSensitiveWindowsOrWslPath('/mnt/c/Windows/System32')).toBe(true)
    expect(isSensitiveWindowsOrWslPath('\\\\.\\pipe\\docker_engine')).toBe(true)
    expect(isSensitiveWindowsOrWslPath('/mnt/wsl/docker-desktop')).toBe(true)
    expect(isSensitiveWindowsOrWslPath('D:\\work\\ws1')).toBe(false)

    expect(() => new WorkspacePolicy({ allowedBaseDirs: ['C:\\'] })).toThrow(WorkspacePolicyError)
    expect(() => new WorkspacePolicy({ allowedBaseDirs: ['C:\\Windows'] })).toThrow(WorkspacePolicyError)
    expect(() => new WorkspacePolicy({ allowedBaseDirs: ['\\\\fileserver\\share'] })).toThrow(WorkspacePolicyError)
  })

  it('builds safe wsl.exe bridge commands without interpolating socketPath into shell source', () => {
    const cmd = buildWslBridgeCommand({
      distro: 'Ubuntu-24.04',
      user: 'dev',
      socketPath: '/var/run/docker.sock',
    })
    expect(cmd.command).toBe('wsl.exe')
    expect(cmd.args.slice(0, 6)).toEqual(['-d', 'Ubuntu-24.04', '-u', 'dev', '--exec', '/bin/sh'])
    expect(cmd.args.at(-3)).toBe('dsh-wsl-bridge')
    expect(cmd.args.at(-2)).toBe('/var/run/docker.sock')
    expect(cmd.args.at(-1)).toBe(Buffer.from('/var/run/docker.sock', 'utf8').toString('base64'))
    expect(() => buildWslBridgeCommand({ socketPath: 'relative/docker.sock' })).toThrow('POSIX absolute path')
  })

  it('formats HostConfig.Mounts for Windows npipe sources and HostConfig.Binds for WSL POSIX sources', () => {
    const npipePayload = buildHardenedContainerPayload({
      image: 'dsh-cloud-sandbox-runtime:latest',
      cmd: ['sleep', 'infinity'],
      workingDir: '/mnt/d/work/ws1',
      mounts: [
        { hostPath: 'D:\\work\\ws1', dockerHostPath: 'D:\\work\\ws1', containerPath: '/mnt/d/work/ws1', readOnly: false },
        { hostPath: 'D:\\skills', dockerHostPath: 'D:\\skills', containerPath: '/mnt/d/skills', readOnly: true },
      ],
      labels: {},
    })
    const npipeHostCfg = npipePayload.HostConfig as Record<string, unknown>
    expect(npipeHostCfg.Binds).toBeUndefined()
    expect(npipeHostCfg.Mounts).toEqual([
      { Type: 'bind', Source: 'D:\\work\\ws1', Target: '/mnt/d/work/ws1', ReadOnly: false },
      { Type: 'bind', Source: 'D:\\skills', Target: '/mnt/d/skills', ReadOnly: true },
    ])

    const wslPayload = buildHardenedContainerPayload({
      image: 'dsh-cloud-sandbox-runtime:latest',
      cmd: ['sleep', 'infinity'],
      workingDir: '/mnt/d/work/ws1',
      mounts: [
        { hostPath: 'D:\\work\\ws1', dockerHostPath: '/mnt/d/work/ws1', containerPath: '/mnt/d/work/ws1', readOnly: false },
        { hostPath: 'D:\\skills', dockerHostPath: '/mnt/d/skills', containerPath: '/mnt/d/skills', readOnly: true },
      ],
      labels: {},
    })
    const wslHostCfg = wslPayload.HostConfig as Record<string, unknown>
    expect(wslHostCfg.Mounts).toBeUndefined()
    expect(wslHostCfg.Binds).toEqual([
      '/mnt/d/work/ws1:/mnt/d/work/ws1:rw',
      '/mnt/d/skills:/mnt/d/skills:ro',
    ])
  })
})

describe('DockerRuntimePool with transport: wsl', () => {
  let rootDir: string
  let wsDir: string
  let skillsDir: string

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'dsh-cloud-wsl-'))
    wsDir = join(rootDir, 'workspaces', 'proj-1')
    skillsDir = join(rootDir, 'skills')
    mkdirSync(wsDir, { recursive: true })
    mkdirSync(skillsDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('produces valid POSIX containerPaths and WSL dockerHostPaths for bind mounts and argv', async () => {
    let createdContainer: DockerContainerCreateRequest | undefined
    let createdExec: DockerExecCreateRequest | undefined

    const fakeDocker: DockerClient = {
      async ping() {},
      async listContainers() { return [] },
      async createContainer(req) {
        createdContainer = req
        return 'wsl-cid-1'
      },
      async startContainer() {},
      async inspectContainer() { return { id: 'wsl-cid-1', running: true, exitCode: 0 } },
      async stopContainer() {},
      async killContainer() {},
      async removeContainer() {},
      async execCreate(req) {
        createdExec = req
        return 'wsl-exec-1'
      },
      async execStart(): Promise<DockerExecStream> {
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        stdout.end('ok\n')
        stderr.end()
        return { stdin, stdout, stderr, closed: Promise.resolve(), destroy() {} }
      },
      async execInspect() { return { id: 'wsl-exec-1', running: false, exitCode: 0, pid: 101 } },
      async execResize() {},
    }

    const pool = createDockerRuntimePool({
      image: 'dsh-cloud-sandbox-runtime:latest',
      transport: 'wsl',
      wsl: { distro: 'Ubuntu-24.04', mountPrefix: '/mnt' },
      workspace: {
        allowedBaseDirs: [join(rootDir, 'workspaces')],
        readOnlyMounts: [skillsDir],
        pathMode: 'mirror',
      },
    }, fakeDocker)

    expect(pool.transport).toBe('wsl')
    await pool.initialize()

    const handle = pool.spawn({
      argv: ['python3', join(skillsDir, 'run.py')],
      cwd: wsDir,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
      graceMs: 500,
    })
    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)

    // Both containerPath and dockerHostPath MUST be valid POSIX absolute paths (no Windows drive colons).
    expect(createdContainer).toBeDefined()
    for (const mount of createdContainer!.mounts) {
      expect(mount.containerPath.startsWith('/')).toBe(true)
      expect(mount.containerPath).not.toContain(':')
      expect(mount.dockerHostPath?.startsWith('/')).toBe(true)
      expect(mount.dockerHostPath).not.toContain(':')
    }
    expect(createdExec?.workingDir.startsWith('/')).toBe(true)
    expect(createdExec?.cmd[1]?.startsWith('/')).toBe(true)
    expect(createdExec?.cmd[1]).toContain('run.py')

    await pool.dispose()
  })
})
