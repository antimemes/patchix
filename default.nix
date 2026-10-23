# The patchix package without flakes: `nix-build` gives `result/bin/patchix`. The nixpkgs and the memelint source
# come from flake.lock: thus they are the same as in the flake.
let
  lockedSources = import ./nix/locked-sources.nix { };
in
{ system ? builtins.currentSystem
, nixpkgs ? lockedSources.nixpkgs
, memelintSrc ? lockedSources.memelint
, pkgs ? import nixpkgs { inherit system; }
}:
pkgs.callPackage ./nix/package.nix { memelint = (import "${memelintSrc}/nix/package.nix" { inherit pkgs; }).default; }
