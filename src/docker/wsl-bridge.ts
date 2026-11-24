/**
 * Dependency-free Windows -> WSL2 Unix domain socket Duplex bridge.
 *
 * Bridges a Node.js `http.Agent.createConnection` stream directly to `/var/run/docker.sock`
 * inside a WSL2 Linux distribution via `wsl.exe` stdin/stdout — opening zero TCP ports and
 * supporting both standard Docker Engine HTTP API calls and `Upgrade: tcp` streaming / PTY execs.
 *
 * Payloads are Base64-encoded so Windows `CreateProcess` argument quoting and newlines never
 * corrupt the bridge script passed through `wsl.exe`.
 *
 * Inside WSL2, selects the best available bridge binary automatically:
 * `socat` -> `python3` (default on Ubuntu/Debian WSL2) -> `node`.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { Duplex, type Readable, type Writable } from 'node:stream'
import type { WslConfig } from '../types.ts'

export const DEFAULT_WSL_DOCKER_SOCKET = '/var/run/docker.sock'
export const DEFAULT_WINDOWS_DOCKER_PIPE = '\\\\.\\pipe\\docker_engine'

const PYTHON_UNIX_BRIDGE = [
  'import base64, os, selectors, socket, sys',
  'sock_path = base64.b64decode(sys.argv[2]).decode("utf-8")',
  's = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
  's.connect(sock_path)',
  'sel = selectors.DefaultSelector()',
  'sel.register(0, selectors.EVENT_READ, "in")',
  'sel.register(s, selectors.EVENT_READ, "sock")',
  'while True:',
  '  for key, _ in sel.select():',
  '    if key.data == "in":',
  '      d = os.read(0, 65536)',
  '      if not d:',
  '        sel.unregister(0)',
  '        try: s.shutdown(socket.SHUT_WR)',
  '        except OSError: pass',
  '      else:',
  '        s.sendall(d)',
  '    else:',
  '      d = s.recv(65536)',
  '      if not d:',
  '        sys.exit(0)',
  '      v = memoryview(d)',
  '      while v:',
  '        n = os.write(1, v)',
  '        v = v[n:]',
].join('\n')

const NODE_UNIX_BRIDGE = [
  'const net = require("node:net");',
  'const sockPath = Buffer.from(process.argv[2], "base64").toString("utf8");',
  'const s = net.createConnection({ path: sockPath, allowHalfOpen: true });',
  's.on("error", (e) => { process.stderr.write(String(e.message || e) + "\\n"); process.exit(1); });',
  'process.stdin.pipe(s);',
  's.pipe(process.stdout);',
  's.on("end", () => process.exit(0));',
].join('\n')

const PYTHON_BRIDGE_B64 = Buffer.from(PYTHON_UNIX_BRIDGE, 'utf8').toString('base64')
const NODE_BRIDGE_B64 = Buffer.from(NODE_UNIX_BRIDGE, 'utf8').toString('base64')

// Single-line, zero-double-quote POSIX sh launcher (immune to Windows CreateProcess quote escaping).
const SH_BRIDGE_DISPATCH = [
  'if command -v socat >/dev/null 2>&1; then exec socat - UNIX-CONNECT:$1;',
  `elif command -v python3 >/dev/null 2>&1; then exec python3 -u -c 'import base64,sys;exec(base64.b64decode(sys.argv[1]))' ${PYTHON_BRIDGE_B64} $2;`,
  `elif command -v node >/dev/null 2>&1; then exec node -e 'eval(Buffer.from(process.argv[1],String.fromCharCode(98,97,115,101,54,52)).toString())' ${NODE_BRIDGE_B64} $2;`,
  'else echo missing_wsl_bridge_tool_socat_python3_or_node >&2; exit 127; fi',
].join(' ')

export interface WslBridgeCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly socketPath: string
}

/** Build the exact `wsl.exe` invocation used to connect to Docker Engine inside WSL2. */
export function buildWslBridgeCommand(config: WslConfig = {}): WslBridgeCommand {
  const socketPath = config.socketPath ?? DEFAULT_WSL_DOCKER_SOCKET
  if (!socketPath.startsWith('/') || socketPath.includes('\0')) {
    throw new Error(`dsh-cloud-sandbox: wsl.socketPath must be a POSIX absolute path, got ${JSON.stringify(socketPath)}`)
  }
  const socketPathB64 = Buffer.from(socketPath, 'utf8').toString('base64')
  const command = config.wslBinary ?? 'wsl.exe'
  const args: string[] = []
  if (config.distro) {
    args.push('-d', config.distro)
  }
  if (config.user) {
    args.push('-u', config.user)
  }
  args.push('--exec', '/bin/sh', '-c', SH_BRIDGE_DISPATCH, 'dsh-wsl-bridge', socketPath, socketPathB64)
  return { command, args, socketPath }
}

