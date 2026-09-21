/** @jsxImportSource @opentui/solid */
/**
 * Reproducer for #26560 — TUI crashes with
 *   `TypeError: undefined is not an object (evaluating 'f.data.map')`
 * when entering a session whose messages endpoint returns a non-2xx.
 * The failure path is `sync.tsx#sync.session.sync` reading
 * `messages.data!` while the SDK leaves `data` undefined on error.
 */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount } from "./sync-fixture"

const sessionID = "ses_undef"

describe("tui sync (#26560)", () => {
  test("a failed history request rejects without replacing already displayed messages", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionPayload = {
      id: sessionID,
      title: "broken",
      time: { created: 0, updated: 0 },
      version: "1.14.42",
      directory,
      project_id: "proj_test",
    }
    let fail = false
    const message = { id: "msg_existing", sessionID, role: "user", time: { created: 1 } }
    const { app, sync, emit } = await mount((url) => {
      if (url.pathname === `/session/${sessionID}`) return json(sessionPayload)
      if (url.pathname === `/session/${sessionID}/message`)
        return fail ? json({}, { status: 500 }) : json([{ info: message, parts: [] }])
      if (url.pathname === `/session/${sessionID}/todo`) return json([])
      if (url.pathname === `/session/${sessionID}/diff`) return json([])
      if (url.pathname === "/session") return json([sessionPayload])
      return undefined
    }, tmp.path)

    try {
      fail = true
      emit({
        directory,
        payload: {
          id: "evt_existing",
          type: "message.updated",
          properties: {
            sessionID,
            info: { ...message, role: "user", agent: "build", model: { providerID: "test", modelID: "test" } },
          },
        },
      })
      await expect(sync.session.sync(sessionID)).rejects.toBeDefined()
      expect(sync.data.message[sessionID]?.[0]?.id).toBe(message.id)
      fail = false
      await expect(sync.session.sync(sessionID)).resolves.toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })
})
