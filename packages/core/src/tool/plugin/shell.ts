export * as ShellTool from "./shell.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import type { Tool } from "@opencode/schema/tool"
import { Deferred, Effect, Exit, Schema, Scope } from "effect"
import { Config } from "../../config.js"
import { Environment } from "../../environment/index.js"
import { Job } from "../../job.js"
import { FileAccess } from "../../file-access.js"
import { Permission } from "../../permission.js"
import { NonNegativeInt } from "../../schema.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { Shell } from "../../shell.js"
import { ShellParse } from "../../shell/parse.js"
import { ShellSelect } from "../../shell/select.js"
import { ShellResult } from "../../shell/result.js"

export const name = "shell"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000

const BACKGROUND_INSTRUCTION =
  "You will be notified automatically when the command finishes. The notification will include the command's output. Unless the user explicitly asks otherwise, DO NOT poll for completion, even if you need the final result to continue. Repeatedly sleeping and reading or searching the output file is polling, not useful work. You may read the current output if it lets you do useful work now, but do not repeatedly check it while waiting for the command to finish. Keep working on anything that does not depend on the result. If you have nothing else to do, end your response; you will be resumed automatically when the command finishes."
const OS =
  process.platform === "darwin"
    ? "macOS"
    : process.platform === "win32"
      ? "Windows"
      : process.platform === "linux"
        ? "Linux"
        : process.platform
const description = (shell?: string) =>
  [
    "Execute a shell command and return its output.",
    ...(shell ? [`Commands run on ${OS} using ${shell}.`] : []),
    "Quote file paths containing spaces or special characters.",
    "Prefer dedicated tools over shell commands when possible.",
    "When output is large, the full result is saved to a file and a truncated preview is returned.",
    "Rely on automatic truncation unless filtering the output is more useful.",
    "Commands accept an optional timeout, background commands have no timeout by default.",
    "Background commands return immediately, and you will be notified when they complete.",
  ].join(" ")

export const Input = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell command string to execute" }),
  workdir: Schema.optionalKey(Schema.String).annotate({
    description:
      "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
  }),
  environment: Schema.optionalKey(Schema.Literals(["project", "bootstrap"])).annotate({
    description:
      "Use project preparation by default, or explicitly select bootstrap host tools for environment repair.",
  }),
  timeout: Schema.optionalKey(NonNegativeInt).annotate({
    description: `Execution timeout in milliseconds, starting after admission. Set to 0 to disable. Defaults to ${DEFAULT_TIMEOUT_MS} for foreground commands. Background commands have no timeout by default.`,
  }),
  queue_timeout: Schema.optionalKey(NonNegativeInt).annotate({
    description:
      "Optional resource wait limit in milliseconds. Omitted or zero waits until cancelled; waiting does not consume execution timeout.",
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
  }),
})

const StructuredOutput = Schema.Struct({
  exit: Schema.optionalKey(Schema.Number),
  signal: Schema.optionalKey(Schema.String),
  shellID: Schema.optionalKey(Schema.String),
  truncated: Schema.Boolean,
  timeout: Schema.optionalKey(Schema.Boolean),
})

const Output = Schema.Struct({
  ...StructuredOutput.fields,
  output: Schema.String,
  status: Schema.optionalKey(Schema.Literals(["completed", "queued", "running"])),
})

type Output = typeof Output.Type

const resultMessages = (output: Output) => {
  const notice =
    output.status === "running" || output.status === "queued" ? BACKGROUND_INSTRUCTION : ShellResult.notice(output)
  return [...(output.output ? [output.output] : []), ...(notice ? [notice] : [])]
}

const toolResult = (output: Output) => {
  return {
    output,
    content: resultMessages(output).map((text) => ({ type: "text" as const, text })),
    metadata: {
      status: output.status,
      ...ShellResult.metadata(output),
      ...(output.shellID !== undefined ? { shellID: output.shellID } : {}),
    },
  }
}

const backgroundResult = (shellID: string, file: string, queued: boolean) => ({
  output: queued
    ? `Command queued in the background (shell ID: ${shellID}).\nOutput will be saved to: ${file}`
    : `Command moved to the background (shell ID: ${shellID}).\nOutput is streaming to: ${file}`,
  shellID,
  truncated: false,
  status: queued ? ("queued" as const) : ("running" as const),
})

