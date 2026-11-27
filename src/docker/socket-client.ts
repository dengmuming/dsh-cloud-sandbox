/**
 * Dependency-free Linux Docker Engine API client over Unix domain socket (`/var/run/docker.sock`).
 *
 * Uses Node.js built-in `node:http` with `socketPath` and raw HTTP `Upgrade: tcp` for
 * `POST /exec/{id}/start`, plus a chunk-safe 8-byte Docker multiplexed stream demuxer.
 */

import http from 'node:http'
import type { Duplex } from 'node:stream'
import { PassThrough, Readable, Writable } from 'node:stream'
import type { BindMountSpec, ContainerSecurityConfig, DockerTransportMode, WslConfig } from '../types.ts'
import { DockerSandboxError, DockerTransportError } from '../types.ts'
import { isWindowsDrivePath, parseWslUncPath } from '../workspace/wsl-paths.ts'
import {
  DEFAULT_WINDOWS_DOCKER_PIPE,
  DEFAULT_WSL_DOCKER_SOCKET,
  createWslSocketStream,
} from './wsl-bridge.ts'

export const MANAGED_LABEL = 'dsh.sandbox.managed'
export const POOL_ID_LABEL = 'dsh.sandbox.pool_id'
export const WORKSPACE_ID_LABEL = 'dsh.sandbox.workspace_id'
export const LIFECYCLE_LABEL = 'dsh.sandbox.lifecycle'

export interface DockerContainerCreateRequest {
  readonly image: string
  readonly cmd: readonly string[]
  readonly workingDir: string
  readonly mounts: readonly BindMountSpec[]
  readonly labels: Readonly<Record<string, string>>
  readonly security?: ContainerSecurityConfig
  readonly env?: readonly string[]
}

export interface DockerContainerSummary {
  readonly id: string
  readonly state: string
  readonly labels: Readonly<Record<string, string>>
}

export interface DockerContainerInspect {
  readonly id: string
  readonly running: boolean
  readonly exitCode: number
}

export interface DockerExecCreateRequest {
  readonly containerId: string
  readonly cmd: readonly string[]
  readonly workingDir: string
  readonly env: readonly string[]
  readonly attachStdin: boolean
  readonly attachStdout: boolean
  readonly attachStderr: boolean
  readonly tty: boolean
  readonly user?: string
}

export interface DockerExecStream {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  /** Raw combined output stream when `tty: true` (identical to stdout). */
  readonly ttyOutput?: Readable
  readonly closed: Promise<void>
  destroy(): void
}

export interface DockerExecInspect {
  readonly id: string
  readonly running: boolean
  readonly exitCode: number | null
  readonly pid: number
}

