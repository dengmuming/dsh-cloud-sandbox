/**
 * Two-tier cloud concurrency controller & per-workspace fair queue scheduler.
 *
 * Pure TypeScript with zero Docker dependencies so every scheduling invariant is
 * deterministically testable across Linux, macOS, and Windows:
 *
 * 1. Container slots (`maxActiveContainers`):
 *    - Tracks warm containers per `workspaceId` with reference counts (`runningTasks + activeTerminals`).
 *    - When full, evicts the least-recently-used idle container via caller-provided `onEvict`.
 *    - If every live container is busy, queues container waiters round-robin across workspaces.
 *    - Background timer reaps idle containers older than `idleTtlMs`.
 * 2. Execution task slots (`maxConcurrentTasks` + `maxConcurrencyPerWorkspace`):
 *    - Fair round-robin queue across waiting `workspaceId`s (prevents noisy-neighbor starvation).
 *    - Bounded by `maxQueueSize` (fast-fail `QueueFullError`) and `queueTimeoutMs` (`QueueTimeoutError`).
 *    - Honors `AbortSignal` immediately while queued without leaking any slot.
 * 3. Separate PTY terminal quota (`maxTotalTerminals` + `maxTerminalsPerWorkspace`):
 *    - Interactive terminals never consume short-lived exec task slots.
 */

import type { FairSchedulerConfig, FairSchedulerMetrics, SchedulerEvent } from '../types.ts'
import { DockerSandboxError, QueueFullError, QueueTimeoutError } from '../types.ts'

export interface WorkspaceContainerState<TContainer> {
  readonly workspaceId: string
  container: TContainer | undefined
  creating: Promise<TContainer> | undefined
  runningTasks: number
  activeTerminals: number
  lastUsedAt: number
}

interface TaskWaiter {
  readonly workspaceId: string
  readonly enqueuedAt: number
  readonly resolve: () => void
  readonly reject: (error: Error) => void
  readonly cleanup: () => void
  settled: boolean
}

interface ContainerWaiter {
  readonly workspaceId: string
  readonly resolve: () => void
  readonly reject: (error: Error) => void
  readonly cleanup: () => void
  settled: boolean
}

export interface TaskLease {
  readonly workspaceId: string
  readonly waitedMs: number
  release(): void
}

export interface TerminalLease {
  readonly workspaceId: string
  release(): void
}

export interface EphemeralContainerSlotLease {
  readonly workspaceId: string
  release(): void
}

export interface FairSchedulerOptions<TContainer> {
  readonly config?: FairSchedulerConfig
  readonly now?: () => number
  readonly onEvictContainer: (workspaceId: string, container: TContainer, reason: 'lru' | 'idle_ttl') => Promise<void>
  readonly onEvent?: (event: SchedulerEvent) => void
}

const DEFAULT_CONFIG: Required<FairSchedulerConfig> = {
  maxActiveContainers: 16,
  maxConcurrentTasks: 8,
  maxConcurrencyPerWorkspace: 2,
  maxQueueSize: 64,
  queueTimeoutMs: 60_000,
  idleTtlMs: 600_000,
  reapIntervalMs: 30_000,
  maxTotalTerminals: 16,
  maxTerminalsPerWorkspace: 2,
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`fair-scheduler: ${name} must be a positive integer, got ${String(value)}`)
  }
}

export class FairScheduler<TContainer> {
  readonly config: Required<FairSchedulerConfig>
  private readonly now: () => number
  private readonly onEvictContainer: (workspaceId: string, container: TContainer, reason: 'lru' | 'idle_ttl') => Promise<void>
  private readonly onEvent?: (event: SchedulerEvent) => void

  private readonly workspaces = new Map<string, WorkspaceContainerState<TContainer>>()
  /** Round-robin ordered list of workspaceIds that currently have queued tasks. */
  private readonly taskQueues = new Map<string, TaskWaiter[]>()
  private readonly taskRrOrder: string[] = []
  private taskRrCursor = 0

