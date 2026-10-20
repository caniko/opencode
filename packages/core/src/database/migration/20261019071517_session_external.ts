import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261019071517_session_external",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_external\` (
          \`key\` text PRIMARY KEY,
          \`body_sha256\` text NOT NULL,
          \`owner\` text NOT NULL,
          \`session_id\` text NOT NULL UNIQUE,
          \`input_id\` text NOT NULL UNIQUE,
          \`admitted\` integer DEFAULT false NOT NULL,
          \`stop_requested\` integer DEFAULT false NOT NULL
        );
      `)
    })
  },
}

export default migration
