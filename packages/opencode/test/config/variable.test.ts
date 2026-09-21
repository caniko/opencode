import { describe, expect, test } from "bun:test"
import { ConfigVariable } from "@/config/variable"
import { ConfigParse } from "@/config/parse"
import { FormatError } from "@/cli/error"

// A secret containing JSON-significant characters must survive env
// substitution without corrupting the config document, and must never
// surface in parse diagnostics. Single-line shape like real API keys.
const NASTY_KEY = "r+El\\vd>rA??b;a\"quote"

describe("config variable substitution", () => {
  test("escapes backslashes, quotes, and newlines in env values", async () => {
    const text = await ConfigVariable.substitute({
      type: "virtual",
      source: "test",
      dir: "/tmp",
      text: `{"apiKey": "{env:NASTY}"}`,
      env: { NASTY: NASTY_KEY },
    })
    // Re-parses as JSON with the value intact: no InvalidEscapeCharacter.
    const parsed = JSON.parse(text) as { apiKey: string }
    expect(parsed.apiKey).toBe(NASTY_KEY)
  })

  test("leaves plain values byte-identical", async () => {
    const text = await ConfigVariable.substitute({
      type: "virtual",
      source: "test",
      dir: "/tmp",
      text: `{"username": "{env:PLAIN}"}`,
      env: { PLAIN: "secret_value" },
    })
    expect(text).toBe(`{"username": "secret_value"}`)
  })
})

describe("config parse redaction", () => {
  test("never embeds substituted config text in parse errors", () => {
    // Escaped-quote suffix defeats textual redaction, and unterminated
    // strings defeat it entirely -- so the diagnostic must not contain
    // the config text at all. NB: NamedError sets error.message to the
    // tag ("ConfigJsonError"); the diagnostic lives in error.data.message
    // and the user-facing FormatError output. Assert on both, or the test
    // inspects a string that never carried the secret.
    for (const text of [
      `{\n"apiKey": "${NASTY_KEY}",\n"oops": ,\n}`,
      `{\n"apiKey": "prefix\\"SECRET_SUFFIX",\n"oops": ,\n}`,
      `{\n"apiKey": "unterminated-${NASTY_KEY}`,
    ]) {
      let threw = false
      let diagnostic = ""
      let formatted = ""
      try {
        ConfigParse.jsonc(text, "test-config")
      } catch (error) {
        threw = true
        const data = (error as { data?: { message?: unknown } }).data
        diagnostic = typeof data?.message === "string" ? data.message : String(data)
        formatted = FormatError(error) ?? ""
      }
      expect(threw).toBe(true)
      for (const payload of [diagnostic, formatted]) {
        expect(payload).not.toContain("r+El")
        expect(payload).not.toContain("SECRET_SUFFIX")
        expect(payload).not.toContain("JSONC Input")
        expect(payload).toContain("line")
      }
    }
  })
})