/**
 * Node.js `net.Socket`-compatible `Duplex` backed by a `wsl.exe` bridge process connected
 * to `/var/run/docker.sock` inside WSL2. Usable directly with `http.Agent.createConnection`.
 */
export class WslBridgeSocket extends Duplex {
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>
  private readonly stderrChunks: Buffer[] = []
  private readonly distroLabel: string
  private readonly socketPath: string
  private bridgeClosed = false
  private receivedAnyBytes = false

  constructor(config: WslConfig = {}) {
    super({ allowHalfOpen: true })
    const spec = buildWslBridgeCommand(config)
    this.socketPath = spec.socketPath
    this.distroLabel = config.distro ? `distro ${config.distro}` : 'default distro'

    this.child = spawn(spec.command, [...spec.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    this.child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.length > 0) this.receivedAnyBytes = true
      if (!this.push(chunk)) {
        this.child.stdout.pause()
      }
    })
    this.child.stdout.on('end', () => {
      // If data was received, end the readable side cleanly; otherwise wait for child 'close'
      // so bridge startup failures report stderr instead of a generic socket hang up.
      if (this.receivedAnyBytes && !this.bridgeClosed && !this.readableEnded) {
        this.push(null)
      }
    })
    this.child.stderr.on('data', (chunk: Buffer) => {
      if (this.stderrChunks.length < 32) {
        this.stderrChunks.push(chunk)
      }
    })

    this.child.on('error', (err) => {
      this.destroy(new Error(
        `failed to launch WSL2 bridge (${spec.command}, ${this.distroLabel}): ${err.message}`,
        { cause: err },
      ))
    })

    this.child.on('close', (code) => {
      if (this.bridgeClosed) return
      this.bridgeClosed = true
      if (code !== 0 && code !== null && !this.destroyed) {
        const detail = Buffer.concat(this.stderrChunks).toString('utf8').trim()
        const msg = detail
          ? `WSL2 Docker bridge exited with code ${code} (${this.distroLabel}, ${this.socketPath}): ${detail}`
          : `WSL2 Docker bridge exited with code ${code} (${this.distroLabel}, ${this.socketPath})`
        this.destroy(new Error(msg))
        return
      }
      if (!this.readableEnded) {
        this.push(null)
      }
      this.emit('close', false)
    })

    // Emit 'connect' asynchronously to match net.Socket lifecycle expected by http.Agent.
    queueMicrotask(() => {
      if (!this.destroyed) this.emit('connect')
    })
  }

  override _read(): void {
    this.child.stdout.resume()
  }

  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.child.stdin.destroyed) {
      callback()
      return
    }
    this.child.stdin.write(chunk, encoding, callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (!this.child.stdin.destroyed) {
      this.child.stdin.end()
    }
    callback()
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.bridgeClosed = true
    if (!this.child.stdin.destroyed) this.child.stdin.destroy()
    if (!this.child.stdout.destroyed) this.child.stdout.destroy()
    if (!this.child.stderr.destroyed) this.child.stderr.destroy()
    if (this.child.exitCode === null && !this.child.killed) {
      try {
        this.child.kill()
      } catch {
        // Ignore kill error on already-exited bridge process.
      }
    }
    callback(error)
  }

  // net.Socket compatibility shims used by Node's http.ClientRequest.
  setTimeout(_msecs: number, _callback?: () => void): this { return this }
  setNoDelay(_noDelay?: boolean): this { return this }
  setKeepAlive(_enable?: boolean, _initialDelay?: number): this { return this }
  ref(): this { this.child.ref(); return this }
  unref(): this { this.child.unref(); return this }
}

/** Create a `net.Socket`-compatible `Duplex` connected to Docker Engine inside WSL2. */
export function createWslSocketStream(config: WslConfig = {}): WslBridgeSocket {
  return new WslBridgeSocket(config)
}
