{
  description = "OpenCode development flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    canix-toolbelt = {
      url = "github:caniko/canix-toolbelt/9caf679440076addbde1ba9bb0786a29d59cd5f6";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    self,
    nixpkgs,
    canix-toolbelt,
    ...
  }: let
    systems = [
      "aarch64-linux"
      "x86_64-linux"
      "aarch64-darwin"
    ];
    forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    rev = self.shortRev or self.dirtyShortRev or "dirty";
  in {
    homeModules.browser-connection = import ./nix/home-manager.nix {toolbelt = canix-toolbelt;};
    homeManagerModules.browser-connection = self.homeModules.browser-connection;
    checks = forEachSystem (pkgs:
      {
        browser-connection = import ./nix/browser-connection-eval.nix {
          inherit pkgs;
          toolbelt = canix-toolbelt;
        };
      }
      // pkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
        managed-execution = pkgs.callPackage ./nix/managed-execution.nix {
          bun = pkgs.callPackage ./nix/bun.nix {};
          node_modules = self.packages.${pkgs.stdenv.hostPlatform.system}.opencode.node_modules;
        };
      });
    devShells = forEachSystem (pkgs: {
      default = pkgs.mkShell {
        packages = with pkgs;
          [
            nodejs
            pkg-config
            openssl
            git
          ]
          ++ [(pkgs.callPackage ./nix/bun.nix {})];
      };
    });

    overlays = {
      default = final: _prev: let
        bun = final.callPackage ./nix/bun.nix {};
        node_modules = final.callPackage ./nix/node_modules.nix {
          inherit rev bun;
        };
      in rec {
        opencode = final.callPackage ./nix/opencode.nix {
          inherit node_modules bun;
        };
        opencode-desktop = final.callPackage ./nix/desktop.nix {
          inherit opencode;
        };
      };
    };

    packages = forEachSystem (
      pkgs: let
        bun = pkgs.callPackage ./nix/bun.nix {};
        node_modules = pkgs.callPackage ./nix/node_modules.nix {
          inherit rev bun;
        };
      in rec {
        default = opencode;
        opencode = pkgs.callPackage ./nix/opencode.nix {
          inherit node_modules bun;
        };
        opencode-desktop = pkgs.callPackage ./nix/desktop.nix {
          inherit opencode;
        };
        # Updater derivation with fakeHash - build fails and reveals correct hash
        node_modules_updater = node_modules.override {
          hash = pkgs.lib.fakeHash;
        };
      }
    );
  };
}
