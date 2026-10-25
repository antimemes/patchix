# The shell for this repository: start it with `nix-shell`, `nix develop` or `direnv allow`.
# The nixpkgs, the memelint source and the nixpkgs of `zellij` come from flake.lock. The flake gives its packages as
# arguments.
let
  lockedSources = import ./nix/locked-sources.nix { };
in
{ pkgs ? import lockedSources.nixpkgs { }
, memelint ? (import "${lockedSources.memelint}/nix/package.nix" { inherit pkgs; }).default
, zellij ? (import lockedSources.nixpkgs-zellij { inherit (pkgs.stdenv.hostPlatform) system; }).zellij
}:
pkgs.mkShell {
  # Chromium records the tour video. nixpkgs has it only for Linux.
  packages = with pkgs; [ nodejs pnpm git jq gh go-task zellij memelint ] ++ pkgs.lib.optional pkgs.stdenv.hostPlatform.isLinux chromium;
  shellHook = ''
    # GH_TOKEN is in .env (not in git).
    if [ -f .env ]; then set -a; . ./.env; set +a; fi
    echo "patchix shell: node $(node --version), pnpm $(pnpm --version)"
  '';
}