  /** Round-robin ordered list of workspaceIds waiting for a free container slot. */
  private readonly containerWaiters: ContainerWaiter[] = []
  private containerWaiterCursor = 0
  private containerSlotReservations = 0
  private activeEphemeralContainers = 0

  private runningTasks = 0
  private queuedTasks = 0
  private activeTerminals = 0
  private disposed = false
  private reaperTimer: ReturnType<typeof setInterval> | undefined

  constructor(options: FairSchedulerOptions<TContainer>) {
    this.config = { ...DEFAULT_CONFIG, ...options.config }
    assertPositiveInt('maxActiveContainers', this.config.maxActiveContainers)
    assertPositiveInt('maxConcurrentTasks', this.config.maxConcurrentTasks)
    assertPositiveInt('maxConcurrencyPerWorkspace', this.config.maxConcurrencyPerWorkspace)
    assertPositiveInt('maxQueueSize', this.config.maxQueueSize)
    assertPositiveInt('queueTimeoutMs', this.config.queueTimeoutMs)
    assertPositiveInt('idleTtlMs', this.config.idleTtlMs)
    assertPositiveInt('reapIntervalMs', this.config.reapIntervalMs)
    assertPositiveInt('maxTotalTerminals', this.config.maxTotalTerminals)
    assertPositiveInt('maxTerminalsPerWorkspace', this.config.maxTerminalsPerWorkspace)

    this.now = options.now ?? (() => Date.now())
    this.onEvictContainer = options.onEvictContainer
    this.onEvent = options.onEvent

    this.reaperTimer = setInterval(() => {
      void this.reapIdleContainers()
    }, this.config.reapIntervalMs)
    this.reaperTimer.unref()
  }

