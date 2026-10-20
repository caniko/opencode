import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import path from "path"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { SessionExternal } from "@opencode/core/session/external"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionEvent } from "@opencode/core/session/event"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { SessionEnvironment } from "@opencode/core/session/environment"
import { SessionStore } from "@opencode/core/session/store"
import { Job } from "@opencode/core/job"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Project } from "@opencode/core/project"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { AbsolutePath } from "@opencode/core/schema"
import { globalProjectNode } from "./lib/project"
import { promptLocationNode } from "./fixture/prompt-location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      SessionEnvironment.node,
      SessionStore.node,
      Job.node,
      Database.node,
      Bus.node,
      SessionRestart.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(promptLocationNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)
const request = (suffix: string, backendID: string) => ({
  key: `paperclip:${suffix}`,
  body: JSON.stringify({
    version: 1,
    backendID,
    owner: "paperclip:company:agent",
    sessionID: `ses_external_${suffix}`,
    inputID: `msg_external_${suffix}`,
    location: { directory: "/project" },
    prompt: { text: "Only owned work" },
    environment: { PAPERCLIP_RUN_ID: suffix },
  }),
})

describe("SessionExternal", () => {
  it.effect("persists Stop-before-admit as a digest-bound tombstone without creating a session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const external = yield* SessionExternal.make.pipe(Effect.provide(SessionExecution.noopLayer))
      const input = request("stopped", (yield* external.info).backendID)
      const stopped = yield* external.stop(input)
      expect(stopped).toMatchObject({
        stopRequested: true,
        settled: true,
        sessionID: "ses_external_stopped",
        lineage: [],
      })
      expect(yield* external.admit(input)).toEqual(stopped)
      expect(yield* sessions.get(Session.ID.make("ses_external_stopped")).pipe(Effect.option)).toMatchObject({
        _tag: "None",
      })
      expect(yield* external.admit({ ...input, body: input.body + " " }).pipe(Effect.flip)).toBeInstanceOf(
        SessionExternal.Conflict,
      )
      const restarted = yield* SessionExternal.make.pipe(Effect.provide(SessionExecution.noopLayer))
      expect(yield* restarted.stop(input)).toEqual(stopped)
    }),
  )

  it.effect("cancels pending owned inputs and descendants while preserving a populated backend", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const external = yield* SessionExternal.make.pipe(Effect.provide(SessionExecution.noopLayer))
      const personal = yield* sessions.create({ location: { directory: AbsolutePath.make("/personal") } })
      yield* sessions.prompt({ sessionID: personal.id, text: "Unrelated input", resume: false })
      const input = request("pending", (yield* external.info).backendID)
      const admitted = yield* external.admit(input)
      const root = Session.ID.make(admitted.sessionID)
      const child = yield* sessions.create({ parentID: root })
      yield* sessions.prompt({ sessionID: child.id, text: "Owned child input", resume: false })
      expect((yield* sessions.inbox(root)).map((item) => item.id)).toEqual([
        SessionMessage.ID.make("msg_external_pending"),
      ])
      const stop = yield* external.stop(input)
      expect(stop.stopRequested && stop.settled).toBe(true)
      expect(stop.lineage.map((item) => item.sessionID).toSorted()).toEqual([root, child.id].toSorted())
      expect(yield* sessions.inbox(root)).toEqual([])
      expect(yield* sessions.inbox(child.id)).toEqual([])
      expect(yield* sessions.inbox(personal.id)).toHaveLength(1)
      expect(yield* external.admit(input)).toEqual(stop)
    }),
  )

  it.effect("rejects a reserved ID collision without stopping or rebinding a personal session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const external = yield* SessionExternal.make.pipe(Effect.provide(SessionExecution.noopLayer))
      const input = request("collision", (yield* external.info).backendID)
      yield* sessions.create({
        id: Session.ID.make("ses_external_collision"),
        location: { directory: AbsolutePath.make("/personal") },
      })
      expect(yield* external.admit(input).pipe(Effect.flip)).toBeInstanceOf(SessionExternal.Conflict)
      expect(yield* external.stop(input).pipe(Effect.flip)).toBeInstanceOf(SessionExternal.Conflict)
      expect((yield* sessions.get(Session.ID.make("ses_external_collision"))).location.directory).toBe(
        AbsolutePath.make("/personal"),
      )
    }),
  )

  it.effect("requires current-generation reconciliation and keeps a durable Stop closed after service recreation", () =>
    Effect.gen(function* () {
      const environments = yield* SessionEnvironment.Service
      const external = yield* SessionExternal.make.pipe(Effect.provide(SessionExecution.noopLayer))
      const input = request("generation", (yield* external.info).backendID)
      const admitted = yield* external.admit(input)
      const root = admitted.sessionID
      yield* environments.set(root, { PAPERCLIP_RUN_ID: "unreconciled" })
      expect(yield* environments.ready(root)).toBe(false)
      expect(
        yield* external.resume({ ...input, backendGeneration: "previous-process" }).pipe(Effect.flip),
      ).toBeInstanceOf(SessionExternal.Conflict)
      yield* external.resume({ ...input, backendGeneration: admitted.backendGeneration })
      expect(yield* environments.ready(root)).toBe(true)
      const successor = yield* Layer.build(Layer.fresh(SessionEnvironment.layer))
      const next = Context.get(successor, SessionEnvironment.Service)
      expect(next.generation).not.toBe(admitted.backendGeneration)
      expect(next.backendID).toBe(admitted.backendID)
      expect(yield* next.ready(root)).toBe(false)
      yield* external.stop(input)
      yield* environments.restore(root, { PAPERCLIP_RUN_ID: "generation" }, admitted.backendGeneration)
      expect(yield* environments.ready(root)).toBe(false)
      expect((yield* external.resume({ ...input, backendGeneration: admitted.backendGeneration })).stopRequested).toBe(
        true,
      )
    }),
  )

  it.effect("restores managed ownership, pending work, claims and Stop from complete SQLite backups", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const store = yield* SessionStore.Service
      const jobs = yield* Job.Service
      const db = (yield* Database.Service).db
      const external = yield* SessionExternal.make.pipe(Effect.provide(SessionExecution.noopLayer))
      const original = request("backup", (yield* external.info).backendID)
      const input = { ...original, body: original.body + "\n\t" }
      const admitted = yield* external.admit(input)
      const root = admitted.sessionID
      const child = yield* sessions.create({ parentID: root })
      yield* sessions.prompt({ sessionID: child.id, text: "Pending child input", resume: false })
      yield* store.claim(root)
      yield* store.claim(child.id)
      const personal = yield* sessions.create({ location: { directory: AbsolutePath.make("/personal-backup") } })
      yield* sessions.prompt({ sessionID: personal.id, text: "Personal pending input", resume: false })
      const notificationID = SessionMessage.ID.make("msg_external_backup_job")
      const job = yield* jobs.start({
        type: "shell",
        notificationID,
        recovery: { kind: "shell", sessionID: child.id, shellID: "backup-shell", command: "fixture" },
        run: Effect.never,
      })
      yield* jobs.background(job.id)
      const stopped = request("backup-stopped", admitted.backendID)
      yield* external.stop(stopped)
      const tmp = yield* tmpdirScoped()
      const snapshot = path.join(tmp.path, "active.sqlite")
      const stoppedSnapshot = path.join(tmp.path, "stopped.sqlite")
      yield* db.run(sql`VACUUM INTO ${snapshot}`).pipe(Effect.orDie)
      const restoredLayer = (filename: string) =>
        AppNodeBuilder.build(
          LayerNode.group([
            Session.node,
            SessionEnvironment.node,
            SessionStore.node,
            Job.node,
            Database.node,
            Bus.node,
            SessionRestart.node,
          ]),
          [
            Database.node.replace(Database.configured({ path: filename })),
            Bus.node.replace(Bus.configured({ persist: true })),
            Project.node.replace(globalProjectNode),
            LocationServiceMap.node.replace(promptLocationNode),
            SessionExecution.node.replace(SessionExecution.noopLayer),
          ],
        ).pipe(Layer.fresh)

      yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        const store = yield* SessionStore.Service
        const jobs = yield* Job.Service
        const environments = yield* SessionEnvironment.Service
        const db = (yield* Database.Service).db
        const external = yield* SessionExternal.make.pipe(Effect.provide(SessionExecution.noopLayer))
        const backend = yield* external.info
        expect(backend.backendID).toBe(admitted.backendID)
        expect(backend.backendGeneration).not.toBe(admitted.backendGeneration)
        expect(yield* environments.ready(root)).toBe(false)
        expect(yield* environments.ready(child.id)).toBe(false)
        expect(yield* store.listSuspended()).toContain(root)
        expect(yield* jobs.pendingBackground).toMatchObject([
          { id: job.id, notificationID, status: "running", recovery: { sessionID: child.id } },
        ])
        const status = yield* external.status(input)
        expect(status).toMatchObject({ admitted: true, settled: false, bodySha256: admitted.bodySha256 })
        expect(status.lineage).toEqual([
          { sessionID: root, active: false, pending: 1, suspended: true },
          { sessionID: child.id, active: false, pending: 1, suspended: true },
        ])
        expect((yield* sessions.inbox(root)).map((item) => item.id)).toEqual([admitted.inputID])
        expect(yield* external.admit(input)).toEqual(status)
        expect(yield* sessions.inbox(root)).toHaveLength(1)
        expect(yield* external.admit(original).pipe(Effect.flip)).toBeInstanceOf(SessionExternal.Conflict)
        expect(
          yield* external.resume({ ...input, backendGeneration: admitted.backendGeneration }).pipe(Effect.flip),
        ).toBeInstanceOf(SessionExternal.Conflict)
        expect(yield* environments.ready(root)).toBe(false)
        expect(yield* external.admit(stopped)).toMatchObject({ admitted: false, stopRequested: true, settled: true })
        const stop = yield* external.stop(input)
        expect(stop).toMatchObject({ stopRequested: true, settled: true })
        expect(yield* sessions.inbox(root)).toEqual([])
        expect(yield* sessions.inbox(child.id)).toEqual([])
        expect(yield* store.listSuspended()).toEqual([])
        expect(yield* jobs.pendingBackground).toEqual([])
        expect(yield* sessions.inbox(personal.id)).toHaveLength(1)
        yield* db.run(sql`VACUUM INTO ${stoppedSnapshot}`).pipe(Effect.orDie)
      }).pipe(Effect.provide(restoredLayer(snapshot)))

      yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        const environments = yield* SessionEnvironment.Service
        const external = yield* SessionExternal.make.pipe(Effect.provide(SessionExecution.noopLayer))
        const backend = yield* external.info
        expect(backend.backendID).toBe(admitted.backendID)
        const stop = yield* external.resume({ ...input, backendGeneration: backend.backendGeneration })
        expect(stop).toMatchObject({ admitted: true, stopRequested: true, settled: true })
        expect(yield* external.admit(input)).toEqual(stop)
        expect(yield* environments.ready(root)).toBe(false)
        expect(yield* environments.ready(child.id)).toBe(false)
        expect(yield* sessions.inbox(root)).toEqual([])
        expect(yield* sessions.inbox(child.id)).toEqual([])
        expect(yield* sessions.inbox(personal.id)).toHaveLength(1)
      }).pipe(Effect.provide(restoredLayer(stoppedSnapshot)))
    }),
  )

  it.effect("refuses an exact request addressed to another durable backend", () =>
    Effect.gen(function* () {
      const external = yield* SessionExternal.make.pipe(Effect.provide(SessionExecution.noopLayer))
      const sessions = yield* Session.Service
      const input = request("wrong_backend", (yield* external.info).backendID)
      const wrong = { ...input, body: JSON.stringify({ ...JSON.parse(input.body), backendID: "another-database" }) }
      expect(yield* external.admit(wrong).pipe(Effect.flip)).toBeInstanceOf(SessionExternal.Conflict)
      expect(yield* external.stop(wrong).pipe(Effect.flip)).toBeInstanceOf(SessionExternal.Conflict)
      expect(yield* sessions.get(Session.ID.make("ses_external_wrong_backend")).pipe(Effect.option)).toMatchObject({
        _tag: "None",
      })
    }),
  )

  it.effect("settles owned background jobs and forked sessions without cancelling a personal job", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* Job.Service
      const external = yield* SessionExternal.make.pipe(Effect.provide(SessionExecution.noopLayer))
      const input = request("jobs", (yield* external.info).backendID)
      const admitted = yield* external.admit(input)
      const root = admitted.sessionID
      yield* sessions.synthetic({ sessionID: root, text: "Fork boundary", resume: false })
      // A delivered message is required by the production fork API.
      const bus = yield* Bus.Service
      yield* bus.publish(SessionEvent.Synthetic, { sessionID: root, text: "Delivered fork boundary" })
      const fork = yield* sessions.fork({ sessionID: root })
      yield* sessions.prompt({ sessionID: fork.id, text: "Fork input", resume: false })
      const stopped = yield* Deferred.make<void>()
      const owned = yield* jobs.start({
        type: "shell",
        recovery: { kind: "shell", sessionID: fork.id, shellID: "owned", command: "fixture" },
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
      })
      yield* jobs.background(owned.id)
      const personal = yield* sessions.create({ location: { directory: AbsolutePath.make("/personal-job") } })
      const unrelated = yield* jobs.start({
        type: "shell",
        recovery: { kind: "shell", sessionID: personal.id, shellID: "personal", command: "fixture" },
        run: Effect.never,
      })
      const stop = yield* external.stop(input)
      expect(stop.settled).toBe(true)
      expect(stop.lineage.map((item) => item.sessionID)).toContain(fork.id)
      expect(yield* Deferred.isDone(stopped)).toBe(true)
      expect((yield* jobs.get(unrelated.id))?.status).toBe("running")
      expect(yield* sessions.inbox(fork.id)).toEqual([])
      yield* jobs.cancel(unrelated.id)
    }),
  )
})
