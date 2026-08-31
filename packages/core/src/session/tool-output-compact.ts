export * as ToolOutputCompact from "./tool-output-compact"

import { Effect } from "effect"
import { eq, inArray } from "drizzle-orm"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { SessionV1 } from "../v1/session"
import { PartTable } from "./sql"

export const PART_UPDATED_TYPE = EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1)
export const PREVIEW_CHARS = 30_000

export interface Report {
  eventsScanned: number
  eventsDeleted: number
  eventsBounded: number
  partsBounded: number
  vacuumed: boolean
}

export function previewOutput(text: string) {
  if (text.length <= PREVIEW_CHARS) return text
  return "...\n\n" + text.slice(-PREVIEW_CHARS)
}

export function supersededRunningIDs<ID extends string>(events: ReadonlyArray<{ id: ID; data: unknown }>) {
  const last = new Map<string, ID>()
  const running: Array<{ id: ID; key: string }> = []
  for (const event of events) {
    const data = event.data as {
      sessionID?: string
      part?: { id?: string; type?: string; state?: { status?: string } }
    }
    if (data.part?.type !== "tool" || !data.part.id) continue
    const key = `${data.sessionID ?? ""}:${data.part.id}`
    last.set(key, event.id)
    if (data.part.state?.status === "running") running.push({ id: event.id, key })
  }
  return running.filter((row) => last.get(row.key) !== row.id).map((row) => row.id)
}

export function boundEventData(data: Record<string, unknown>) {
  const part = data.part
  if (!part || typeof part !== "object") return { data, changed: false }
  const typed = part as { type?: string; state?: { metadata?: Record<string, unknown> } }
  if (typed.type !== "tool") return { data, changed: false }
  const output = typed.state?.metadata?.output
  if (typeof output !== "string") return { data, changed: false }
  const preview = previewOutput(output)
  if (preview === output) return { data, changed: false }
  return {
    changed: true,
    data: {
      ...data,
      part: {
        ...typed,
        state: {
          ...typed.state,
          metadata: { ...typed.state?.metadata, output: preview },
        },
      },
    },
  }
}

export function boundPartData(data: Record<string, unknown>) {
  if (data.type !== "tool") return { data, changed: false }
  const state = data.state
  if (!state || typeof state !== "object") return { data, changed: false }
  const typed = state as { metadata?: Record<string, unknown> }
  const output = typed.metadata?.output
  if (typeof output !== "string") return { data, changed: false }
  const preview = previewOutput(output)
  if (preview === output) return { data, changed: false }
  return {
    changed: true,
    data: {
      ...data,
      state: {
        ...typed,
        metadata: { ...typed.metadata, output: preview },
      },
    },
  }
}

export const compact = Effect.fn("ToolOutputCompact.compact")(function* (opts: {
  apply: boolean
  vacuum: boolean
}) {
  const { db } = yield* Database.Service
  const events = yield* db
    .select({ id: EventTable.id, data: EventTable.data })
    .from(EventTable)
    .where(eq(EventTable.type, PART_UPDATED_TYPE))
    .orderBy(EventTable.aggregate_id, EventTable.seq)
    .all()
    .pipe(Effect.orDie)

  const drop = new Set(supersededRunningIDs(events))
  const eventUpdates = events.flatMap((event) => {
    if (drop.has(event.id)) return []
    const next = boundEventData(event.data)
    if (!next.changed) return []
    return [{ id: event.id, data: next.data }]
  })

  const parts = yield* db.select({ id: PartTable.id, data: PartTable.data }).from(PartTable).all().pipe(Effect.orDie)
  const partUpdates = parts.flatMap((part) => {
    const next = boundPartData(part.data as Record<string, unknown>)
    if (!next.changed) return []
    return [{ id: part.id, data: next.data }]
  })

  const report: Report = {
    eventsScanned: events.length,
    eventsDeleted: drop.size,
    eventsBounded: eventUpdates.length,
    partsBounded: partUpdates.length,
    vacuumed: false,
  }
  if (!opts.apply) return report

  const ids = [...drop]
  const chunks = Array.from({ length: Math.ceil(ids.length / 500) }, (_, i) => ids.slice(i * 500, i * 500 + 500))
  for (const chunk of chunks) {
    yield* db.delete(EventTable).where(inArray(EventTable.id, chunk)).run().pipe(Effect.orDie)
  }
  for (const row of eventUpdates) {
    yield* db.update(EventTable).set({ data: row.data }).where(eq(EventTable.id, row.id)).run().pipe(Effect.orDie)
  }
  for (const row of partUpdates) {
    yield* db.update(PartTable).set({ data: row.data }).where(eq(PartTable.id, row.id)).run().pipe(Effect.orDie)
  }
  if (!opts.vacuum) return report
  yield* db.run("VACUUM")
  return { ...report, vacuumed: true }
})
