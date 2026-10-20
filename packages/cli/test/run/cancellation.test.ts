import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { OpenCode } from "@opencode/client/promise"
import { admissionGrace, runNonInteractivePrompt } from "../../src/run/noninteractive"

afterEach(() => mock.restore())

for (const failure of ["accepted", "admission", "interrupt", "wait"] as const) {
  test(`SIGINT awaits session cleanup after ${failure}`, async () => {
    const client = OpenCode.make({ baseUrl: "https://opencode.test" })
    const idle = Promise.withResolvers<void>()
    const requested = Promise.withResolvers<void>()
    const originalExitCode = process.exitCode
    const output: string[] = []
    spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk))
      return true
    })
    let returned = false
    spyOn(client.event, "subscribe").mockImplementation(({ signal } = {}) =>
      (async function* () {
        yield { id: "evt_connected", type: "server.connected" as const, data: {} }
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve()
          signal?.addEventListener("abort", () => resolve(), { once: true })
        })
      })(),
    )
    const interrupt = spyOn(client.session, "interrupt").mockImplementation(async () => {
      if (failure === "interrupt") throw new Error("interrupt unavailable")
      return { interrupted: true }
    })
    const wait = spyOn(client.session, "wait").mockImplementation(() => idle.promise)
    spyOn(client.permission, "list").mockResolvedValue([])
    spyOn(client.session.form, "list").mockResolvedValue([])
    spyOn(client.message, "list").mockResolvedValue({ data: [], cursor: {} })
    spyOn(client.session, "prompt").mockImplementation(async (input) => {
      process.emit("SIGINT")
      process.emit("SIGTERM")
      requested.resolve()
      if (failure === "accepted")
        return {
          id: input.id ?? "msg_cancelled",
          sessionID: "ses_review",
          time: { created: 1 },
          type: "user" as const,
          payload: { text: input.text },
          delivery: "steer" as const,
        }
      throw new Error("admission transport closed")
    })
    const running = runNonInteractivePrompt({
      client,
      sessionID: "ses_review",
      location: { directory: "/review" },
      message: "review",
      files: [],
      thinking: false,
      format: "json",
      auto: false,
      attached: true,
      renderTool: async () => {},
      renderToolError: async () => {},
    }).finally(() => {
      returned = true
    })
    const result = running.then(
      () => undefined,
      (error: unknown) => error,
    )
    try {
      await requested.promise
      await Bun.sleep(20)
      if (failure !== "interrupt") {
        expect(returned).toBe(false)
        expect(wait).toHaveBeenCalledWith({ sessionID: "ses_review" })
      }
      if (failure === "wait") idle.reject(new Error("cleanup unavailable"))
      else idle.resolve()
      const error = await result
      if (failure === "accepted") expect(error).toBeUndefined()
      else
        expect(String(error)).toContain(
          failure === "admission"
            ? "admission outcome unknown"
            : failure === "wait"
              ? "cleanup unavailable"
              : "interrupt unavailable",
        )
      expect(interrupt.mock.calls.every(([input]) => input.sessionID === "ses_review")).toBe(true)
      expect(output.join("").includes('"type":"session_cancelled"')).toBe(failure === "accepted")
      expect(process.exitCode).toBe(130)
    } finally {
      idle.resolve()
      await result
      process.exitCode = originalExitCode ?? 0
    }
  })
}

test("a stuck admission is aborted after the signal grace and reports an unknown outcome", async () => {
  const client = OpenCode.make({ baseUrl: "https://opencode.test" })
  const originalExitCode = process.exitCode
  const originalGrace = admissionGrace.ms
  admissionGrace.ms = 20
  spyOn(process.stdout, "write").mockImplementation(() => true)
  spyOn(client.event, "subscribe").mockImplementation(({ signal } = {}) =>
    (async function* () {
      yield { id: "evt_connected", type: "server.connected" as const, data: {} }
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
    })(),
  )
  spyOn(client.session, "interrupt").mockResolvedValue({ interrupted: true })
  spyOn(client.session, "wait").mockResolvedValue(undefined as never)
  spyOn(client.permission, "list").mockResolvedValue([])
  spyOn(client.session.form, "list").mockResolvedValue([])
  spyOn(client.message, "list").mockResolvedValue({ data: [], cursor: {} })
  // The transport never answers; only the grace abort can settle it.
  spyOn(client.session, "prompt").mockImplementation(
    (_input, options) =>
      new Promise((_resolve, reject) => {
        process.emit("SIGINT")
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      }),
  )
  try {
    const error = await runNonInteractivePrompt({
      client,
      sessionID: "ses_stuck",
      location: { directory: "/review" },
      message: "review",
      files: [],
      thinking: false,
      format: "json",
      auto: false,
      attached: true,
      renderTool: async () => {},
      renderToolError: async () => {},
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(String(error)).toContain("admission outcome unknown")
    expect(process.exitCode).toBe(130)
  } finally {
    admissionGrace.ms = originalGrace
    process.exitCode = originalExitCode ?? 0
  }
}, 5_000)
