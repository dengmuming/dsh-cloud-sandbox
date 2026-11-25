import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DockerSandboxError,
  DockerShellExecutor,
  DockerSubprocessRuntime,
  WorkspaceFencedFileSystem,
  WorkspacePolicyError,
  createDockerRuntimePool,
  dockerShellPlugin,
  dockerSubprocessPlugin,
  isHostRipgrepBinary,
  type DockerClient,
  type DockerContainerCreateRequest,
  type DockerContainerInspect,
  type DockerContainerSummary,
  type DockerExecCreateRequest,
  type DockerExecInspect,
  type DockerExecStream,
} from '../src/index.ts'

interface FakeExecRecord {
  readonly id: string
  readonly request: DockerExecCreateRequest
  exitCode: number | null
  running: boolean
  pid: number
  resizes: Array<{ cols: number; rows: number }>
}

/** Deterministic in-memory DockerClient simulating Linux Docker Engine behavior. */
class FakeDockerClient implements DockerClient {
  containers = new Map<string, { id: string; request: DockerContainerCreateRequest; running: boolean }>()
  execs = new Map<string, FakeExecRecord>()
  removedIds: string[] = []
  private seq = 0
  private execSeq = 0

  /** Custom handler invoked when execStart runs (for simulating commands, EROFS, long runs, PTYs). */
  onExecStart?: (
    record: FakeExecRecord,
    container: { id: string; request: DockerContainerCreateRequest; running: boolean },
    streams: { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough },
  ) => Promise<number> | number

  async ping(): Promise<void> {}

  async listContainers(labels: Readonly<Record<string, string>>): Promise<DockerContainerSummary[]> {
    const out: DockerContainerSummary[] = []
    for (const c of this.containers.values()) {
      const match = Object.entries(labels).every(([k, v]) => c.request.labels[k] === v)
      if (match) out.push({ id: c.id, state: c.running ? 'running' : 'exited', labels: c.request.labels })
    }
    return out
  }

  async createContainer(request: DockerContainerCreateRequest): Promise<string> {
    const id = `fake-cid-${++this.seq}`
    this.containers.set(id, { id, request, running: false })
    return id
  }

  async startContainer(containerId: string): Promise<void> {
    const c = this.containers.get(containerId)
    if (!c) throw new Error(`missing container ${containerId}`)
    c.running = true
  }

  async inspectContainer(containerId: string): Promise<DockerContainerInspect | undefined> {
    const c = this.containers.get(containerId)
    if (!c) return undefined
    return { id: c.id, running: c.running, exitCode: c.running ? 0 : 137 }
  }

  async stopContainer(containerId: string): Promise<void> {
    const c = this.containers.get(containerId)
    if (c) c.running = false
  }

  async killContainer(containerId: string): Promise<void> {
    const c = this.containers.get(containerId)
    if (c) c.running = false
  }

  async removeContainer(containerId: string): Promise<void> {
    this.containers.delete(containerId)
    this.removedIds.push(containerId)
  }

  async execCreate(request: DockerExecCreateRequest): Promise<string> {
    const id = `fake-exec-${++this.execSeq}`
    this.execs.set(id, {
      id,
      request,
      exitCode: null,
      running: true,
      pid: 1000 + this.execSeq,
      resizes: [],
    })
    return id
  }

  async execStart(execId: string, options: { tty: boolean }): Promise<DockerExecStream> {
    const record = this.execs.get(execId)
    if (!record) throw new Error(`missing exec ${execId}`)
    const container = this.containers.get(record.request.containerId)
    if (!container) throw new Error(`missing container ${record.request.containerId}`)

    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()

    const closed = (async () => {
      try {
        const code = this.onExecStart
          ? await this.onExecStart(record, container, { stdin, stdout, stderr })
          : (() => {
            stdout.end(`ran:${record.request.cmd.join(' ')}`)
            stderr.end()
            return 0
          })()
        record.exitCode = code
        record.running = false
      } finally {
        stdout.end()
        stderr.end()
      }
    })()

    return {
      stdin,
      stdout,
      stderr,
      ...(options.tty ? { ttyOutput: stdout } : {}),
      closed,
      destroy: () => {
        record.running = false
        record.exitCode ??= 143
        stdin.end()
        stdout.end()
        stderr.end()
      },
    }
  }

