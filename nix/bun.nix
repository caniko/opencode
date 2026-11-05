{
  bun,
  fetchurl,
  stdenvNoCC,
}: let
  releases = {
    x86_64-linux = {
      asset = "bun-linux-x64-baseline.zip";
      hash = "sha256-4ERutVmVdy65iUvrrppr42jZhai5Jx7hJEhvmUbu3XY=";
    };
    aarch64-linux = {
      asset = "bun-linux-aarch64.zip";
      hash = "sha256-uqa7NvUdblhWHgK76oJQOKnfRU9nPW13bou/hvjHhQ4=";
    };
    x86_64-darwin = {
      asset = "bun-darwin-x64-baseline.zip";
      hash = "sha256-1KFVrfv9CRVes7oFyeOlRPOSl9emhhbTx3WfZ6tcR9w=";
    };
    aarch64-darwin = {
      asset = "bun-darwin-aarch64.zip";
      hash = "sha256-wkDX8My5DCY6hJ/NsJt+5iYw2SE0jtaq/ahrnVd7xRA=";
    };
  };
  release = releases.${stdenvNoCC.hostPlatform.system};
in
  bun.overrideAttrs (_: {
    version = "1.4.4";
    src = fetchurl {
      url = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/${release.asset}";
      inherit (release) hash;
    };
  })
