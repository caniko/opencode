import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode, Node } from "@opencode-ai/core/effect/app-node"
import { GlobalBus } from "@/bus/global"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance as runDisposers } from "@/effect/instance-registry"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Context, Deferred, Duration, Effect, Exit, Layer, Schedule, Scope } from "effect"
import { type InstanceContext } from "./instance-context"
import { InstanceBootstrap } from "./bootstrap-service"
import * as Project from "./project"

export interface LoadInput {
  directory: string
  worktree?: string
  project?: Project.Info
}

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly reload: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void>
  readonly disposeDirectory: (directory: string) => Effect.Effect<void>
  readonly disposeAll: () => Effect.Effect<void>
  readonly status: () => Effect.Effect<{ loadedInstances: number }>
  readonly sweepIdle: (cutoff: number) => Effect.Effect<void>
  readonly provide: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceStore") {}

export const use = serviceUse(Service)

interface Entry {
  readonly deferred: Deferred.Deferred<InstanceContext>
  disposing?: Deferred.Deferred<void>
  inactive?: Deferred.Deferred<void>
  active: number
  lastUsed: number
}

function idleTTL() {
  const raw = process.env.OPENCODE_INSTANCE_IDLE_TTL_MS
  if (raw === undefined) return Duration.toMillis(Duration.hours(1))
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("OPENCODE_INSTANCE_IDLE_TTL_MS must be a positive integer")
  return value
}

