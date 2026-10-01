import { createInterface } from "node:readline"
import { Schema } from "effect"
import { Browser } from "../../src/rpc.js"

const id = `tab_${crypto.randomUUID()}`
const tab = {
  id,
  url: "about:blank",
  title: "Fixture",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  generation: 1,
}
const operations = process.argv[2] === "mismatch" ? ["navigate"] : ["tabs.list", "evaluate"]
console.log(JSON.stringify({ type: "ready", version: 1, operations }))
const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, command: Browser.Command })),
)

for await (const line of createInterface({ input: process.stdin })) {
  const input = decode(line)
  if (input.command.action.type === "evaluate" && input.command.action.script === "hang") continue
  if (input.command.action.type === "evaluate" && input.command.action.script === "malformed") {
    console.log("not-json")
    continue
  }
  console.log(
    JSON.stringify({
      id: input.id,
      outcome: {
        type: "success",
        result: {
          value:
            input.command.action.type === "tabs.list" ? { tabs: [tab], focusedTabID: id } : { tab, value: "fixture" },
          files: [],
        },
      },
    }),
  )
}
