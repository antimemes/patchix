# The patchix package: the server, the CLI and the web client. The flake and default.nix use it with `callPackage`.
{ lib
, stdenv
, nodejs
, pnpm_12
, fetchPnpmDeps
, pnpmConfigHook
, writeShellApplication
, callPackage
, git
, gh
, zellij
, memelint
, version ? "0-unstable"
}:
let
  fs = lib.fileset;
  # The files that pnpm reads. A change of the code does not change the dependencies.
  manifests = fs.unions [
    ../package.json ../pnpm-lock.yaml ../pnpm-workspace.yaml
    ../packages/common/package.json ../packages/fleet/package.json ../packages/server/package.json ../packages/ui/package.json
  ];

  # The command `patchix`: the web page and the API at http://127.0.0.1:8788/. The package replaces `@root@` with
  # the path of its files.
  # `nix` and `claude` come from the `PATH` of the host. `brotli-check` is the check of `campaigns/brotli`.
  wrapper = writeShellApplication {
    name = "patchix";
    runtimeInputs = [ nodejs git gh zellij memelint (callPackage ../campaigns/brotli/check.nix { }) ];
    excludeShellChecks = [ "SC1090" "SC1091" ];
    text = ''
      export PATCHIX_ROOT=@root@
      export PATCHIX_DATA="''${PATCHIX_DATA:-''${XDG_DATA_HOME:-$HOME/.local/share}/patchix}"
      mkdir -p "$PATCHIX_DATA"
      # GH_TOKEN can be in the .env file of the data directory.
      if [ -f "$PATCHIX_DATA/.env" ]; then set -a; . "$PATCHIX_DATA/.env"; set +a; fi
      exec node "$PATCHIX_ROOT/packages/server/src/main.ts" "$@"
    '';
  };
in
stdenv.mkDerivation (finalAttrs: {
  pname = "patchix";
  inherit version;

  # Only these files: the repository directory also has `node_modules`, `dist`, `state` and `.cache`.
  src = fs.toSource {
    root = ../.;
    fileset = fs.unions [
      manifests ../tsconfig.base.json ../campaigns ../packages/ui/build.ts ../packages/ui/tsconfig.json
      ../packages/common/src ../packages/fleet/src ../packages/server/src ../packages/ui/src
    ];
  };

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname;
    src = fs.toSource { root = ../.; fileset = manifests; };
    pnpm = pnpm_12;
    fetcherVersion = 4;
    hash = "sha256-E5bcZa0+lBYcO7LosyJGRgxgfbN/tPWLF7GrauN5qC4=";
  };

  nativeBuildInputs = [ nodejs pnpm_12 pnpmConfigHook ];

  # `pnpmConfigHook` installs all the dependencies. esbuild builds the web client. Then `pnpm install --prod`
  # removes the `devDependencies` from the package.
  buildPhase = ''
    runHook preBuild
    pnpm --filter @patchix/ui build
    rm -rf node_modules packages/*/node_modules
    pnpm install --offline --prod --frozen-lockfile --ignore-scripts
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/patchix $out/bin
    cp -r package.json pnpm-workspace.yaml node_modules packages campaigns $out/lib/patchix/
    substitute ${wrapper}/bin/patchix $out/bin/patchix --replace-fail @root@ $out/lib/patchix
    chmod +x $out/bin/patchix
    runHook postInstall
  '';

  meta = {
    description = "Fleets of agents that fix packages of nixpkgs";
    homepage = "https://github.com/antimemes/patchix";
    mainProgram = "patchix";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
})
