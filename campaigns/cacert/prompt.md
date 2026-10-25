# The cacert campaign

You are one agent of a fleet. The fleet fixes the packages of the tracking issue NixOS/nixpkgs#576541, "Vendored CA PEM bundles". A package of this list has a copy of a CA trust store in its output. That copy does not get the `cacert` changes of nixpkgs, for example the removal of the eMudhra roots (`emSign ECC Root CA - G3` and the roots that Sectigo `AAA Certificate Services` cross-signed). The fix makes the package use the `cacert` bundle of nixpkgs.

Your task is one package. The task block at the end gives the attribute, the files of the issue entry and the paths.

## The fix

Make the smallest change that makes the package use `cacert`:

1. Replace the bundled file with a symlink to `${cacert}/etc/ssl/certs/ca-bundle.crt`, in `postInstall` or `postFixup`. Add `cacert` to the inputs, in the same sequence as the other inputs (A to Z). This is the usual fix. Use only these reviewed branches as examples: `git show cacert/bazarr`, `cacert/freefilesync`, `cacert/moodle`, `cacert/monica`, `cacert/python3Packages.stripe`. The other `cacert/*` branches are not examples: some of them are not reviewed.
2. When the package reads the bundle through a path in its code, point the code at the `cacert` file in `postPatch`, with `substituteInPlace` or a small patch.
3. When the bundle is in an archive (a wheel, a jar, an `app.asar`), a symlink in the output does not change it. Then the fix must change the archive or the build. If that is not a small change, do not make it: see "When there is no small fix".
4. A Java keystore (`cacerts`) gets `jre-generate-cacerts`. That is a different campaign (NixOS/nixpkgs#576543). Do not fix keystores here.

Instructions:

- Remove the bundled file with `rm`, then make the symlink with `ln -s`. Do not use `ln -sf`: the `rm` stops the build when a new version moves the file, and that is the signal a person wants.
- Write each path in full. For more than one copy, use a `for` loop on the full paths. Do not use `find`: when `find` finds no file, the build completes and the fix is not there.
- Do not remove a file that is not a CA file to get a `pass` from the check. When the fix removes an executable file, a worker, a library or a directory, the description must tell the cause: no software uses it.
- A fix can add inputs, write an archive again or change the build, when a symlink is not sufficient. Then the description must tell the cause: the symlink is not sufficient, and what the fix does.
- Commit only a change that makes the package use `cacert`. A change that only moves files or changes other lines is not a fix of this campaign.
- Change only the package of the task. Do not change `cacert`, `lib/` or other packages.
- Keep the format of the file. Do not change lines that the fix does not touch.
- Make one commit. The message is `<attr>: use cacert bundle instead of vendored CA bundle` (or `... CA file`, `... CA list`, as applicable). The attribute in the message is the attribute of the task, for example `python3Packages.wassima: use cacert bundle instead of vendored CA list`. The last line of the message is `Assisted-by: Claude Code (<model name>) with patchix`, for example `Assisted-by: Claude Code (Claude Opus 5.5) with patchix`. The `automation/AI policy` of nixpkgs makes this line necessary, with the tool and the model. Do not add a `Co-Authored-By` line.
- Build the package: `nix-build -A <attr>` in the worktree. Do not use `nix build .#<attr>`: the worktree has only a part of the commits, and that command stops with an error. The build must complete.
- A change can also fix other entries of the task list, for example entries that copy the file that you changed. Then write `attrs.txt` in the run directory: one attribute for each line, with the attribute of this task. patchix starts the checks for each attribute of the list, and an entry with a `pass` points at this branch. Do not write an attribute that the change does not fix.
- Do not push. Do not make a pull request. Do not edit files that are not in the worktree or the run directory.

## The check

Start each check command of the task block in the worktree. The output of the `harness` check must have the line `VERDICT <attr> emudhra: FIXED`. When the verdict is different, the fix is not correct: examine the output and correct the fix, or stop with "no small fix".

## The description

Write `description.md` in the run directory of the task block. It is the pull request description. Obey the text instructions below. The maintainer of the package reads this description. They see one pull request of this campaign, not the campaign. Write what they must know to accept the change, and no more. A fact that makes a difference to the change is good, for example the cause of a fix that is not the usual fix. A fact that makes no difference is work for the reader, and it reads as text that an agent made. The output of the check below has the numbers and the certificate names: do not copy them into the text. The structure is:

```
Part of #576541.

<Two or three sentences. One: the package has a bundled CA file, with its path, and the file trusts the compromised eMudhra roots. Two: this change is the usual fix of this campaign, a symlink to the `cacert` bundle of nixpkgs in `postInstall`, or what the change does instead, and where. Three, only when the change is not the usual fix: the cause. No numbers, no certificate names, no text about the platforms or the code paths of the package, no text about other problems of the package.>

{{disclosure}}

### Test

[nix-cacert-harness](https://github.com/irgolic/nix-cacert-harness) examines the package before and after this change. A local copy of nixpkgs is not necessary.

{{check:harness}}

<One or two sentences: before the change, the file accepts N of the 14 eMudhra chains; after, none. When the live test ran: one sentence on what the program did before and after.>

{{template}}
```

patchix replaces the marks `{{disclosure}}`, `{{check:harness}}` and `{{template}}`. Do not write the AI disclosure, the harness output or the "Things done" list. Write `{pr}` where the pull request number goes.

The title of the pull request is the commit message.

## When there is no small fix

Do not commit when the fix is not small, or when the package does not build here. Do not commit when the check is not `pass` after two corrections. Write `description.md` with one heading `## No small fix` and one or two paragraphs. Tell what you found and what a person must do. The run is then recorded as `wontfix`, with your text: a person must change the issue entry, and no agent starts this task again.
