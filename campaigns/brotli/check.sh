#!/bin/sh
# The check `scanner` of the `brotli` campaign (NixOS/nixpkgs#578375, CVE-2026-111497). `check.nix` makes the command
# `brotli-check` from this file. It gives the scanner in `$SCANNER`, the commit of the scanner in `$SCANNER_REV`,
# `verdict.py` in `$VERDICT`, and `python3`, `nix` and `curl` in the `PATH`.
#
# The command builds `<attr>` of two nixpkgs sources, "after" and "before". Then the standalone scanner of
# `trailofbits/brotli-checker` examines each output, and `verdict.py` compares the two reports. The scanner does not
# start the files that it examines. Start the command in a nixpkgs checkout. With `--pr`, it does not use a checkout.
#
# - `brotli-check <attr> --base <commit>`: "after" is the checkout, and "before" is the commit `<commit>` of
#   NixOS/nixpkgs. patchix starts it in the worktree of the task.
# - `brotli-check <attr> --pr <number>`: "after" is the tip of the pull request `<number>` of NixOS/nixpkgs, and
#   "before" is its base commit. The GitHub API gives the two commits. A person can start it without a checkout:
#   `nix run github:antimemes/patchix#brotli-check -- <attr> --pr <number>`.
# - `brotli-check <attr>`: "after" is the checkout, and there is no "before".
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
# - `VERDICT <attr>: MARKED INSECURE`: `meta.knownVulnerabilities` of `<attr>` of "after" has the CVE. The check does
#   not build.
# - `VERDICT <attr>: UNKNOWN (...)`: no bad copy after, and no bad copy before. Thus the scanner cannot see the copy
#   of the issue, or there is no "before".
#
# The exit code is 0 when the output has a verdict. It is 1 when the GitHub API, the build of "after" or the scanner
# stops with an error. It is 2 when the arguments are not correct.
set -eu

usage() {
  echo "usage: brotli-check <attr> [--base <commit> | --pr <number>]"
}

wrong_usage() {
  usage >&2
  exit 2
}

attr='' base='' pr=''
while [ $# -gt 0 ]; do
  case $1 in
    -h | --help) usage; exit 0 ;;
    --base) [ $# -ge 2 ] || wrong_usage; base=$2; shift 2 ;;
    --pr) [ $# -ge 2 ] || wrong_usage; pr=$2; shift 2 ;;
    -*) wrong_usage ;;
    *) [ -z "$attr" ] || wrong_usage; attr=$1; shift ;;
  esac
done
[ -n "$attr" ] || wrong_usage
[ -z "$base" ] || [ -z "$pr" ] || wrong_usage
case $pr in *[!0-9]*) wrong_usage ;; esac

cve=CVE-2026-111497
archive=https://github.com/NixOS/nixpkgs/archive
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

after=./.
after_name="this checkout"
if [ -n "$pr" ]; then
  # One reply of the GitHub API gives the base commit and the tip. Thus the two commits agree, and the output gives
  # the commit of "after". Nix keeps the archive of a URL for one hour: thus a URL without the commit can give a tip
  # before the last push. With `GH_TOKEN`, the request has the token: without a token, the API accepts only 60 requests
  # in one hour. `-H @-` reads the header from stdin: thus the token is not in the command line of `curl`.
  url=https://api.github.com/repos/NixOS/nixpkgs/pulls/$pr
  if [ -n "${GH_TOKEN:-}" ]; then
    printf 'Authorization: Bearer %s\n' "$GH_TOKEN" | curl -fsSL -H @- "$url" >"$tmp/pull.json"
  else
    curl -fsSL "$url" >"$tmp/pull.json"
  fi || { echo "the GitHub API request for NixOS/nixpkgs#$pr stopped with an error (without GH_TOKEN, the API accepts 60 requests in one hour)" >&2; exit 1; }
  commits=$(python3 -I -c 'import json, sys; p = json.load(sys.stdin); print(p["base"]["sha"], p["head"]["sha"])' <"$tmp/pull.json")
  base=${commits% *}
  after=$archive/${commits#* }.tar.gz
  after_name="NixOS/nixpkgs#$pr at ${commits#* }"
fi

if nix-instantiate --eval --strict --json "$after" -A "$attr.meta.knownVulnerabilities" 2>/dev/null | grep -q "$cve"; then
  echo "meta.knownVulnerabilities of $attr has $cve."
  echo "VERDICT $attr: MARKED INSECURE"
  exit 0
fi

echo "scanner: trailofbits/brotli-checker@$SCANNER_REV"

# `side <name> <nixpkgs>` builds `<attr>` of `<nixpkgs>` and examines the output paths with the scanner. The build log
# and the JSON go into `$tmp/<name>.log` and `$tmp/<name>.json`. It gives 1 when the build stops with an error. The
# scanner gives exit code 1 when a copy has or can have the problem, and 3 when a person must examine its output. Each
# other code stops the check with exit code 1.
side() {
  paths=$(nix-build --no-out-link -Q "$2" -A "$attr" 2>"$tmp/$1.log") || { tail -n 30 "$tmp/$1.log" >&2; return 1; }
  code=0
  # The scanner uses only the standard library. With `-E -s`, Python does not read `PYTHONPATH` and the packages of
  # the user. Do not use `-I`: the scanner imports the modules in the directory of its script.
  # Not `"$paths"`: each output path is one argument.
  python3 -E -s "$SCANNER" --json --max-files 1000000 $paths >"$tmp/$1.json" || code=$?
  case $code in
    0 | 1 | 3) ;;
    *) echo "the scanner stopped with exit code $code" >&2; exit 1 ;;
  esac
}

echo "after: nix-build -A $attr ($after_name)"
side after "$after" || { echo "the build of $attr stopped with an error"; exit 1; }
if [ -n "$base" ]; then
  echo "before: nix-build -A $attr (NixOS/nixpkgs@$base)"
  side before "$archive/$base.tar.gz" || echo "before: the build stopped with an error"
fi

python3 -I "$VERDICT" "$attr" "$tmp/before.json" "$tmp/after.json"
