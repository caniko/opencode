import { expect } from "bun:test"
import { Effect } from "effect"
import { join } from "node:path"
import { ServerFetch } from "@opencode/server/fetch"
import { it } from "../../core/test/lib/effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { isolatedEnv } from "./fixture/environment"

it.live("uses the existing private registration for an external Stop without changing it", () =>
  Effect.gen(function* () {
    const temporary = yield* tmpdirScoped()
    const handler = yield* ServerFetch.make({
      password: "private-fixture",
      app: { version: "local" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    })
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handler(request) })),
      (server) => Effect.sync(() => server.stop(true)),
    )
    const registration = join(temporary.path, "state/opencode/service-local.json")
    const contents = JSON.stringify({
      id: crypto.randomUUID(),
      version: "local",
      url: server.url.toString(),
      pid: process.pid,
      password: "private-fixture",
    })
    yield* Effect.promise(() => Bun.write(registration, contents, { mode: 0o600 }))
    const backend = JSON.parse((yield* Effect.promise(() => cli(temporary.path, "", "info"))).stdout)
    const input = JSON.stringify({
      key: "paperclip:cli",
      body: JSON.stringify({
        version: 1,
        backendID: backend.backendID,
        owner: "paperclip:company:agent",
        sessionID: "ses_external_cli",
        inputID: "msg_external_cli",
        location: { directory: temporary.path },
        prompt: { text: "Do not admit this" },
        environment: { SECRET: "secret-fixture" },
      }),
    })
    const result = yield* Effect.promise(() => cli(temporary.path, input))
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      key: "paperclip:cli",
      stopRequested: true,
      settled: true,
      lineage: [],
    })
    expect(result.stdout + result.stderr).not.toMatch(/private-fixture|secret-fixture/)
    expect(yield* Effect.promise(() => Bun.file(registration).text())).toBe(contents)
  }).pipe(Effect.scoped),
)

it.live("refuses an absent managed backend without starting a replacement", () =>
  Effect.gen(function* () {
    const temporary = yield* tmpdirScoped()
    const result = yield* Effect.promise(() =>
      cli(temporary.path, JSON.stringify({ key: "paperclip:absent", body: "{}" })),
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("No compatible managed OpenCode backend")
    expect(
      yield* Effect.promise(() => Bun.file(join(temporary.path, "state/opencode/service-local.json")).exists()),
    ).toBe(false)
    expect(yield* Effect.promise(() => Bun.file(join(temporary.path, "opencode.db")).exists())).toBe(false)
  }).pipe(Effect.scoped),
)

async function cli(root: string, stdin: string, operation = "stop") {
  const child = Bun.spawn(
    [process.execPath, "run", join(import.meta.dir, "../src/index.ts"), "session", "external", operation],
    {
      env: isolatedEnv(root),
      stdin: new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}
