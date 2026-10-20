export * as Job from "./job.js"

import {
  Array,
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Result,
  Schema,
  Scope,
  SynchronizedRef,
} from "effect"
import { isDeepStrictEqual } from "node:util"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Identifier } from "./id/id.js"
import { KV } from "./kv.js"
import { SessionMessage } from "./session/message.js"
import { SessionSchema } from "./session/schema.js"

const Background = Schema.Struct({
  id: Schema.String,
  notificationID: SessionMessage.ID,
  recovery: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("shell"),
      sessionID: SessionSchema.ID,
      shellID: Schema.String,
      command: Schema.String,
      // Preserve the request, not a prepared environment or entry capability.
      // Legacy notification-only markers remain readable and are never replayed.
      request: Schema.optionalKey(
        Schema.Struct({
          cwd: Schema.String,
          shell: Schema.String,
          timeout: Schema.Number,
          queueTimeout: Schema.optionalKey(Schema.Number),
          background: Schema.Boolean,
          environment: Schema.Literals(["project", "bootstrap"]),
          messageID: SessionMessage.ID,
          toolCallID: Schema.String,
        }),
      ),
    }),
    Schema.Struct({
      kind: Schema.Literal("subagent"),
      parentSessionID: SessionSchema.ID,
      childSessionID: SessionSchema.ID,
      agent: Schema.String,
      description: Schema.String,
    }),
  ]),
  status: Schema.Literals(["queued", "running", "cancelling", "reconciling", "completed", "error", "cancelled"]),
  notified: Schema.optionalKey(Schema.Boolean),
  output: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  time: Schema.optionalKey(
    Schema.Struct({
      submitted: Schema.Number,
      executed: Schema.optionalKey(Schema.Number),
      completed: Schema.optionalKey(Schema.Number),
    }),
  ),
})

export type Background = typeof Background.Type
export type Recovery = Background["recovery"]
export type Status = Background["status"]

export function isActive(status: Status): status is "queued" | "running" | "cancelling" {
  return status === "queued" || status === "running" || status === "cancelling"
}

const decodeBackground = Schema.decodeUnknownResult(Background)
const backgroundPrefix = "job.background/"
const COMPLETED_LIMIT = 25
export const ACTIVE_LIMIT = 128
export const REQUEST_LIMIT = 65_536

export class ConflictError extends Schema.TaggedError<ConflictError>()("Job.ConflictError", {
  id: Schema.String,
}) {
  override get message() {
    return `Job ${this.id} was already accepted with a different request; no work was dispatched.`
  }
}

export class PayloadError extends Schema.TaggedError<PayloadError>()("Job.PayloadError", {
  limit: Schema.Number,
}) {
  override get message() {
    return `Job request exceeds ${this.limit} bytes; no work was accepted.`
  }
}

export class CapacityError extends Schema.TaggedError<CapacityError>()("Job.CapacityError", {
  retryAfterMs: Schema.Number,
}) {
  override get message() {
    return "Job queue is full; no work was accepted. Retry after capacity becomes available."
  }
}

// Entered work whose outcome is unproven. The job settles as reconciling, without a
// completion time, and its accepted intent is retained without automatic replay.
export class ReconcilingError extends Schema.TaggedError<ReconcilingError>()("Job.ReconcilingError", {
  message: Schema.String,
}) {}

export type Info = {
  id: string
  type: string
  title?: string
  status: Status
  started_at: number
  executed_at?: number
  completed_at?: number
  output?: string
  error?: string
  metadata?: Record<string, unknown>
  notificationID?: SessionMessage.ID
}

type Active = {
  info: Info
  done: Deferred.Deferred<Info>
  backgrounded: Deferred.Deferred<Info>
  scope: Scope.Closeable
  blockingSessions: Map<SessionSchema.ID, number>
  isBackgrounded: boolean
  consumed: boolean
  queuedSubmission: boolean
  recovery?: Recovery
}

type State = {
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  scope: Scope.Scope
}

