# The cacert-keystore campaign

You are one agent of a fleet. The fleet fixes the packages of the tracking issue NixOS/nixpkgs#576543, "Vendored Java CA keystores". A package of this list has a Java trust store in its output, usually `lib/security/cacerts` of a bundled JRE or JDK. That keystore does not get the `cacert` changes of nixpkgs, for example the removal of the eMudhra roots (`emSign ECC Root CA - G3` and the roots that Sectigo `AAA Certificate Services` cross-signed). The fix makes a new keystore from the `cacert` bundle at build time.

Your task is one package. The task block at the end gives the attribute, the files of the issue entry and the paths.

## The fix

Make the smallest change that makes the keystore agree with `cacert`:

1. Replace the keystore with one that `jre-generate-cacerts` makes from `${cacert}/etc/ssl/certs/ca-bundle.crt`, in `postInstall` or `postFixup`, as `openjdk` does (NixOS/nixpkgs#576518). Add `cacert` and `jre-generate-cacerts` to the inputs. This is the usual fix. Use only these reviewed branches as examples: `git show cacert/temurin-bin`, `cacert/zulu`, `cacert/corretto`, `cacert/tracecompass`. The other `cacert/*` branches are not examples: some of them are not reviewed.
2. When the keystore has a password, make the new keystore with the same password. The JDK opens `cacerts` without a password. A keystore that does not open without a password is empty for the JDK. The harness counts it as bad.
3. When the package does not start the bundled runtime, no software reads the keystore. Then remove the keystore, or the runtime, and tell this in the description.
4. When the package reads a keystore through a path in its code, point the code at the new keystore in `postPatch`.
5. A PEM bundle (`cacert.pem`, `ca-bundle.crt`) is a different campaign (NixOS/nixpkgs#576541). Do not fix PEM bundles here.

Instructions:

- Change only the package of the task. Do not change `cacert`, `jre-generate-cacerts`, `openjdk` or other packages.
- Keep the format of the file. Do not change lines that the fix does not touch.
- Make one commit. The message is `<attr>: generate cacerts from cacert`. The attribute in the message is the attribute of the task. The last line of the message is `Assisted-by: Claude Code (<model name>) with patchix`, for example `Assisted-by: Claude Code (Claude Opus 5.5) with patchix`. The `automation/AI policy` of nixpkgs makes this line necessary, with the tool and the model. Do not add a `Co-Authored-By` line.
- Remove only a keystore, or a runtime that no software starts. Do not remove an executable file, a library or a directory to get a `pass` from the check.
- A fix can add inputs or change the build, when `jre-generate-cacerts` in `postInstall` is not sufficient. Then the description must tell the cause.
- Build the package: `nix-build -A <attr>` in the worktree. Do not use `nix build .#<attr>`: the worktree has only a part of the commits, and that command stops with an error. The build must complete. A build of a JDK from source is very long. When the dry run shows such a build, stop with "no small fix".
- A change can also fix other entries of the task list, for example entries that copy the file that you changed. Then write `attrs.txt` in the run directory: one attribute for each line, with the attribute of this task. patchix starts the checks for each attribute of the list, and an entry with a `pass` points at this branch. Do not write an attribute that the change does not fix.
- Do not push. Do not make a pull request. Do not edit files that are not in the worktree or the run directory.

## The check

Start each check command of the task block in the worktree. The output of the `harness` check must have the line `VERDICT <attr> emudhra: FIXED`. When the verdict is different, the fix is not correct: examine the output and correct the fix, or stop with "no small fix".

## The description

Write `description.md` in the run directory of the task block. It is the pull request description. Obey the text instructions below. The maintainer of the package reads this description. They see one pull request of this campaign, not the campaign. Write what they must know to accept the change, and no more. A fact that makes a difference to the change is good, for example the cause of a fix that is not the usual fix. A fact that makes no difference is work for the reader, and it reads as text that an agent made. The output of the check below has the numbers and the certificate names: do not copy them into the text. The structure is:

```
Part of #576543.

<Two or three sentences. One: the package has a bundled Java keystore, with its path, and the keystore trusts the compromised eMudhra roots. Two: this change is the usual fix of this campaign, a keystore that `jre-generate-cacerts` makes from the `cacert` bundle in `postInstall`, or what the change does instead, and where. Three, only when the change is not the usual fix: the cause. No numbers, no certificate names, no text about other problems of the package.>

{{disclosure}}

### Test

[nix-cacert-harness](https://github.com/irgolic/nix-cacert-harness) examines the package before and after this change. A local copy of nixpkgs is not necessary.

{{check:harness}}

<One or two sentences: before the change, the keystore accepts N of the 14 eMudhra chains; after, none. When the live test ran: one sentence on what the program did before and after.>

{{template}}
```

patchix replaces the marks `{{disclosure}}`, `{{check:harness}}` and `{{template}}`. Do not write the AI disclosure, the harness output or the "Things done" list. Write `{pr}` where the pull request number goes.

The title of the pull request is the commit message.

## When there is no small fix

Do not commit when the fix is not small, or when the package does not build here. Do not commit when the check is not `pass` after two corrections. Write `description.md` with one heading `## No small fix` and one or two paragraphs. Tell what you found and what a person must do. The run is then recorded as `wontfix`, with your text: a person must change the issue entry, and no agent starts this task again.
