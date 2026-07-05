// Replay the session message pipeline against the actual database data

import { Database } from "bun:sqlite"
import * as path from "path"

const DB_PATH = "/home/can/.local/share/opencode/opencode.db"
const SESSION_ID = "ses_117616400ffemZgD5XqgzCCLgl"
const OPENCODE_SRC = "/data/nvme0/can/Projects/opencode"

async function main() {
  // Load DB
  const db = new Database(DB_PATH)
  db.run("PRAGMA journal_mode=WAL")
  const msgRows = db.query("SELECT id, session_id, data FROM message WHERE session_id = ? ORDER BY time_created ASC").all(SESSION_ID) as any[]
  const partRows = db.query("SELECT id, message_id, data FROM part WHERE session_id = ?").all(SESSION_ID) as any[]

  const partsByMsg = new Map<string, any[]>()
  for (const p of partRows) {
    const data = JSON.parse(p.data)
    if (!partsByMsg.has(p.message_id)) partsByMsg.set(p.message_id, [])
    partsByMsg.get(p.message_id)!.push(data)
  }

  // Build WithParts
  const withParts = msgRows.map((row) => {
    const data = JSON.parse(row.data as string)
    return { id: row.id, session_id: row.session_id, info: data.info || data, parts: partsByMsg.get(row.id) || [] }
  })

  console.log(`Total: ${withParts.length} msgs, ${partRows.length} parts`)

  // Run toModelMessages with correct params
  const { toModelMessages } = await import(`${OPENCODE_SRC}/packages/opencode/src/session/message-v2`)

  // Build a minimal model object for toModelMessages
  const modelObj = {
    id: "zai-org/GLM-5.2-FP8",
    providerID: "gmi",
    api: {
      id: "zai-org/GLM-5.2-FP8",
      npm: "@ai-sdk/openai-compatible",
      url: "",
    },
    capabilities: {
      input: { image: false, file: false },
      reasoning: false,
    },
    limit: { context: 131072, output: 16384 },
    tool_call: true,
  }

  let modelMessages: any[]
  try {
    modelMessages = await toModelMessages(withParts, modelObj, { stripMedia: true })
    console.log(`ModelMessages: ${modelMessages.length}`)
  } catch (e: any) {
    console.error("toModelMessages CRASH:", e.message)
    console.error(e.stack)
    db.close()
    return
  }

  // Check for null/undefined in model messages
  console.log("\n=== Checking for null/undefined content ===")
  let foundBad = false
  for (let i = 0; i < modelMessages.length; i++) {
    const m = modelMessages[i]
    if (m.content === null || m.content === undefined) {
      console.log(`  msg[${i}] role=${m.role} content=NULL/UNDEFINED!`)
      foundBad = true
    } else if (Array.isArray(m.content)) {
      for (let j = 0; j < m.content.length; j++) {
        const p = m.content[j]
        if (p === null || p === undefined) {
          console.log(`  msg[${i}] role=${m.role} content[${j}]=NULL/UNDEFINED!`)
          foundBad = true
        } else if (!p.type) {
          console.log(`  msg[${i}] role=${m.role} content[${j}].type=MISSING! data=${JSON.stringify(p).slice(0, 100)}`)
          foundBad = true
        }
      }
    }
  }
  if (!foundBad) console.log("All content OK")
  else console.log("FOUND BAD DATA ^^")

  // Dump last model messages
  console.log("\nLast 5 model messages:")
  for (const m of modelMessages.slice(-5)) {
    const c = Array.isArray(m.content)
      ? m.content.map((p: any) => p.type).join(",")
      : typeof m.content === "string"
        ? `"${m.content.slice(0, 80)}..."`
        : String(m.content).slice(0, 80)
    console.log(`  ${m.role}: [${c}]`)
  }

  db.close()
}

main().catch((e) => {
  console.error("FATAL:", e.message, "\n", e.stack)
  process.exit(1)
})
