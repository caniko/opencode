import { describe, expect, test } from "bun:test"
import { ToolOutputCompact } from "@opencode-ai/core/session/tool-output-compact"

const running = (sessionID: string, partID: string, output = "out") => ({
  sessionID,
  part: { id: partID, type: "tool", state: { status: "running", metadata: { output } } },
})

const completed = (sessionID: string, partID: string, output = "done") => ({
  sessionID,
  part: { id: partID, type: "tool", state: { status: "completed", metadata: { output } } },
})

describe("ToolOutputCompact", () => {
  test("drops running snapshots once a later event exists for the part", () => {
    expect(
      ToolOutputCompact.supersededRunningIDs([
        { id: "e1", data: running("ses", "prt1") },
        { id: "e2", data: running("ses", "prt1") },
        { id: "e3", data: completed("ses", "prt1") },
      ]),
    ).toEqual(["e1", "e2"])
  })

  test("keeps the last running snapshot when the tool never completed", () => {
    expect(
      ToolOutputCompact.supersededRunningIDs([
        { id: "e1", data: running("ses", "prt1") },
        { id: "e2", data: running("ses", "prt1") },
      ]),
    ).toEqual(["e1"])
  })

  test("does not drop a different part", () => {
    expect(
      ToolOutputCompact.supersededRunningIDs([
        { id: "e1", data: running("ses", "prt1") },
        { id: "e2", data: running("ses", "prt2") },
      ]),
    ).toEqual([])
  })

  test("bounds oversized metadata.output on events and parts", () => {
    const output = "x".repeat(ToolOutputCompact.PREVIEW_CHARS + 10)
    const event = ToolOutputCompact.boundEventData({
      sessionID: "ses",
      part: { type: "tool", state: { status: "completed", metadata: { output } } },
    })
    expect(event.changed).toBe(true)
    const eventOutput = (event.data.part as { state: { metadata: { output: string } } }).state.metadata.output
    expect(eventOutput).toBe(ToolOutputCompact.previewOutput(output))

    const part = ToolOutputCompact.boundPartData({
      type: "tool",
      state: { status: "completed", metadata: { output } },
    })
    expect(part.changed).toBe(true)
    const partOutput = (part.data.state as { metadata: { output: string } }).metadata.output
    expect(partOutput).toBe(eventOutput)
  })

  test("leaves short output alone", () => {
    const data = { type: "tool", state: { metadata: { output: "short" } } }
    expect(ToolOutputCompact.boundPartData(data)).toEqual({ data, changed: false })
  })
})
