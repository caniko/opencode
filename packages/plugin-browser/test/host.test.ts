import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { Effect, Schema } from "effect"
import { Session } from "@opencode/schema/session"
import { BrowserHost } from "../src/host.js"
import { Browser } from "../src/rpc.js"

const fixture = fileURLToPath(new URL("./fixtures/host.ts", import.meta.url))
const options = {
  command: [process.execPath, fixture],
  operations: ["tabs.list", "evaluate"],
} satisfies BrowserHost.Options
const inventory = { action: { type: "tabs.list" }, files: [] } satisfies Browser.Command

test("terminal host dispatches correlated native commands and decodes results", async () => {
  const host = await BrowserHost.start(options, process.cwd())
  try {
    const results = await Promise.all(
      Array.from({ length: 3 }, () => host.request(inventory, new AbortController().signal)),
    )
    const states = results.map((result) => Schema.decodeUnknownSync(Browser.State)(result.value))
    expect(states[0]?.tabs[0]?.id).toMatch(/^tab_/)
    expect(states[1]).toEqual(states[0])
    expect(states[2]).toEqual(states[0])
  } finally {
    await host.close()
  }
})

test("terminal host rejects capability mismatch before accepting commands", async () => {
  await expect(
    BrowserHost.start({ ...options, command: [...options.command, "mismatch"] }, process.cwd()),
  ).rejects.toThrow("capabilities")
})

test("malformed protocol messages close the connection without replay", async () => {
  const host = await BrowserHost.start(options, process.cwd())
  try {
    const state = Schema.decodeUnknownSync(Browser.State)(
      (await host.request(inventory, new AbortController().signal)).value,
    )
    const command = {
      action: { type: "evaluate", tabID: state.tabs[0]!.id, script: "malformed" },
      files: [],
    } satisfies Browser.Command
    await expect(host.request(command, new AbortController().signal)).rejects.toThrow("invalid protocol")
    expect(host.disconnected).toBe(true)
    await expect(host.request(command, new AbortController().signal)).rejects.toThrow()
  } finally {
    await host.close()
  }
})

test("cancellation terminates an owned host and rejects pending work", async () => {
  const host = await BrowserHost.start(options, process.cwd())
  const signal = new AbortController()
  try {
    const state = Schema.decodeUnknownSync(Browser.State)((await host.request(inventory, signal.signal)).value)
    const result = host.request(
      { action: { type: "evaluate", tabID: state.tabs[0]!.id, script: "hang" }, files: [] },
      signal.signal,
    )
    signal.abort()
    await expect(result).rejects.toThrow("cancelled")
    expect(host.disconnected).toBe(true)
  } finally {
    await host.close()
  }
})

test("sessions have separate hosts and foreign tab IDs are rejected", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* BrowserHost.make(options, process.cwd())
        const first = Session.ID.make("ses_first")
        const second = Session.ID.make("ses_second")
        const target = yield* host.target(first, inventory.action)
        const state = Schema.decodeUnknownSync(Browser.State)((yield* target.request([])).value)
        const other = yield* host.target(second, inventory.action)
        const otherState = Schema.decodeUnknownSync(Browser.State)((yield* other.request([])).value)
        expect(otherState.tabs[0]!.id).not.toBe(state.tabs[0]!.id)
        const error = yield* host
          .target(second, { type: "evaluate", tabID: state.tabs[0]!.id, script: "1" })
          .pipe(Effect.flip)
        expect(error.message).toContain("does not belong")
      }),
    ),
  )
})
