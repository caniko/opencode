{toolbelt}: {
  config,
  lib,
  ...
}: let
  cfg = config.programs.opencode.browserConnection;
in {
  imports = [toolbelt.homeModules.browser-connection];

  options.programs.opencode.browserConnection = {
    enable = lib.mkEnableOption "native OpenCode browser tools from terminal sessions";
    headless = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Run the actual default browser in an isolated headless automation profile.";
    };
    browser = lib.mkOption {
      type = lib.types.nullOr (lib.types.submodule {
        options = {
          family = lib.mkOption {type = lib.types.enum ["firefox" "chromium"];};
          executable = lib.mkOption {type = lib.types.str;};
          arguments = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [];
          };
        };
      });
      default = null;
      description = "Optional browser override. Null connects the XDG default browser at runtime.";
    };
  };

  config = lib.mkIf (config.programs.opencode.enable && cfg.enable) {
    canix-toolbelt.browserConnection = {
      enable = true;
      inherit (cfg) headless browser;
    };
    programs.opencode.settings.plugins = [
      {
        package = "opencode.browser";
        options.host = config.canix-toolbelt.browserConnection.adapters.opencode;
      }
    ];
  };
}
