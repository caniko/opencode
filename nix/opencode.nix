{
  lib,
  stdenvNoCC,
  callPackage,
  bun,
  nodejs,
  sysctl,
  makeBinaryWrapper,
  models-dev,
  ripgrep,
  wayland,
  installShellFiles,
  versionCheckHook,
  writableTmpDirAsHomeHook,
  node_modules ? callPackage ./node-modules.nix {},
}:
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "opencode";
  inherit (node_modules) version src;
  inherit node_modules;

  nativeBuildInputs = [
    bun
    nodejs # for patchShebangs node_modules
    installShellFiles
    makeBinaryWrapper
    models-dev
    writableTmpDirAsHomeHook
  ];

  configurePhase = ''
    runHook preConfigure

    cp -R ${finalAttrs.node_modules}/. .
    patchShebangs node_modules
    patchShebangs packages/*/node_modules

    runHook postConfigure
  '';

  env.MODELS_DEV_API_JSON = "${models-dev}/dist/_api.json";
  env.OPENCODE_DISABLE_MODELS_FETCH = true;
  env.OPENCODE_VERSION = finalAttrs.version;
  env.OPENCODE_CHANNEL = "prod";
  env.NODE_OPTIONS = "--max-old-space-size=4096";

  buildPhase = ''
    runHook preBuild

    cd ./packages/cli
    bun --bun ./script/build.ts --single --skip-install

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm755 dist/cli-*/bin/opencode $out/bin/opencode

    # OpenTUI dlopens Wayland for clipboard images.
    wrapProgram $out/bin/opencode \
      --prefix PATH : ${
      lib.makeBinPath (
        [
          ripgrep
        ]
        # bun runs sysctl to detect if running on rosetta2
        ++ lib.optional stdenvNoCC.hostPlatform.isDarwin sysctl
      )
    } ${lib.optionalString stdenvNoCC.hostPlatform.isLinux ''
      --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [wayland]}
    ''}

    ln -s opencode $out/bin/opencode2

    runHook postInstall
  '';

  postInstall = lib.optionalString (stdenvNoCC.buildPlatform.canExecute stdenvNoCC.hostPlatform) ''
    installShellCompletion --cmd opencode \
      --bash <($out/bin/opencode --completions bash) \
      --zsh <($out/bin/opencode --completions zsh) \
      --fish <($out/bin/opencode --completions fish)

    installShellCompletion --cmd opencode2 \
      --bash <($out/bin/opencode2 --completions bash) \
      --zsh <($out/bin/opencode2 --completions zsh) \
      --fish <($out/bin/opencode2 --completions fish)
  '';

  nativeInstallCheckInputs = [
    versionCheckHook
    writableTmpDirAsHomeHook
  ];
  doInstallCheck = true;
  versionCheckKeepEnvironment = ["HOME" "OPENCODE_DISABLE_MODELS_FETCH"];
  versionCheckProgramArg = "--version";

  passthru = {
    inherit (finalAttrs) env;
  };

  meta = {
    description = "The open source coding agent";
    homepage = "https://opencode.ai";
    license = lib.licenses.mit;
    mainProgram = "opencode";
    inherit (node_modules.meta) platforms;
  };
})
