import { expect, test } from "bun:test"
import { Permission } from "@opencode/core/permission"

const rules: Permission.Ruleset = [
  { action: "shell", resource: "*", effect: "ask" },
  { action: "shell", resource: "*=* canix workspace update *", effect: "allow" },
  { action: "shell", resource: "*=* /nix/store/*/bin/canix workspace update *", effect: "allow" },
  { action: "shell", resource: "*=* ./result/bin/canix workspace update *", effect: "allow" },
  { action: "shell", resource: "*=* nix-*", effect: "deny" },
]

test.each([
  "RUST_LOG=info canix workspace update plan --project nix-theme-broker",
  "RUST_LOG=info /nix/store/example-canix/bin/canix workspace update --project nix-theme-broker",
  "RUST_LOG=info ./result/bin/canix workspace update plan --project nix-theme-broker",
])("shell environment twins do not match later arguments: %s", (command) => {
  expect(Permission.evaluate("shell", command, rules).effect).toBe("allow")
})

test.each(["RUST_LOG=info", "A='nix-build ignored' B=", 'A="two words"'])(
  "shell environment twins stop at the executable after %s",
  (prefix) => {
    expect(
      Permission.evaluate("shell", `${prefix} canix workspace update --project nix-theme-broker`, rules).effect,
    ).toBe("allow")
    expect(Permission.evaluate("shell", `${prefix} nix-build .`, rules).effect).toBe("deny")
  },
)

test.each([
  "RUST_LOG=$LEVEL canix workspace update status",
  "X=1 Y=$(id) canix workspace update",
  "X=hello\\ world canix workspace update",
  "X='unfinished canix workspace update",
])("unknown shell environment values cannot gain generic allows: %s", (command) => {
  expect(Permission.evaluate("shell", command, rules).effect).toBe("ask")
})

test("unknown shell environment values retain restrictive matching", () => {
  expect(Permission.evaluate("shell", "X=$(id) nix-build .", rules).effect).toBe("deny")
  expect(
    Permission.evaluate("shell", "X=$LEVEL canix workspace update", [
      { action: "shell", resource: "*=* canix workspace update *", effect: "ask" },
    ]).effect,
  ).toBe("ask")
})

test("other rules keep whole-resource matching and last-match precedence", () => {
  const command = "X=$LEVEL canix workspace update"
  expect(
    Permission.evaluate("shell", command, rules, [{ action: "shell", resource: "X=* canix *", effect: "allow" }])
      .effect,
  ).toBe("allow")
  expect(
    Permission.evaluate("custom", command, [{ action: "*", resource: "*=* canix workspace update *", effect: "allow" }])
      .effect,
  ).toBe("allow")
  expect(Permission.evaluate("shell", "echo X=1 canix workspace update", rules).effect).toBe("ask")
  expect(
    Permission.evaluate("shell", "canix --output=json workspace update --project nix-theme-broker", rules).effect,
  ).toBe("ask")
})
