/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { SDKProvider, useSDK } from "../../src/context/sdk"
import { createEventSource } from "../fixture/tui-sdk"
import { wait } from "../cli/cmd/tui/sync-fixture"

test.each([false, true])(
  "subscriber failure preserves delivery and requests reconciliation (batched=%s)",
  async (batched) => {
    const events = createEventSource()
    const seen: string[] = []
    let recovery = 0
    const log = spyOn(console, "error").mockImplementation(() => {})
    function Probe() {
      const sdk = useSDK()
      sdk.onResync(() => recovery++)
      sdk.event.on("event", (event) => {
        if (event.payload.id === "bad") throw new Error("private payload must not be logged")
      })
      sdk.event.on("event", (event) => seen.push(event.payload.id!))
      return <box />
    }
    const app = await testRender(() => (
      <SDKProvider url="http://test" events={events.source}>
        <Probe />
      </SDKProvider>
    ))
    try {
      const emit = (id: string) =>
        events.emit({ directory: "global", payload: { id, type: "vcs.branch.updated", properties: { branch: id } } })
      if (batched) emit("warmup")
      emit("bad")
      emit("good")
      await wait(() => seen.includes("good"))
      expect(seen).toEqual(batched ? ["warmup", "bad", "good"] : ["bad", "good"])
      expect(recovery).toBe(1)
      expect(JSON.stringify(log.mock.calls)).not.toContain("private payload")
    } finally {
      app.renderer.destroy()
      log.mockRestore()
    }
  },
)

test("SSE reconnects after EOF and transport errors, reconciles, and stops on disposal", async () => {
  const connected = `data: ${JSON.stringify({ directory: "global", payload: { id: "connected", type: "server.connected", properties: {} } })}\n\n`
  let calls = 0
  let recovery = 0
  let sdk!: ReturnType<typeof useSDK>
  let close!: () => void
  function Probe() {
    sdk = useSDK()
    sdk.onResync(() => recovery++)
    return <box />
  }
  const app = await testRender(() => (
    <SDKProvider
      url="http://test"
      fetch={
        (async (input) => {
          const request = input as Request
          calls++
          if (calls === 1) throw new Error("offline")
          return new Response(
            new ReadableStream({
              start(controller) {
                const done = () => {
                  request.signal.removeEventListener("abort", done)
                  controller.close()
                }
                close = done
                controller.enqueue(new TextEncoder().encode(connected))
                request.signal.addEventListener("abort", done, { once: true })
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        }) as typeof fetch
      }
    >
      <Probe />
    </SDKProvider>
  ))
  try {
    await wait(() => calls === 2 && sdk.connected, 4000)
    expect(recovery).toBe(0)
    close()
    await wait(() => calls === 3 && sdk.connected, 4000)
    expect(recovery).toBe(1)
  } finally {
    app.renderer.destroy()
  }
  const stopped = calls
  await Bun.sleep(1100)
  expect(calls).toBe(stopped)
})