  /** Acquire a global + per-workspace execution task slot, fairly queued if saturated. */
  async acquireTaskSlot(workspaceId: string, signal?: AbortSignal): Promise<TaskLease> {
    this.assertNotDisposed()
    signal?.throwIfAborted()

    const state = this.getOrCreateWorkspace(workspaceId)
    const startAt = this.now()

    if (this.canStartTask(workspaceId, state)) {
      return this.grantTaskLease(workspaceId, state, 0)
    }

    if (this.queuedTasks >= this.config.maxQueueSize) {
      this.emit({ type: 'task_rejected', workspaceId, reason: 'queue_full' })
      throw new QueueFullError(this.config.maxQueueSize)
    }

    return new Promise<TaskLease>((resolve, reject) => {
      const queue = this.taskQueues.get(workspaceId) ?? []
      if (!this.taskQueues.has(workspaceId)) {
        this.taskQueues.set(workspaceId, queue)
        this.taskRrOrder.push(workspaceId)
      }

      const waiter: TaskWaiter = {
        workspaceId,
        enqueuedAt: startAt,
        settled: false,
        resolve: () => {
          const waitedMs = Math.max(0, this.now() - startAt)
          resolve(this.grantTaskLease(workspaceId, this.getOrCreateWorkspace(workspaceId), waitedMs))
        },
        reject,
        cleanup: () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        },
      }

      const onAbort = (): void => {
        if (waiter.settled) return
        waiter.settled = true
        waiter.cleanup()
        this.removeTaskWaiter(waiter)
        this.emit({ type: 'task_rejected', workspaceId, reason: 'aborted' })
        const reason = signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
        reject(reason)
      }

      const timer = setTimeout(() => {
        if (waiter.settled) return
        waiter.settled = true
        waiter.cleanup()
        this.removeTaskWaiter(waiter)
        this.emit({ type: 'task_rejected', workspaceId, reason: 'queue_timeout' })
        reject(new QueueTimeoutError(this.config.queueTimeoutMs))
      }, this.config.queueTimeoutMs)
      timer.unref()

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
      }

      queue.push(waiter)
      this.queuedTasks += 1
      this.emit({
        type: 'task_queued',
        workspaceId,
        queueDepth: this.queuedTasks,
        position: this.queuedTasks,
      })
    })
  }

  /** Acquire a dedicated terminal slot (separate from short-task concurrency limits). */
  acquireTerminalSlot(workspaceId: string): TerminalLease {
    this.assertNotDisposed()
    const state = this.getOrCreateWorkspace(workspaceId)
    if (this.activeTerminals >= this.config.maxTotalTerminals) {
      throw new DockerSandboxError(
        'TERMINAL_QUOTA_EXCEEDED',
        `host terminal quota exceeded (${this.config.maxTotalTerminals} active terminals)`,
      )
    }
    if (state.activeTerminals >= this.config.maxTerminalsPerWorkspace) {
      throw new DockerSandboxError(
        'TERMINAL_QUOTA_EXCEEDED',
        `workspace terminal quota exceeded (${this.config.maxTerminalsPerWorkspace} active terminals)`,
      )
    }
    state.activeTerminals += 1
    state.lastUsedAt = this.now()
    this.activeTerminals += 1

    let released = false
    return {
      workspaceId,
      release: () => {
        if (released) return
        released = true
        state.activeTerminals = Math.max(0, state.activeTerminals - 1)
        state.lastUsedAt = this.now()
        this.activeTerminals = Math.max(0, this.activeTerminals - 1)
        this.wakeContainerWaiters()
      },
    }
  }

  /**
   * Ensure a warm container exists for `workspaceId`, respecting `maxActiveContainers`.
   * If the pool is full, evicts the least-recently-used idle container or waits until a slot opens.
   */
  async ensureContainer(
    workspaceId: string,
    create: () => Promise<TContainer>,
    signal?: AbortSignal,
  ): Promise<TContainer> {
    this.assertNotDisposed()
    signal?.throwIfAborted()

    while (true) {
      this.assertNotDisposed()
      signal?.throwIfAborted()
      const state = this.getOrCreateWorkspace(workspaceId)

      if (state.container !== undefined) {
        state.lastUsedAt = this.now()
        return state.container
      }
      if (state.creating !== undefined) {
        return state.creating
      }

      if (this.totalAllocatedContainers() < this.config.maxActiveContainers) {
        return this.createInReservedSlot(state, create)
      }

      // Pool full: check synchronously for an idle LRU victim to avoid any lost-wakeup gap before queueing.
      const victim = this.selectLruIdleVictim(workspaceId)
      if (victim !== undefined) {
        const container = victim.container as TContainer
        victim.container = undefined
        this.emit({ type: 'container_evicted', workspaceId: victim.workspaceId, reason: 'lru' })
        await this.onEvictContainer(victim.workspaceId, container, 'lru').catch(() => {})
        continue
      }

      // All live containers are busy — enqueue synchronously before yielding.
      await this.waitForContainerSlot(workspaceId, signal)
    }
  }

  /**
   * Reserve a container slot for an ephemeral or read-only container under the same
   * `maxActiveContainers` budget (evicting an LRU idle warm container or waiting if saturated).
   */
  async acquireEphemeralContainerSlot(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<EphemeralContainerSlotLease> {
    this.assertNotDisposed()
    signal?.throwIfAborted()

    while (true) {
      this.assertNotDisposed()
      signal?.throwIfAborted()

      if (this.totalAllocatedContainers() < this.config.maxActiveContainers) {
        this.activeEphemeralContainers += 1
        let released = false
        return {
          workspaceId,
          release: () => {
            if (released) return
            released = true
            this.activeEphemeralContainers = Math.max(0, this.activeEphemeralContainers - 1)
            this.wakeContainerWaiters()
          },
        }
      }

      const victim = this.selectLruIdleVictim(workspaceId)
      if (victim !== undefined) {
        const container = victim.container as TContainer
        victim.container = undefined
        this.emit({ type: 'container_evicted', workspaceId: victim.workspaceId, reason: 'lru' })
        await this.onEvictContainer(victim.workspaceId, container, 'lru').catch(() => {})
        this.pruneEmptyWorkspace(victim.workspaceId)
        continue
      }

      await this.waitForContainerSlot(workspaceId, signal)
    }
  }

  /** Drop a workspace's container handle (e.g., after container crash or explicit removal). */
  invalidateContainer(workspaceId: string, container?: TContainer): void {
    const state = this.workspaces.get(workspaceId)
    if (!state) return
    if (container !== undefined && state.container !== container) return
    state.container = undefined
    state.lastUsedAt = this.now()
    this.wakeContainerWaiters()
  }

  /** Return all currently tracked live containers (for shutdown/diagnostics). */
  listContainers(): Array<{ readonly workspaceId: string; readonly container: TContainer }> {
    const out: Array<{ readonly workspaceId: string; readonly container: TContainer }> = []
    for (const [workspaceId, state] of this.workspaces) {
      if (state.container !== undefined) {
        out.push({ workspaceId, container: state.container })
      }
    }
    return out
  }

  /** Reap any idle containers whose `lastUsedAt` exceeded `idleTtlMs`. */
  async reapIdleContainers(): Promise<number> {
    if (this.disposed) return 0
    const cutoff = this.now() - this.config.idleTtlMs
    const victims: Array<{ workspaceId: string; container: TContainer }> = []

    for (const [workspaceId, state] of this.workspaces) {
      if (state.container !== undefined && this.isIdle(state) && state.lastUsedAt <= cutoff) {
        victims.push({ workspaceId, container: state.container })
        state.container = undefined
      }
    }

    for (const victim of victims) {
      this.emit({ type: 'container_evicted', workspaceId: victim.workspaceId, reason: 'idle_ttl' })
      await this.onEvictContainer(victim.workspaceId, victim.container, 'idle_ttl').catch(() => {})
    }

    if (victims.length > 0) {
      for (const victim of victims) {
        this.pruneEmptyWorkspace(victim.workspaceId)
      }
      this.wakeContainerWaiters()
    }
    this.pruneAllEmptyWorkspaces()
    return victims.length
  }

  /** Snapshot current pool, concurrency, and queue metrics (user-agnostic). */
  getMetrics(): FairSchedulerMetrics {
    let activeContainers = 0
    let idleContainers = 0
    const workspaces: Record<string, {
      hasContainer: boolean
      runningTasks: number
      queuedTasks: number
      activeTerminals: number
      lastUsedAt: number
    }> = {}

    for (const [workspaceId, state] of this.workspaces) {
      const hasContainer = state.container !== undefined
      if (hasContainer) {
        activeContainers += 1
        if (this.isIdle(state)) idleContainers += 1
      }
      workspaces[workspaceId] = {
        hasContainer,
        runningTasks: state.runningTasks,
        queuedTasks: this.taskQueues.get(workspaceId)?.length ?? 0,
        activeTerminals: state.activeTerminals,
        lastUsedAt: state.lastUsedAt,
      }
    }

    return {
      activeContainers: activeContainers + this.activeEphemeralContainers,
      idleContainers,
      runningTasks: this.runningTasks,
      queuedTasks: this.queuedTasks,
      queuedContainerWaiters: this.containerWaiters.length,
      activeTerminals: this.activeTerminals,
      workspaces,
    }
  }

  /** Reject all pending waiters and stop background timers. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer)
      this.reaperTimer = undefined
    }
    const err = new DockerSandboxError('POOL_DISPOSED', 'docker sandbox scheduler has been disposed')
    for (const queue of this.taskQueues.values()) {
      for (const waiter of queue) {
        if (!waiter.settled) {
          waiter.settled = true
          waiter.cleanup()
          waiter.reject(err)
        }
      }
    }
    this.taskQueues.clear()
    this.taskRrOrder.length = 0
    this.queuedTasks = 0

    for (const waiter of this.containerWaiters.splice(0)) {
      if (!waiter.settled) {
        waiter.settled = true
        waiter.cleanup()
        waiter.reject(err)
      }
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new DockerSandboxError('POOL_DISPOSED', 'docker sandbox scheduler has been disposed')
    }
  }

  private getOrCreateWorkspace(workspaceId: string): WorkspaceContainerState<TContainer> {
    let state = this.workspaces.get(workspaceId)
    if (!state) {
      state = {
        workspaceId,
        container: undefined,
        creating: undefined,
        runningTasks: 0,
        activeTerminals: 0,
        lastUsedAt: this.now(),
      }
      this.workspaces.set(workspaceId, state)
    }
    return state
  }

  private isIdle(state: WorkspaceContainerState<TContainer>): boolean {
    return state.runningTasks === 0 && state.activeTerminals === 0 && state.creating === undefined
  }

  private canStartTask(workspaceId: string, state: WorkspaceContainerState<TContainer>): boolean {
    void workspaceId
    return (
      this.runningTasks < this.config.maxConcurrentTasks
      && state.runningTasks < this.config.maxConcurrencyPerWorkspace
    )
  }

  private grantTaskLease(
    workspaceId: string,
    state: WorkspaceContainerState<TContainer>,
    waitedMs: number,
  ): TaskLease {
    state.runningTasks += 1
    state.lastUsedAt = this.now()
    this.runningTasks += 1
    this.emit({ type: 'task_started', workspaceId, waitedMs, runningTasks: this.runningTasks })

    let released = false
    return {
      workspaceId,
      waitedMs,
      release: () => {
        if (released) return
        released = true
        state.runningTasks = Math.max(0, state.runningTasks - 1)
        state.lastUsedAt = this.now()
        this.runningTasks = Math.max(0, this.runningTasks - 1)
        this.emit({ type: 'task_finished', workspaceId, runningTasks: this.runningTasks })
        this.drainTaskQueues()
        this.wakeContainerWaiters()
      },
    }
  }

  /** Round-robin dispatch across workspaces that have queued tasks and available per-workspace headroom. */
  private drainTaskQueues(): void {
    while (this.runningTasks < this.config.maxConcurrentTasks && this.taskRrOrder.length > 0) {
      let dispatched = false
      const total = this.taskRrOrder.length
      for (let i = 0; i < total; i += 1) {
        const idx = (this.taskRrCursor + i) % this.taskRrOrder.length
        const wsId = this.taskRrOrder[idx]
        if (wsId === undefined) continue
        const queue = this.taskQueues.get(wsId)
        if (!queue || queue.length === 0) {
          this.taskQueues.delete(wsId)
          this.taskRrOrder.splice(idx, 1)
          if (this.taskRrOrder.length > 0) {
            this.taskRrCursor = idx % this.taskRrOrder.length
          } else {
            this.taskRrCursor = 0
          }
          dispatched = true
          break
        }
        const state = this.getOrCreateWorkspace(wsId)
        if (!this.canStartTask(wsId, state)) continue

        const next = queue.shift()
        if (!next) continue
        this.queuedTasks = Math.max(0, this.queuedTasks - 1)
        if (queue.length === 0) {
          this.taskQueues.delete(wsId)
          this.taskRrOrder.splice(idx, 1)
          this.taskRrCursor = this.taskRrOrder.length > 0 ? idx % this.taskRrOrder.length : 0
        } else {
          // Advance cursor strictly past this workspace so the next slot goes to another workspace first.
          this.taskRrCursor = (idx + 1) % this.taskRrOrder.length
        }

        if (!next.settled) {
          next.settled = true
          next.cleanup()
          next.resolve()
        }
        dispatched = true
        break
      }
      if (!dispatched) break
    }
  }

  private removeTaskWaiter(waiter: TaskWaiter): void {
    const queue = this.taskQueues.get(waiter.workspaceId)
    if (!queue) return
    const pos = queue.indexOf(waiter)
    if (pos !== -1) {
      queue.splice(pos, 1)
      this.queuedTasks = Math.max(0, this.queuedTasks - 1)
    }
    if (queue.length === 0) {
      this.taskQueues.delete(waiter.workspaceId)
      const rrIdx = this.taskRrOrder.indexOf(waiter.workspaceId)
      if (rrIdx !== -1) {
        this.taskRrOrder.splice(rrIdx, 1)
        if (this.taskRrOrder.length === 0) {
          this.taskRrCursor = 0
        } else if (rrIdx < this.taskRrCursor) {
          this.taskRrCursor -= 1
        } else {
          this.taskRrCursor = this.taskRrCursor % this.taskRrOrder.length
        }
      }
    }
  }

  private totalAllocatedContainers(): number {
    let count = this.containerSlotReservations + this.activeEphemeralContainers
    for (const state of this.workspaces.values()) {
      if (state.container !== undefined) count += 1
    }
    return count
  }

  private pruneEmptyWorkspace(workspaceId: string): void {
    const state = this.workspaces.get(workspaceId)
    if (!state) return
    if (
      state.container === undefined
      && state.creating === undefined
      && state.runningTasks === 0
      && state.activeTerminals === 0
      && (this.taskQueues.get(workspaceId)?.length ?? 0) === 0
    ) {
      this.workspaces.delete(workspaceId)
    }
  }

  private pruneAllEmptyWorkspaces(): void {
    for (const workspaceId of [...this.workspaces.keys()]) {
      this.pruneEmptyWorkspace(workspaceId)
    }
  }

  private async createInReservedSlot(
    state: WorkspaceContainerState<TContainer>,
    create: () => Promise<TContainer>,
  ): Promise<TContainer> {
    this.containerSlotReservations += 1
    const pending = (async () => {
      try {
        const container = await create()
        state.container = container
        state.lastUsedAt = this.now()
        return container
      } finally {
        state.creating = undefined
        this.containerSlotReservations = Math.max(0, this.containerSlotReservations - 1)
        this.wakeContainerWaiters()
      }
    })()
    state.creating = pending
    return pending
  }

  private selectLruIdleVictim(excludeWorkspaceId: string): WorkspaceContainerState<TContainer> | undefined {
    let victim: WorkspaceContainerState<TContainer> | undefined
    for (const state of this.workspaces.values()) {
      if (state.workspaceId === excludeWorkspaceId) continue
      if (state.container === undefined || !this.isIdle(state)) continue
      if (!victim || state.lastUsedAt < victim.lastUsedAt) {
        victim = state
      }
    }
    return victim
  }

  private waitForContainerSlot(workspaceId: string, signal?: AbortSignal): Promise<void> {
    if (this.containerWaiters.length >= this.config.maxQueueSize) {
      throw new QueueFullError(this.config.maxQueueSize)
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: ContainerWaiter = {
        workspaceId,
        settled: false,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        },
      }
      const onAbort = (): void => {
        if (waiter.settled) return
        waiter.settled = true
        waiter.cleanup()
        const idx = this.containerWaiters.indexOf(waiter)
        if (idx !== -1) this.containerWaiters.splice(idx, 1)
        const reason = signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
        reject(reason)
      }
      const timer = setTimeout(() => {
        if (waiter.settled) return
        waiter.settled = true
        waiter.cleanup()
        const idx = this.containerWaiters.indexOf(waiter)
        if (idx !== -1) this.containerWaiters.splice(idx, 1)
        reject(new QueueTimeoutError(this.config.queueTimeoutMs))
      }, this.config.queueTimeoutMs)
      timer.unref()

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.containerWaiters.push(waiter)
    })
  }

  private wakeContainerWaiters(): void {
    const freeSlots = Math.max(0, this.config.maxActiveContainers - this.totalAllocatedContainers())
    const idleCount = [...this.workspaces.values()].filter(s => s.container !== undefined && this.isIdle(s)).length
    let wakesRemaining = Math.max(freeSlots, idleCount)

    while (wakesRemaining > 0 && this.containerWaiters.length > 0) {
      const idx = this.containerWaiterCursor % this.containerWaiters.length
      const [waiter] = this.containerWaiters.splice(idx, 1)
      if (!waiter || waiter.settled) continue
      this.containerWaiterCursor = this.containerWaiters.length > 0 ? idx % this.containerWaiters.length : 0
      waiter.settled = true
      waiter.cleanup()
      waiter.resolve()
      wakesRemaining -= 1
    }
  }

  private emit(event: SchedulerEvent): void {
    try {
      this.onEvent?.(event)
    } catch {
      // Telemetry callbacks must never break scheduling.
    }
  }
}
