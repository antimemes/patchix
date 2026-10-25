# `nix run` starts the server, `nix develop` gives the shell of shell.nix. The package is in nix/package.nix.
# default.nix and shell.nix read the same inputs from flake.lock with nix/locked-sources.nix.
{
  description = "patchix: fleets of agents that fix packages of nixpkgs";

  inputs = {
    # The channel tarball: cache.nixos.org has the packages of this commit.
    nixpkgs.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.xz";
    # memelint uses the nixpkgs of patchix.
    memelint = {
      url = "github:antimemes/memelint/bf5518cc9e43ae2afd3b6252d06daa2ac7176934";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # `zellij` 0.45 removes the tabs that patchix opens before a person attaches to the session (zellij-org/zellij#5594).
    # This commit of `nixos-unstable` has `zellij` 0.44.3, and cache.nixos.org has its build. Remove this input when a
    # release has the fix (zellij-org/zellij#5612).
    nixpkgs-zellij.url = "github:NixOS/nixpkgs/1055f58374f42fd07626aec0ef4fb1d658add341";
  };

  outputs = { self, nixpkgs, memelint, nixpkgs-zellij }:
    let
      forAllSystems = f: nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ]
        (system: f system nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (system: pkgs: {
        default = pkgs.callPackage ./nix/package.nix {
          memelint = memelint.packages.${system}.default;
          zellij = nixpkgs-zellij.legacyPackages.${system}.zellij;
          version = "0-unstable-${builtins.substring 0 8 (self.lastModifiedDate or "19700101")}";
        };
        # The check of `campaigns/brotli`. A person starts it with `nix run github:antimemes/patchix#brotli-check`.
        brotli-check = pkgs.callPackage ./campaigns/brotli/check.nix { };
      });

      apps = forAllSystems (system: pkgs: {
        default = {
          type = "app";
          program = pkgs.lib.getExe self.packages.${system}.default;
          meta.description = "patchix: the web page and the API at http://127.0.0.1:8788/";
        };
        brotli-check = {
          type = "app";
          program = pkgs.lib.getExe self.packages.${system}.brotli-check;
          meta.description = "The check of the brotli campaign: brotli-check <attr> --pr <number> [--onto <ref>]";
        };
      });

      devShells = forAllSystems (system: pkgs: {
        default = import ./shell.nix {
          inherit pkgs;
          memelint = memelint.packages.${system}.default;
          zellij = nixpkgs-zellij.legacyPackages.${system}.zellij;
        };
      });
    };
}