export interface DockerClient {
  ping(signal?: AbortSignal): Promise<void>
  listContainers(labels: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<DockerContainerSummary[]>
  createContainer(request: DockerContainerCreateRequest, signal?: AbortSignal): Promise<string>
  startContainer(containerId: string, signal?: AbortSignal): Promise<void>
  inspectContainer(containerId: string, signal?: AbortSignal): Promise<DockerContainerInspect | undefined>
  stopContainer(containerId: string, timeoutSeconds?: number): Promise<void>
  killContainer(containerId: string, signalName?: string): Promise<void>
  removeContainer(containerId: string, force?: boolean): Promise<void>
  execCreate(request: DockerExecCreateRequest, signal?: AbortSignal): Promise<string>
  execStart(execId: string, options: { tty: boolean; detach?: boolean }, signal?: AbortSignal): Promise<DockerExecStream>
  execInspect(execId: string, signal?: AbortSignal): Promise<DockerExecInspect>
  execResize(execId: string, cols: number, rows: number): Promise<void>
}

const DEFAULT_USER = '1000:1000'
const DEFAULT_CPUS = 2
const DEFAULT_MEMORY_BYTES = 2 * 1024 * 1024 * 1024
const DEFAULT_PIDS_LIMIT = 256
const DEFAULT_TMPFS_SIZE_MB = 256

/** Build the hardened Docker Engine `/containers/create` JSON body. */
export function buildHardenedContainerPayload(request: DockerContainerCreateRequest): Record<string, unknown> {
  const sec = request.security ?? {}
  const cpus = sec.cpus ?? DEFAULT_CPUS
  const memoryBytes = sec.memoryBytes ?? DEFAULT_MEMORY_BYTES
  const memorySwapBytes = sec.memorySwapBytes ?? memoryBytes
  const pidsLimit = sec.pidsLimit ?? DEFAULT_PIDS_LIMIT
  const readonlyRootfs = sec.readonlyRootfs ?? true
  const tmpfsSizeMb = sec.tmpfsSizeMb ?? DEFAULT_TMPFS_SIZE_MB
  const tmpfsFlags = sec.tmpfsNoExec
    ? `rw,nosuid,nodev,noexec,size=${tmpfsSizeMb}m`
    : `rw,nosuid,nodev,exec,size=${tmpfsSizeMb}m`

  const capDrop = Array.from(new Set(['ALL', ...(sec.capDrop ?? [])]))
  const securityOpt = Array.from(new Set(['no-new-privileges:true', ...(sec.securityOpt ?? [])]))

  // Use structured HostConfig.Mounts when any source path is a Windows drive/UNC path
  // (avoids colon-parsing ambiguity on Windows Docker Desktop named pipes), and classic
  // HostConfig.Binds for POSIX / WSL2 paths.
  const hasWindowsSource = request.mounts.some((m) => {
    const src = m.dockerHostPath ?? m.hostPath
    return isWindowsDrivePath(src) || parseWslUncPath(src) !== undefined
  })

  const hostConfig: Record<string, unknown> = {
    ...(hasWindowsSource
      ? {
        Mounts: request.mounts.map(m => ({
          Type: 'bind',
          Source: m.dockerHostPath ?? m.hostPath,
          Target: m.containerPath,
          ReadOnly: m.readOnly,
        })),
      }
      : {
        Binds: request.mounts.map(m => `${m.dockerHostPath ?? m.hostPath}:${m.containerPath}:${m.readOnly ? 'ro' : 'rw'}`),
      }),
    CapDrop: capDrop,
    SecurityOpt: securityOpt,
    ReadonlyRootfs: readonlyRootfs,
    Tmpfs: { '/tmp': tmpfsFlags },
    NetworkMode: sec.networkMode ?? 'none',
    NanoCpus: Math.max(100_000_000, Math.round(cpus * 1e9)),
    Memory: memoryBytes,
    MemorySwap: memorySwapBytes,
    PidsLimit: pidsLimit,
    Init: true,
    Privileged: false,
    PublishAllPorts: false,
  }

  if (sec.runtime) {
    hostConfig.Runtime = sec.runtime
  }

  return {
    Image: request.image,
    Cmd: [...request.cmd],
    WorkingDir: request.workingDir,
    User: sec.user ?? DEFAULT_USER,
    Env: request.env ? [...request.env] : [],
    Labels: { ...request.labels },
    OpenStdin: false,
    Tty: false,
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    HostConfig: hostConfig,
  }
}

/**
 * Demultiplex Docker's 8-byte framed exec stream (`[streamType, 0, 0, 0, sizeBE]`)
 * into separate `stdout` (type 1) and `stderr` (type 2) Readable streams.
 * Safely handles arbitrary TCP chunk boundaries, partial headers, and multiple frames per chunk.
 */
export function demuxDockerStream(
  source: Readable,
  stdout: PassThrough,
  stderr: PassThrough,
): void {
  let pending: Buffer = Buffer.alloc(0)

  const flush = (): void => {
    while (pending.length >= 8) {
      const streamType = pending[0]
      const frameSize = pending.readUInt32BE(4)
      if (pending.length < 8 + frameSize) return
      const payload = pending.subarray(8, 8 + frameSize)
      pending = pending.subarray(8 + frameSize)
      if (frameSize === 0) continue
      if (streamType === 1) {
        stdout.write(payload)
      } else if (streamType === 2) {
        stderr.write(payload)
      } else {
        // Stream type 0 (stdin echo) or unknown falls back to stdout to avoid losing diagnostics.
        stdout.write(payload)
      }
    }
  }

  source.on('data', (chunk: Buffer | string) => {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    pending = pending.length === 0 ? buf : Buffer.concat([pending, buf])
    flush()
  })

  source.on('end', () => {
    flush()
    stdout.end()
    stderr.end()
  })

  source.on('error', (error) => {
    stdout.destroy(error)
    stderr.destroy(error)
  })
}

export type ConcreteDockerTransport = Exclude<DockerTransportMode, 'auto'>

export interface UnixSocketDockerClientOptions {
  /** Concrete transport: `'unix'` (Linux/macOS), `'npipe'` (Windows Docker Desktop), or `'wsl'` (Windows -> WSL2). */
  readonly transport?: ConcreteDockerTransport
  /** Socket/pipe path (`unix` default `/var/run/docker.sock`, `npipe` default `\\.\pipe\docker_engine`). */
  readonly socketPath?: string
  /** WSL2 configuration when `transport === 'wsl'`. */
  readonly wsl?: WslConfig
  /** Docker Engine API version prefix. Default: `'v1.45'`. */
  readonly apiVersion?: string
}

export class UnixSocketDockerClient implements DockerClient {
  readonly transport: ConcreteDockerTransport
  readonly socketPath: string
  private readonly wsl?: WslConfig
  private readonly apiVersion: string

