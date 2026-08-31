import { expect, test } from "bun:test"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"

const validSummary = (objective = "Keep the compaction state usable") => `## Objective
- ${objective}

## Important Details
- (none)

## Work State
### Completed
- (none)

### Active
- (none)

### Blocked
- (none)

## Next Move
1. Continue the current task

## Relevant Files
- (none)`

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toStartWith(
    "Here is the conversation so far:\n\n<conversation>\nconversation history\n</conversation>",
  )
  expect(prompt.indexOf("</conversation>")).toBeLessThan(prompt.indexOf("Create a new anchored summary"))
  expect(prompt).toContain("conversation history in the <conversation> tags above")
  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction prompt gives update instructions for a prior summary", () => {
  const prompt = SessionCompaction.buildPrompt({
    context: ["new conversation"],
    previousSummary: "existing summary",
  })

  expect(prompt.indexOf("<conversation>")).toBeLessThan(prompt.indexOf("<prior-summary>"))
  expect(prompt.indexOf("</prior-summary>")).toBeLessThan(prompt.indexOf("The <prior-summary> summarizes"))
  expect(prompt).toContain(
    "Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary>",
  )
  expect(prompt).toContain('Move completed work from "Active" to "Completed".')
  expect(prompt).toContain('Update "Objective" and "Next Move" to reflect the current work state.')
})

test("compaction summary validation rejects malformed and repetitive output", () => {
  expect(SessionCompaction.validateSummary(validSummary())).toMatchObject({ valid: true, headingCount: 8 })
  expect(SessionCompaction.validateSummary(validSummary().replace("## Relevant Files", "## Files"))).toMatchObject({
    valid: false,
    reason: "structure",
  })
  expect(
    SessionCompaction.validateSummary(validSummary().replace("- (none)\n\n### Active", "\n### Active")),
  ).toMatchObject({
    valid: false,
    reason: "empty-section",
  })
  const repeated = "- This substantive summary line should not be repeated three times"
  expect(
    SessionCompaction.validateSummary(validSummary().replace("- (none)", [repeated, repeated, repeated].join("\n"))),
  ).toMatchObject({ valid: false, reason: "repetition", repeatedLineCount: 1 })
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})
