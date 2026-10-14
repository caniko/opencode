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
gh workflow run test.yml --repo caniko/opencode --ref vendor-release-v2 -f suite=all
```

The two focused selections run fixed keeper paths on Linux and Windows. Timeline
diagnostics retain traces on every attempt plus paging-state JSON on failure.
CLI diagnostics enable debug logging and retain child output and pre-cleanup exit state in failure logs.
Only `all` exercises the complete unit/E2E gate; focused runs do not establish
full candidate acceptance. Push and pull-request events retain the full selection.
