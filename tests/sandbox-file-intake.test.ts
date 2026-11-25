import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DockerSandboxError,
  SandboxFileIntake,
  WorkspacePolicyError,
  dockerSubprocessPlugin,
  normalizeUploadsSubdir,
  sandboxFileIntakePlugin,
  sanitizeLeafFilename,
  type DockerClient,
  type DockerContainerCreateRequest,
  type DockerContainerInspect,
  type DockerContainerSummary,
  type DockerExecCreateRequest,
  type DockerExecInspect,
  type DockerExecStream,
  type SandboxImportResult,
} from '../src/index.ts'

class StubDockerClient implements DockerClient {
  async ping(): Promise<void> {}
  async listContainers(): Promise<DockerContainerSummary[]> { return [] }
  async createContainer(_request: DockerContainerCreateRequest): Promise<string> { return 'stub-cid' }
  async startContainer(): Promise<void> {}
  async inspectContainer(id: string): Promise<DockerContainerInspect> { return { id, running: true, exitCode: 0 } }
  async stopContainer(): Promise<void> {}
  async killContainer(): Promise<void> {}
  async removeContainer(): Promise<void> {}
  async execCreate(_request: DockerExecCreateRequest): Promise<string> { return 'stub-exec' }
  async execStart(): Promise<DockerExecStream> { throw new Error('unused') }
  async execInspect(id: string): Promise<DockerExecInspect> { return { id, running: false, exitCode: 0, pid: 2 } }
  async execResize(): Promise<void> {}
}

