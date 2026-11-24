/**
 * DSH-compliant offset-based bounded output collector (`SubprocessOutputReader`).
 *
 * Retains the newest `maxBytes` tail in memory and optionally spills the full stream
 * to a bounded file on disk up to `spill.maxBytes` (discarding the spill file if the
 * stream exceeds the spill cap, matching `@deepseek-ai/dsh-subprocess` semantics).
 */

import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessCollect, SubprocessOutputRead, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

export class BoundedStreamCollector implements SubprocessOutputReader {
  private readonly maxBytes: number
  private readonly spillMaxBytes: number | undefined
  private readonly spillDir: string

  private chunks: Buffer[] = []
  private retainedBytes = 0
  private totalBytes = 0

  private spillPath: string | undefined
  private spillFd: number | undefined
  private spillDiscarded = false
  private finished = false

  constructor(spec: SubprocessCollect, spillDir?: string) {
    this.maxBytes = Math.max(1, Math.floor(spec.maxBytes))
    this.spillMaxBytes = spec.spill ? Math.max(1, Math.floor(spec.spill.maxBytes)) : undefined
    this.spillDir = spillDir ?? join(tmpdir(), 'dsh-cloud-sandbox-spill')
  }

  /** Append raw bytes arriving from the container stream. */
  append(data: Buffer | string): void {
    if (this.finished) return
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    if (buf.length === 0) return

    this.totalBytes += buf.length
    this.writeToSpill(buf)

    if (buf.length >= this.maxBytes) {
      this.chunks = [buf.subarray(buf.length - this.maxBytes)]
      this.retainedBytes = this.maxBytes
      return
    }

    this.chunks.push(buf)
    this.retainedBytes += buf.length

    while (this.retainedBytes > this.maxBytes && this.chunks.length > 0) {
      const overflow = this.retainedBytes - this.maxBytes
      const first = this.chunks[0]
      if (!first) break
      if (first.length <= overflow) {
        this.chunks.shift()
        this.retainedBytes -= first.length
      } else {
        this.chunks[0] = first.subarray(overflow)
        this.retainedBytes -= overflow
      }
    }
  }

  /** Finalize the collector (closes spill file descriptor if opened). */
  finish(): void {
    if (this.finished) return
    this.finished = true
    if (this.spillFd !== undefined) {
      try {
        closeSync(this.spillFd)
      } catch {
        // Ignore close error on teardown.
      }
      this.spillFd = undefined
    }
  }

  /** Non-consuming incremental read from a whole-stream byte coordinate. */
  readFrom(fromByte: number): SubprocessOutputRead {
    const safeOffset = Math.max(0, Math.floor(fromByte))
    const headOffset = this.totalBytes - this.retainedBytes
    const merged = this.chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(this.chunks, this.retainedBytes)

    const lossy = safeOffset < headOffset
    const sliceStart = lossy ? 0 : Math.min(merged.length, safeOffset - headOffset)
    const slice = sliceStart === 0 ? merged : merged.subarray(sliceStart)

    return {
      text: slice.toString('utf8'),
      nextOffset: this.totalBytes,
      lossy,
      ...(this.spillPath !== undefined && !this.spillDiscarded ? { spillPath: this.spillPath } : {}),
    }
  }

  private writeToSpill(buf: Buffer): void {
    if (this.spillMaxBytes === undefined || this.spillDiscarded) return

    if (this.totalBytes > this.spillMaxBytes) {
      this.discardSpill()
      return
    }

    // Lazily create spill file only once totalBytes exceeds the in-memory window.
    if (this.spillFd === undefined && this.totalBytes > this.maxBytes) {
      try {
        mkdirSync(this.spillDir, { recursive: true, mode: 0o700 })
        const filePath = join(this.spillDir, `stream-${randomUUID()}.log`)
        const fd = openSync(filePath, 'wx', 0o600)
        // Flush already-retained tail first (note: if the very first chunk exceeded maxBytes,
        // `buf` itself still holds the complete bytes before truncation).
        if (this.chunks.length > 0) {
          const prior = Buffer.concat(this.chunks, this.retainedBytes)
          writeSync(fd, prior)
        }
        writeSync(fd, buf)
        this.spillFd = fd
        this.spillPath = filePath
      } catch {
        this.discardSpill()
      }
      return
    }

    if (this.spillFd !== undefined) {
      try {
        writeSync(this.spillFd, buf)
      } catch {
        this.discardSpill()
      }
    }
  }

  private discardSpill(): void {
    this.spillDiscarded = true
    if (this.spillFd !== undefined) {
      try {
        closeSync(this.spillFd)
      } catch {
        // Ignore close error.
      }
      this.spillFd = undefined
    }
    if (this.spillPath !== undefined) {
      try {
        unlinkSync(this.spillPath)
      } catch {
        // Ignore unlink error.
      }
      this.spillPath = undefined
    }
  }
}
