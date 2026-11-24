import { readFileSync, rmSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  BoundedStreamCollector,
  buildHardenedContainerPayload,
  demuxDockerStream,
} from '../src/index.ts'

function dockerFrame(streamType: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const header = Buffer.alloc(8)
  header[0] = streamType
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

describe('Docker stream demuxing, hardening payload, and BoundedStreamCollector', () => {
  it('demultiplexes Docker 8-byte framed streams across arbitrary 1-byte TCP splits', async () => {
    const raw = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    demuxDockerStream(raw, stdout, stderr)

    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    stdout.on('data', (c: Buffer) => outChunks.push(c))
    stderr.on('data', (c: Buffer) => errChunks.push(c))

    const combined = Buffer.concat([
      dockerFrame(1, 'hello '),
      dockerFrame(2, 'warn: '),
      dockerFrame(1, ''),
      dockerFrame(1, 'world\n'),
      dockerFrame(2, 'oops\n'),
    ])

    // Feed 1 byte at a time to stress header/payload split handling.
    for (let i = 0; i < combined.length; i += 1) {
      raw.write(combined.subarray(i, i + 1))
    }
    raw.end()

    await Promise.all([
      new Promise<void>(r => stdout.once('end', () => r())),
      new Promise<void>(r => stderr.once('end', () => r())),
    ])

    expect(Buffer.concat(outChunks).toString('utf8')).toBe('hello world\n')
    expect(Buffer.concat(errChunks).toString('utf8')).toBe('warn: oops\n')
  })

  it('builds hardened Linux Docker container payloads with fail-closed security defaults', () => {
    const payload = buildHardenedContainerPayload({
      image: 'dsh-cloud-sandbox-runtime:latest',
      cmd: ['sleep', 'infinity'],
      workingDir: '/srv/ws/a',
      mounts: [
        { hostPath: '/srv/ws/a', containerPath: '/srv/ws/a', readOnly: false },
        { hostPath: '/srv/skills', containerPath: '/srv/skills', readOnly: true },
      ],
      labels: { 'dsh.sandbox.managed': 'true' },
      security: { runtime: 'runsc', tmpfsNoExec: true },
    })

    const hostConfig = payload.HostConfig as Record<string, unknown>
    expect(payload.User).toBe('1000:1000')
    expect(hostConfig.CapDrop).toEqual(['ALL'])
    expect(hostConfig.SecurityOpt).toEqual(['no-new-privileges:true'])
    expect(hostConfig.ReadonlyRootfs).toBe(true)
    expect(hostConfig.NetworkMode).toBe('none')
    expect(hostConfig.Privileged).toBe(false)
    expect(hostConfig.Init).toBe(true)
    expect(hostConfig.PidsLimit).toBe(256)
    expect(hostConfig.Runtime).toBe('runsc')
    expect(hostConfig.Tmpfs).toEqual({ '/tmp': 'rw,nosuid,nodev,noexec,size=256m' })
    expect(hostConfig.Binds).toEqual([
      '/srv/ws/a:/srv/ws/a:rw',
      '/srv/skills:/srv/skills:ro',
    ])
  })

  it('implements offset-based non-consuming reads, tail truncation, and bounded spill files', () => {
    const collector = new BoundedStreamCollector({ maxBytes: 8, spill: { maxBytes: 32 } })
    collector.append('abcd')
    const r1 = collector.readFrom(0)
    expect(r1).toEqual({ text: 'abcd', nextOffset: 4, lossy: false })

    // Exceeds in-memory window (8 bytes) but stays under spill cap (32 bytes).
    collector.append('efghijkl')
    collector.finish()

    const r2 = collector.readFrom(0)
    expect(r2.lossy).toBe(true)
    expect(r2.text).toBe('efghijkl')
    expect(r2.nextOffset).toBe(12)
    expect(r2.spillPath).toBeTruthy()
    expect(readFileSync(r2.spillPath!, 'utf8')).toBe('abcdefghijkl')

    // Incremental read from offset 8 is non-lossy.
    const r3 = collector.readFrom(8)
    expect(r3.lossy).toBe(false)
    expect(r3.text).toBe('ijkl')
    rmSync(r2.spillPath!, { force: true })

    // Exceeding spill cap discards spill file cleanly.
    const oversized = new BoundedStreamCollector({ maxBytes: 4, spill: { maxBytes: 10 } })
    oversized.append('0123456789ABCDEF')
    oversized.finish()
    const r4 = oversized.readFrom(0)
    expect(r4.lossy).toBe(true)
    expect(r4.text).toBe('CDEF')
    expect(r4.spillPath).toBeUndefined()

    // Late chunks arriving after finish() are ignored and never reopen a spill file.
    const lateCollector = new BoundedStreamCollector({ maxBytes: 4, spill: { maxBytes: 32 } })
    lateCollector.append('ab')
    lateCollector.finish()
    lateCollector.append('cdefghij')
    expect(lateCollector.readFrom(0)).toEqual({ text: 'ab', nextOffset: 2, lossy: false })
  })
})
