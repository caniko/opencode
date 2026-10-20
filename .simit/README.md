# CI templates

`simit.toml` maps `.simit/templates/test.yml` to `.github/workflows/test.yml`.
Edit the template, then regenerate and verify from the repository root:

```sh
simit init ci --platform github --ci-provider actions --runtime nix
simit init ci --platform github --ci-provider actions --runtime nix --check --diff
```

The template mechanism was verified with published Simit revision
`c80345688cc82ba330b0b79b4c610cbc8b4c38d5` (36 template integration tests).
The installed Simit must support `[ci.workflow_templates]`.

Hosted diagnostics use the existing `test.yml` dispatch on the candidate ref:

```sh
gh workflow run test.yml --repo caniko/opencode --ref vendor-release-v2 -f suite=timeline-history
gh workflow run test.yml --repo caniko/opencode --ref vendor-release-v2 -f suite=cli-startup
gh workflow run test.yml --repo caniko/opencode --ref vendor-release-v2 -f suite=npm-git
gh workflow run test.yml --repo caniko/opencode --ref core-context-probe -f suite=core-context
gh workflow run test.yml --repo caniko/opencode --ref vendor-release-v2 -f suite=composer
gh workflow run test.yml --repo caniko/opencode --ref vendor-release-v2 -f suite=all
```

The focused selections run fixed keeper paths on Linux and Windows. Timeline
diagnostics retain traces on every attempt plus paging-state JSON on failure.
CLI diagnostics enable debug logging and retain child output and pre-cleanup exit state in failure logs.
Git-package diagnostics run the existing Npm keeper with Git command and timing
traces. Composer diagnostics retain browser traces on every attempt and report
caret, viewport and selection state from the unchanged visibility predicate.
Only `all` exercises the complete unit/E2E gate; focused runs do not establish
full candidate acceptance. Push and pull-request events retain the full selection.

`core-context` runs the entire Core shard and its normal build dependencies once,
uncached and serial at the task level, on both hosted platforms. The test-only
`OPENCODE_TEST_JUNIT` environment variable passes through only to Core's test
task, so dependency builds receive no reporter arguments. It preserves test
order, assertions, offline enforcement and deadlines, and retains the log,
exit status and Bun JUnit test timings even on failure. It skips CLI, remaining
packages and browser gates, so it is diagnostic evidence, not full acceptance.
