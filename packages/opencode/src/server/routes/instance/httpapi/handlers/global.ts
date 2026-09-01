import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Database } from "@opencode-ai/core/database/database"
import { ProcessGovernor } from "@opencode-ai/core/process-governor"
import { InstanceStore } from "@/project/instance-store"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { sql } from "drizzle-orm"
import { stat } from "node:fs/promises"
import { Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { IncomingMessage } from "node:http"
import { RootHttpApi } from "../api"
import { GlobalUpgradeInput } from "../groups/global"

let attachedSessions = 0

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function connectionClosed(request: HttpServerRequest.HttpServerRequest) {
  const source = request.source
  if (source instanceof Request) {
    return Effect.callback<void>((resume) => {
      if (source.signal.aborted) {
        resume(Effect.void)
        return
      }
      const close = () => resume(Effect.void)
      source.signal.addEventListener("abort", close, { once: true })
      return Effect.sync(() => source.signal.removeEventListener("abort", close))
    })
  }
  if (!(source instanceof IncomingMessage)) return Effect.never
  return Effect.callback<void>((resume) => {
    if (source.socket.destroyed) {
      resume(Effect.void)
      return
    }
    const close = () => resume(Effect.void)
    source.socket.once("close", close)
    return Effect.sync(() => source.socket.off("close", close))
  })
}

function eventResponse() {
  return Effect.gen(function* () {
    let attached = false
    const request = yield* HttpServerRequest.HttpServerRequest
    const events = Stream.callback<GlobalBusEvent>((queue) => {
      const handler = (event: GlobalBusEvent) => Queue.offerUnsafe(queue, event)
      return Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", handler)),
        () => Effect.sync(() => GlobalBus.off("event", handler)),
      )
    })
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
    )

    return HttpServerResponse.stream(
      Stream.make({ payload: { id: EventV2.ID.create(), type: "server.connected", properties: {} } }).pipe(
        Stream.tap(() =>
          Effect.sync(() => {
            attached = true
            attachedSessions++
          }).pipe(Effect.andThen(Effect.logInfo("global event connected"))),
        ),
        Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(
          Effect.sync(() => {
            if (!attached) return
            attached = false
            attachedSessions--
          }).pipe(Effect.andThen(Effect.logInfo("global event disconnected"))),
        ),
        Stream.merge(Stream.fromEffect(connectionClosed(request)).pipe(Stream.drain), { haltStrategy: "right" }),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const database = yield* Database.Service
    const instances = yield* InstanceStore.Service
    const bridge = yield* EffectBridge.make()

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      const counts = yield* database.db
        .get<{ sessions: number; messages: number; parts: number; events: number }>(
          sql`
          SELECT
            (SELECT count(*) FROM session) AS sessions,
            (SELECT count(*) FROM message) + (SELECT count(*) FROM session_message) AS messages,
            (SELECT count(*) FROM part) AS parts,
            (SELECT count(*) FROM event) AS events
        `,
        )
        .pipe(Effect.orDie)
      const databasePath = Database.path()
      const bytes =
        databasePath === ":memory:"
          ? 0
          : yield* Effect.promise(() =>
              Promise.all(
                [databasePath, `${databasePath}-wal`].map((file) =>
                  stat(file).then(
                    (info) => info.size,
                    () => 0,
                  ),
                ),
              ).then((sizes) => sizes.reduce((total, size) => total + size, 0)),
            )
      return {
        healthy: true as const,
        version: InstallationVersion,
        runtime: {
          attachedSessions,
          ...(yield* instances.status()),
          tools: yield* ProcessGovernor.status().pipe(Effect.orDie),
          rejectedCompactions: SessionCompaction.rejectedCount(),
          database: {
            bytes,
            sessions: counts?.sessions ?? 0,
            messages: counts?.messages ?? 0,
            parts: counts?.parts ?? 0,
            events: counts?.events ?? 0,
          },
        },
      }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return yield* eventResponse()
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return HttpServerResponse.jsonUnsafe(
          { success: false as const, error: "Unknown installation method" },
          { status: 400 },
        )
      }
      const target = ctx.payload.target
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ success: true as const, version: target }),
        Effect.catch((err) =>
          Effect.succeed({
            success: false as const,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      )
      if (!result.success) return HttpServerResponse.jsonUnsafe(result, { status: 500 })
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return HttpServerResponse.jsonUnsafe(result)
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handle("upgrade", upgrade)
  }),
)
