{
  pkgs,
  toolbelt,
}: let
  inherit (pkgs) lib;
  evaluate = enabled:
    lib.evalModules {
      specialArgs = {inherit pkgs;};
      modules = [
        (import ./home-manager.nix {inherit toolbelt;})
        {
          options.home.packages = lib.mkOption {
            type = lib.types.listOf lib.types.package;
            default = [];
          };
          options.programs.opencode = {
            enable = lib.mkOption {
              type = lib.types.bool;
              default = false;
            };
            settings = lib.mkOption {
              type = lib.types.attrs;
              default = {};
            };
          };
        }
        {
          programs.opencode = {
            enable = true;
            browserConnection = {
              enable = enabled;
              headless = true;
            };
          };
        }
      ];
    };
  enabled = (evaluate true).config;
  disabled = (evaluate false).config;
  plugin = builtins.head enabled.programs.opencode.settings.plugins;
in
  assert plugin.package == "opencode.browser";
  assert plugin.options.host == enabled.canix-toolbelt.browserConnection.adapters.opencode;
  assert enabled.canix-toolbelt.browserConnection.headless;
  assert !disabled.canix-toolbelt.browserConnection.enable;
  assert disabled.programs.opencode.settings == {};
    pkgs.writeText "opencode-browser-connection-eval" "ok"
