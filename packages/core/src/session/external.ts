export * as SessionExternal from "./external.js"

import { createHash } from "node:crypto"
import { eq, inArray, or } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { SessionExternal } from "@opencode/schema/session-external"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Database } from "../database/database.js"
import { KeyedMutex } from "../effect/keyed-mutex.js"
import { Job } from "../job.js"
import { Session } from "../session.js"
import { SessionEnvironment } from "./environment.js"
import { SessionExecution } from "./execution.js"
import { SessionRestart } from "./execution/restart.js"
import { SessionStore } from "./store.js"
import { SessionExternalTable, SessionTable } from "./sql.js"

export class Conflict extends Schema.TaggedError<Conflict>()("SessionExternal.Conflict", { message: Schema.String }) {}
export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("SessionExternal.InvalidRequest", {
  message: Schema.String,
}) {}

const locks = KeyedMutex.makeUnsafe<string>()
type Binding = typeof SessionExternalTable.$inferSelect

export const make = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const sessions = yield* Session.Service
  const store = yield* SessionStore.Service
  const environments = yield* SessionEnvironment.Service
  const execution = yield* SessionExecution.Service
  const jobs = yield* Job.Service
  const restart = yield* SessionRestart.Service

  const decode = (request: SessionExternal.Request) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(SessionExternal.Body))(request.body, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new InvalidRequest({ message: "Invalid external session body" })))

  const checkSession = Effect.fnUntraced(function* (binding: Binding) {
    const session = yield* store.get(binding.session_id)
    if (
      session &&
      (session.metadata?.externalExecutionKey !== binding.key ||
        session.metadata.externalExecutionSha256 !== binding.body_sha256 ||
        session.environmentRequired !== true)
    )
      return yield* new Conflict({ message: "Session ID is not owned by this external execution" })
    return session
  })

  const reserve = Effect.fnUntraced(function* (request: SessionExternal.Request, body: SessionExternal.Body) {
    const digest = createHash("sha256").update(request.body, "utf8").digest("hex")
    return yield* db
      .transaction(() =>
        Effect.gen(function* () {
          const existing = yield* db
            .select()
            .from(SessionExternalTable)
            .where(eq(SessionExternalTable.key, request.key))
            .get()
            .pipe(Effect.orDie)
          if (existing) {
            if (existing.body_sha256 !== digest)
              return yield* new Conflict({ message: "Idempotency key is already bound to different request bytes" })
            yield* checkSession(existing)
            return existing
          }
          const collision = yield* db
            .select()
            .from(SessionExternalTable)
            .where(
              or(eq(SessionExternalTable.session_id, body.sessionID), eq(SessionExternalTable.input_id, body.inputID)),
            )
            .get()
            .pipe(Effect.orDie)
          if (collision || (yield* store.get(body.sessionID)))
            return yield* new Conflict({ message: "Reserved external identity is already in use" })
          const binding: Binding = {
            key: request.key,
            body_sha256: digest,
            owner: body.owner,
            session_id: body.sessionID,
            input_id: body.inputID,
            admitted: false,
            stop_requested: false,
          }
          yield* db.insert(SessionExternalTable).values(binding).run().pipe(Effect.orDie)
          return binding
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", () => new Conflict({ message: "Could not reserve external execution identity" })),
      )
  })

  const lineage = Effect.fnUntraced(function* (root: Session.ID) {
    const result: Session.ID[] = []
    const seen = new Set<Session.ID>()
    const visit = Effect.fnUntraced(function* (ids: Session.ID[]): Effect.fn.Return<void> {
      const fresh = ids.filter((id) => !seen.has(id))
      if (!fresh.length) return
      fresh.forEach((id) => seen.add(id))
      result.push(...fresh)
      const children = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(or(inArray(SessionTable.parent_id, fresh), inArray(SessionTable.fork_session_id, fresh)))
        .all()
        .pipe(Effect.orDie)
      yield* visit(children.map((child) => child.id))
    })
    if (yield* store.get(root)) yield* visit([root])
    return result
  })

  const receipt = Effect.fnUntraced(function* (binding: Binding): Effect.fn.Return<SessionExternal.Receipt> {
    const members = yield* lineage(binding.session_id)
    const infos = yield* Effect.forEach(members, (id) => sessions.get(id).pipe(Effect.orDie))
    const runningJobs = (yield* jobs.forSessions(new Set(members))).some((job) => job.status === "running")
    const observations = yield* Effect.forEach(members, (id) =>
      Effect.gen(function* () {
        const session = yield* store.get(id)
        const claim = yield* db
          .select({ suspended: SessionTable.time_suspended })
          .from(SessionTable)
          .where(eq(SessionTable.id, id))
          .get()
          .pipe(Effect.orDie)
        return {
          sessionID: id,
          active: yield* execution.isActive(id),
          pending: (yield* sessions.inbox(id).pipe(Effect.orDie)).length,
          suspended: claim?.suspended != null,
          ...(session?.outcome ? { outcome: session.outcome } : {}),
        }
      }),
    )
    const settled =
      !runningJobs &&
      observations.every((item) => !item.active && !item.pending && !item.suspended) &&
      (binding.stop_requested ||
        (binding.admitted && observations.length > 0 && observations.every((item) => item.outcome !== undefined)))
    const messages =
      settled && binding.admitted && infos.length ? yield* store.context(binding.session_id).pipe(Effect.orDie) : []
    const assistant = messages.findLast(
      (message) => message.type === "assistant" && message.time.completed !== undefined,
    )
    const result =
      settled && binding.admitted && infos.length
        ? {
            summary:
              assistant?.type === "assistant"
                ? assistant.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("")
                    .slice(0, 2000)
                : "",
            costUsd: infos.reduce((total, info) => total + info.cost, 0),
            tokens: infos.reduce(
              (total, info) => ({
                input: total.input + info.tokens.input,
                output: total.output + info.tokens.output,
                reasoning: total.reasoning + info.tokens.reasoning,
                cache: {
                  read: total.cache.read + info.tokens.cache.read,
                  write: total.cache.write + info.tokens.cache.write,
                },
              }),
              { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            ),
          }
        : undefined
    return {
      version: 1,
      key: binding.key,
      bodySha256: binding.body_sha256,
      backendID: environments.backendID,
      backendGeneration: environments.generation,
      sessionID: binding.session_id,
      inputID: binding.input_id,
      admitted: binding.admitted,
      stopRequested: binding.stop_requested,
      settled,
      lineage: observations,
      ...(result ? { result } : {}),
    }
  })

  const run = <A, E, R>(
    request: SessionExternal.Request,
    operation: (binding: Binding, body: SessionExternal.Body) => Effect.Effect<A, E, R>,
  ) =>
    locks.withLock(request.key)(
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(SessionExternal.Key)(request.key).pipe(
          Effect.mapError(() => new InvalidRequest({ message: "Invalid external execution key" })),
        )
        const body = yield* decode(request)
        if (body.backendID !== environments.backendID)
          return yield* new Conflict({ message: "External execution belongs to a different backend database" })
        return yield* operation(yield* reserve(request, body), body)
      }),
    )

  const admit = (request: SessionExternal.Request) =>
    run(request, (binding, body) =>
      Effect.gen(function* () {
        if (binding.stop_requested || binding.admitted) return yield* receipt(binding)
        const session = yield* sessions
          .create({
            id: body.sessionID,
            location: body.location,
            environmentRequired: true,
            title: body.title,
            agent: body.agent,
            model: body.model,
            permissions: body.permissions,
            metadata: {
              externalExecutionKey: binding.key,
              externalExecutionSha256: binding.body_sha256,
              externalOwner: body.owner,
            },
          })
          .pipe(Effect.orDie)
        yield* checkSession(binding)
        yield* sessions.prompt({ sessionID: session.id, id: body.inputID, ...body.prompt, resume: false }).pipe(
          Effect.catchTag(
            "Session.NotFoundError",
            () => new Conflict({ message: "Owned session disappeared during admission" }),
          ),
          Effect.catchTag(
            "Session.PromptConflictError",
            () => new Conflict({ message: "External input identity is already in use" }),
          ),
          Effect.catchTag(
            "Session.AttachmentError",
            () => new InvalidRequest({ message: "Invalid external prompt attachment" }),
          ),
          Effect.catchTag(
            "Session.SkillNotFoundError",
            () => new InvalidRequest({ message: "External prompt skill not found" }),
          ),
        )
        yield* db
          .update(SessionExternalTable)
          .set({ admitted: true })
          .where(eq(SessionExternalTable.key, binding.key))
          .run()
          .pipe(Effect.orDie)
        return yield* receipt({ ...binding, admitted: true })
      }),
    )

  const stop = (request: SessionExternal.Request) =>
    run(request, (binding) =>
      Effect.gen(function* () {
        // Persist first. A process death during cancellation must never turn a retry into fresh admission.
        yield* db
          .update(SessionExternalTable)
          .set({ stop_requested: true })
          .where(eq(SessionExternalTable.key, binding.key))
          .run()
          .pipe(Effect.orDie)
        yield* environments.clear(binding.session_id)
        const settled = new Set<Session.ID>()
        const cancel = Effect.fnUntraced(function* (): Effect.fn.Return<void> {
          const members = yield* lineage(binding.session_id)
          const fresh = members.filter((id) => !settled.has(id))
          yield* Effect.forEach(
            fresh,
            (id) =>
              Effect.gen(function* () {
                yield* execution.interrupt(id, { awaitSettlement: true })
                yield* execution.awaitIdle(id)
              }),
            { concurrency: "unbounded", discard: true },
          )
          const owned = new Set(members)
          yield* Effect.forEach(yield* jobs.forSessions(owned), (job) => jobs.cancel(job.id), { discard: true })
          yield* Effect.forEach(
            yield* jobs.pendingBackground,
            (background) =>
              Effect.gen(function* () {
                const recovery = background.recovery
                if (
                  !(recovery.kind === "shell"
                    ? owned.has(recovery.sessionID)
                    : owned.has(recovery.parentSessionID) || owned.has(recovery.childSessionID))
                )
                  return
                yield* jobs.cancel(background.id)
                yield* jobs.completeBackground(background.notificationID)
              }),
            { discard: true },
          )
          yield* Effect.forEach(
            members,
            (id) =>
              Effect.gen(function* () {
                yield* Effect.forEach(
                  yield* sessions.inbox(id).pipe(Effect.orDie),
                  (item) =>
                    sessions.cancelInbox({ sessionID: id, inboxID: item.id }).pipe(
                      Effect.catchTag("Session.InboxConflictError", () => Effect.void),
                      Effect.orDie,
                    ),
                  { discard: true },
                )
                yield* store.release(id)
                yield* environments.clear(id)
              }),
            { discard: true },
          )
          fresh.forEach((id) => settled.add(id))
          // A running parent can create a child before its interruption settles. Discover that child before acknowledging Stop.
          if ((yield* lineage(binding.session_id)).some((id) => !settled.has(id))) yield* cancel()
        })
        yield* cancel()
        return yield* receipt({ ...binding, stop_requested: true })
      }),
    )

  const status = (request: SessionExternal.Request) => run(request, receipt)
  const resume = (request: SessionExternal.Request & { readonly backendGeneration: string }) =>
    run(request, (binding, body) =>
      Effect.gen(function* () {
        if (binding.stop_requested) return yield* receipt(binding)
        if (!binding.admitted || !(yield* checkSession(binding)))
          return yield* new Conflict({ message: "External execution has not been admitted" })
        if (!(yield* environments.restore(binding.session_id, body.environment, request.backendGeneration)))
          return yield* new Conflict({ message: "Backend process generation changed; reconcile before resuming" })
        const members = yield* lineage(binding.session_id)
        yield* restart.resumeSessions(new Set(members))
        yield* Effect.forEach(
          members,
          (id) =>
            execution.wake(id).pipe(
              Effect.when(
                sessions.inbox(id).pipe(
                  Effect.map((items) => items.length > 0),
                  Effect.orDie,
                ),
              ),
            ),
          { discard: true },
        )
        return yield* receipt(binding)
      }),
    )
  const info = Effect.succeed<SessionExternal.Backend>({
    version: 1,
    backendID: environments.backendID,
    backendGeneration: environments.generation,
  })
  return { admit, stop, status, resume, info }
})

export type Interface = Effect.Success<typeof make>
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionExternal") {}
export const node = makeGlobalNode({
  service: Service,
  layer: Layer.effect(Service, make),
  deps: [
    Database.node,
    Session.node,
    SessionStore.node,
    SessionEnvironment.node,
    SessionExecution.node,
    SessionRestart.node,
    Job.node,
  ],
})
