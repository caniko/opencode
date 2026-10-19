import { Service } from "@opencode/client/effect/service"
import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"

export default Runtime.handler(
  Commands.commands.service.commands.wait,
  Effect.fn("cli.service.wait")(function* (input) {
    yield* Service.wait({
      ...(yield* ServiceConfig.options({ checkVersion: true })),
      pid: input.pid,
      timeout: input.timeout * 1_000,
    })
  }),
)