  async execInspect(execId: string): Promise<DockerExecInspect> {
    const record = this.execs.get(execId)
    if (!record) throw new Error(`missing exec ${execId}`)
    return {
      id: record.id,
      running: record.running,
      exitCode: record.exitCode,
      pid: record.pid,
    }
  }

  async execResize(execId: string, cols: number, rows: number): Promise<void> {
    const record = this.execs.get(execId)
    if (record) record.resizes.push({ cols, rows })
  }
}

describe('DSH Seam Integration (DockerSubprocessRuntime, DockerShellExecutor, WorkspaceFencedFileSystem)', () => {
  let rootDir: string
  let workspacesDir: string
  let ws1: string
  let ws2: string
  let skillsDir: string
  let secretDir: string

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'dsh-cloud-int-'))
    workspacesDir = join(rootDir, 'workspaces')
    ws1 = join(workspacesDir, 'ws1')
    ws2 = join(workspacesDir, 'ws2')
    skillsDir = join(rootDir, 'skills')
    secretDir = join(rootDir, 'host-secrets')
    mkdirSync(ws1, { recursive: true })
    mkdirSync(ws2, { recursive: true })
    mkdirSync(skillsDir, { recursive: true })
    mkdirSync(secretDir, { recursive: true })
    writeFileSync(join(ws1, 'hello.txt'), 'hello workspace\n')
    writeFileSync(join(skillsDir, 'SKILL.md'), '# Skill\n')
    writeFileSync(join(secretDir, 'api.key'), 'sk-secret-123')
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('runs DSH ctx.subprocess & DockerShellExecutor with warm reuse, RO mode, escalation block, and orphan sweep', async () => {
    const docker = new FakeDockerClient()
    // Seed an orphan container from a prior crash.
    const orphanId = await docker.createContainer({
      image: 'dsh-cloud-sandbox-runtime:latest',
      cmd: ['sleep', 'infinity'],
      workingDir: ws1,
      mounts: [],
      labels: { 'dsh.sandbox.managed': 'true', 'dsh.sandbox.pool_id': 'test-pool' },
    })
    await docker.startContainer(orphanId)

    docker.onExecStart = (record, container, { stdout, stderr }) => {
      const wsMount = container.request.mounts[0]
      if (record.request.cmd.includes('touch /blocked') && wsMount?.readOnly) {
        stderr.end('touch: cannot touch \'/blocked\': Read-only file system')
        return 1
      }
      stdout.end(`ok:${record.request.workingDir}:${record.request.env.join(',')}`)
      return 0
    }

    const pool = createDockerRuntimePool({
      image: 'dsh-cloud-sandbox-runtime:latest',
      poolId: 'test-pool',
      workspace: {
        allowedBaseDirs: [workspacesDir],
        readOnlyMounts: [skillsDir],
      },
      envBlocklist: [/^CUSTOM_SECRET$/],
    }, docker)

    await pool.initialize()
    // Orphan container swept on startup.
    expect(docker.removedIds).toContain(orphanId)

    const ctx = new Context()
    await ctx.plugin(DockerSubprocessRuntime, { pool, ownPool: true })
    await ctx.plugin(DockerShellExecutor, { allowDangerFullAccess: false })

    // Executable & terminalEnvironment contracts.
    expect(await ctx.subprocess.resolveExecutable('bash')).toBe('/bin/bash')
    expect(await ctx.subprocess.terminalEnvironment()).toEqual({ platform: 'posix', defaultShell: '/bin/bash' })
    await expect(ctx.subprocess.resolveExecutable('./relative/bin')).rejects.toThrow('relative path')

    // 1. workspace-write execution reuses warm container across calls and respects env blocklist.
    const spec1 = ctx.shell.resolve({
      command: 'echo hi',
      workdir: ws1,
      env: { SAFE_VAR: '1', CUSTOM_SECRET: 'nope' },
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: ws1 },
    })
    const ex1 = await ctx.shell.execute(spec1)
    const res1 = await ex1.result()
    expect(res1.exitCode).toBe(0)
    expect(res1.stdout.text).toContain('SAFE_VAR=1')
    expect(res1.stdout.text).not.toContain('CUSTOM_SECRET')
    expect(res1.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })

    const containersAfterFirst = docker.containers.size
    const spec2 = ctx.shell.resolve({
      command: 'echo again',
      workdir: ws1,
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: ws1 },
    })
    await (await ctx.shell.execute(spec2)).result()
    expect(docker.containers.size).toBe(containersAfterFirst)

    // 2. read-only mode mounts workspace :ro in an ephemeral container and reports sandbox denial on EROFS.
    const specRo = ctx.shell.resolve({
      command: 'touch /blocked',
      workdir: ws1,
      sandboxPolicy: { mode: 'read-only', workspaceRoot: ws1 },
    })
    const resRo = await (await ctx.shell.execute(specRo)).result()
    expect(resRo.exitCode).toBe(1)
    expect(resRo.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'full' })

    // 3. danger-full-access escalation is rejected fail-closed.
    const specEsc = ctx.shell.resolve({
      command: 'id',
      workdir: ws1,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: ws1 },
    })
    await expect(ctx.shell.execute(specEsc)).rejects.toThrow(DockerSandboxError)

    // 3b. Cross-workspace workdir escape (sibling ws2 under same allowedBaseDirs) is rejected!
    const specCrossWs = ctx.shell.resolve({
      command: 'ls',
      workdir: ws2,
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: ws1 },
    })
    await expect(ctx.shell.execute(specCrossWs)).rejects.toThrow(WorkspacePolicyError)

    // 4. PTY terminal session works via spawnTerminal.
    docker.onExecStart = (_record, _container, { stdin, stdout }) => new Promise<number>((resolve) => {
      stdin.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        stdout.write(`echo:${text}`)
        if (text.includes('exit')) resolve(0)
      })
    })
    const term = await ctx.subprocess.spawnTerminal({
      argv: ['/bin/bash'],
      cwd: ws1,
      rows: 24,
      cols: 80,
      terminalType: 'xterm-256color',
      graceMs: 500,
    })
    await term.resize(120, 40)
    const chunks: string[] = []
    term.output.on('data', (c: Buffer) => chunks.push(c.toString('utf8')))
    await term.write('hello\n')
    await term.write('exit\n')
    const termOutcome = await term.done
    expect(termOutcome.exitCode).toBe(0)
    expect(chunks.join('')).toContain('echo:hello')

    await ctx.fiber.dispose()
    expect(docker.containers.size).toBe(0)
  })

  it('shares one host-level DockerRuntimePool across multiple independent Cordis Contexts', async () => {
    const docker = new FakeDockerClient()
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>(r => { releaseFirst = r })
    let startedCount = 0

    docker.onExecStart = async (record, _container, { stdout }) => {
      startedCount += 1
      if (record.request.cmd.includes('slow')) {
        await firstBlocked
      }
      stdout.end(`done:${record.request.workingDir}`)
      return 0
    }

    const sharedPool = createDockerRuntimePool({
      image: 'dsh-cloud-sandbox-runtime:latest',
      workspace: { allowedBaseDirs: [workspacesDir] },
      scheduler: { maxConcurrentTasks: 1, maxConcurrencyPerWorkspace: 1, maxActiveContainers: 4 },
    }, docker)
    await sharedPool.initialize()

    const ctxA = new Context()
    const ctxB = new Context()
    await ctxA.plugin(DockerSubprocessRuntime, { pool: sharedPool, ownPool: false })
    await ctxB.plugin(DockerSubprocessRuntime, { pool: sharedPool, ownPool: false })

    // Start slow task in Context A (ws1); Context B (ws2) MUST wait on the shared host queue!
    const handleA = ctxA.subprocess.spawn({
      argv: ['bash', '-c', 'slow'],
      cwd: ws1,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      graceMs: 500,
    })
    const handleB = ctxB.subprocess.spawn({
      argv: ['bash', '-c', 'fast'],
      cwd: ws2,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      graceMs: 500,
    })

    // Give microtasks a tick: only task A should have entered Docker while B is queued.
    await new Promise(r => setTimeout(r, 25))
    expect(startedCount).toBe(1)
    expect(sharedPool.getMetrics().queuedTasks).toBe(1)

    releaseFirst()
    expect((await handleA.done).exitCode).toBe(0)
    expect((await handleB.done).exitCode).toBe(0)
    expect(startedCount).toBe(2)

    // Stopping Context A must NOT dispose the shared pool used by Context B!
    await ctxA.fiber.dispose()
    const handleB2 = ctxB.subprocess.spawn({
      argv: ['bash', '-c', 'after-a-stopped'],
      cwd: ws2,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      graceMs: 500,
    })
    expect((await handleB2.done).exitCode).toBe(0)

    await ctxB.fiber.dispose()
    await sharedPool.dispose()
  })

  it('fences both reads and writes with WorkspaceFencedFileSystem while allowing read-only Skill mounts', async () => {
    const ctx = new Context()
    await ctx.plugin(WorkspaceFencedFileSystem, {
      allowedBaseDirs: [workspacesDir],
      readOnlyMounts: [skillsDir],
      cwd: ws1,
    })

    // Reading & writing inside workspace succeeds.
    const wsTarget = await ctx.fs.resolve(join(ws1, 'hello.txt'))
    expect(await ctx.fs.readText(wsTarget)).toBe('hello workspace\n')

    const noteTarget = await ctx.fs.resolve(join(ws1, 'note.txt'))
    await ctx.fs.writeText(noteTarget, 'created\n')
    expect(await ctx.fs.readText(noteTarget)).toBe('created\n')

    // Reading a file inside a read-only Skill mount succeeds, but writing to it is DENIED!
    const skillTarget = await ctx.fs.resolve(join(skillsDir, 'SKILL.md'))
    expect(await ctx.fs.readText(skillTarget)).toBe('# Skill\n')
    await expect(ctx.fs.writeText(skillTarget, 'tampered')).rejects.toThrow(FsError)

    // Reading host secrets outside allowedBaseDirs is DENIED (unlike upstream dsh-fs-sandbox).
    await expect(ctx.fs.resolve(join(secretDir, 'api.key'))).rejects.toThrow(FsError)

    // Writing under read-only per-call SandboxExecutionPolicy is DENIED.
    await expect(
      ctx.fs.writeText(noteTarget, 'blocked', undefined, undefined, { mode: 'read-only', workspaceRoot: ws1 }),
    ).rejects.toThrow(FsError)

    await ctx.fiber.dispose()
  })

  it('polls execInspect until containerd settles exitCode instead of misclassifying as SIGKILL', async () => {
    const docker = new FakeDockerClient()
    let inspectCalls = 0
    const baseInspect = docker.execInspect.bind(docker)
    docker.execInspect = async (execId: string) => {
      inspectCalls += 1
      if (inspectCalls === 1) {
        return { id: execId, running: true, exitCode: null, pid: 2001 }
      }
      return baseInspect(execId)
    }

    const pool = createDockerRuntimePool({
      image: 'dsh-cloud-sandbox-runtime:latest',
      workspace: { allowedBaseDirs: [workspacesDir] },
    }, docker)
    await pool.initialize()

    const handle = pool.spawn({
      argv: ['echo', 'settled'],
      cwd: ws1,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
      graceMs: 500,
    })
    const outcome = await handle.done
    expect(outcome).toEqual({ exitCode: 0, signal: null })
    expect(inspectCalls).toBeGreaterThanOrEqual(2)
    await pool.dispose()
  })

  it('hands off subprocess and shell cleanly during live Cordis reload when departing providers have slow dependents', async () => {
    const docker = new FakeDockerClient()
    const ctx = new Context()

    class MockLocalSubprocess extends Service {
      constructor(c: Context) {
        super(c, 'subprocess')
      }
    }

    class MockLocalShell extends Service {
      static inject = ['subprocess']
      constructor(c: Context) {
        super(c, 'shell')
      }
    }

    // Dependent plugin whose async teardown takes 50ms, holding Cordis 4.x's
    // `while ([...this.provisions].some(impl => impl.dependents.size))` barrier open
    // on both MockLocalShell and MockLocalSubprocess after dispose() is triggered.
    const slowDependent = {
      name: 'SlowSubprocessAndShellConsumer',
      inject: ['subprocess', 'shell'],
      apply(c: Context) {
        c.effect(() => async () => {
          await new Promise(resolve => setTimeout(resolve, 50))
        }, 'slow consumer teardown')
      },
    }

    const oldSubprocessFiber = await ctx.plugin(MockLocalSubprocess)
    const oldShellFiber = await ctx.plugin(MockLocalShell)
    await ctx.plugin(slowDependent)

    // Simulate `@deepseek-ai/cordis-plugin-loader`'s `EntryGroup.update()`:
    // fire-and-forget dispose of the disabled legacy providers while immediately starting
    // the replacement `dsh-cloud-sandbox/subprocess` and `dsh-cloud-sandbox/shell` entries.
    void oldSubprocessFiber.dispose()
    void oldShellFiber.dispose()

    const newSubprocessFiber = ctx.plugin(dockerSubprocessPlugin, {
      image: 'dsh-cloud-sandbox-runtime:latest',
      workspace: { allowedBaseDirs: [workspacesDir] },
      dockerClient: docker,
    })
    const newShellFiber = ctx.plugin(dockerShellPlugin, {
      cwd: ws1,
      timeoutMs: 10_000,
    })

    await newSubprocessFiber
    await newShellFiber.await()

    expect(ctx.get('subprocess')).toBeInstanceOf(DockerSubprocessRuntime)
    expect(ctx.get('shell')).toBeInstanceOf(DockerShellExecutor)

    await ctx.fiber.dispose()
  })

  it('still fails closed when an active (non-disposing) subprocess provider is already registered', async () => {
    const docker = new FakeDockerClient()
    const ctx = new Context()

    class ActiveSubprocess extends Service {
      constructor(c: Context) {
        super(c, 'subprocess')
      }
    }

    await ctx.plugin(ActiveSubprocess)

    await expect(ctx.plugin(dockerSubprocessPlugin, {
      image: 'dsh-cloud-sandbox-runtime:latest',
      workspace: { allowedBaseDirs: [workspacesDir] },
      dockerClient: docker,
    })).rejects.toThrow(/service "subprocess" has been registered/)

    await ctx.fiber.dispose()
  })

  it('aborts handoff cleanly if the replacement fiber is disposed while waiting for a departing provider', async () => {
    const docker = new FakeDockerClient()
    const ctx = new Context()

    let releaseSlowDependent!: () => void
    const slowDependentGate = new Promise<void>((resolve) => {
      releaseSlowDependent = resolve
    })

    class SlowOldSubprocess extends Service {
      constructor(c: Context) {
        super(c, 'subprocess')
      }
    }

    const slowDependent = {
      name: 'BlockedConsumer',
      inject: ['subprocess'],
      apply(c: Context) {
        c.effect(() => async () => {
          await slowDependentGate
        }, 'blocked consumer teardown')
      },
    }

    const oldFiber = await ctx.plugin(SlowOldSubprocess)
    await ctx.plugin(slowDependent)

    void oldFiber.dispose()

    const replacementFiber = ctx.plugin(dockerSubprocessPlugin, {
      image: 'dsh-cloud-sandbox-runtime:latest',
      workspace: { allowedBaseDirs: [workspacesDir] },
      dockerClient: docker,
    })

    // Yield briefly so replacementFiber enters waitForDisposingService, then cancel it.
    await new Promise(resolve => setTimeout(resolve, 15))
    await replacementFiber.dispose()

    // Release the old provider; the cancelled replacement must NOT have registered itself.
    releaseSlowDependent()
    await oldFiber.await()

    expect(ctx.get('subprocess')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('rewrites host ripgrep binary and target paths so DSH glob/grep work inside Linux Docker', async () => {
    expect(isHostRipgrepBinary('C:\\Users\\admin\\node_modules\\@vscode\\ripgrep\\bin\\rg.exe')).toBe(true)
    expect(isHostRipgrepBinary('D:\\dsh\\dsh-rg.exe')).toBe(true)
    expect(isHostRipgrepBinary('/opt/dsh/node_modules/@vscode/ripgrep/bin/rg')).toBe(true)
    expect(isHostRipgrepBinary('bash')).toBe(false)
    expect(isHostRipgrepBinary('/usr/bin/python3')).toBe(false)

    const docker = new FakeDockerClient()
    let seenCmd: readonly string[] = []
    docker.onExecStart = async (record, _container, streams) => {
      seenCmd = record.request.cmd
      streams.stdout.end('hello.txt\n')
      return 0
    }

    const ctx = new Context()
    await ctx.plugin(dockerSubprocessPlugin, {
      image: 'dsh-cloud-sandbox-runtime:latest',
      workspace: { allowedBaseDirs: [workspacesDir], pathMode: 'remap' },
      dockerClient: docker,
    })

    expect(await ctx.subprocess.resolveExecutable('C:\\dsh\\@vscode\\ripgrep\\bin\\rg.exe')).toBe('/usr/bin/rg')

    const handle = ctx.subprocess.spawn({
      argv: [
        'C:\\dsh\\node_modules\\@vscode\\ripgrep\\bin\\rg.exe',
        '--no-config',
        '--files',
        '--',
        'src\\nested',
      ],
      cwd: ws1,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      graceMs: 500,
    })
    expect((await handle.done).exitCode).toBe(0)
    expect(seenCmd).toEqual(['rg', '--no-config', '--files', '--', 'src/nested'])

    // Absolute host path after `--` maps into container workspace path.
    const handle2 = ctx.subprocess.spawn({
      argv: ['/host/node_modules/@vscode/ripgrep/bin/rg', '--no-config', '--json', '--regexp=hello', '--', ws1],
      cwd: ws1,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      graceMs: 500,
    })
    expect((await handle2.done).exitCode).toBe(0)
    expect(seenCmd).toEqual(['rg', '--no-config', '--json', '--regexp=hello', '--', '/workspace'])

    await ctx.fiber.dispose()
  })

  it('trusts DSH workspaceRegistry folders and auto-mounts DSH attachments read-only when enabled', async () => {
    const docker = new FakeDockerClient()
    const fakeDshHome = join(rootDir, 'dsh-home')
    const attachmentsDir = join(fakeDshHome, 'attachments', 'v1', 'files')
    mkdirSync(attachmentsDir, { recursive: true })
    writeFileSync(join(attachmentsDir, 'receipt.pdf'), 'pdf-bytes')

    const extraProject = join(rootDir, 'registered-project')
    mkdirSync(extraProject, { recursive: true })

    const ctx = new Context()
    ;(ctx as unknown as { dshHomePath: (sub: string) => string }).dshHomePath = (sub: string) => join(fakeDshHome, sub)

    class MockWorkspaceRegistry extends Service {
      constructor(c: Context) {
        super(c, 'workspaceRegistry')
      }
      list() {
        return [{ path: extraProject }]
      }
    }
    await ctx.plugin(MockWorkspaceRegistry)

    await ctx.plugin(dockerSubprocessPlugin, {
      image: 'dsh-cloud-sandbox-runtime:latest',
      workspace: {
        allowedBaseDirs: [ws1],
        trustRegisteredWorkspaces: true,
        mountAttachments: true,
      },
      dockerClient: docker,
    })

    // Registered project outside static allowedBaseDirs is allowed automatically!
    const handle = ctx.subprocess.spawn({
      argv: ['echo', 'ok'],
      cwd: extraProject,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
      graceMs: 500,
    })
    expect((await handle.done).exitCode).toBe(0)

    const container = [...docker.containers.values()][0]
    expect(container).toBeDefined()
    const attachmentMount = container!.request.mounts.find(m => m.hostPath.includes('attachments'))
    expect(attachmentMount).toBeDefined()
    expect(attachmentMount?.readOnly).toBe(true)

    // Unregistered host directory (secretDir) is STILL rejected fail-closed!
    expect(() => ctx.subprocess.spawn({
      argv: ['echo', 'nope'],
      cwd: secretDir,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
      graceMs: 500,
    })).toThrow(WorkspacePolicyError)

    await ctx.fiber.dispose()
  })

  it('supports user-approved one-shot ephemeral read-only host file mounts while blocking credential paths', async () => {
    const docker = new FakeDockerClient()
    const downloadsDir = join(rootDir, 'downloads')
    mkdirSync(downloadsDir, { recursive: true })
    const receiptFile = join(downloadsDir, 'Receipt-2917-2642.pdf')
    writeFileSync(receiptFile, 'receipt-data')

    const sshDir = join(rootDir, '.ssh')
    mkdirSync(sshDir, { recursive: true })
    const sshKey = join(sshDir, 'id_rsa')
    writeFileSync(sshKey, 'PRIVATE KEY')

    let seenCommand = ''
    let seenMounts: DockerContainerCreateRequest['mounts'] = []
    docker.onExecStart = async (record, container, streams) => {
      seenCommand = record.request.cmd[2] ?? ''
      seenMounts = container.request.mounts
      if (container.request.mounts.some(m => m.hostPath === receiptFile || m.hostPath.endsWith('Receipt-2917-2642.pdf'))) {
        streams.stdout.end('parsed receipt\n')
        return 0
      }
      streams.stderr.end(`cat: ${receiptFile}: No such file or directory\n`)
      return 1
    }

    const ctx = new Context()
    await ctx.plugin(dockerSubprocessPlugin, {
      image: 'dsh-cloud-sandbox-runtime:latest',
      workspace: { allowedBaseDirs: [workspacesDir] },
      dockerClient: docker,
    })
    await ctx.plugin(dockerShellPlugin, {
      cwd: ws1,
      timeoutMs: 10_000,
      allowDangerFullAccess: false,
      allowApprovedHostReadOnly: true,
    })

    // 1) Normal workspace-write mode: unmounted host file fails and marks sandbox.denied = true
    //    so DSH prompts the user for approval (or asks them to upload the file).
    const unapproved = await ctx.shell.execute(ctx.shell.resolve({
      command: `cat "${receiptFile}"`,
      workdir: ws1,
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: ws1 },
    }))
    const unapprovedResult = await unapproved.result()
    expect(unapprovedResult.exitCode).toBe(1)
    expect(unapprovedResult.sandbox?.denied).toBe(true)

    // 2) After user approves via DSH approval dialog (mode === 'danger-full-access'):
    //    mounts ONLY the approved receipt file strictly read-only into an ephemeral container!
    const approved = await ctx.shell.execute(ctx.shell.resolve({
      command: `cat "${receiptFile}"`,
      workdir: ws1,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: ws1 },
    }))
    const approvedResult = await approved.result()
    expect(approvedResult.exitCode).toBe(0)
    expect(approvedResult.stdout.text).toContain('parsed receipt')
    const receiptMount = seenMounts.find(m => m.hostPath.endsWith('Receipt-2917-2642.pdf'))
    expect(receiptMount).toBeDefined()
    expect(receiptMount?.readOnly).toBe(true)
    expect(seenCommand).toContain(receiptMount!.containerPath)
    // Ephemeral container was auto-removed after the approved command exited.
    expect(docker.removedIds.length).toBeGreaterThanOrEqual(1)

    // 3) Even WITH approval, host credential paths (.ssh/id_rsa) are ALWAYS rejected fail-closed!
    await expect(ctx.shell.execute(ctx.shell.resolve({
      command: `cat "${sshKey}"`,
      workdir: ws1,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: ws1 },
    }))).rejects.toThrow(WorkspacePolicyError)

    await ctx.fiber.dispose()
  })
})
