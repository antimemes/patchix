#!/bin/sh
# The check `scanner` of the `brotli` campaign (NixOS/nixpkgs#578375, CVE-2026-111497). `check.nix` makes the command
# `brotli-check` from this file. It gives the scanner in `$SCANNER`, the commit of the scanner in `$SCANNER_REV`,
# `verdict.py` in `$VERDICT`, and `python3`, `nix`, `curl`, `patch` and `nm` in the `PATH`.
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
# - `--onto <ref>`, with `--base` or with `--pr`: the same change on a different branch or commit `<ref>` of
#   NixOS/nixpkgs. For example `staging`, when `staging` has the fixed `brotli` and `master` does not have it.
#   "before" is the tip of `<ref>`, and "after" is the tip of `<ref>` with the change. With `--base`, the change is
#   `git diff <commit> HEAD` of the checkout, and `git` comes from the `PATH` of the host. With `--pr`, the change is
#   the diff of the pull request. `patch -p1` applies the change. When a part of the change does not apply, the
#   command stops, and it does not build.
#
# A copy is an entry of the scanner report that shows the source or the code of the decoder in a file of the package.
# For example: a source file of the decoder, or its code, its version or its names in a binary. An import of the
# shared library `libbrotlidec` is not a copy. A reference is also not a copy: the file uses the decoder of a different
# file. `verdict.py` examines the file of three types of entry to find a reference. A .NET assembly is a reference.
# It can have `Brotli` in its name or the names of the native functions of the decoder, but not their code.
# A static library is a reference when `nm` shows no definition of a `Brotli` symbol. When `nm` stops with an error,
# the library stays a copy. An ELF file with the names of the decoder stays a copy. `verdict.py` cannot open a path in
# an archive. That entry is a reference only when it has the same bytes as the file of a different reference. If not,
# it stays a copy. `verdict.py` has the list of the values of `kind`. A bad copy is a copy without one of these values
# of `patch_status`: `fixed_source`, `fixed_code_match` or `upstream_fixed_version`. Thus a copy with an unknown version
# is a bad copy, and its removal is the fix.
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
# The exit code is 0 when the output has a verdict. It is 1 when a request to GitHub, `git diff`, the build of "after"
# or the scanner stops with an error. It is also 1 when the change does not apply. It is 2 when the arguments are not
# correct.
set -eu

usage() {
  echo "usage: brotli-check <attr> [--base <commit> | --pr <number>] [--onto <ref>]"
}

wrong_usage() {
  usage >&2
  exit 2
}

attr='' base='' pr='' onto=''
while [ $# -gt 0 ]; do
  case $1 in
    -h | --help) usage; exit 0 ;;
    --base) [ $# -ge 2 ] || wrong_usage; base=$2; shift 2 ;;
    --pr) [ $# -ge 2 ] || wrong_usage; pr=$2; shift 2 ;;
    --onto) [ $# -ge 2 ] || wrong_usage; onto=$2; shift 2 ;;
    -*) wrong_usage ;;
    *) [ -z "$attr" ] || wrong_usage; attr=$1; shift ;;
  esac
done
[ -n "$attr" ] || wrong_usage
[ -z "$base" ] || [ -z "$pr" ] || wrong_usage
case $pr in *[!0-9]*) wrong_usage ;; esac
# `--onto` is correct only with `--base` or `--pr`: they give the change. The ref goes into a URL.
[ -z "$onto" ] || [ -n "$base$pr" ] || wrong_usage
case $onto in -* | *[!A-Za-z0-9._/-]*) wrong_usage ;; esac

cve=CVE-2026-111497
api=https://api.github.com/repos/NixOS/nixpkgs
archive=https://github.com/NixOS/nixpkgs/archive
tmp=$(mktemp -d)
# The files of the Nix store are read-only, also in `$tmp/after`, and `rm` cannot remove them.
trap 'chmod -R u+w "$tmp" 2>/dev/null || :; rm -rf "$tmp"' EXIT