type FinishResult = {
  info?: Info
  done?: Deferred.Deferred<Info>
  scope?: Scope.Closeable
  generation?: Scope.Closeable
}

type BackgroundResult = {
  info?: Info
  backgrounded?: Deferred.Deferred<Info>
}

type StartResult = { info: Info } | { info: Info; scope: Scope.Closeable }

type BlockWait = {
  done: Deferred.Deferred<Info>
  backgrounded: Deferred.Deferred<Info>
  generation: Scope.Closeable
}

type BlockStart =
  | { type: "missing" }
  | { type: "finished"; info: Info; generation: Scope.Closeable }
  | { type: "backgrounded"; info: Info }
  | { type: "wait"; wait: BlockWait }

export type StartInput = {
  id?: string
  type: string
  title?: string
  metadata?: Record<string, unknown>
  recovery?: Recovery
  notificationID?: SessionMessage.ID
  queued?: boolean
  // Queued producers mark actual execution after preparation and admission.
  run: Effect.Effect<string, unknown> | ((started: Effect.Effect<void>) => Effect.Effect<string, unknown>)
}

export type WaitInput = {
  id: string
  timeout?: number
}

export type WaitResult = {
  info?: Info
  timedOut: boolean
}

export type BlockInput = {
  id: string
  sessionID: SessionSchema.ID
}

export type BlockResult = { type: "finished"; info: Info } | { type: "backgrounded"; info: Info }

export type BackgroundAllInput = {
  sessionID: SessionSchema.ID
  type?: string
}

