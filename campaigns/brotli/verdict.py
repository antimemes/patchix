"""Compares the JSON reports of the scanner before and after the change, and writes the `VERDICT` line.

`check.sh` starts it as `verdict.py <attr> <before.json> <after.json>`, and its comment tells the verdicts and the
copies. When `<before.json>` is not there, there is no "before".
"""
import json, os, re, sys

# The values of `kind` that do not show the decoder in the file. Each other value is a copy. Thus a new value of a
# different version of the scanner is a copy, and it cannot give `FIXED`. The copies of this version of the scanner:
#
# - `exact_source_match` and `modified_decoder_source`: a source file of the decoder.
# - `decoder_code_match`: the code of the decoder in an ELF file.
# - `binary_version_candidate`: the version of the decoder in an ELF file.
# - `decoder_symbol_candidate`: names or symbols of the decoder in a binary, without an import.
# - `container_symbol_candidate`: names of the decoder in an archive that the scanner cannot open fully.
# - `artifact_name_candidate`: a library or an archive with `brotli` in its name.
NOT_COPY = {
    "decoder_import_candidate",  # an ELF file that gets the decoder from a shared library
    "binary_candidate",  # an ELF file without names, symbols or code of the decoder
    "dependency_candidate",  # a dependency in a file of the build, for example `package.json`
    "node_fetch_candidate",  # `fetch` in JavaScript: the decoder is in the Node.js runtime
    "supplied_version",  # a version on the command line of the scanner: `check.sh` gives none
}
# The values of `patch_status` of a copy with the fix. A bad copy has a different value, also `unknown`.
FIXED = {"fixed_source", "fixed_code_match", "upstream_fixed_version"}
STORE = re.compile(r"/nix/store/[0-9a-z]{32}-")


def load(file):
    """The report with the entries of its `findings` in the lists `bad`, `fixed` and `other`, or None."""
    if not os.path.exists(file):
        return None
    with open(file, encoding="utf-8") as f:
        report = json.load(f)
    report.update(bad=[], fixed=[], other=[])
    for x in report["findings"]:
        group = "other" if x["kind"] in NOT_COPY else "fixed" if x["patch_status"] in FIXED else "bad"
        report[group].append(x)
    return report


def label(name, x):
    """One entry of `findings` as text: `path` without the hash, `kind`, `patch_status` and the decoder versions."""
    versions = x["evidence"].get("decoder_metadata", {}).get("versions", [])
    brotli = "".join(f", brotli {v['version']}" for v in versions)
    return f"  {name}: {STORE.sub('', x['path'])} ({x['kind']}, {x['patch_status']}{brotli})"


attr, before_file, after_file = sys.argv[1:4]
before, after = load(before_file), load(after_file)
for name, side in (("before", before), ("after", after)):
    if side is None:
        print(f"{name}: not examined")
        continue
    coverage = side["coverage"]
    print(f"{name}: {len(side['bad'])} bad and {len(side['fixed'])} fixed copies, {len(side['other'])} other findings; "
          f"{coverage['files_read']} files read, {coverage['gap_count']} gaps; scanner result {side['result']}")
    for x in side["bad"]:
        print(label("bad copy", x))
    for x in side["fixed"]:
        print(label("fixed copy", x))
    # The imports of the shared library `libbrotlidec`, for example after the fix.
    imports = [x for x in side["other"] if x["kind"] == "decoder_import_candidate"]
    for x in imports[:10]:
        print(label("import", x))
    if len(imports) > 10:
        print(f"  ... {len(imports) - 10} more imports")

# `check.sh` does not start `verdict.py` without a report of "after".
bad = after["bad"]
if bad and all(x["kind"] == "binary_version_candidate" for x in bad):
    verdict = "NOT FIXED (only by the decoder version: a patch of the bundled source keeps the version)"
elif bad:
    verdict = "NOT FIXED"
elif before is None:
    verdict = "UNKNOWN (no bad copy after, and no before)"
elif before["bad"]:
    verdict = "FIXED"
else:
    verdict = "UNKNOWN (the scanner finds no bad copy before and after)"
print(f"VERDICT {attr}: {verdict}")
