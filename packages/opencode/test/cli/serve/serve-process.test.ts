// Subprocess integration tests for `opencode serve`. Spawns the real CLI in
// headless mode and exercises it over HTTP — this is the only test tier that
// catches bugs spanning argv → server boot → routing → instance loading.
//
// `serve` is long-lived: the harness returns a handle (url/port/kill/exited)
// and kills the process when the test scope closes. The OS-assigned port is
// parsed off the "listening on http://..." line.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
import { cliIt } from "../../lib/cli-process"
import path from "node:path"

describe("opencode serve (subprocess)", () => {
  // Smoke test: server starts, binds a port, and /global/health responds.
  // If this fails, all other serve tests likely will too — debug here first.
  cliIt.live(
    "starts, binds a port, and serves /global/health",
    ({ opencode }) =>
      Effect.gen(function* () {
        const server = yield* opencode.serve()
        expect(server.port).toBeGreaterThan(0)
        expect(server.url).toMatch(/^http:\/\//)

        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${server.url}/global/health`)
        expect(res.status).toBe(200)
        // GlobalHealth schema is { success: true, ... } | { success: false, error }.
        // We don't lock in further shape here — any 200 with parseable JSON is
        // enough proof the routing + auth-bypass + instance loading is alive.
        const body = yield* res.json
        expect(body).toBeDefined()
      }),
    60_000,
  )

  // The scope-close finalizer must actually terminate the child. Without this
  // test a regression in the kill path (e.g. a future refactor that forgets
  // to wire the finalizer) would leak processes on every test run.
  cliIt.live(
    "preserves sessions and accepts attachments after restart",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const env = { OPENCODE_DB: path.join(home, "restart.db") }
        const first = yield* opencode.serve({ env })
        const created = yield* Effect.promise(() =>
          fetch(`${first.url}/session`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-opencode-directory": home },
            body: JSON.stringify({ title: "restart-persistence" }),
          }),
        )
        expect(created.status).toBe(200)
        const session = (yield* Effect.promise(() => created.json())) as { id: string }

        yield* Effect.sync(first.kill)
        yield* Effect.promise(() => first.exited).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () => Effect.fail(new Error("timed out waiting for first server shutdown")),
          }),
        )

        const restarted = yield* opencode.serve({ env })
        const restored = yield* Effect.promise(() =>
          fetch(`${restarted.url}/session/${session.id}`, { headers: { "x-opencode-directory": home } }),
        )
        expect(restored.status).toBe(200)

        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (value) => Effect.sync(() => value.abort()),
        )
        const events = yield* Effect.promise(() =>
          fetch(`${restarted.url}/global/event`, { signal: controller.signal }),
        )
        expect(events.status).toBe(200)
        if (!events.body) return yield* Effect.die(new Error("event response did not include a body"))
        const reader = events.body.getReader()
        yield* Effect.promise(() => reader.read()).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.fail(new Error("timed out waiting for restarted event attachment")),
          }),
        )

        const health = yield* Effect.promise(() =>
          fetch(`${restarted.url}/global/health`).then(
            (response) =>
              response.json() as Promise<{ runtime: { attachedSessions: number; database: { sessions: number } } }>,
          ),
        )
        expect(health.runtime.database.sessions).toBeGreaterThanOrEqual(1)
        expect(health.runtime.attachedSessions).toBeGreaterThanOrEqual(1)
      }),
    60_000,
  )

  cliIt.live(
    "kills the subprocess on scope close",
    ({ opencode }) =>
      Effect.gen(function* () {
        // Inner scope so we can observe `.exited` resolving after it closes.
        const exitedPromise = yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* opencode.serve()
            // Capture the Promise, not the resolved value — scope closes after
            // this gen returns, at which point the finalizer kills the child.
            return server.exited
          }),
        )
        // After scope close: finalizer fired, process must have exited.
        const code = yield* Effect.promise(() => exitedPromise)
        // Bun reports the exit code; SIGTERM-killed processes return non-null
        // (typically 143 on POSIX). We just require resolution within a sane
        // window — anything else means the kill didn't take.
        expect(typeof code === "number" || code === null).toBe(true)
      }),
    60_000,
  )
})
