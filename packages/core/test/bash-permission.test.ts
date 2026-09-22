import { expect, test } from "bun:test"
import { BashPermission } from "../src/util/bash-permission"
import { PermissionV2 } from "../src/permission"

test("permission evaluation does not let the Nix deny match a project argument", () => {
  const rules: PermissionV2.Ruleset = [
    { action: "bash", resource: "*", effect: "ask" },
    { action: "bash", resource: "*=* canix update *", effect: "allow" },
    { action: "bash", resource: "*=* nix-*", effect: "deny" },
  ]
  expect(
    PermissionV2.evaluate("bash", "RUST_LOG=info canix update plan --project nix-theme-broker", rules).effect,
  ).toBe("allow")
  expect(PermissionV2.evaluate("bash", "RUST_LOG=info nix-build .", rules).effect).toBe("deny")
})

test("environment twins match the executable, not an argument", () => {
  for (const prefix of ["RUST_LOG=info", "A='nix-build ignored' B=", 'A="two words"']) {
    const command = `${prefix} canix update plan --project nix-theme-broker`
    expect(BashPermission.match(command, "*=* canix update *", "allow")).toBe(true)
    expect(BashPermission.match(command, "*=* nix-*", "deny")).toBe(false)
    expect(BashPermission.match(`${prefix} nix-build .`, "*=* nix-*", "deny")).toBe(true)
  }
  expect(
    BashPermission.match("X=1 /nix/store/example/bin/canix update", "*=* /nix/store/*/bin/canix update *", "allow"),
  ).toBe(true)
  expect(BashPermission.match("X=1 canix update", "X=* canix *", "deny")).toBe(true)
  expect(BashPermission.match("echo X=1 canix update", "*=* canix update *", "allow")).toBe(false)
  expect(BashPermission.match("canix --output=json update plan --project nix-theme-broker", "*=* nix-*", "deny")).toBe(
    false,
  )
})

test("unsupported assignments cannot gain generic environment allows", () => {
  for (const command of [
    "X=$HOME canix update",
    "X=1 Y=$(id) canix update",
    "X=hello\\ world canix update",
    "X='unfinished canix update",
  ]) {
    expect(BashPermission.match(command, "*=* canix update *", "allow")).toBe(false)
  }
  expect(BashPermission.match("X=$(id) nix-build .", "*=* nix-*", "deny")).toBe(true)
  expect(BashPermission.match("X=$HOME canix update", "*=* canix update *", "ask")).toBe(true)
})
