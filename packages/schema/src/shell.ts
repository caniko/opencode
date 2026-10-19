export * as Shell from "./shell.js"

import { Schema } from "effect"
import { optional } from "./schema.js"
import { ephemeral, inventory } from "./event.js"
import { ascending } from "./identifier.js"
import { NonNegativeInt, statics } from "./schema.js"

const IDSchema = Schema.String.check(Schema.isStartsWith("sh_")).pipe(Schema.brand("Shell.ID"))

export const ID = IDSchema.pipe(
  statics((schema: typeof IDSchema) => {
    const create = () => schema.make("sh_" + ascending())
    return {
      create,
      ascending: (id?: string) => (id === undefined ? create() : schema.make(id)),
    }
  }),
)
export type ID = typeof ID.Type

export const Status = Schema.Literals(["queued", "running", "exited", "timeout", "killed", "failed"])
export type Status = typeof Status.Type

export const Time = Schema.Struct({
  queued: optional(Schema.Finite).annotate({ description: "Acceptance time in milliseconds since the Unix epoch" }),
  started: optional(Schema.Finite).annotate({
    description: "Execution start time in milliseconds since the Unix epoch; absent while queued",
  }),
  completed: optional(Schema.Finite).annotate({
    description: "Completion time in milliseconds since the Unix epoch",
  }),
})
export interface Time extends Schema.Schema.Type<typeof Time> {}

// Opaque caller-supplied tags echoed back on Info and events. The Shell service never interprets
// these; callers (e.g. ShellTool stores the originating session ID) use them to filter or correlate.
export const Metadata = Schema.Record(Schema.String, Schema.Unknown)
export type Metadata = typeof Metadata.Type

export const Info = Schema.Struct({
  id: ID,
  status: Status,
  command: Schema.String,
  cwd: Schema.String,
  shell: Schema.String,
  // Absolute path of the file capturing combined stdout/stderr. Page through it via `output`.
  file: Schema.String,
  pid: optional(NonNegativeInt),
  exit: optional(Schema.Finite),
  signal: optional(Schema.String),
  error: optional(Schema.String),
  // Always present; defaults to an empty object when the creator supplies no metadata.
  metadata: Metadata,
  time: Time,
}).annotate({ identifier: "Shell.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

const Created = ephemeral({ type: "shell.created", schema: { info: Info } })
const Started = ephemeral({ type: "shell.started", schema: { info: Info } })
const Exited = ephemeral({ type: "shell.exited", schema: { id: ID, exit: optional(Schema.Finite), status: Status } })
const Deleted = ephemeral({ type: "shell.deleted", schema: { id: ID } })
export const Event = { Created, Started, Exited, Deleted, Definitions: inventory(Created, Started, Exited, Deleted) }

export const CreateInput = Schema.Struct({
  command: Schema.String,
  cwd: optional(Schema.String),
  timeout: optional(NonNegativeInt),
  queueTimeout: optional(NonNegativeInt).annotate({
    description:
      "Optional resource wait limit in milliseconds. Omitted or zero waits until cancelled; does not consume execution timeout.",
  }),
  background: optional(Schema.Boolean).annotate({
    description: "Return the accepted queued handle without waiting for process admission.",
  }),
  metadata: optional(Metadata),
})
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}

export const OutputInput = Schema.Struct({
  cursor: optional(NonNegativeInt),
  limit: optional(NonNegativeInt),
})
export interface OutputInput extends Schema.Schema.Type<typeof OutputInput> {}

export const Output = Schema.Struct({
  output: Schema.String,
  // Absolute cursor after this page. Equals `size` once fully caught up.
  cursor: NonNegativeInt,
  // Total bytes captured so far. A consumer has more to page while `cursor < size`.
  size: NonNegativeInt,
  truncated: Schema.Boolean,
})
export interface Output extends Schema.Schema.Type<typeof Output> {}
