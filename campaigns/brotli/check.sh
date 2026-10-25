#!/bin/sh
# The check `scanner` of the `brotli` campaign (NixOS/nixpkgs#578375, CVE-2026-111497). The command is
# `sh check.sh <attr> [<base>]`.
#
# Start it in a nixpkgs checkout: patchix starts it in the worktree of the task. It builds `<attr>` of the checkout
# ("after") and of the commit `<base>` of NixOS/nixpkgs ("before"). Then the standalone scanner of
# `trailofbits/brotli-checker` examines each output, and `verdict.py` compares the two reports. The scanner does not
# start the files that it examines.
#
# A copy is an entry of the scanner report that shows the source or the code of the decoder in a file of the package.
# For example: a source file of the decoder, or its code, its version or its names in a binary. An import of the
# shared library `libbrotlidec` is not a copy. `verdict.py` has the list of the values of `kind`. A bad copy is a copy
# without one of these values of `patch_status`: `fixed_source`, `fixed_code_match` or `upstream_fixed_version`. Thus
# a copy with an unknown version is a bad copy, and its removal is the fix.
#
# The last line of the output is the verdict:
#
# - `VERDICT <attr>: FIXED`: the scanner finds a bad copy before, and no bad copy after.
# - `VERDICT <attr>: NOT FIXED`: the scanner finds a bad copy after. When the scanner found each bad copy only by its
#   `BrotliDecoderVersion`, the verdict tells it: a patch of the bundled source keeps the version.
# - `VERDICT <attr>: MARKED INSECURE`: `meta.knownVulnerabilities` of `<attr>` has the CVE. The check does not build.
# - `VERDICT <attr>: UNKNOWN (...)`: no bad copy after, and no bad copy before. Thus the scanner cannot see the copy
#   of the issue, or there is no "before".
#
# The exit code is 0 when the output has a verdict. It is 1 when the build of "after" or the scanner stops with an
# error.
set -eu

attr=$1
base=${2:-}
root=$(dirname "$0")
cve=CVE-2026-111497
rev=7a585c00589471351b6625a46574c7173720ada0
hash=sha256-M61Ki9727e3j/0lOcEtlrY+uj8SQYfMnaro8+kFyV0A=
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if nix-instantiate --eval --strict --json ./. -A "$attr.meta.knownVulnerabilities" 2>/dev/null | grep -q "$cve"; then
  echo "meta.knownVulnerabilities of $attr has $cve."
  echo "VERDICT $attr: MARKED INSECURE"
  exit 0
fi

# The scanner and Python come from the nixpkgs of the checkout. The scanner uses only the standard library. With
# `-E -s`, Python does not read `PYTHONPATH` and the packages of the user. Do not use `-I`: the scanner imports the
# modules in the directory of its script.
checker=$(nix-build --no-out-link -Q -E "(import ./. { }).fetchFromGitHub { owner = \"trailofbits\"; repo = \"brotli-checker\"; rev = \"$rev\"; hash = \"$hash\"; }")
python=$(nix-build --no-out-link -Q ./. -A python3.out)/bin/python3
scanner=$checker/skills/brotli-checker/scripts/brotli_inventory.py
echo "scanner: trailofbits/brotli-checker@$rev"

# `side <name> <nixpkgs>` builds `<attr>` of `<nixpkgs>` and examines the output paths with the scanner. The build log
# and the JSON go into `$tmp/<name>.log` and `$tmp/<name>.json`. It gives 1 when the build stops with an error. The
# scanner gives exit code 1 when a copy has or can have the problem, and 3 when a person must examine its output. Each
# other code stops the check with exit code 1.
side() {
  paths=$(nix-build --no-out-link -Q "$2" -A "$attr" 2>"$tmp/$1.log") || { tail -n 30 "$tmp/$1.log" >&2; return 1; }
  code=0
  # Not `"$paths"`: each output path is one argument.
  "$python" -E -s "$scanner" --json --max-files 1000000 $paths >"$tmp/$1.json" || code=$?
  case $code in
    0 | 1 | 3) ;;
    *) echo "the scanner stopped with exit code $code" >&2; exit 1 ;;
  esac
}

echo "after: nix-build -A $attr (this checkout)"
side after ./. || { echo "the build of $attr stopped with an error"; exit 1; }
if [ -n "$base" ]; then
  echo "before: nix-build -A $attr (NixOS/nixpkgs@$base)"
  side before "https://github.com/NixOS/nixpkgs/archive/$base.tar.gz" || echo "before: the build stopped with an error"
fi

"$python" -E -s "$root/verdict.py" "$attr" "$tmp/before.json" "$tmp/after.json"
