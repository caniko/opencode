export * as SessionExternal from "./session-external.js"

import { Schema } from "effect"
import { Agent } from "./agent.js"
import { Location } from "./location.js"
import { Model } from "./model.js"
import { Permission } from "./permission.js"
import { PromptInput } from "./prompt-input.js"
import { optional } from "./schema.js"
import { Session } from "./session.js"
import { SessionMessage } from "./session-message.js"
import { TokenUsage } from "./token-usage.js"

export type Key = Schema.Schema.Type<typeof Key>
export const Key = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/)).annotate({
  identifier: "SessionExternal.Key",
})

/** Exact UTF-8 JSON bytes are bound to the key. Environment values are never persisted by the server. */
export interface Request extends Schema.Schema.Type<typeof Request> {}
export const Request = Schema.Struct({ key: Key, body: Schema.String }).annotate({
  identifier: "SessionExternal.Request",
})

export interface Backend extends Schema.Schema.Type<typeof Backend> {}
export const Backend = Schema.Struct({
  version: Schema.Literal(1),
  backendID: Schema.String,
  backendGeneration: Schema.String,
}).annotate({ identifier: "SessionExternal.Backend" })

export interface Body extends Schema.Schema.Type<typeof Body> {}
export const Body = Schema.Struct({
  version: Schema.Literal(1),
  backendID: Schema.String,
  owner: Key,
  sessionID: Session.ID.check(Schema.isPattern(/^ses_external_[a-zA-Z0-9_-]+$/)),
  inputID: SessionMessage.ID.check(Schema.isPattern(/^msg_external_[a-zA-Z0-9_-]+$/)),
  location: Location.PublicRef,
  prompt: PromptInput.Prompt,
  environment: Schema.Record(Schema.String, Schema.String),
  title: Schema.String.pipe(optional),
  agent: Agent.ID.pipe(optional),
  model: Model.Ref.pipe(optional),
  permissions: Permission.Ruleset.pipe(optional),
}).annotate({ identifier: "SessionExternal.Body" })

export interface Receipt extends Schema.Schema.Type<typeof Receipt> {}
export const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  key: Key,
  bodySha256: Schema.String,
  backendID: Schema.String,
  backendGeneration: Schema.String,
  sessionID: Session.ID,
  inputID: SessionMessage.ID,
  admitted: Schema.Boolean,
  stopRequested: Schema.Boolean,
  settled: Schema.Boolean,
  lineage: Schema.Array(
    Schema.Struct({
      sessionID: Session.ID,
      active: Schema.Boolean,
      pending: Schema.Number,
      suspended: Schema.Boolean,
      outcome: Session.Info.fields.outcome,
    }),
  ),
  result: Schema.Struct({ summary: Schema.String, costUsd: Schema.Number, tokens: TokenUsage.Info }).pipe(optional),
}).annotate({ identifier: "SessionExternal.Receipt" })