describe('SandboxFileIntake (per-session attachment staging + approval-gated host file import)', () => {
  let rootDir: string
  let workspacesDir: string
  let wsA: string
  let wsB: string
  let downloadsDir: string
  let attachmentStoreDir: string

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'dsh-intake-'))
    workspacesDir = join(rootDir, 'workspaces')
    wsA = join(workspacesDir, 'ws-a')
    wsB = join(workspacesDir, 'ws-b')
    downloadsDir = join(rootDir, 'downloads')
    attachmentStoreDir = join(rootDir, 'attachments-store')
    mkdirSync(wsA, { recursive: true })
    mkdirSync(wsB, { recursive: true })
    mkdirSync(downloadsDir, { recursive: true })
    mkdirSync(attachmentStoreDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('validates uploadsDir and sanitizes leaf filenames across Windows and POSIX', () => {
    expect(normalizeUploadsSubdir('.dsh-uploads')).toBe('.dsh-uploads')
    expect(normalizeUploadsSubdir('inputs/pdfs')).toBe('inputs/pdfs')
    expect(() => normalizeUploadsSubdir('../escape')).toThrow(WorkspacePolicyError)
    expect(() => normalizeUploadsSubdir('a/../b')).toThrow(WorkspacePolicyError)

    expect(sanitizeLeafFilename('C:\\Users\\admin\\Downloads\\Receipt-2917-2642.pdf')).toBe('Receipt-2917-2642.pdf')
    expect(sanitizeLeafFilename('CON.txt')).toBe('_CON.txt')
    expect(sanitizeLeafFilename('bad:name?.pdf')).toBe('bad_name_.pdf')
  })

  it('stages uploaded session attachments ONLY into that session workspace (tenant-isolated)', async () => {
    const storedPdf = join(attachmentStoreDir, 'receipt-a.pdf')
    writeFileSync(storedPdf, 'PDF-CONTENT-A')

    const ctx = new Context()
    await ctx.plugin(dockerSubprocessPlugin, {
      image: 'dsh-cloud-sandbox-runtime:latest',
      workspace: { allowedBaseDirs: [workspacesDir] },
      dockerClient: new StubDockerClient(),
    })

    class MockAttachments extends Service {
      constructor(c: Context) {
        super(c, 'attachments')
      }
      fileHostPath(ref: { attachmentId?: string }) {
        if (ref.attachmentId === 'sha256:aaaaaaaa11111111') return storedPdf
        return undefined
      }
      async *readFileStream(ref: { attachmentId?: string }) {
        if (ref.attachmentId === 'sha256:bbbbbbbb22222222') {
          yield Buffer.from('STREAMED-PDF-B')
        }
      }
    }
    await ctx.plugin(MockAttachments)

    const intake = new SandboxFileIntake(ctx, {
      uploadsDir: '.dsh-uploads',
      stageSessionAttachments: true,
      enableHostFileImport: false,
    })

    const sessionA = { header: { cwd: wsA } }
    const stagedA = await intake.stageAttachmentsForSession(sessionA, [
      { attachmentId: 'sha256:aaaaaaaa11111111', name: 'Receipt-2917-2642.pdf', bytes: 13 },
      { attachmentId: 'sha256:bbbbbbbb22222222', name: 'Receipt-2917-2642.pdf', bytes: 14 },
    ])

    expect(stagedA).toHaveLength(2)
    expect(readFileSync(join(wsA, '.dsh-uploads', 'Receipt-2917-2642.pdf'), 'utf8')).toBe('PDF-CONTENT-A')
    expect(readFileSync(join(wsA, '.dsh-uploads', 'Receipt-2917-2642-bbbbbbbb.pdf'), 'utf8')).toBe('STREAMED-PDF-B')

    // Sibling workspace B received NOTHING from session A.
    expect(() => readFileSync(join(wsB, '.dsh-uploads', 'Receipt-2917-2642.pdf'))).toThrow()

    await ctx.fiber.dispose()
  })

  it('registers sandbox_import_file only when enabled and imports host files after explicit approval', async () => {
    const pdf1 = join(downloadsDir, 'Receipt-2917-2642.pdf')
    const pdf2 = join(downloadsDir, 'Receipt-2184-6675.pdf')
    writeFileSync(pdf1, 'RECEIPT-1')
    writeFileSync(pdf2, 'RECEIPT-2')

    const sshDir = join(rootDir, '.ssh')
    mkdirSync(sshDir, { recursive: true })
    const sshKey = join(sshDir, 'id_rsa')
    writeFileSync(sshKey, 'TOP-SECRET-KEY')

    const registeredTools = new Map<string, Record<string, unknown>>()
    const approvalRequests: Array<{ toolName: string; reason?: string }> = []
    let nextApprovalOutcome = 'allowed-once'

    const ctx = new Context()
    await ctx.plugin(dockerSubprocessPlugin, {
      image: 'dsh-cloud-sandbox-runtime:latest',
      workspace: { allowedBaseDirs: [workspacesDir], pathMode: 'remap' },
      dockerClient: new StubDockerClient(),
    })

    class MockTools extends Service {
      constructor(c: Context) {
        super(c, 'tools')
      }
      register(def: Record<string, unknown>) {
        const name = String(def.name)
        registeredTools.set(name, def)
        return () => { registeredTools.delete(name) }
      }
    }
    class MockWorkingDirectory extends Service {
      constructor(c: Context) {
        super(c, 'workingDirectory')
      }
      async ensure() {
        return wsA
      }
    }
    class MockApproval extends Service {
      constructor(c: Context) {
        super(c, 'approval')
      }
      async request(req: { toolName: string; reason?: string }) {
        approvalRequests.push({ toolName: req.toolName, reason: req.reason })
        return nextApprovalOutcome
      }
    }

    await ctx.plugin(MockTools)
    await ctx.plugin(MockWorkingDirectory)
    await ctx.plugin(MockApproval)

    // Cloud mode (enableHostFileImport: false): tool MUST NOT register.
    const cloudFiber = await ctx.plugin(sandboxFileIntakePlugin, {
      stageSessionAttachments: true,
      enableHostFileImport: false,
    })
    expect(registeredTools.has('sandbox_import_file')).toBe(false)
    await cloudFiber.dispose()

    // Local mode (enableHostFileImport: true): tool registers cleanly.
    await ctx.plugin(sandboxFileIntakePlugin, {
      stageSessionAttachments: true,
      enableHostFileImport: true,
      maxFileBytes: 1024,
    })
    const tool = registeredTools.get('sandbox_import_file') as {
      execute: (args: unknown, exec: unknown) => Promise<SandboxImportResult>
      output: { render: (args: unknown, val: unknown) => Array<{ text: string }> }
    } | undefined
    expect(tool).toBeDefined()

    // 1) Sensitive credential path (.ssh/id_rsa) is blocked BEFORE prompting the user!
    await expect(tool!.execute(
      { paths: [sshKey], reason: 'read key' },
      { agent: { session: { header: { cwd: wsA } } }, callId: 'call-1' },
    )).rejects.toThrow(WorkspacePolicyError)
    expect(approvalRequests).toHaveLength(0)

    // 2) Directories are blocked BEFORE prompting the user!
    await expect(tool!.execute(
      { paths: [downloadsDir], reason: 'import dir' },
      { agent: { session: { header: { cwd: wsA } } }, callId: 'call-2' },
    )).rejects.toThrow(WorkspacePolicyError)
    expect(approvalRequests).toHaveLength(0)

    // 3) User rejects approval -> fails closed and copies nothing!
    nextApprovalOutcome = 'rejected'
    await expect(tool!.execute(
      { paths: [pdf1], reason: 'analyze receipt' },
      { agent: { session: { header: { cwd: wsA } } }, callId: 'call-3' },
    )).rejects.toThrow(DockerSandboxError)
    expect(approvalRequests).toHaveLength(1)
    expect(() => readFileSync(join(wsA, '.dsh-uploads', 'Receipt-2917-2642.pdf'))).toThrow()

    // 4) User approves -> copies both PDFs into workspace `.dsh-uploads/` and maps container paths!
    nextApprovalOutcome = 'allowed-once'
    const result = await tool!.execute(
      { paths: [pdf1, pdf2], reason: 'analyze 2 windsurf receipts' },
      { agent: { session: { header: { cwd: wsA } } }, callId: 'call-4' },
    )
    expect(result.imported).toHaveLength(2)
    expect(result.containerTargetDir).toBe('/workspace/.dsh-uploads')
    expect(result.imported[0]?.containerPath).toBe('/workspace/.dsh-uploads/Receipt-2917-2642.pdf')
    expect(result.imported[1]?.containerPath).toBe('/workspace/.dsh-uploads/Receipt-2184-6675.pdf')
    expect(readFileSync(join(wsA, '.dsh-uploads', 'Receipt-2917-2642.pdf'), 'utf8')).toBe('RECEIPT-1')
    expect(readFileSync(join(wsA, '.dsh-uploads', 'Receipt-2184-6675.pdf'), 'utf8')).toBe('RECEIPT-2')

    const rendered = tool!.output.render({}, result)
    expect(rendered[0]?.text).toContain('/workspace/.dsh-uploads/Receipt-2917-2642.pdf')

    await ctx.fiber.dispose()
    expect(registeredTools.has('sandbox_import_file')).toBe(false)
  })
})