export interface Interface {
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Info, CapacityError | ConflictError | PayloadError>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  readonly block: (input: BlockInput) => Effect.Effect<BlockResult | undefined>
  readonly background: (id: string) => Effect.Effect<Info | undefined>
  readonly backgroundAll: (input: BackgroundAllInput) => Effect.Effect<Info[]>
  readonly cancel: (id: string) => Effect.Effect<Info | undefined>
  readonly pendingBackground: Effect.Effect<readonly Background[]>
  // Acknowledge delivery, not execution: unresolved accepted intents remain durable.
  readonly completeBackground: (notificationID: SessionMessage.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Job") {}

function snapshot(job: Active): Info {
  return {
    ...job.info,
    ...(job.info.metadata ? { metadata: { ...job.info.metadata } } : {}),
  }
}

function recoveredInfo(background: Background): Info | undefined {
  if (background.recovery.kind !== "shell" || !background.recovery.request) return
  return {
    id: background.id,
    type: "shell",
    title: background.recovery.command,
    status: isActive(background.status) ? "reconciling" : background.status,
    started_at: background.time?.submitted ?? 0,
    executed_at: background.time?.executed,
    completed_at: background.time?.completed,
    output: background.output,
    error: background.error,
    notificationID: background.notificationID,
    metadata: { sessionID: background.recovery.sessionID, shellID: background.recovery.shellID },
  }
}

function errorText(cause: Cause.Cause<unknown>) {
  const render = (error: Error): string => {
    const message = error.message || error.name || "Unknown error"
    if (!(error.cause instanceof Error)) return message
    const detail = render(error.cause)
    return detail === message || detail.startsWith(`${message}\n`) ? detail : `${message}\nCaused by: ${detail}`
  }
  return Cause.prettyErrors(cause).map(render).join("\n") || "Unknown error"
}

function incrementSession(input: Map<SessionSchema.ID, number>, sessionID: SessionSchema.ID) {
  return new Map(input).set(sessionID, (input.get(sessionID) ?? 0) + 1)
}

function decrementSession(input: Map<SessionSchema.ID, number>, sessionID: SessionSchema.ID) {
  const count = input.get(sessionID)
  if (count === undefined) return input
  const next = new Map(input)
  if (count <= 1) next.delete(sessionID)
  else next.set(sessionID, count - 1)
  return next
}

/**
 * Makes one scoped, process-local registry. Explicitly recoverable background
 * work also owns a durable notification marker until its notification is admitted.
 * Unconsumed results survive the start-to-wait handoff. Foreground block/cancel
 * and non-recoverable wait results enter a 25-entry consumed history. Recoverable
 * wait results stay available for background registration and acknowledgment.
 * Accepted shell requests without a local owner remain reconciling across restarts;
 * notice delivery neither proves native cleanup nor authorizes their replay.
 */
export const make = Effect.gen(function* () {
  const kv = yield* KV.Service
  const state: State = {
    jobs: yield* SynchronizedRef.make(new Map()),
    scope: yield* Scope.Scope,
  }

  const backgrounds = Effect.gen(function* () {
    const recovered: Background[] = []
    let after: string | undefined
    do {
      const page = yield* kv.scan({ prefix: backgroundPrefix, after })
      recovered.push(...Array.filterMap(page.entries, (entry) => decodeBackground(entry.value)))
      after = page.next
    } while (after)
    return recovered
  })

  const consume = (id: string, generation: Scope.Closeable) =>
    SynchronizedRef.update(state.jobs, (jobs) => {
      const job = jobs.get(id)
      if (!job || job.scope !== generation || isActive(job.info.status) || job.consumed) return jobs
      const next = new Map(jobs)
      // Order history by first consumption, not by start time or subsequent reads.
      next.delete(id)
      next.set(id, { ...job, consumed: true })
      const completed = [...next].filter(([, job]) => job.consumed && !job.info.notificationID)
      for (const [id] of completed.slice(0, -COMPLETED_LIMIT)) next.delete(id)
      return next
    })

  const persistBackground = Effect.fnUntraced(function* (job: Active) {
    if (!job.recovery || !job.info.notificationID) return
    yield* kv.set(`${backgroundPrefix}${job.info.notificationID}`, {
      id: job.info.id,
      notificationID: job.info.notificationID,
      recovery: job.recovery,
      status: job.info.status,
      time: {
        submitted: job.info.started_at,
        ...(job.info.executed_at !== undefined ? { executed: job.info.executed_at } : {}),
        ...(job.info.completed_at !== undefined ? { completed: job.info.completed_at } : {}),
      },
      ...(job.info.output !== undefined ? { output: job.info.output } : {}),
      ...(job.info.error !== undefined ? { error: job.info.error } : {}),
    })
  })

  const settle = Effect.fnUntraced(function* (id: string, scope: Scope.Closeable, exit: Exit.Exit<string, unknown>) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [FinishResult, Map<string, Active>]> {
        const job = jobs.get(id)
        if (!job) return [{}, jobs]
        if (job.scope !== scope) return [{}, jobs]
        if (!isActive(job.info.status)) return [{ info: snapshot(job) }, jobs]
        const status: Exclude<Status, "queued" | "running" | "cancelling"> = Exit.isSuccess(exit)
          ? "completed"
          : Cause.hasInterruptsOnly(exit.cause)
            ? "cancelled"
            : Result.getOrUndefined(Cause.findError(exit.cause)) instanceof ReconcilingError
              ? "reconciling"
              : "error"
        const next = {
          ...job,
          blockingSessions: new Map<SessionSchema.ID, number>(),
          info: {
            ...job.info,
            status,
            ...(status === "reconciling" ? {} : { completed_at }),
            ...(Exit.isSuccess(exit) ? { output: exit.value } : {}),
            ...(Exit.isFailure(exit) ? { error: errorText(exit.cause) } : {}),
          },
        }
        // Shutdown interruption leaves the prior marker for reconciliation;
        // explicit cancellation becomes terminal only after producer cleanup.
        if (status !== "cancelled" || job.info.status === "cancelling") yield* persistBackground(next)
        return [{ info: snapshot(next), done: job.done, scope: job.scope }, new Map(jobs).set(id, next)]
      }),
    )
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info)
    if (result.scope) {
      yield* Scope.close(result.scope, Exit.void).pipe(Effect.forkIn(state.scope, { startImmediately: true }))
    }
    return result.info
  })

  const get: Interface["get"] = Effect.fn("Job.get")(function* (id) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    if (job) return snapshot(job)
    const background = (yield* backgrounds).find((entry) => entry.id === id)
    return background && recoveredInfo(background)
  })

  const markRunning = (id: string, scope: Scope.Closeable) =>
    SynchronizedRef.updateEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs) {
        const job = jobs.get(id)
        if (!job || job.scope !== scope || job.info.status !== "queued") return jobs
        const next = {
          ...job,
          info: { ...job.info, status: "running" as const, executed_at: yield* Clock.currentTimeMillis },
        }
        yield* persistBackground(next)
        return new Map(jobs).set(id, next)
      }),
    )

  const start: Interface["start"] = Effect.fnUntraced(function* (input) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const id = input.id ?? Identifier.ascending("job")
        const started_at = yield* Clock.currentTimeMillis
        const done = yield* Deferred.make<Info>()
        const backgrounded = yield* Deferred.make<Info>()
        const result = yield* SynchronizedRef.modifyEffect(
          state.jobs,
          Effect.fnUntraced(function* (jobs): Effect.fn.Return<
            readonly [StartResult, Map<string, Active>],
            CapacityError | ConflictError | PayloadError
          > {
            const existing = jobs.get(id)
            if (existing && (input.queued || existing.queuedSubmission)) {
              if (existing.info.type !== input.type || !isDeepStrictEqual(existing.recovery, input.recovery))
                return yield* new ConflictError({ id })
              // A terminal result awaiting acknowledgment is still the accepted
              // request, not permission to dispatch its side effects again.
              return [{ info: snapshot(existing) }, jobs]
            }
            if (existing && isActive(existing.info.status)) {
              return [{ info: snapshot(existing) }, jobs]
            }
            // ponytail: scan the submission-bounded marker set; add an ID index
            // here if the queue policy grows beyond the current 128 requests.
            const durable = input.queued || input.id !== undefined ? yield* backgrounds : []
            const accepted = durable.find((entry) => entry.id === id)
            const recovered = accepted && recoveredInfo(accepted)
            if (accepted && recovered) {
              if (recovered.type !== input.type || !isDeepStrictEqual(accepted.recovery, input.recovery))
                return yield* new ConflictError({ id })
              return [{ info: recovered }, jobs]
            }
            if (input.queued && input.recovery && Buffer.byteLength(JSON.stringify(input.recovery)) > REQUEST_LIMIT)
              return yield* new PayloadError({ limit: REQUEST_LIMIT })
            if (
              input.queued &&
              new Set([
                ...[...jobs.values()]
                  .filter((job) => !job.consumed || job.info.notificationID)
                  .map((job) => job.info.id),
                ...durable.map((entry) => entry.id),
              ]).size >= ACTIVE_LIMIT
            )
              return yield* new CapacityError({ retryAfterMs: 250 })
            const scope = yield* Scope.fork(state.scope, "parallel")
            const job = {
              info: {
                id,
                type: input.type,
                title: input.title,
                status: input.queued ? ("queued" as const) : ("running" as const),
                started_at,
                metadata: input.metadata,
                ...(input.notificationID || (input.queued && input.recovery)
                  ? { notificationID: input.notificationID ?? SessionMessage.ID.create() }
                  : {}),
              },
              done,
              backgrounded,
              scope,
              blockingSessions: new Map<SessionSchema.ID, number>(),
              isBackgrounded: false,
              consumed: false,
              queuedSubmission: input.queued === true,
              recovery: input.recovery,
            }
            // Persist the accepted intent before the first producer effect,
            // including foreground work that may queue or be interrupted.
            if (input.queued) yield* persistBackground(job)
            return [{ info: snapshot(job), scope }, new Map(jobs).set(id, job)]
          }),
        )
        if ("scope" in result)
          yield* restore(typeof input.run === "function" ? input.run(markRunning(id, result.scope)) : input.run).pipe(
            Effect.exit,
            Effect.flatMap((exit) => settle(id, result.scope, exit)),
            Effect.asVoid,
            Effect.forkIn(result.scope, { startImmediately: true }),
          )
        return result.info
      }),
    )
  })

  const wait: Interface["wait"] = Effect.fn("Job.wait")(function* (input) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(input.id)
    if (!job) {
      const info = yield* get(input.id)
      return { ...(info ? { info } : {}), timedOut: false }
    }
    return yield* Effect.gen(function* () {
      if (!isActive(job.info.status)) return { info: snapshot(job), timedOut: false }
      if (input.timeout === undefined) return { info: yield* Deferred.await(job.done), timedOut: false }
      if (input.timeout <= 0) return { info: snapshot(job), timedOut: true }
      const info = yield* Deferred.await(job.done).pipe(Effect.timeoutOption(input.timeout))
      if (info._tag === "Some") return { info: info.value, timedOut: false }
      return { info: snapshot(job), timedOut: true }
    }).pipe(
      // Recoverable wait -> background is a supported handoff, even after failure.
      Effect.tap((result) =>
        isActive(result.info.status) || job.recovery ? Effect.void : consume(input.id, job.scope),
      ),
    )
  })

  const removeBlock = Effect.fnUntraced(function* (input: BlockInput) {
    yield* SynchronizedRef.update(state.jobs, (jobs) => {
      const job = jobs.get(input.id)
      if (!job || !isActive(job.info.status) || job.isBackgrounded) return jobs
      return new Map(jobs).set(input.id, {
        ...job,
        blockingSessions: decrementSession(job.blockingSessions, input.sessionID),
      })
    })
  })

  const block: Interface["block"] = Effect.fnUntraced(function* (input) {
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [BlockStart, Map<string, Active>] => {
      const job = jobs.get(input.id)
      if (!job) return [{ type: "missing" }, jobs]
      if (!isActive(job.info.status)) return [{ type: "finished", info: snapshot(job), generation: job.scope }, jobs]
      if (job.isBackgrounded) return [{ type: "backgrounded", info: snapshot(job) }, jobs]
      return [
        { type: "wait", wait: { done: job.done, backgrounded: job.backgrounded, generation: job.scope } },
        new Map(jobs).set(input.id, {
          ...job,
          blockingSessions: incrementSession(job.blockingSessions, input.sessionID),
        }),
      ]
    })
    if (result.type === "missing") return undefined
    if (result.type === "finished") {
      yield* consume(input.id, result.generation)
      return { type: "finished", info: result.info }
    }
    if (result.type === "backgrounded") return { type: "backgrounded", info: result.info }
    return yield* Effect.raceFirst(
      Deferred.await(result.wait.done).pipe(Effect.map((info) => ({ type: "finished" as const, info }))),
      Deferred.await(result.wait.backgrounded).pipe(Effect.map((info) => ({ type: "backgrounded" as const, info }))),
    ).pipe(
      Effect.tap((outcome) => (outcome.type === "finished" ? consume(input.id, result.wait.generation) : Effect.void)),
      Effect.ensuring(removeBlock(input)),
    )
  })

  const markBackground = Effect.fnUntraced(function* (job: Active) {
    const next = {
      ...job,
      isBackgrounded: true,
      blockingSessions: new Map<SessionSchema.ID, number>(),
      info: {
        ...job.info,
        ...(job.recovery ? { notificationID: job.info.notificationID ?? SessionMessage.ID.create() } : {}),
      },
    }
    yield* persistBackground(next)
    return next
  })

  const background: Interface["background"] = Effect.fn("Job.background")(function* (id) {
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [BackgroundResult, Map<string, Active>]> {
        const job = jobs.get(id)
        // Recoverable work may finish before the caller backgrounds it.
        if (!job || (!isActive(job.info.status) && !job.recovery)) return [{}, jobs]
        if (job.isBackgrounded) return [{ info: snapshot(job) }, jobs]
        const next = yield* markBackground(job)
        return [{ info: snapshot(next), backgrounded: job.backgrounded }, new Map(jobs).set(id, next)]
      }),
    )
    if (result.info && result.backgrounded) yield* Deferred.succeed(result.backgrounded, result.info)
    return result.info
  })

  const backgroundAll: Interface["backgroundAll"] = Effect.fn("Job.backgroundAll")(function* (input) {
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<
        readonly [Required<BackgroundResult>[], Map<string, Active>]
      > {
        const results: Required<BackgroundResult>[] = []
        const next = new Map(jobs)
        for (const [id, job] of jobs) {
          if (!isActive(job.info.status)) continue
          if (job.isBackgrounded) continue
          if (input.type !== undefined && job.info.type !== input.type) continue
          if (!job.blockingSessions.has(input.sessionID)) continue
          const updated = yield* markBackground(job)
          results.push({ info: snapshot(updated), backgrounded: job.backgrounded })
          next.set(id, updated)
        }
        return [results, next]
      }),
    )
    yield* Effect.forEach(result, (item) => Deferred.succeed(item.backgrounded, item.info), { discard: true })
    return result.map((item) => item.info)
  })

  const cancel: Interface["cancel"] = Effect.fn("Job.cancel")(function* (id) {
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [FinishResult, Map<string, Active>]> {
        const job = jobs.get(id)
        if (!job) return [{}, jobs]
        if (!isActive(job.info.status)) return [{ info: snapshot(job), generation: job.scope }, jobs]
        const next = {
          ...job,
          blockingSessions: new Map<SessionSchema.ID, number>(),
          info: {
            ...job.info,
            status: "cancelling" as const,
          },
        }
        yield* persistBackground(next)
        return [
          { info: snapshot(next), done: job.done, scope: job.scope, generation: job.scope },
          new Map(jobs).set(id, next),
        ]
      }),
    )
    // Closing the producer scope performs process/descendant cleanup. Waiters
    // and durable recovery must not see a terminal cancellation before it ends.
    const info = result.scope
      ? yield* Scope.close(result.scope, Exit.void).pipe(Effect.andThen(settle(id, result.scope, Exit.interrupt())))
      : result.info
    if (result.generation) yield* consume(id, result.generation)
    return info ?? (yield* get(id))
  })

  const pendingBackground: Interface["pendingBackground"] = backgrounds.pipe(
    Effect.map((entries) => entries.filter((entry) => !entry.notified)),
    Effect.withSpan("Job.pendingBackground"),
  )

  const completeBackground: Interface["completeBackground"] = Effect.fn("Job.completeBackground")((notificationID) =>
    SynchronizedRef.updateEffect(state.jobs, (jobs) =>
      Effect.gen(function* () {
        const background = Result.getOrUndefined(
          decodeBackground(yield* kv.get(`${backgroundPrefix}${notificationID}`)),
        )
        if (
          background?.recovery.kind === "shell" &&
          background.recovery.request &&
          (isActive(background.status) || background.status === "reconciling")
        ) {
          // A delivered notice is not native cleanup evidence. Keep the bounded
          // accepted intent until its outcome can actually be reconciled.
          yield* kv.set(`${backgroundPrefix}${notificationID}`, {
            ...background,
            status: "reconciling",
            notified: true,
          })
          return jobs
        }
        yield* kv.remove(`${backgroundPrefix}${notificationID}`)
        const entry = [...jobs].find(([, job]) => job.info.notificationID === notificationID)
        if (!entry || isActive(entry[1].info.status)) return jobs
        const next = new Map(jobs)
        next.delete(entry[0])
        return next
      }),
    ),
  )

  return Service.of({
    get,
    start,
    wait,
    block,
    background,
    backgroundAll,
    cancel,
    pendingBackground,
    completeBackground,
  })
})

const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer, deps: [KV.node] })
