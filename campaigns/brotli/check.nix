# The command `brotli-check`: the check `scanner` of the `brotli` campaign, for patchix and for a person without a
# checkout (`nix run github:antimemes/patchix#brotli-check -- <attr> --pr <number>`). check.sh tells the arguments and
# the verdicts. The commit and the hash of the scanner are in this file.
{ writeShellApplication, fetchFromGitHub, python3, nix, curl, gnupatch }:
let
  checker = fetchFromGitHub {
    owner = "trailofbits";
    repo = "brotli-checker";
    rev = "7a585c00589471351b6625a46574c7173720ada0";
    hash = "sha256-M61Ki9727e3j/0lOcEtlrY+uj8SQYfMnaro8+kFyV0A=";
  };
in
writeShellApplication {
  name = "brotli-check";
  runtimeInputs = [ python3 nix curl gnupatch ];
  text = ''
    export SCANNER=${checker}/skills/brotli-checker/scripts/brotli_inventory.py
    export SCANNER_REV=${checker.rev}
    export VERDICT=${./verdict.py}
    exec sh ${./check.sh} "$@"
  '';
}
