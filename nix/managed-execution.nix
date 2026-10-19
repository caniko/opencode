{
  lib,
  stdenvNoCC,
  bun,
  nodejs,
  git,
  models-dev,
  node_modules,
}:
stdenvNoCC.mkDerivation {
  pname = "opencode-managed-execution";
  inherit (node_modules) src version;
  nativeBuildInputs = [bun nodejs git];
  env.MODELS_DEV_API_JSON = "${models-dev}/dist/_api.json";
  env.OPENCODE_DISABLE_MODELS_FETCH = true;
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    cp -R ${node_modules}/. .
    chmod -R u+w .
    patchShebangs node_modules packages/*/node_modules
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME" "$out"
    cd packages/core
    bun run script/test.ts --retry 0 --reporter junit --reporter-outfile "$out/core.xml" \
      test/session-external.test.ts test/session-execution.test.ts \
      test/session-environment.test.ts test/v1-migration.test.ts test/session-create.test.ts
    cd ../cli
    bun test --retry 0 --reporter junit --reporter-outfile "$out/cli.xml" \
      test/service-readiness.test.ts test/session-external.test.ts
    cd ../server
    bun test --retry 0 --reporter junit --reporter-outfile "$out/server.xml" test/session-external.test.ts
    # No selected assertion may be skipped or retried into a pass.
    for report in "$out/core.xml" "$out/cli.xml" "$out/server.xml"; do
      test -s "$report"
      grep -q '<testcase' "$report"
    done
    ! grep -E ' (failures|errors|skipped)="[1-9][0-9]*"|<(skipped|failure|error|rerunFailure|flakyFailure)([ />])' "$out/"*.xml
    runHook postBuild
  '';
  dontInstall = true;
  meta.platforms = lib.platforms.linux;
}
