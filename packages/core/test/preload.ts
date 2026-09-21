import path from "path"

process.env.OPENCODE_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"
process.env.OPENCODE_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.OPENCODE_DISABLE_MODELS_FETCH = "true"

// Shell resolution falls back to $SHELL; suites assume bash semantics, so
// pin it for hermetic runs regardless of the login shell.
if (process.platform !== "win32") process.env.SHELL = "/bin/bash"
