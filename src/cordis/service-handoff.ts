/**
 * Cordis hot-reload service-handoff helper.
 *
 * When a DSH bundle overlay replaces a built-in service provider (such as `ctx.subprocess` or
 * `ctx.shell`) during a live profile reload, `@deepseek-ai/cordis-plugin-loader` calls
 * `oldEntry.fiber.dispose()` without awaiting it while starting the replacement entry in the same
 * `Promise.all` batch. Under `@deepseek-ai/cordis` 4.x, the departing provider's `_unload()` waits
 * until all dependent fibers finish unloading before deleting its slot from `ctx.reflect.store`.
 *
 * Waiting for a *disposing* predecessor fiber before instantiating the replacement `Service`
 * eliminates transient `service "<name>" has been registered at <...>` activation failures while
 * remaining strictly fail-closed whenever an *active* (non-disposing) duplicate provider exists.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'

interface ServiceImplRecord {
  readonly ctx?: { readonly fiber?: Fiber }
  readonly fiber?: Fiber
}

interface ReflectStoreCarrier {
  readonly store?: Record<symbol, ServiceImplRecord | undefined>
}

interface ServiceInstanceHooks {
  readonly [key: symbol]: unknown
}

const MAX_HANDOFF_ATTEMPTS = 16
const INIT_HOOKS_SYMBOL = Symbol.for('cordis.initHooks')
// Cordis FiberState values (const enum cannot be accessed at runtime under verbatimModuleSyntax).
const FIBER_STATE_DISPOSED = 4
const FIBER_STATE_UNLOADING = 5

function getRegisteredServiceFiber(ctx: Context, serviceName: string): Fiber | undefined {
  const isolateMap = (ctx as unknown as Record<symbol, Record<string, symbol | undefined> | undefined>)[Context.isolate]
  const key = isolateMap?.[serviceName]
  if (!key) return undefined
  const store = (ctx.reflect as unknown as ReflectStoreCarrier).store
  const impl = store?.[key]
  if (!impl) return undefined
  return impl.ctx?.fiber ?? impl.fiber
}

function isFiberDisposingOrDisposed(fiber: Fiber): boolean {
  const state = fiber.state as number
  return fiber.uid === null
    || state === FIBER_STATE_UNLOADING
    || state === FIBER_STATE_DISPOSED
}

/** Return true when `ctx.fiber` is still eligible to register services and effects. */
export function isFiberActiveForRegistration(ctx: Context): boolean {
  return !isFiberDisposingOrDisposed(ctx.fiber)
}

/**
 * Wait until any currently *disposing* predecessor providing `serviceName` in `ctx`'s isolation
 * realm has completed teardown and vacated `ctx.reflect.store`.
 *
 * Returns immediately if no provider is registered or if the existing provider is still active
 * (preserving fail-closed duplicate-service errors). Aborts promptly if `ctx.fiber` itself is
 * disposed while waiting.
 */
export async function waitForDisposingService(ctx: Context, serviceName: string): Promise<void> {
  for (let attempt = 0; attempt < MAX_HANDOFF_ATTEMPTS; attempt++) {
    if (!isFiberActiveForRegistration(ctx)) return

    const ownerFiber = getRegisteredServiceFiber(ctx, serviceName)
    if (!ownerFiber || ownerFiber === ctx.fiber) return
    if (!isFiberDisposingOrDisposed(ownerFiber)) return

    let stopWatchingStatus: (() => void) | undefined
    let stopWatchingPlugin: (() => void) | undefined
    const ownDisposed = new Promise<void>((resolve) => {
      const checkOwnDisposal = (fiber: Fiber): void => {
        if (fiber === ctx.fiber && isFiberDisposingOrDisposed(fiber)) {
          resolve()
        }
      }
      // `internal/plugin` fires synchronously when `fiber.dispose()` runs during LOADING
      // (before `this.inertia` finishes and `internal/status` transitions to DISPOSING).
      stopWatchingPlugin = ctx.on('internal/plugin', checkOwnDisposal, { global: true })
      stopWatchingStatus = ctx.on('internal/status', checkOwnDisposal, { global: true })
      if (!isFiberActiveForRegistration(ctx)) {
        resolve()
      }
    })

    try {
      const ownerSettled = typeof ownerFiber.await === 'function'
        ? ownerFiber.await().then(() => undefined, () => undefined)
        : Promise.resolve()
      await Promise.race([ownerSettled, ownDisposed])
    } finally {
      stopWatchingPlugin?.()
      stopWatchingStatus?.()
    }

    if (!isFiberActiveForRegistration(ctx)) return
    if (getRegisteredServiceFiber(ctx, serviceName) === ownerFiber) {
      await Promise.resolve()
    }
  }
}

export interface ServiceHandoffPluginOptions<TConfig, TSchema = undefined> {
  readonly name: string
  readonly serviceName: string
  readonly inject?: string[]
  readonly Config?: TSchema
  readonly instantiate: (ctx: Context, config: TConfig) => unknown
}

export type ServiceHandoffPlugin<TConfig, TSchema = undefined> = {
  readonly name: string
  readonly inject?: string[]
  readonly apply: (ctx: Context, config: TConfig) => Promise<void>
} & ([TSchema] extends [undefined] ? Record<never, never> : { readonly Config: TSchema })

/**
 * Wrap a Cordis `Service` subclass in an async plugin object that gracefully hands off
 * `serviceName` from a disposing predecessor during live DSH bundle reloads.
 */
export function createServiceHandoffPlugin<TConfig, TSchema = undefined>(
  options: ServiceHandoffPluginOptions<TConfig, TSchema>,
): ServiceHandoffPlugin<TConfig, TSchema> {
  const plugin: Record<string, unknown> = {
    name: options.name,
    async apply(ctx: Context, config: TConfig): Promise<void> {
      await waitForDisposingService(ctx, options.serviceName)
      if (!isFiberActiveForRegistration(ctx)) return
      const instance = options.instantiate(ctx, config) as ServiceInstanceHooks | undefined
      const hooks = instance?.[INIT_HOOKS_SYMBOL]
      if (Array.isArray(hooks)) {
        for (const hook of hooks) {
          if (typeof hook === 'function') hook()
        }
      }
      const init = instance?.[Service.init]
      if (typeof init === 'function') {
        await (init as () => unknown).call(instance)
      }
    },
  }
  if (options.inject !== undefined) {
    plugin.inject = options.inject
  }
  if (options.Config !== undefined) {
    plugin.Config = options.Config
  }
  return plugin as unknown as ServiceHandoffPlugin<TConfig, TSchema>
}