  constructor(options: UnixSocketDockerClientOptions = {}) {
    this.transport = options.transport ?? (process.platform === 'win32' ? 'npipe' : 'unix')
    this.wsl = options.wsl
    this.socketPath = options.socketPath ?? (
      this.transport === 'npipe'
        ? DEFAULT_WINDOWS_DOCKER_PIPE
        : (options.wsl?.socketPath ?? DEFAULT_WSL_DOCKER_SOCKET)
    )
    this.apiVersion = options.apiVersion ?? 'v1.45'
  }

  private endpointLabel(): string {
    if (this.transport === 'wsl') {
      const distro = this.wsl?.distro ? `distro ${this.wsl.distro}` : 'default distro'
      return `WSL2 (${distro}) ${this.socketPath}`
    }
    return this.socketPath
  }

  private httpConnectionOptions(): Pick<http.RequestOptions, 'socketPath' | 'agent'> {
    if (this.transport === 'wsl') {
      const wslCfg: WslConfig = { ...this.wsl, socketPath: this.socketPath }
      const agent = new http.Agent({ keepAlive: false })
      agent.createConnection = () => createWslSocketStream(wslCfg) as unknown as import('node:net').Socket
      return { agent }
    }
    return { socketPath: this.socketPath }
  }

  async ping(signal?: AbortSignal): Promise<void> {
    try {
      const res = await this.request('GET', '/_ping', undefined, signal)
      if (res.statusCode !== 200) {
        throw new DockerSandboxError('DOCKER_UNAVAILABLE', `Docker daemon ping returned HTTP ${res.statusCode}: ${res.body}`)
      }
    } catch (error) {
      if (error instanceof DockerSandboxError) throw error
      throw new DockerSandboxError(
        'DOCKER_UNAVAILABLE',
        `Docker daemon is unavailable at ${this.endpointLabel()}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  async listContainers(labels: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<DockerContainerSummary[]> {
    const labelFilters = Object.entries(labels).map(([k, v]) => `${k}=${v}`)
    const filters = encodeURIComponent(JSON.stringify({ label: labelFilters }))
    const res = await this.requestJson<Array<{ Id: string; State: string; Labels?: Record<string, string> }>>(
      'GET',
      `/${this.apiVersion}/containers/json?all=true&filters=${filters}`,
      undefined,
      signal,
    )
    return res.map(item => ({
      id: item.Id,
      state: item.State,
      labels: item.Labels ?? {},
    }))
  }

  async createContainer(request: DockerContainerCreateRequest, signal?: AbortSignal): Promise<string> {
    const payload = buildHardenedContainerPayload(request)
    const res = await this.requestJson<{ Id: string }>(
      'POST',
      `/${this.apiVersion}/containers/create`,
      payload,
      signal,
    )
    if (!res.Id) {
      throw new DockerTransportError('Docker createContainer response omitted container Id')
    }
    return res.Id
  }

  async startContainer(containerId: string, signal?: AbortSignal): Promise<void> {
    const res = await this.request('POST', `/${this.apiVersion}/containers/${encodeURIComponent(containerId)}/start`, undefined, signal)
    if (res.statusCode !== 204 && res.statusCode !== 304) {
      throw new DockerTransportError(`failed to start container ${containerId}: HTTP ${res.statusCode} ${res.body}`, res.statusCode)
    }
  }

  async inspectContainer(containerId: string, signal?: AbortSignal): Promise<DockerContainerInspect | undefined> {
    const res = await this.request('GET', `/${this.apiVersion}/containers/${encodeURIComponent(containerId)}/json`, undefined, signal)
    if (res.statusCode === 404) return undefined
    if (res.statusCode !== 200) {
      throw new DockerTransportError(`failed to inspect container ${containerId}: HTTP ${res.statusCode} ${res.body}`, res.statusCode)
    }
    const parsed = JSON.parse(res.body) as { Id: string; State?: { Running?: boolean; ExitCode?: number } }
    return {
      id: parsed.Id,
      running: Boolean(parsed.State?.Running),
      exitCode: parsed.State?.ExitCode ?? 0,
    }
  }

  async stopContainer(containerId: string, timeoutSeconds = 5): Promise<void> {
    const res = await this.request(
      'POST',
      `/${this.apiVersion}/containers/${encodeURIComponent(containerId)}/stop?t=${Math.max(0, Math.floor(timeoutSeconds))}`,
    )
    if (res.statusCode !== 204 && res.statusCode !== 304 && res.statusCode !== 404) {
      throw new DockerTransportError(`failed to stop container ${containerId}: HTTP ${res.statusCode} ${res.body}`, res.statusCode)
    }
  }

  async killContainer(containerId: string, signalName = 'SIGKILL'): Promise<void> {
    const res = await this.request(
      'POST',
      `/${this.apiVersion}/containers/${encodeURIComponent(containerId)}/kill?signal=${encodeURIComponent(signalName)}`,
    )
    if (res.statusCode !== 204 && res.statusCode !== 404 && res.statusCode !== 409) {
      throw new DockerTransportError(`failed to kill container ${containerId}: HTTP ${res.statusCode} ${res.body}`, res.statusCode)
    }
  }

  async removeContainer(containerId: string, force = true): Promise<void> {
    const res = await this.request(
      'DELETE',
      `/${this.apiVersion}/containers/${encodeURIComponent(containerId)}?force=${force ? 'true' : 'false'}&v=true`,
    )
    if (res.statusCode !== 204 && res.statusCode !== 404) {
      throw new DockerTransportError(`failed to remove container ${containerId}: HTTP ${res.statusCode} ${res.body}`, res.statusCode)
    }
  }

  async execCreate(request: DockerExecCreateRequest, signal?: AbortSignal): Promise<string> {
    const body: Record<string, unknown> = {
      AttachStdin: request.attachStdin,
      AttachStdout: request.attachStdout,
      AttachStderr: request.attachStderr,
      Tty: request.tty,
      Cmd: [...request.cmd],
      WorkingDir: request.workingDir,
      Env: [...request.env],
    }
    if (request.user) {
      body.User = request.user
    }
    const res = await this.requestJson<{ Id: string }>(
      'POST',
      `/${this.apiVersion}/containers/${encodeURIComponent(request.containerId)}/exec`,
      body,
      signal,
    )
    if (!res.Id) {
      throw new DockerTransportError('Docker execCreate response omitted exec Id')
    }
    return res.Id
  }

  async execStart(
    execId: string,
    options: { tty: boolean; detach?: boolean },
    signal?: AbortSignal,
  ): Promise<DockerExecStream> {
    signal?.throwIfAborted()
    const payload = JSON.stringify({ Detach: Boolean(options.detach), Tty: options.tty })

    return new Promise<DockerExecStream>((resolve, reject) => {
      const req = http.request({
        ...this.httpConnectionOptions(),
        method: 'POST',
        path: `/${this.apiVersion}/exec/${encodeURIComponent(execId)}/start`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Connection: 'Upgrade',
          Upgrade: 'tcp',
        },
      })

      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      }

      const onAbort = (): void => {
        req.destroy()
        const reason = signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
        fail(reason)
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      req.on('error', (error) => {
        fail(new DockerTransportError(`Docker execStart transport error: ${error.message}`, undefined, { cause: error }))
      })

      req.on('upgrade', (_res, socket: Duplex, head: Buffer) => {
        if (settled) {
          socket.destroy()
          return
        }
        settled = true
        signal?.removeEventListener('abort', onAbort)

        const rawIn = new PassThrough()
        const stdout = new PassThrough()
        const stderr = new PassThrough()

        // Allow stdin half-close without tearing down the container's stdout/stderr read side.
        if ('allowHalfOpen' in socket) {
          (socket as unknown as { allowHalfOpen: boolean }).allowHalfOpen = true
        }
        // Prevent uncaught socket errors (e.g., EPIPE/ECONNRESET on fast command exit).
        socket.on('error', () => {})

        const closed = new Promise<void>((resolveClosed) => {
          socket.once('close', () => resolveClosed())
          socket.once('end', () => resolveClosed())
        })

        if (options.tty) {
          if (head.length > 0) stdout.write(head)
          socket.pipe(stdout)
          stderr.end()
        } else {
          demuxDockerStream(rawIn, stdout, stderr)
          if (head.length > 0) rawIn.write(head)
          socket.pipe(rawIn)
        }

        const stdin = new Writable({
          write(chunk, encoding, callback) {
            if (socket.destroyed) {
              callback()
              return
            }
            socket.write(chunk, encoding, callback)
          },
          final(callback) {
            if (!socket.destroyed && !options.tty) {
              socket.end()
            }
            callback()
          },
        })

        resolve({
          stdin,
          stdout,
          stderr,
          ...(options.tty ? { ttyOutput: stdout } : {}),
          closed,
          destroy: () => {
            socket.destroy()
            stdout.end()
            stderr.end()
          },
        })
      })

      req.on('response', (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          fail(new DockerTransportError(`Docker execStart did not upgrade (HTTP ${res.statusCode}): ${text}`, res.statusCode))
        })
      })

      req.write(payload)
      req.end()
    })
  }

  async execInspect(execId: string, signal?: AbortSignal): Promise<DockerExecInspect> {
    const res = await this.requestJson<{
      ID?: string
      Running?: boolean
      ExitCode?: number | null
      Pid?: number
    }>('GET', `/${this.apiVersion}/exec/${encodeURIComponent(execId)}/json`, undefined, signal)
    return {
      id: res.ID ?? execId,
      running: Boolean(res.Running),
      exitCode: res.ExitCode ?? null,
      pid: res.Pid ?? 0,
    }
  }

  async execResize(execId: string, cols: number, rows: number): Promise<void> {
    const res = await this.request(
      'POST',
      `/${this.apiVersion}/exec/${encodeURIComponent(execId)}/resize?h=${Math.max(1, Math.floor(rows))}&w=${Math.max(1, Math.floor(cols))}`,
    )
    if (res.statusCode !== 200 && res.statusCode !== 201 && res.statusCode !== 204 && res.statusCode !== 404) {
      throw new DockerTransportError(`failed to resize exec ${execId}: HTTP ${res.statusCode} ${res.body}`, res.statusCode)
    }
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.request(method, path, body, signal)
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new DockerTransportError(`Docker ${method} ${path} failed (HTTP ${res.statusCode}): ${res.body}`, res.statusCode)
    }
    return JSON.parse(res.body) as T
  }

  private request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ statusCode: number; body: string }> {
    signal?.throwIfAborted()
    const payload = body === undefined ? undefined : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const headers: Record<string, string | number> = {}
      if (payload !== undefined) {
        headers['Content-Type'] = 'application/json'
        headers['Content-Length'] = Buffer.byteLength(payload)
      }
      const req = http.request(
        { ...this.httpConnectionOptions(), method, path, headers },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            signal?.removeEventListener('abort', onAbort)
            resolve({
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            })
          })
          res.on('error', (error) => {
            signal?.removeEventListener('abort', onAbort)
            reject(new DockerTransportError(`Docker response error on ${method} ${path}: ${error.message}`, undefined, { cause: error }))
          })
        },
      )

      const onAbort = (): void => {
        req.destroy()
        const reason = signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
        reject(reason)
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      req.on('error', (error) => {
        signal?.removeEventListener('abort', onAbort)
        reject(new DockerTransportError(`Docker request error on ${method} ${path}: ${error.message}`, undefined, { cause: error }))
      })

      if (payload !== undefined) req.write(payload)
      req.end()
    })
  }
}
