import { describe, expect, it } from 'vitest'
import { FairScheduler, QueueFullError, QueueTimeoutError, type SchedulerEvent } from '../src/index.ts'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('FairScheduler', () => {
  it('enforces global + per-workspace limits and dispatches queued tasks fairly round-robin across workspaces', async () => {
    const events: SchedulerEvent[] = []
    const scheduler = new FairScheduler<string>({
      config: {
        maxConcurrentTasks: 2,
        maxConcurrencyPerWorkspace: 1,
        maxQueueSize: 16,
        queueTimeoutMs: 5_000,
      },
      onEvictContainer: async () => {},
      onEvent: (e) => events.push(e),
    })

    try {
      // Occupy both global slots with ws-a and ws-b.
      const leaseA1 = await scheduler.acquireTaskSlot('ws-a')
      const leaseB1 = await scheduler.acquireTaskSlot('ws-b')
      expect(scheduler.getMetrics().runningTasks).toBe(2)

      // ws-a floods 3 queued tasks, then ws-c and ws-d each submit 1 task.
      const order: string[] = []
      const pA2 = scheduler.acquireTaskSlot('ws-a').then((l) => { order.push('ws-a-2'); return l })
      const pA3 = scheduler.acquireTaskSlot('ws-a').then((l) => { order.push('ws-a-3'); return l })
      const pC1 = scheduler.acquireTaskSlot('ws-c').then((l) => { order.push('ws-c-1'); return l })
      const pD1 = scheduler.acquireTaskSlot('ws-d').then((l) => { order.push('ws-d-1'); return l })

      expect(scheduler.getMetrics().queuedTasks).toBe(4)

      // Release ws-b: ws-a is at per-workspace cap (1), so ws-c MUST jump ahead of ws-a's queued tasks!
      leaseB1.release()
      const leaseC1 = await pC1
      expect(order).toEqual(['ws-c-1'])

      // Release ws-a1: cursor moved past ws-c to ws-d, so ws-d gets the next slot before ws-a-2!
      leaseA1.release()
      const leaseD1 = await pD1
      expect(order).toEqual(['ws-c-1', 'ws-d-1'])

      // Release ws-c1: now ws-a-2 starts.
      leaseC1.release()
      const leaseA2 = await pA2
      expect(order).toEqual(['ws-c-1', 'ws-d-1', 'ws-a-2'])

      leaseD1.release()
      leaseA2.release()
      const leaseA3 = await pA3
      leaseA3.release()

      expect(scheduler.getMetrics().runningTasks).toBe(0)
      expect(scheduler.getMetrics().queuedTasks).toBe(0)
      expect(events.some(e => e.type === 'task_queued')).toBe(true)
    } finally {
      scheduler.dispose()
    }
  })

  it('fast-fails with QueueFullError and removes aborted waiters without leaking slots', async () => {
    const scheduler = new FairScheduler<string>({
      config: {
        maxConcurrentTasks: 1,
        maxConcurrencyPerWorkspace: 1,
        maxQueueSize: 1,
        queueTimeoutMs: 5_000,
      },
      onEvictContainer: async () => {},
    })

    try {
      const lease1 = await scheduler.acquireTaskSlot('ws-a')
      const abort = new AbortController()
      const queued = scheduler.acquireTaskSlot('ws-b', abort.signal)

      // Queue is now at maxQueueSize=1 -> next waiter fails fast.
      await expect(scheduler.acquireTaskSlot('ws-c')).rejects.toThrow(QueueFullError)

      // Abort the queued waiter; queue should become empty immediately.
      abort.abort(new Error('user-cancelled'))
      await expect(queued).rejects.toThrow('user-cancelled')
      expect(scheduler.getMetrics().queuedTasks).toBe(0)

      // Subsequent task can now queue and run cleanly when lease1 releases.
      const nextPromise = scheduler.acquireTaskSlot('ws-c')
      lease1.release()
      const leaseC = await nextPromise
      leaseC.release()
      expect(scheduler.getMetrics().runningTasks).toBe(0)
    } finally {
      scheduler.dispose()
    }
  })

  it('rejects queued waiters with QueueTimeoutError after queueTimeoutMs', async () => {
    const scheduler = new FairScheduler<string>({
      config: {
        maxConcurrentTasks: 1,
        maxConcurrencyPerWorkspace: 1,
        maxQueueSize: 4,
        queueTimeoutMs: 40,
      },
      onEvictContainer: async () => {},
    })

    try {
      const lease1 = await scheduler.acquireTaskSlot('ws-a')
      await expect(scheduler.acquireTaskSlot('ws-b')).rejects.toThrow(QueueTimeoutError)
      expect(scheduler.getMetrics().queuedTasks).toBe(0)
      lease1.release()
    } finally {
      scheduler.dispose()
    }
  })

  it('evicts least-recently-used idle containers when maxActiveContainers is reached and reaps expired idle TTL', async () => {
    let clock = 1_000
    const evicted: Array<{ ws: string; container: string; reason: string }> = []
    const scheduler = new FairScheduler<string>({
      config: {
        maxActiveContainers: 2,
        idleTtlMs: 500,
        reapIntervalMs: 60_000,
      },
      now: () => clock,
      onEvictContainer: async (ws, container, reason) => {
        evicted.push({ ws, container, reason })
      },
    })

    try {
      const c1 = await scheduler.ensureContainer('ws-1', async () => 'cid-1')
      clock = 2_000
      const c2 = await scheduler.ensureContainer('ws-2', async () => 'cid-2')
      expect(c1).toBe('cid-1')
      expect(c2).toBe('cid-2')

      // Touch ws-1 so ws-2 becomes the LRU idle container.
      clock = 2_500
      await scheduler.ensureContainer('ws-1', async () => 'should-not-create')

      // Creating ws-3 should evict ws-2 (LRU).
      clock = 2_600
      const c3 = await scheduler.ensureContainer('ws-3', async () => 'cid-3')
      expect(c3).toBe('cid-3')
      expect(evicted).toEqual([{ ws: 'ws-2', container: 'cid-2', reason: 'lru' }])

      // Advance clock past idleTtlMs; keep ws-3 busy so only ws-1 gets reaped and pruned.
      const lease3 = await scheduler.acquireTaskSlot('ws-3')
      clock = 4_000
      const reaped = await scheduler.reapIdleContainers()
      expect(reaped).toBe(1)
      expect(evicted[1]).toEqual({ ws: 'ws-1', container: 'cid-1', reason: 'idle_ttl' })
      expect(scheduler.getMetrics().workspaces['ws-1']).toBeUndefined()
      lease3.release()
    } finally {
      scheduler.dispose()
    }
  })

  it('enforces maxActiveContainers budget for ephemeral/read-only containers too', async () => {
    const evicted: string[] = []
    const scheduler = new FairScheduler<string>({
      config: { maxActiveContainers: 1 },
      onEvictContainer: async (ws) => { evicted.push(ws) },
    })

    try {
      await scheduler.ensureContainer('ws-1', async () => 'cid-1')
      // Acquiring an ephemeral slot when pool is full evicts idle ws-1 and accounts for the container.
      const slot = await scheduler.acquireEphemeralContainerSlot('ws-2')
      expect(evicted).toEqual(['ws-1'])
      expect(scheduler.getMetrics().activeContainers).toBe(1)

      // A second ephemeral slot must wait until the first releases.
      let secondAcquired = false
      const pSecond = scheduler.acquireEphemeralContainerSlot('ws-3').then((s) => {
        secondAcquired = true
        return s
      })
      await new Promise(r => setTimeout(r, 15))
      expect(secondAcquired).toBe(false)

      slot.release()
      const slot2 = await pSecond
      expect(secondAcquired).toBe(true)
      slot2.release()
      expect(scheduler.getMetrics().activeContainers).toBe(0)
    } finally {
      scheduler.dispose()
    }
  })

  it('separates interactive PTY terminal quota from short-lived exec task slots', async () => {
    const scheduler = new FairScheduler<string>({
      config: {
        maxConcurrentTasks: 1,
        maxConcurrencyPerWorkspace: 1,
        maxTotalTerminals: 2,
        maxTerminalsPerWorkspace: 1,
        maxActiveContainers: 1,
      },
      onEvictContainer: async () => {},
    })

    try {
      const term1 = scheduler.acquireTerminalSlot('ws-1')
      // Even with a terminal open, ws-1 can still acquire its short-lived exec task slot!
      const task1 = await scheduler.acquireTaskSlot('ws-1')
      expect(scheduler.getMetrics().activeTerminals).toBe(1)
      expect(scheduler.getMetrics().runningTasks).toBe(1)

      // Second terminal in same workspace hits per-workspace terminal cap.
      expect(() => scheduler.acquireTerminalSlot('ws-1')).toThrow('workspace terminal quota exceeded')

      // Container for ws-1 is pinned while terminal is active: ws-2 waits until ws-1 frees.
      await scheduler.ensureContainer('ws-1', async () => 'cid-1')
      task1.release()
      const created2 = deferred<string>()
      const pWs2 = scheduler.ensureContainer('ws-2', async () => {
        created2.resolve('cid-2')
        return 'cid-2'
      })
      term1.release()
      expect(await pWs2).toBe('cid-2')
    } finally {
      scheduler.dispose()
    }
  })
})
