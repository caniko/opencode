export * as SessionEnvironment from "./environment.js"

import { Context, Effect, Layer, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Database } from "../database/database.js"
import { KVTable } from "../kv/sql.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"
import { SessionExternalTable } from "./sql.js"

export type Variables = Readonly<Record<string, string>>

export interface Interface {
  readonly backendID: string
  readonly generation: string
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<Variables | undefined>
  readonly set: (sessionID: SessionSchema.ID, variables: Variables) => Effect.Effect<void>
  readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly ready: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Reconciled external ownership is valid only for this backend process generation. */
  readonly restore: (sessionID: SessionSchema.ID, variables: Variables, generation: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionEnvironment") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const db = (yield* Database.Service).db
    const generation = randomUUID()
    yield* db
      .insert(KVTable)
      .values({ key: "session.external.backend", value: randomUUID() })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const identity = yield* db
      .select()
      .from(KVTable)
      .where(eq(KVTable.key, "session.external.backend"))
      .get()
      .pipe(Effect.orDie)
    const backendID = yield* Schema.decodeUnknownEffect(Schema.String)(identity?.value).pipe(Effect.orDie)
    const authorized = new Set<SessionSchema.ID>()
    const environments = new Map<SessionSchema.ID, Variables>()
    const get = Effect.fn("SessionEnvironment.get")(function* (
      sessionID: SessionSchema.ID,
    ): Effect.fn.Return<Variables | undefined> {
      const session = yield* store.get(sessionID)
      const parentID = session?.parentID ?? (session?.environmentRequired ? session.fork?.sessionID : undefined)
      if (parentID && session?.environmentRequired && (yield* store.get(parentID))?.environmentRequired)
        return yield* get(parentID)
      const variables = environments.get(sessionID)
      if (variables !== undefined) return variables
      return parentID ? yield* get(parentID) : undefined
    })
    const ready = Effect.fn("SessionEnvironment.ready")(function* (
      sessionID: SessionSchema.ID,
    ): Effect.fn.Return<boolean> {
      const session = yield* store.get(sessionID)
      if (session?.environmentRequired !== true) return true
      const parentID = session.parentID ?? session.fork?.sessionID
      if (parentID && (yield* store.get(parentID))?.environmentRequired === true) return yield* ready(parentID)
      const external = yield* db
        .select()
        .from(SessionExternalTable)
        .where(eq(SessionExternalTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (external && (external.stop_requested || !authorized.has(sessionID))) return false
      return (yield* get(sessionID)) !== undefined
    })

    return Service.of({
      backendID,
      generation,
      get,
      ready,
      restore: (sessionID, variables, expected) =>
        Effect.sync(() => {
          if (expected !== generation) return false
          environments.set(sessionID, { ...variables })
          authorized.add(sessionID)
          return true
        }),
      set: (sessionID, variables) =>
        Effect.sync(() => {
          environments.set(sessionID, { ...variables })
          authorized.delete(sessionID)
        }),
      clear: (sessionID) =>
        Effect.sync(() => {
          environments.delete(sessionID)
          authorized.delete(sessionID)
        }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [SessionStore.node, Database.node] })