export const Plugin = {
  id: "opencode.tool.shell",
  effect: Effect.fn("ShellTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const scope = yield* Scope.Scope
    const environment = yield* Environment.Service
    const access = yield* FileAccess.Service
    const shell = yield* Shell.Service
    const shellSelect = yield* ShellSelect.Service
    const compatibleShell = shellSelect.resolve({ priority: "compat" })
    const permission = yield* Permission.Service
    const config = yield* Config.Service

    const prepare = Effect.fn("ShellTool.prepare")(function* (
      invocation: ShellCreateBefore,
      context: Tool.Context,
      authorized?: Pick<ShellCreateBefore, "command" | "cwd" | "shell">,
    ) {
      const source = {
        type: "tool" as const,
        messageID: context.messageID,
        id: context.id,
      }
      const target = yield* access.resolve({ path: invocation.cwd, kind: "directory" })
      invocation.cwd = target.absolute
      const timeout = invocation.timeout
      if (
        !authorized ||
        authorized.command !== invocation.command ||
        authorized.cwd !== invocation.cwd ||
        authorized.shell !== invocation.shell
      ) {
        const portable = Config.latest(yield* config.entries(), "experimental")?.portable_shell_scanner === true
        const parsed = yield* ShellParse.scan(invocation.command, invocation.shell, target.absolute, { portable })
        const directories = yield* Effect.forEach(parsed.directories, (directory) =>
          access.resolve({
            path: FileAccess.resolvePath(target.absolute, directory),
            kind: "directory",
          }),
        )
        yield* access.authorizeExternal([target, ...directories], context)
        // Even a comment-only request can run environment preparation hooks.
        yield* permission.assert({
          action: name,
          resources: parsed.commands.length ? parsed.commands.map((command) => command.resource) : [invocation.command],
          save: parsed.commands.map((command) => command.save),
          sessionID: context.sessionID,
          agent: context.agent,
          source,
        })
      }
      // Approval can outlive the directory, so validate immediately before spawning.
      const workdir = yield* Environment.typeFollowing(environment.files, target.absolute).pipe(
        Effect.catchTag("Environment.NotFound", () =>
          Effect.fail(new Error(`Working directory does not exist: ${target.absolute}`)),
        ),
      )
      if (workdir !== "directory")
        return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.absolute}`))
      return timeout
    })

    const notifyWhenDone = Effect.fn("ShellTool.notifyWhenDone")(
      function* (
        sessionID: SessionSchema.ID,
        id: string,
        shellID: string,
        command: string,
        settled: Deferred.Deferred<Output>,
      ) {
        const info = (yield* jobs.wait({ id })).info
        if (!info || Job.isActive(info.status)) return
        const output = info.status === "completed" ? yield* Deferred.await(settled) : undefined
        const text = output
          ? resultMessages(output).join("\n\n")
          : info.status === "error"
            ? (info.error ?? "Command failed")
            : "Cancelled"
        yield* sessions.synthetic({
          ...(info.notificationID ? { id: info.notificationID } : {}),
          sessionID,
          description: command,
          ...ShellResult.notification({
            jobID: id,
            shellID,
            command,
            state: info.status,
            text,
            output,
          }),
        })
        if (info.notificationID) yield* jobs.completeBackground(info.notificationID)
      },
      Effect.forkIn(scope, { startImmediately: true }),
    )

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description: description(),
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const timeout = input.background === true ? (input.timeout ?? 0) : (input.timeout ?? DEFAULT_TIMEOUT_MS)
              const id = Shell.ID.create()
              const accepted = yield* Deferred.make<Shell.Info, unknown>()
              const settled = yield* Deferred.make<Output>()
              let finalTimeout = timeout
              let authorized: Pick<ShellCreateBefore, "command" | "cwd" | "shell"> | undefined
              const selectedShell = yield* compatibleShell
              const job = yield* jobs.start({
                // CodeMode children share a tool-call ID, but each shell owns its job.
                id,
                type: name,
                title: input.command,
                queued: true,
                metadata: { sessionID: context.sessionID, shellID: id },
                recovery: { kind: "shell", sessionID: context.sessionID, shellID: id, command: input.command },
                run: (started) =>
                  Effect.gen(function* () {
                    const info = yield* shell
                      .create(
                        {
                          id,
                          command: input.command,
                          cwd: input.workdir,
                          timeout,
                          shell: selectedShell,
                          background: true,
                          queueTimeout: input.queue_timeout,
                          environment: input.environment,
                          metadata: { sessionID: context.sessionID, toolCallID: context.id },
                        },
                        (invocation) =>
                          Effect.gen(function* () {
                            invocation.env.AGENT = "1"
                            invocation.env.OPENCODE = "1"
                            invocation.env.AI_AGENT ||= "opencode"
                            invocation.env.OPENCODE_SESSION_ID = context.sessionID
                            finalTimeout = yield* prepare(invocation, context, authorized)
                          }),
                        (invocation) =>
                          Effect.gen(function* () {
                            yield* prepare(invocation, context)
                            // Do not ask twice for an unchanged request: an approval
                            // may be once-only. Hook rewrites still require approval.
                            authorized = { command: invocation.command, cwd: invocation.cwd, shell: invocation.shell }
                          }),
                      )
                      .pipe(Effect.onExit((exit) => Deferred.done(accepted, exit)))
                    yield* shell.started(info.id)
                    yield* started
                    const result = yield* shell.result(info)
                    if (!result.capture) return yield* new Shell.NotFoundError({ id: info.id })
                    const output = ShellResult.output(result)
                    return {
                      ...output,
                      output: output.timeout
                        ? `${output.output}\n\nCommand exceeded timeout of ${finalTimeout} ms. Retry with a larger timeout if the command is expected to take longer.`
                        : output.output,
                      status: "completed" as const,
                    }
                  }).pipe(
                    Effect.tap((output) => Deferred.succeed(settled, output)),
                    Effect.map((output) => resultMessages(output).join("\n\n")),
                    Effect.onInterrupt(() => shell.remove(id).pipe(Effect.ignore)),
                  ),
              })
              const info = yield* Deferred.await(accepted).pipe(
                Effect.onExit((exit) =>
                  Exit.isFailure(exit)
                    ? jobs
                        .cancel(job.id)
                        .pipe(
                          Effect.andThen(
                            job.notificationID ? jobs.completeBackground(job.notificationID) : Effect.void,
                          ),
                        )
                    : Effect.void,
                ),
              )
              yield* context.progress({ shellID: info.id })

              if (input.background === true) {
                yield* jobs.background(job.id)
                yield* notifyWhenDone(context.sessionID, job.id, info.id, info.command, settled)
                return backgroundResult(info.id, info.file, (yield* jobs.get(job.id))?.status === "queued")
              }

              const result = yield* jobs
                .block({ id: job.id, sessionID: context.sessionID })
                .pipe(
                  Effect.onInterrupt(() =>
                    jobs
                      .cancel(job.id)
                      .pipe(
                        Effect.andThen(job.notificationID ? jobs.completeBackground(job.notificationID) : Effect.void),
                      ),
                  ),
                )
              if (result?.type === "backgrounded") {
                yield* shell.timeout(info.id, 0)
                yield* notifyWhenDone(context.sessionID, job.id, info.id, info.command, settled)
                return backgroundResult(info.id, info.file, result.info.status === "queued")
              }
              if (job.notificationID) yield* jobs.completeBackground(job.notificationID)
              if (result?.info.status === "error")
                return yield* Effect.fail(new Error(result.info.error ?? "Command failed"))
              if (result?.info.status === "cancelled") return yield* Effect.fail(new Error("Command cancelled"))

              return yield* Deferred.await(settled)
            }).pipe(
              Effect.map(toolResult),
              Effect.mapError(
                (error) => new ToolFailure({ message: `Unable to execute command: ${input.command}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const tool = event.tools[name]
        if (!tool) return
        tool.description = description(ShellSelect.name(yield* compatibleShell))
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