# `get <file> <curl argument>...` writes the reply of GitHub into `<file>`. With `GH_TOKEN`, the request has the token:
# without a token, the API accepts only 60 requests in one hour. `-H @-` reads the header from stdin: thus the token is
# not in the command line of `curl`. With `-L`, `curl` follows the reply to a different URL, but it does not send the
# header to a different host.
get() {
  file=$1
  shift
  if [ -n "${GH_TOKEN:-}" ]; then
    printf 'Authorization: Bearer %s\n' "$GH_TOKEN" | curl -fsSL -H @- "$@" >"$file"
  else
    curl -fsSL "$@" >"$file"
  fi
}
no_token="(without GH_TOKEN, the API accepts 60 requests in one hour)"

after=./.
after_name="this checkout"
if [ -n "$pr" ] && [ -z "$onto" ]; then
  # One reply of the GitHub API gives the base commit and the tip. Thus the two commits agree, and the output gives
  # the commit of "after". Nix keeps the archive of a URL for one hour: thus a URL without the commit can give a tip
  # before the last push.
  get "$tmp/pull.json" "$api/pulls/$pr" || { echo "the GitHub API request for NixOS/nixpkgs#$pr stopped with an error $no_token" >&2; exit 1; }
  commits=$(python3 -I -c 'import json, sys; p = json.load(sys.stdin); print(p["base"]["sha"], p["head"]["sha"])' <"$tmp/pull.json")
  base=${commits% *}
  after=$archive/${commits#* }.tar.gz
  after_name="NixOS/nixpkgs#$pr at ${commits#* }"
fi
before=''
if [ -n "$base" ]; then
  before=$archive/$base.tar.gz
  before_name="NixOS/nixpkgs@$base"
fi

if [ -n "$onto" ]; then
  if [ -n "$pr" ]; then
    change="NixOS/nixpkgs#$pr"
    # The URL goes to `patch-diff.githubusercontent.com`.
    get "$tmp/change.diff" "https://github.com/NixOS/nixpkgs/pull/$pr.diff" || { echo "the request for the diff of $change stopped with an error" >&2; exit 1; }
  else
    change="this checkout"
    # The `git` configuration of the person can change the format of the diff. The prefixes `a/` and `b/` are
    # necessary for `patch -p1`.
    git diff --no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/ "$base" HEAD >"$tmp/change.diff" || { echo "git diff $base HEAD stopped with an error" >&2; exit 1; }
  fi
  [ -s "$tmp/change.diff" ] || { echo "$change has no change after its base" >&2; exit 1; }
  # As with `--pr`, the URL of the archive has the commit of `<ref>`, and the output gives it.
  get "$tmp/onto.sha" -H "Accept: application/vnd.github.sha" "$api/commits/$onto" || { echo "the GitHub API request for the commit of $onto stopped with an error $no_token" >&2; exit 1; }
  sha=$(cat "$tmp/onto.sha")
  # `builtins.fetchTarball` puts the tree into the Nix store one time. "before" builds from the tree in the Nix store,
  # and "after" from the changed tree in `$tmp/after`.
  tree=$(nix-instantiate --eval --argstr url "$archive/$sha.tar.gz" --expr '{ url }: builtins.fetchTarball url') || { echo "the download of NixOS/nixpkgs@$sha stopped with an error" >&2; exit 1; }
  tree=${tree#\"}
  tree=${tree%\"}
  cp -R "$tree" "$tmp/after"
  chmod -R u+w "$tmp/after"
  # `--fuzz=0`: the lines before and after each part of the change must agree, as with `git apply`. Thus a part of the
  # change cannot go to a different location. `--force` and `--forward`: `patch` asks no questions, and a part that is
  # in `<ref>` is an error. `--no-backup-if-mismatch`: `patch` does not add `.orig` files to the tree.
  if ! patch -p1 --force --forward --fuzz=0 --no-backup-if-mismatch -d "$tmp/after" -i "$tmp/change.diff" >"$tmp/patch.log" 2>&1; then
    cat "$tmp/patch.log" >&2
    echo "the change of $change does not apply onto $onto@$sha" >&2
    exit 1
  fi
  before=$tree
  before_name="$onto@$sha"
  after=$tmp/after
  after_name="$change onto $onto@$sha"
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
if [ -n "$before" ]; then
  echo "before: nix-build -A $attr ($before_name)"
  side before "$before" || echo "before: the build stopped with an error"
fi

python3 -I "$VERDICT" "$attr" "$tmp/before.json" "$tmp/after.json"
