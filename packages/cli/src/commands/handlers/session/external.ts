import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { SessionExternal } from "@opencode/schema/session-external"
import { Effect, Schema } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"
import { readStdin } from "../../../util/io"

const Resume = Schema.Struct({ ...SessionExternal.Request.fields, backendGeneration: Schema.String })

export default Runtime.handler(
  Commands.commands.session.commands.external,
  Effect.fn("cli.session.external")(function* (input) {
    // Discovery never spawns, stops, or replaces the user's shared backend.
    const options = yield* ServiceConfig.options({ checkVersion: true })
    const endpoint = yield* Service.discover(options)
    if (!endpoint) return yield* Effect.fail(new Error("No compatible managed OpenCode backend is ready"))
    const url = new URL(endpoint.url)
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) || !endpoint.auth)
      return yield* Effect.fail(new Error("External execution requires a private loopback backend registration"))
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    if (input.operation === "info") {
      const info = yield* Effect.tryPromise({
        try: (signal) => client.session.external.info({ signal }),
        catch: () => new Error("External session backend identity is unavailable"),
      })
      process.stdout.write(JSON.stringify(info) + "\n")
      return
    }
    const body = yield* Effect.tryPromise(readStdin)
    const operation = input.operation
    const invoke =
      operation === "resume"
        ? Schema.decodeUnknownEffect(Schema.fromJsonString(Resume))(body).pipe(
            Effect.flatMap((request) =>
              Effect.tryPromise((signal) => client.session.external.resume(request, { signal })),
            ),
          )
        : Schema.decodeUnknownEffect(Schema.fromJsonString(SessionExternal.Request))(body).pipe(
            Effect.flatMap((request) =>
              Effect.tryPromise((signal) => client.session.external[operation](request, { signal })),
            ),
          )
    const result = yield* invoke.pipe(
      Effect.mapError(
        () =>
          // Request bodies contain credentials. Keep SDK/transport error objects out of logs.
          new Error("External session control failed; reconcile the original request before retrying"),
      ),
    )
    process.stdout.write(JSON.stringify(result) + "\n")
  }),
)
