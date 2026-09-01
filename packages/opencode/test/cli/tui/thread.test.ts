import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import yargs from "yargs"
import { tmpdir } from "../../fixture/fixture"
import { managedAttachUrl, TuiThreadCommand, resolveThreadDirectory } from "../../../src/cli/cmd/tui"
import { cliIt } from "../../lib/cli-process"

describe("tui thread", () => {
  test("loads the TUI integration lazily", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui.ts", import.meta.url)).text()

    expect(source).toContain('await import("../tui/layer")')
    expect(source).toMatch(/await import\(["']@\/plugin\/tui\/runtime["']\)/)
    expect(source).not.toContain('import("./app")')
  })

  test("forwards the CLI environment to the TUI worker", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui.ts", import.meta.url)).text()

    expect(source).toMatch(/new Worker\(file, \{\s*env: Object\.fromEntries\(\s*Object\.entries\(process\.env\)/)
  })

  async function check(project?: string) {
    await using tmp = await tmpdir({ git: true })
    const link = path.join(path.dirname(tmp.path), path.basename(tmp.path) + "-link")
    const type = process.platform === "win32" ? "junction" : "dir"

    try {
      await fs.symlink(tmp.path, link, type)
      expect(resolveThreadDirectory(project, link, tmp.path)).toBe(tmp.path)
    } finally {
      await fs.rm(link, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  test("uses the real cwd when PWD points at a symlink", async () => {
    await check()
  })

  test("uses the real cwd after resolving a relative project from PWD", async () => {
    await check(".")
  })

  test("resolves a relative mini project from PWD when cwd differs", async () => {
    await using pwd = await tmpdir({ git: true })
    await using cwd = await tmpdir({ git: true })

    expect(resolveThreadDirectory(".", pwd.path, cwd.path)).toBe(pwd.path)
    expect(resolveThreadDirectory(undefined, pwd.path, cwd.path)).toBe(cwd.path)
  })

  test("uses the managed server unless direct mode is explicit", () => {
    expect(managedAttachUrl({ OPENCODE_ATTACH_URL: "http://127.0.0.1:4096" })).toBe("http://127.0.0.1:4096")
    expect(managedAttachUrl({ OPENCODE_ATTACH_URL: "http://127.0.0.1:4096", OPENCODE_DIRECT: "1" })).toBeUndefined()
    expect(managedAttachUrl({ OPENCODE_ATTACH_URL: "http://127.0.0.1:4096", OPENCODE_DIRECT: "TRUE" })).toBeUndefined()
  })

  test("parses supported --no-replay forms", async () => {
    for (const option of ["--no-replay", "--no-replay=true", "--noReplay"]) {
      const args = await yargs([])
        .command({ ...TuiThreadCommand, handler: () => {} })
        .exitProcess(false)
        .parse(["--mini", option, "--replay-limit", "10"])

      expect(args.replay === false || args.noReplay === true).toBe(true)
      expect(args.replayLimit).toBe(10)
    }
  })

  test("preserves boolean negation for existing options", async () => {
    const args = await yargs([])
      .command({ ...TuiThreadCommand, handler: () => {} })
      .exitProcess(false)
      .parse(["--mdns", "--no-mdns"])

    expect(args.mdns).toBe(false)
  })

  cliIt.live("rejects mini-only options without --mini", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["--replay-limit", "10"])

      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--replay-limit requires --mini")
    }),
  )

  cliIt.live("routes attached sessions to mini mode", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["attach", "http://127.0.0.1:1", "--mini"])

      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--mini requires a TTY stdout")
    }),
  )

  cliIt.live("uses managed attachment unless direct mode is explicit", ({ opencode }) =>
    Effect.gen(function* () {
      const session = "ses_206f84f18ffeZ6hhD7pFYAiW5T"
      const managed = yield* opencode.spawn(["--session", session], {
        env: { OPENCODE_ATTACH_URL: "http://127.0.0.1:1" },
      })
      const direct = yield* opencode.spawn(["--session", session], {
        env: { OPENCODE_ATTACH_URL: "http://127.0.0.1:1", OPENCODE_DIRECT: "1" },
      })

      opencode.expectExit(managed, 1)
      opencode.expectExit(direct, 1)
      expect(managed.stderr).not.toContain("Session not found")
      expect(managed.stderr).not.toContain("react/jsx-dev-runtime")
      expect(direct.stderr).toMatch(/Session not found|react\/jsx-dev-runtime/)
    }),
  )

  cliIt.live("rejects network options in mini mode", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["--mini", "--port", "4096"])

      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--port cannot be used with --mini")
    }),
  )
})
