# The patchix package without flakes: `nix-build` gives `result/bin/patchix`. The nixpkgs, the memelint source and
# the nixpkgs of `zellij` come from flake.lock: thus they are the same as in the flake.
let
  lockedSources = import ./nix/locked-sources.nix { };
in
{ system ? builtins.currentSystem
, nixpkgs ? lockedSources.nixpkgs
, memelintSrc ? lockedSources.memelint
, nixpkgsZellij ? lockedSources.nixpkgs-zellij
, pkgs ? import nixpkgs { inherit system; }
}:
pkgs.callPackage ./nix/package.nix {
  memelint = (import "${memelintSrc}/nix/package.nix" { inherit pkgs; }).default;
  zellij = (import nixpkgsZellij { inherit system; }).zellij;
}