const layer: Layer.Layer<Service, never, Project.Service | InstanceBootstrap.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const project = yield* Project.Service
    const bootstrap = yield* InstanceBootstrap.Service
    const scope = yield* Scope.Scope
    const cache = new Map<string, Entry>()
    const ttl = idleTTL()

    const boot = (input: LoadInput & { directory: string }) =>
      Effect.gen(function* () {
        const ctx: InstanceContext =
          input.project && input.worktree
            ? {
                directory: input.directory,
                worktree: input.worktree,
                project: input.project,
              }
            : yield* project.fromDirectory(input.directory).pipe(
                Effect.map((result) => ({
                  directory: input.directory,
                  worktree: result.sandbox,
                  project: result.project,
                })),
              )
        yield* bootstrap.run.pipe(Effect.provideService(InstanceRef, ctx))
        return ctx
      }).pipe(Effect.withSpan("InstanceStore.boot"))

    const removeEntry = (directory: string, entry: Entry) =>
      Effect.sync(() => {
        if (cache.get(directory) !== entry) return false
        cache.delete(directory)
        return true
      })

    const completeLoad = (directory: string, input: LoadInput, entry: Entry) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(boot({ ...input, directory }))
        if (Exit.isFailure(exit)) yield* removeEntry(directory, entry)
        yield* Deferred.done(entry.deferred, exit).pipe(Effect.asVoid)
      })

    const emitDisposed = (input: { directory: string; project?: string }) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: input.directory,
          project: input.project,
          workspace: WorkspaceContext.workspaceID,
          payload: {
            type: "server.instance.disposed",
            properties: {
              directory: input.directory,
            },
          },
        }),
      )

    const disposeContext = Effect.fn("InstanceStore.disposeContext")(function* (ctx: InstanceContext) {
      yield* Effect.logInfo("disposing instance", { directory: ctx.directory })
      yield* Effect.promise(() => runDisposers(ctx.directory))
      yield* emitDisposed({ directory: ctx.directory, project: ctx.project.id })
    })

    const disposeEntry = Effect.fnUntraced(function* (directory: string, entry: Entry, ctx: InstanceContext) {
      if (cache.get(directory) !== entry) return false
      if (entry.disposing) {
        yield* Deferred.await(entry.disposing)
        return false
      }
      const disposing = Deferred.makeUnsafe<void>()
      entry.disposing = disposing
      return yield* Effect.gen(function* () {
        if (entry.inactive) yield* Deferred.await(entry.inactive)
        yield* disposeContext(ctx)
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* removeEntry(directory, entry)
            yield* Deferred.succeed(disposing, undefined)
          }),
        ),
        Effect.as(true),
      )
    })

    const load = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const existing = cache.get(directory)
          if (existing) {
            if (existing.disposing) {
              yield* restore(Deferred.await(existing.disposing))
              return yield* restore(load(input))
            }
            existing.lastUsed = Date.now()
            return yield* restore(Deferred.await(existing.deferred))
          }

          const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext>(), active: 0, lastUsed: Date.now() }
          cache.set(directory, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("creating instance", { directory: directory })
            yield* completeLoad(directory, input, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          return yield* restore(Deferred.await(entry.deferred))
        }),
      ).pipe(Effect.withSpan("InstanceStore.load"))
    }

    const reload = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const previous = cache.get(directory)
          yield* Effect.logInfo("reloading instance", { directory })
          if (previous) {
            const exit = yield* restore(Deferred.await(previous.deferred)).pipe(Effect.exit)
            if (Exit.isFailure(exit)) yield* removeEntry(directory, previous)
            else yield* restore(disposeEntry(directory, previous, exit.value))
          }
          return yield* restore(load({ ...input, directory }))
        }),
      ).pipe(Effect.withSpan("InstanceStore.reload"))
    }

    const dispose = Effect.fn("InstanceStore.dispose")(function* (ctx: InstanceContext) {
      const entry = cache.get(ctx.directory)
      if (!entry) return yield* disposeContext(ctx)

      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(ctx.directory, entry).pipe(Effect.asVoid)
      if (exit.value !== ctx) return
      yield* disposeEntry(ctx.directory, entry, ctx).pipe(Effect.asVoid)
    })

    const disposeDirectory = Effect.fn("InstanceStore.disposeDirectory")(function* (input: string) {
      const directory = FSUtil.resolve(input)
      const entry = cache.get(directory)
      if (!entry) return
      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(directory, entry).pipe(Effect.asVoid)
      yield* disposeEntry(directory, entry, exit.value).pipe(Effect.asVoid)
    })

    const disposeAllOnce = Effect.fnUntraced(function* () {
      yield* Effect.logInfo("disposing all instances")
      while (cache.size) {
        yield* Effect.forEach(
          [...cache.entries()],
          (item) =>
            Effect.gen(function* () {
              const exit = yield* Deferred.await(item[1].deferred).pipe(Effect.exit)
              if (Exit.isFailure(exit)) {
                yield* Effect.logWarning("instance dispose failed", { key: item[0], cause: exit.cause })
                yield* removeEntry(item[0], item[1])
                return
              }
              yield* disposeEntry(item[0], item[1], exit.value)
            }),
          { discard: true },
        )
      }
    })

    const cachedDisposeAll = yield* Effect.cachedWithTTL(disposeAllOnce(), Duration.zero)
    const disposeAll = Effect.fn("InstanceStore.disposeAll")(function* () {
      return yield* cachedDisposeAll
    })

    const status = Effect.fn("InstanceStore.status")(function* () {
      return { loadedInstances: cache.size }
    })

    const sweepIdle = Effect.fn("InstanceStore.sweepIdle")(function* (cutoff: number) {
      yield* Effect.forEach(
        [...cache.entries()],
        ([directory, entry]) =>
          Effect.gen(function* () {
            if (entry.active > 0 || entry.lastUsed > cutoff) return
            const lastUsed = entry.lastUsed
            const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
            if (Exit.isFailure(exit)) return yield* removeEntry(directory, entry).pipe(Effect.asVoid)
            if (cache.get(directory) !== entry || entry.active > 0 || entry.lastUsed !== lastUsed) return
            yield* disposeEntry(directory, entry, exit.value)
          }),
        { discard: true },
      )
    })

    const pin = (input: LoadInput): Effect.Effect<{ ctx: InstanceContext; entry: Entry }> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const ctx = yield* restore(load(input))
          const entry = cache.get(ctx.directory)
          if (!entry) return yield* restore(pin(input))
          if (entry.disposing) {
            yield* restore(Deferred.await(entry.disposing))
            return yield* restore(pin(input))
          }
          if (entry.active === 0) entry.inactive = Deferred.makeUnsafe<void>()
          entry.active++
          return { ctx, entry }
        }),
      )

    const provide = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const pinned = yield* restore(pin(input))
          return yield* restore(effect.pipe(Effect.provideService(InstanceRef, pinned.ctx))).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                pinned.entry.active--
                pinned.entry.lastUsed = Date.now()
                if (pinned.entry.active > 0) return
                const inactive = pinned.entry.inactive
                pinned.entry.inactive = undefined
                if (inactive) Deferred.doneUnsafe(inactive, Effect.void)
              }),
            ),
          )
        }),
      )

    const touch = (event: { directory?: string }) => {
      if (!event.directory) return
      const entry = cache.get(FSUtil.resolve(event.directory))
      if (entry) entry.lastUsed = Date.now()
    }
    GlobalBus.on("event", touch)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", touch)))
    yield* Effect.suspend(() => sweepIdle(Date.now() - ttl)).pipe(
      Effect.repeat(Schedule.spaced(Math.max(1_000, Math.min(ttl, 60_000)))),
      Effect.forkScoped,
    )

    yield* Effect.addFinalizer(() => disposeAll().pipe(Effect.ignore))

    return Service.of({
      load,
      reload,
      dispose,
      disposeDirectory,
      disposeAll,
      status,
      sweepIdle,
      provide,
    })
  }),
)

export const bootstrapNode = LayerNode.unbound(InstanceBootstrap.Service, Node.tags.values.global)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [Project.node, bootstrapNode],
})

export * as InstanceStore from "./instance-store"
