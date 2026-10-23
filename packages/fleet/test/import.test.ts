/**
 * The import with temporary repositories. A bare repository in a `file://` directory operates as GitHub
 * (`NixOS/nixpkgs`). A different checkout has the branches of a person, and a test script operates as `gh`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseIssueTasks } from "../src/issue.ts";
import { branchAttrs, convertDescription, scopeWords } from "../src/import.ts";
import { cloneBase, importBranches, listRuns, readCampaign, readDraft, readPr, readTasks, renderDraft, repoPath, runDir, taskViews, writeSettings, writeTasks, type Ctx } from "../src/index.ts";
import { mergeTasks } from "../src/sync.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();

const CAMPAIGN = `name: t
title: Test
issue: { repo: NixOS/nixpkgs, number: 1 }
branch_prefix: t/
labels: ["1.severity: security"]
checks:
  - name: harness
    command: "true"
    pass: "^VERDICT {attr} emudhra: FIXED"
    reviewer: "harness {attr} --pr {pr}"
`;

const DESCRIPTION = (attr: string) => `Part of #1.

The package has a bundled CA file. Before <this PR>, it trusts the eMudhra roots. See also 577 and 5770.

> [!WARNING]
> **AI Disclosure**: Claude Code made the code change.
> A second line.

### Test

\`\`\`sh
harness ${attr} --pr <this PR>
\`\`\`

<details>
<summary>Harness output: ${attr}</summary>

\`\`\`console
$ harness ${attr}
VERDICT ${attr} emudhra: FIXED
\`\`\`

</details>

The text after the output.

## Things done

- [x] Fits [CONTRIBUTING.md].
`;

const TOML = `check = false
[scopes.docs]
paths = ["docs/"]
words = ["certificate"]

[scopes.foo]
paths = ["docs/foo.md"]
words = [
  # a comment
  "patchix", "castore",
]

[scopes.shared]
paths = ['docs/shared.md']
words = ["gem"]
`;

let tmp = "";
let ctx: Ctx;
let source = "";
let master = "";
let docs = "";

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "patchix-import-"));
  const upstream = join(tmp, "gh", "NixOS", "nixpkgs");
  source = join(tmp, "source");
  const root = join(tmp, "patchix");
  git(tmp, "init", "-q", "--bare", "-b", "master", upstream);
  git(tmp, "init", "-q", "-b", "master", source);
  await mkdir(join(source, "pkgs"), { recursive: true });
  await writeFile(join(source, "pkgs", "a.nix"), "{ }\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "one");
  await writeFile(join(source, "README"), "two\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "two");
  git(source, "push", "-q", upstream, "master");
  master = git(source, "rev-parse", "HEAD");
  const branch = async (name: string, message: string) => {
    git(source, "checkout", "-q", "-b", name, master);
    await writeFile(join(source, "pkgs", "a.nix"), `{ ${name} }\n`);
    git(source, "commit", "-q", "-am", message);
  };
  await branch("t/foo", "foo: use cacert bundle");
  await branch("t/pkgs.a-b", "pkgs.{a,b}: use cacert bundle");
  await branch("t/other", "other: not a task of this campaign");
  git(source, "checkout", "-q", "master");

  await mkdir(join(root, "campaigns", "t"), { recursive: true });
  await writeFile(join(root, "campaigns", "t", "campaign.yaml"), CAMPAIGN);
  await writeFile(join(root, "campaigns", "t", "memelint.toml"), 'words = ["patchix"]\n');
  ctx = { root, data: join(tmp, "data"), github: `file://${join(tmp, "gh")}` };
  await writeSettings(ctx, { fork: "someone", model: "claude-opus-5-5", concurrency: 2 });
  await writeTasks(ctx, "t", { synced: "2026-01-01T00:00:00Z", tasks: parseIssueTasks("- [ ] **foo** — `/a`\n- [ ] **pkgs.a** — `/b`\n- [ ] **pkgs.b** — `/c`\n- [ ] **foo2** — `/d` — #577\n") });

  docs = join(tmp, "work", "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(join(docs, "foo.md"), DESCRIPTION("foo"));
  await writeFile(join(docs, "shared.md"), DESCRIPTION("pkgs.a").replace("harness pkgs.a --pr <this PR>", "harness pkgs.a --pr <this PR>\nharness pkgs.b --pr <this PR>"));
  await writeFile(join(docs, "stray.md"), "A description of a different change.\n");
  await writeFile(join(tmp, "work", "memelint.toml"), TOML);
  const gh = join(tmp, "gh.sh");
  await writeFile(gh, `#!/bin/sh\necho '[{"number":577,"state":"OPEN","mergedAt":null,"url":"https://github.com/NixOS/nixpkgs/pull/577","headRefName":"t/foo"},{"number":12,"state":"CLOSED","mergedAt":null,"url":"u","headRefName":"t/foo"}]'\n`);
  await chmod(gh, 0o755);
  process.env["PATCHIX_GH_BIN"] = gh;
});

after(async () => {
  delete process.env["PATCHIX_GH_BIN"];
  await rm(tmp, { recursive: true, force: true });
});

test("branchAttrs", () => {
  assert.deepEqual(branchAttrs("t/", "t/foo", "foo: fix"), ["foo"]);
  assert.deepEqual(branchAttrs("t/", "t/r.a-b", "r.{a, b}: fix"), ["r.a", "r.b", "r.a-b"]);
  assert.deepEqual(branchAttrs("t/", "t/x", "no colon"), ["x"]);
});

test("convertDescription", () => {
  const { text, output } = convertDescription(DESCRIPTION("foo"), "harness", 577);
  assert.equal(output, "$ harness foo\nVERDICT foo emudhra: FIXED\n");
  assert.equal(
    text,
    "Part of #1.\n\nThe package has a bundled CA file. Before {pr}, it trusts the eMudhra roots. See also {pr} and 5770.\n\n{{disclosure}}\n\n### Test\n\n{{check:harness}}\n\nThe text after the output.\n\n{{template}}\n",
  );
  assert.equal(convertDescription("No marks.\n", "harness", null).output, null);
  assert.equal(convertDescription(DESCRIPTION("foo").replace("[!WARNING]", "[!NOTE]"), "harness", 577).text, text);
});

test("scopeWords", () => {
  assert.deepEqual(scopeWords(TOML, "docs/foo.md"), ["patchix", "castore"]);
  assert.deepEqual(scopeWords(TOML, "docs/shared.md"), ["gem"]);
  assert.deepEqual(scopeWords(TOML, "docs/stray.md"), []);
});

test("the sync keeps the branch of a task", () => {
  const [old] = parseIssueTasks("- [ ] **foo** — `/a`\n");
  assert.ok(old !== undefined);
  const tasks = mergeTasks(parseIssueTasks("- [x] **foo** — `/a`\n"), new Map([["new", ""]]), [{ ...old, branch: "t/x" }]);
  assert.deepEqual(tasks.map((t) => [t.attr, t.checked, t.branch]), [["foo", true, "t/x"], ["new", false, null]]);
});

test("the import makes a run and a draft for each task of a branch", async () => {
  const url = `file://${source}`;
  // A worktree of a person makes a branch at the tip of the base branch. The branch has no work: the import replaces it.
  git(await cloneBase(ctx, await readCampaign(ctx, "t")), "branch", "t/foo", "master");
  const result = await importBranches(ctx, "t", url, docs);
  assert.deepEqual(result.imported.map((i) => [i.branch, i.attrs]), [["t/foo", ["foo", "foo2"]], ["t/pkgs.a-b", ["pkgs.a", "pkgs.b"]]], "the issue entry of foo2 has the pull request of t/foo");
  assert.deepEqual(result.unmatched_branches, ["t/other"]);
  assert.deepEqual(result.unmatched_files, ["stray.md"]);

  const repo = repoPath(ctx);
  assert.equal(git(repo, "rev-list", "--count", "t/foo"), "2", "the tip and its parent");
  assert.equal(git(repo, "rev-list", "--count", "master"), "1");
  const tip = git(source, "rev-parse", "t/foo");
  const [run] = await listRuns(ctx, "t", "foo");
  assert.deepEqual([run?.tags, run?.status, run?.base, run?.head, run?.commits, run?.model], [["imported"], "ok", master, tip, 1, "claude-opus-5-5"]);
  assert.deepEqual(run?.checks.map((c) => [c.name, c.status]), [["harness", "pass"]]);
  const dir = runDir(ctx, "t", "foo", run?.id ?? "");
  assert.match(await readFile(join(dir, "diff.patch"), "utf8"), /^\+\{ t\/foo \}$/m);
  assert.match(await readFile(join(dir, "log.txt"), "utf8"), new RegExp(`import of the branch t/foo \\(${tip}\\) from ${url}`));
  assert.equal(await readFile(join(dir, "checks", "harness.txt"), "utf8"), "$ harness foo\nVERDICT foo emudhra: FIXED\n");

  const pr = await readPr(ctx, "t", "foo");
  assert.deepEqual([pr?.title, pr?.labels, pr?.words, pr?.number, pr?.url, pr?.state, pr?.run], ["foo: use cacert bundle", ["1.severity: security"], ["castore"], 577, "https://github.com/NixOS/nixpkgs/pull/577", "open", run?.id]);
  const rendered = (await renderDraft(ctx, "t", "foo")) ?? "";
  assert.match(rendered, /harness foo --pr 577/);
  assert.match(rendered, /VERDICT foo emudhra: FIXED/);
  assert.match(rendered, /Before 577, it trusts/);
  assert.doesNotMatch(rendered, /\{\{|\{pr\}/);

  assert.equal(await readDraft(ctx, "t", "pkgs.b"), await readDraft(ctx, "t", "pkgs.a"), "shared.md is the description of the two tasks");
  assert.deepEqual((await readPr(ctx, "t", "pkgs.b"))?.words, ["gem"]);
  assert.equal((await readPr(ctx, "t", "pkgs.b"))?.number, null);
  assert.equal(await readDraft(ctx, "t", "foo2"), await readDraft(ctx, "t", "foo"), "foo.md is the file of the branch suffix");
  assert.deepEqual((await readTasks(ctx, "t"))?.tasks.map((t) => [t.attr, t.branch]), [["foo", null], ["pkgs.a", "t/pkgs.a-b"], ["pkgs.b", "t/pkgs.a-b"], ["foo2", "t/foo"]]);
  const views = await taskViews(ctx, "t");
  assert.deepEqual(views.map((v) => [v.attr, v.state, v.branch_name, v.head]), [
    ["foo", "pr", "t/foo", tip],
    ["pkgs.a", "ready", "t/pkgs.a-b", git(source, "rev-parse", "t/pkgs.a-b")],
    ["pkgs.b", "ready", "t/pkgs.a-b", git(source, "rev-parse", "t/pkgs.a-b")],
    ["foo2", "pr", "t/foo", tip],
  ]);

  const again = await importBranches(ctx, "t", url);
  assert.deepEqual(again.imported.map((i) => i.run), result.imported.map((i) => i.run), "a second import makes no run");
  assert.equal((await listRuns(ctx, "t", "foo")).length, 1);

  // The repository of patchix has a different commit of the branch: the import does not change it.
  git(source, "checkout", "-q", "t/foo");
  git(source, "commit", "-q", "--amend", "-m", "foo: a different commit");
  git(source, "checkout", "-q", "master");
  const changed = await importBranches(ctx, "t", url);
  assert.deepEqual(changed.unmatched_branches, ["t/foo", "t/other"]);
  assert.equal(git(repo, "rev-parse", "t/foo"), tip);
  await assert.rejects(importBranches(ctx, "t", "--upload-pack=x"), /not an https:\/\/ or file:\/\/ URL/);
});
