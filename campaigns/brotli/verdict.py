"""Compares the JSON reports of the scanner before and after the change, and writes the `VERDICT` line.

`check.sh` starts it as `verdict.py <attr> <before.json> <after.json>`, and its comment tells the verdicts and the
copies. When `<before.json>` is not there, there is no "before".

The `path` of each entry is a file in the Nix store. For three values of `kind`, the script also examines the file, and
a copy can become a reference: see `reference`. The script cannot open a path in an archive (`<archive>!<member>`). Such
an entry is a reference only when its `sha256` is the hash of the file of a different reference: see `load`. Each other
entry in an archive, and each entry with a missing file, keeps the value of `kind` of the scanner.
"""
import hashlib, json, os, re, struct, subprocess, sys

# The values of `kind` that do not show the decoder in the file. Each other value is a copy. Thus a new value of a
# different version of the scanner is a copy, and it cannot give `FIXED`. The copies of this version of the scanner:
#
# - `exact_source_match` and `modified_decoder_source`: a source file of the decoder.
# - `decoder_code_match`: the code of the decoder in an ELF file.
# - `binary_version_candidate`: the version of the decoder in an ELF file.
# - `decoder_symbol_candidate`: names or symbols of the decoder in a binary, without an import. A .NET assembly is a
#   reference: see `reference`.
# - `container_symbol_candidate`: names of the decoder in an archive that the scanner cannot open fully. A static
#   library without a definition of a `Brotli` symbol is a reference: see `reference`.
# - `artifact_name_candidate`: a library or an archive with `brotli` in its name. A .NET assembly is a reference: see
#   `reference`.
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
BROTLI = re.compile(r"_?Brotli")


def head(path, size):
    """The first `size` bytes of the file `path`, or None for a path in an archive or a missing file."""
    if "!" in path:
        return None
    try:
        with open(path, "rb") as f:
            return f.read(size)
    except OSError:
        return None


def assembly(data):
    """`True` when `data` is the start of a .NET assembly: a PE file with a CLR header (the data directory 14)."""
    if not data or not data.startswith(b"MZ"):
        return False
    try:
        pe = struct.unpack_from("<I", data, 0x3C)[0]
        # The optional header of PE32 and of PE32+ has the data directories at a different offset.
        directories = pe + 24 + {0x10B: 96, 0x20B: 112}[struct.unpack_from("<H", data, pe + 24)[0]]
        count = struct.unpack_from("<I", data, directories - 4)[0]
        address, size = struct.unpack_from("<II", data, directories + 14 * 8)
    except (struct.error, KeyError):
        return False
    return data[pe:pe + 4] == b"PE\0\0" and count > 14 and address > 0 and size > 0


def reference(x):
    """`True` when the copy `x` is a reference to the decoder in a different file. It can add a `note` to `x`.

    - `decoder_symbol_candidate` of a .NET assembly: the scanner does not examine the code of PE files. It found only
      the names of the native functions that the assembly uses. The native library is a different entry. An ELF file
      stays a copy, also one file with all the libraries in it.
    - `artifact_name_candidate` of a .NET assembly: the name has `Brotli`, but the assembly has no native code of the
      decoder. For example the reference assembly `System.IO.Compression.Brotli.dll` of `Microsoft.NETCore.App.Ref`.
    - `container_symbol_candidate` of a static library (`!<arch>`): `nm --defined-only` shows the symbols that each
      object gives. Without a definition of a `Brotli` symbol, the library only uses the decoder of a different
      library. When `nm` is not there or stops with an error, the library stays a copy.
    """
    if x["kind"] in ("decoder_symbol_candidate", "artifact_name_candidate"):
        if assembly(head(x["path"], 4096)):
            x["note"] = "a .NET assembly"
            return True
        return False
    if x["kind"] != "container_symbol_candidate" or head(x["path"], 8) != b"!<arch>\n":
        return False
    try:
        nm = subprocess.run(["nm", "--defined-only", "--format=posix", x["path"]],
                            capture_output=True, text=True, errors="replace")
    except OSError:
        x["note"] = "nm is not available, thus a copy"
        return False
    if nm.returncode != 0:
        x["note"] = f"nm stopped with exit code {nm.returncode}, thus a copy"
        return False
    # The format `posix`: one line `<name> <type> <value> <size>` for each symbol. A Mach-O object adds `_` before
    # the name.
    if any(BROTLI.match(line) for line in nm.stdout.splitlines()):
        x["note"] = "nm shows a definition of a Brotli symbol"
        return False
    x["note"] = "nm shows no definition of a Brotli symbol"
    return True


def digest(path):
    """The hash of the file `path`, in the format of `sha256` of the scanner."""
    with open(path, "rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def load(file):
    """The report with the entries of its `findings` in the lists `bad`, `fixed`, `reference` and `other`, or None.

    An entry in an archive is a reference when its `sha256` is the hash of the file of a different reference of the
    same report. Then the two entries have the same bytes, and `reference` gives the same result for them.
    """
    if not os.path.exists(file):
        return None
    with open(file, encoding="utf-8") as f:
        report = json.load(f)
    copies = [x for x in report["findings"] if x["kind"] not in NOT_COPY]
    references = {id(x) for x in copies if reference(x)}
    # `reference` opened each of these files: a reference is not a path in an archive.
    hashes = {}
    for x in copies:
        if id(x) in references:
            hashes.setdefault(digest(x["path"]), x["path"])
    for x in copies:
        same = hashes.get(x["evidence"].get("sha256"))
        if "!" in x["path"] and same:
            x["note"] = f"same content as {STORE.sub('', same)}"
            references.add(id(x))
    report.update(bad=[], fixed=[], reference=[], other=[])
    for x in report["findings"]:
        if x["kind"] in NOT_COPY:
            group = "other"
        elif id(x) in references:
            group = "reference"
        else:
            group = "fixed" if x["patch_status"] in FIXED else "bad"
        report[group].append(x)
    return report


def label(name, x):
    """One entry of `findings` as text: `path` without the hash, `kind`, `patch_status`, the decoder versions and the
    `note` of `reference`."""
    versions = x["evidence"].get("decoder_metadata", {}).get("versions", [])
    brotli = "".join(f", brotli {v['version']}" for v in versions)
    note = f"; {x['note']}" if "note" in x else ""
    return f"  {name}: {STORE.sub('', x['path'])} ({x['kind']}, {x['patch_status']}{brotli}{note})"


attr, before_file, after_file = sys.argv[1:4]
before, after = load(before_file), load(after_file)
for name, side in (("before", before), ("after", after)):
    if side is None:
        print(f"{name}: not examined")
        continue
    coverage = side["coverage"]
    print(f"{name}: {len(side['bad'])} bad and {len(side['fixed'])} fixed copies, {len(side['reference'])} references, "
          f"{len(side['other'])} other findings; {coverage['files_read']} files read, {coverage['gap_count']} gaps; "
          f"scanner result {side['result']}")
    for x in side["bad"]:
        print(label("bad copy", x))
    for x in side["fixed"]:
        print(label("fixed copy", x))
    # The references and the imports of the shared library `libbrotlidec`, for example after the fix. The output
    # shows all the references: each one is a decision of this script, not of the scanner.
    for x in side["reference"]:
        print(label("reference", x))
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
