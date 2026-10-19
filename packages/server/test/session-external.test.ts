import { expect } from "bun:test"
import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { SessionExternal } from "@opencode/schema/session-external"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live("authenticates external lifecycle requests and preserves an exact-byte Stop tombstone", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      password: "fixture-password",
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    })
    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/session/external", {
          headers: { authorization: `Basic ${btoa("opencode:fixture-password")}` },
        }),
      ),
    )
    const backend = Schema.decodeUnknownSync(SessionExternal.Backend)(yield* Effect.promise(() => response.json()))
    const body = JSON.stringify({
      version: 1,
      backendID: backend.backendID,
      owner: "paperclip:company:agent",
      sessionID: "ses_external_http",
      inputID: "msg_external_http",
      location: { directory: "/project" },
      prompt: { text: "Never start" },
      environment: { SECRET: "not-for-a-receipt" },
    })
    const payload = { key: "paperclip:http", body }
    const call = (operation: string, value: unknown, authenticated = true) =>
      Effect.promise(() =>
        handler(
          new Request(`http://opencode.local/api/session/external/${operation}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(authenticated ? { authorization: `Basic ${btoa("opencode:fixture-password")}` } : {}),
            },
            body: JSON.stringify(value),
          }),
        ),
      )
    expect((yield* call("stop", payload, false)).status).toBe(401)
    const stopped = yield* call("stop", payload)
    expect(stopped.status).toBe(200)
    const receipt = Schema.decodeUnknownSync(SessionExternal.Receipt)(yield* Effect.promise(() => stopped.json()))
    expect(receipt).toMatchObject({
      key: payload.key,
      bodySha256: createHash("sha256").update(body).digest("hex"),
      stopRequested: true,
      settled: true,
      lineage: [],
    })
    expect(JSON.stringify(receipt)).not.toContain("not-for-a-receipt")
    const admitted = yield* call("admit", payload)
    expect(admitted.status).toBe(200)
    expect(yield* Effect.promise(() => admitted.json())).toEqual(receipt)
    expect((yield* call("admit", { ...payload, body: `${body} ` })).status).toBe(409)
    expect((yield* call("admit", { ...payload, key: "invalid/key" })).status).toBe(400)
    expect((yield* call("admit", { ...payload, key: "another", body: "{}" })).status).toBe(400)
  }).pipe(Effect.scoped),
)
