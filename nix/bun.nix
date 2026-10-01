{
  bun,
  fetchurl,
  stdenvNoCC,
}: let
  releases = {
    x86_64-linux = {
      asset = "bun-linux-x64-baseline.zip";
      hash = "sha256-xngEDxT+BEDrg503y9DOTAUaMtpygGrJfeamqra/co8=";
    };
    aarch64-linux = {
      asset = "bun-linux-aarch64.zip";
      hash = "sha256-VDKLvC2cjgyfiSxUTWbFeoO4QTnjSQnl7oF1jxrI/ac=";
    };
    x86_64-darwin = {
      asset = "bun-darwin-x64-baseline.zip";
      hash = "sha256-utW71s8U0JgNEV9ZVMn/kE32GdXplNLaH/zNPzFjALA=";
    };
    aarch64-darwin = {
      asset = "bun-darwin-aarch64.zip";
      hash = "sha256-kJh6OhbX21VtiGrD1VHnttPt8KHPQ6yu1iLoZ2vh0S8=";
    };
  };
  release = releases.${stdenvNoCC.hostPlatform.system};
in
  bun.overrideAttrs (_: {
    version = "1.4.2";
    src = fetchurl {
      url = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/${release.asset}";
      inherit (release) hash;
    };
  })
