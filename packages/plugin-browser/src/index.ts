import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema } from "effect"
import { BrowserConnection } from "./connection.js"
import { BrowserTools } from "./tools.js"
import { BrowserHost } from "./host.js"

export default Plugin.define({
  id: "opencode.browser",
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = yield* Schema.decodeUnknownEffect(Schema.Struct({ host: Schema.optional(BrowserHost.Options) }))(
        ctx.options,
      )
      const connection = yield* BrowserConnection.make(ctx, options.host)
      yield* BrowserTools.register(ctx, connection, options.host?.operations)
    }).pipe(Effect.orDie),
})
