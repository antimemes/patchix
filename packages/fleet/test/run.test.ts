/**
 * The runs with temporary repositories. Two bare repositories in a `file://` directory operate as
 * GitHub: `NixOS/nixpkgs` (the issue repository) and `someone/nixpkgs` (the fork). A test script operates as `claude`.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CONFIRM_ERROR, tipChecks, type Campaign, type PublishInput, type Run } from "@patchix/common";
import { DONE_RULE } from "../src/run.ts";
import { parseIssueTasks } from "../src/issue.ts";
import {
  adopt,
  branchCommits,
  branchDiff,
  branchDir,
  branchGit,
  cacheUntracked,
  campaignState,
  cloneBase,
  commitProblems,
  createOrUpdatePr,
  exists,
  isClean,
  listRuns,
  makeDraft,
  newId,
  publishLogOf,
  push,
  questionFile,
  readCampaign,
  readDraft,
  readPr,
  readPublishLog,
  readTasks,
  renderDraft,
  repoPath,
  runDir,
  runSource,
  startRun,
  updateBase,
  updateTasks,
  worktreePath,
  writeRun,
  writeSettings,
  writeTasks,
  type Ctx,
} from "../src/index.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();

const CAMPAIGN = `name: t
title: Test
issue: { repo: NixOS/nixpkgs, number: 1 }
base_branch: master
branch_prefix: t/
labels: ["1.severity: security"]
timeout_minutes: 1
checks:
  - name: harness
    command: "[ x$PATCHIX_TEST_CHECK != xerror ] && v=\${PATCHIX_TEST_CHECK:-FIXED} && { [ x{attr} != x$PATCHIX_TEST_REFUTE ] || v=REFUTED; } && echo VERDICT {attr} emudhra: $v base={base} && printenv NIX_CONFIG | grep -q github.com= && echo nix has the token"
    pass: "^VERDICT {attr} emudhra: FIXED"
    reviewer: "harness {attr} --pr {pr}"
    timeout_minutes: 1
`;

const MEMELINT = `check = true
profile = "strict"
words = [
  "nixpkgs", "patchix", "memelint", "Claude Code", "Claude Opus", "Simplified Technical English", "AI disclosure",
  "pull request description", "pull request", "trust store", "symlink",
  "Things done", "automation/AI policy", "Built on platform", "Basic functionality",
  "Ran on this", "nixpkgs-review usage", "core functionality", "release notes",
  "Package update", "major or breaking", "Module addition", "when adding",
  "Module update", "change is significant",
]
`;

/**
 * The agent of the test. A run: one commit in the worktree, then `description.md` and `words.txt` in the run
 * directory. A run with a question: a reply on `stdout`. When the question has the words `Amend the fix`, the agent
 * changes the commit with `git commit --amend`. With `Change a file`, it changes a file without a commit. With
 * `PATCHIX_TEST_NO_CONVERSATION`, `--continue` gives an error. With `PATCHIX_TEST_NO_FIX`, a run makes no commit and
 * writes a description with the heading `## No small fix`; with the value `dirty`, it also changes a file. With
 * `PATCHIX_TEST_NO_TRAILER`, the commit has a `Co-Authored-By` line and no `Assisted-by` line. With `PATCHIX_TEST_ATTRS`, the
 * agent writes its words into `attrs.txt`, one on each line. The check gives `REFUTED` for the attribute
 * `PATCHIX_TEST_REFUTE`.
 */
const CLAUDE = `#!/bin/sh
set -e
case "$*" in
*"# The question"*)
  case "$*" in *--continue*) if [ -n "$PATCHIX_TEST_NO_CONVERSATION" ]; then echo "No conversation found" >&2; exit 1; fi;; esac
  echo "The reply."
  case "$*" in
  *"Amend the fix"*) echo 'reply = 1;' >> pkgs/foo/default.nix; git -c user.name=t -c user.email=t@example.com commit -q --amend --no-edit -a;;
  *"Change a file"*) echo 'reply = 1;' >> pkgs/foo/default.nix;;
  esac
  exit 0;;
esac
if [ -n "$PATCHIX_TEST_NO_FIX" ]; then
  printf '## No small fix\\n\\nThe package puts the bundle into a jar file. A person must change the build.\\n' > "$PATCHIX_RUN_DIR/description.md"
  if [ "$PATCHIX_TEST_NO_FIX" = dirty ]; then echo 'x = 1;' >> pkgs/foo/default.nix; fi
  exit 0
fi
echo "fake claude in $(pwd)"
case "$NIX_CONFIG" in *"access-tokens = github.com=$GH_TOKEN") echo "nix has the token";; esac
if [ -n "$PATCHIX_TEST_SLEEP" ]; then sleep 30; fi
echo 'ca = "cacert";' >> pkgs/foo/default.nix
trailer="Assisted-by: Claude Code (Claude Opus 5.5) with patchix"
if [ -n "$PATCHIX_TEST_NO_TRAILER" ]; then trailer="Co-Authored-By: Claude <noreply@anthropic.com>"; fi
git -c user.name=t -c user.email=t@example.com commit -q -am "foo: use cacert bundle instead of bundled CA file" -m "$trailer"
cat > "$PATCHIX_RUN_DIR/description.md" <<'MD'
Part of #1.

The package \`foo\` has a castore copy of a trust store. The change replaces it with a symlink to the \`cacert\` bundle.

{{disclosure}}

### Test

{{check:harness}}

{{template}}
MD
printf 'castore\\n' > "$PATCHIX_RUN_DIR/words.txt"
if [ -n "$PATCHIX_TEST_ATTRS" ]; then printf '%s\\n' $PATCHIX_TEST_ATTRS > "$PATCHIX_RUN_DIR/attrs.txt"; fi
`;

let tmp = "";
let work = "";
let ctx: Ctx;
let campaign: Campaign;
let master = "";
/** A test token: the test examines that it goes to `nix`, and not into a file of the run. */
const TOKEN = "patchix-test-token";
const oldToken = process.env["GH_TOKEN"];

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "patchix-test-"));
  const upstream = join(tmp, "gh", "NixOS", "nixpkgs");
  const fork = join(tmp, "gh", "someone", "nixpkgs");
  work = join(tmp, "work");
  const root = join(tmp, "patchix");
  git(tmp, "init", "-q", "--bare", "-b", "master", upstream);
  git(tmp, "init", "-q", "--bare", "-b", "master", fork);
  git(tmp, "init", "-q", "-b", "master", work);
  await mkdir(join(work, "pkgs", "foo"), { recursive: true });
  await writeFile(join(work, "pkgs", "foo", "default.nix"), "{ }\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "one");
  await writeFile(join(work, "README"), "two\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "two");
  git(work, "push", "-q", upstream, "master");
  // A fork on GitHub has the commits of the upstream repository: thus a push from the clone with depth 1 can operate.
  git(work, "push", "-q", fork, "master");
  master = git(work, "rev-parse", "HEAD");

  await mkdir(join(root, "campaigns", "t"), { recursive: true });
  await writeFile(join(root, "campaigns", "t", "campaign.yaml"), CAMPAIGN);
  await writeFile(join(root, "campaigns", "t", "prompt.md"), "# The test campaign\n\nFix the package.\n");
  await writeFile(join(root, "campaigns", "t", "memelint.toml"), MEMELINT);
  await writeFile(join(root, "campaigns", "style.md"), "Write short sentences.\n");
  // patchix writes only into the data directory.
  await chmod(root, 0o555);
  const claude = join(tmp, "claude.sh");
  await writeFile(claude, CLAUDE);
  await chmod(claude, 0o755);
  process.env["PATCHIX_CLAUDE_BIN"] = claude;
  process.env["GH_TOKEN"] = TOKEN;
  ctx = { root, data: join(tmp, "data"), github: `file://${join(tmp, "gh")}` };
  // The runs use the model of the settings.
  await writeSettings(ctx, { fork: "someone", model: "claude-opus-5-6", concurrency: 2 });
  campaign = await readCampaign(ctx, "t");
  await writeTasks(ctx, "t", { synced: "2026-01-01T00:00:00Z", tasks: parseIssueTasks("- [ ] **foo** — `/share/foo/ca.pem` · trusts AAA\n- [ ] **bar** — `/b`\n- [ ] **baz** — `/c`\n- [ ] **qux** — `/d`\n- [ ] **quux** — `/e`\n- [ ] **lib.a** — `/f`\n- [ ] **lib.b** — `/g`\n- [ ] **lib.c** — `/h`\n- [x] **done** — `/i`\n") });
});

after(async () => {
  await chmod(ctx.root, 0o755);
  await rm(tmp, { recursive: true, force: true });
  if (oldToken === undefined) delete process.env["GH_TOKEN"];
  else process.env["GH_TOKEN"] = oldToken;
});

test("a run with a commit, a description and a check that passes is ok", async () => {
  const run = await startRun(ctx, "t", "foo");
  assert.equal(run.status, "ok", run.error ?? "");
  assert.equal(run.model, "claude-opus-5-6", "the model of the settings");
  assert.equal(run.base, master, "the base is the tip of master");
  assert.equal(run.commits, 1);
  assert.notEqual(run.head, null);
  assert.equal(run.pid, null);
  assert.equal(run.checks[0]?.status, "pass");
  assert.equal(run.lint, 0, "memelint accepts the description with the castore word of words.txt");
  const dir = runDir(ctx, "t", "foo", run.id);
  assert.equal(await exists(join(dir, "diff.patch")), false, "the branch has the diff, not the run");
  assert.match(await branchDiff(ctx, campaign, "foo"), /^diff --git a\/pkgs\/foo\/default.nix [^]*\n\+ca = "cacert";\n$/);
  assert.ok(await exists(join(dir, "description.md")));
  assert.match(await readFile(join(dir, "reply.md"), "utf8"), /^fake claude in /, "reply.md is the stdout of claude");
  assert.equal(run.question, null);
  assert.match(await readFile(join(dir, "checks", "foo.harness.txt"), "utf8"), new RegExp(`^VERDICT foo emudhra: FIXED base=${master}$`, "m"));
  assert.deepEqual([run.attrs, run.checks.map((c) => [c.attr, c.name, c.status])], [["foo"], [["foo", "harness", "pass"]]], "without attrs.txt, the run declares its key");
  const prompt = await readFile(join(dir, "prompt.md"), "utf8");
  assert.ok(prompt.includes(`Run directory, for \`description.md\`, \`words.txt\` and \`attrs.txt\`: \`${dir}\``));
  assert.ok(prompt.includes("- Attribute: `foo`\n"), "the run on an entry has the issue entry");
  assert.ok(prompt.includes("\n`attrs.txt` of the run directory names the entries of the task list that this change fixes"));
  assert.ok(prompt.includes(`# The task list\n\n${DONE_RULE}\n\n- foo (todo)\n- bar (todo)\n`), "each entry with its state");
  assert.ok(prompt.includes("\n- done (external)\n"), "an entry with a tick box is done");
  assert.ok(prompt.includes("- Model: `claude-opus-5-6`"));
  const log = await readFile(join(dir, "log.txt"), "utf8");
  assert.ok(!log.includes("# The task"), "the log does not contain the prompt");
  assert.match(log, /^\[patchix [^\]]+\] .* -p <prompt\.md> --model claude-opus-5-6 /m);
  assert.ok(log.includes("nix has the token"), "claude gets the token in NIX_CONFIG");
  assert.ok((await readFile(join(dir, "checks", "foo.harness.txt"), "utf8")).includes("nix has the token"), "the check gets the token in NIX_CONFIG");
  for (const f of ["log.txt", "prompt.md", "run.yaml", "checks/foo.harness.txt"]) assert.ok(!(await readFile(join(dir, f), "utf8")).includes(TOKEN), `${f} does not contain the token`);

  const repo = repoPath(ctx);
  assert.equal(git(repo, "rev-parse", "--is-shallow-repository"), "true");
  assert.equal(git(repo, "rev-list", "--count", "master"), "1", "the clone has depth 1");
  assert.equal(git(repo, "remote", "get-url", "fork"), `${ctx.github}/someone/nixpkgs`);
  git(repo, "remote", "set-url", "fork", "https://github.com/someone/nixpkgs");
  await cloneBase(ctx, campaign);
  assert.equal(git(repo, "remote", "get-url", "fork"), `${ctx.github}/someone/nixpkgs`, "cloneBase corrects the URL of the fork of a repository that is there");
  const fooTree = worktreePath(ctx, campaign, "foo");
  assert.equal(git(repo, "config", "core.untrackedCache"), "true", "the clone sets the untracked cache");
  assert.equal(git(fooTree, "config", "core.untrackedCache"), "true", "the worktree uses the config of the bare repository");
  git(repo, "config", "--unset", "core.untrackedCache");
  await cacheUntracked(repo);
  assert.equal(git(repo, "config", "core.untrackedCache"), "true", "cacheUntracked sets it in a repository that is there");
  await cacheUntracked(join(tmp, "no-repository"));
  assert.equal(await isClean(fooTree), true);
  await writeFile(join(fooTree, "pkgs", "foo", "fix.patch"), "");
  assert.equal(await isClean(fooTree), false, "a new file without `git add` is a change");
  await rm(join(fooTree, "pkgs", "foo", "fix.patch"));
  assert.equal(await isClean(fooTree), true);

  const state = await campaignState(ctx, "t");
  const [view] = state.branches;
  assert.deepEqual([view?.key, view?.state, view?.head, view?.name, view?.covers], ["foo", "ready", run.head, "t/foo", ["foo"]], "the checks passed: the entry links to the branch");
  assert.equal(view?.worktree, worktreePath(ctx, campaign, "foo"), "the worktree stays");
  assert.deepEqual(state.tasks.slice(0, 2).map((t) => [t.attr, t.branch, t.state]), [["foo", "foo", "ready"], ["bar", null, "todo"]]);
  assert.match(await readFile(join(dir, "log.txt"), "utf8"), /\] foo: the entry links to this branch\n/);

  const pr = await makeDraft(ctx, "t", "foo");
  assert.deepEqual([pr.title, pr.labels, pr.number], ["foo: use cacert bundle instead of bundled CA file", ["1.severity: security"], null]);
  assert.deepEqual(pr.words, ["castore"]);
  assert.match((await readDraft(ctx, "t", "foo")) ?? "", /^Part of #1\./);
  assert.deepEqual((await renderDraft(ctx, "t", "foo"))?.problems, [], "the marks of the draft have no problem");
  const rendered = (await renderDraft(ctx, "t", "foo"))?.text ?? "";
  assert.ok(!rendered.includes("{{"), rendered);
  assert.match(rendered, /harness foo --pr <this PR>/);
  assert.match(rendered, /VERDICT foo emudhra: FIXED/, "the output of the check of the tip");
  assert.match(rendered, /Claude Code used Claude Opus 5\.5\./, "the model of the Assisted-by line, not the model of the settings");
  const commits = await branchCommits(ctx, campaign, "foo");
  assert.deepEqual(
    commits.map(({ sha, subject, message }) => ({ sha, subject, message })),
    [{ sha: run.head, subject: "foo: use cacert bundle instead of bundled CA file", message: "foo: use cacert bundle instead of bundled CA file\n\nAssisted-by: Claude Code (Claude Opus 5.5) with patchix" }],
    "the message of a commit has its trailer line",
  );
  assert.match(commits[0]?.patch ?? "", /^diff --git a\/pkgs\/foo\/default.nix b\/pkgs\/foo\/default.nix\n[^]*\n\+ca = "cacert";\n$/, "the patch is the diff of the commit only");

  await push(ctx, "t/foo");
  const fork = join(tmp, "gh", "someone", "nixpkgs");
  assert.equal(git(fork, "rev-parse", "refs/heads/t/foo"), run.head);

  // A new commit replaces the head. Without `force`, the push replaces the branch of the fork only when the fork has the commit of the last push.
  const wt = worktreePath(ctx, campaign, "foo");
  git(wt, "commit", "-q", "--amend", "-m", "foo: use cacert bundle (2)");
  await assert.rejects(push(ctx, "t/foo"), /rejected/);
  await assert.rejects(push(ctx, "t/foo", master), /stale info/);
  // With `force`, the push replaces the branch of the fork, also when the fork does not have the commit of the last push.
  await push(ctx, "t/foo", master, undefined, true);
  assert.equal(git(fork, "rev-parse", "refs/heads/t/foo"), git(wt, "rev-parse", "HEAD"), "`force` replaced the branch of the fork");
  git(fork, "update-ref", "refs/heads/t/foo", run.head ?? "");
  await push(ctx, "t/foo", run.head);
  assert.equal(git(fork, "rev-parse", "refs/heads/t/foo"), git(wt, "rev-parse", "HEAD"));
  git(wt, "reset", "-q", "--hard", run.head ?? "");
});

test("the publish writes each command and its output into publish.log, also when a command fails", async () => {
  const fork = join(tmp, "gh", "someone", "nixpkgs");
  const pull = '{"html_url":"https://github.com/NixOS/nixpkgs/pull/42","number":42,"state":"open"}';
  const gh = join(tmp, "gh.sh");
  // `gh` keeps a copy of `publish.log` at the time that it makes the pull request.
  const seen = join(tmp, "seen.log");
  await writeFile(
    gh,
    `#!/bin/sh
case "$*" in
*/labels*) echo "1.severity: security";;
*"POST repos/NixOS/nixpkgs/pulls "*) cp '${join(branchDir(ctx, "t", "foo"), "publish.log")}' '${seen}'; echo '${pull}'; echo "a warning of gh" >&2;;
*"PATCH repos/NixOS/nixpkgs/pulls/42 "*) echo '${pull}';;
*) echo "unknown: $*" >&2; exit 1;;
esac
`,
  );
  await chmod(gh, 0o755);
  process.env["PATCHIX_GH_BIN"] = gh;
  try {
    // The branch of the fork has a different commit (see the first test), and the draft has no `pushed` commit. Thus the fork rejects `git push`.
    // When the person did not set the tick box, no command starts.
    await assert.rejects(createOrUpdatePr(ctx, "t", "foo", {} as PublishInput), (e: unknown) => {
      assert.deepEqual([(e as { status?: unknown }).status, (e as Error).message, publishLogOf(e)], [409, CONFIRM_ERROR, null]);
      return true;
    });
    let failed = "";
    await assert.rejects(createOrUpdatePr(ctx, "t", "foo", { confirmed: true }), (e: unknown) => {
      failed = publishLogOf(e) ?? "";
      return true;
    });
    assert.match(failed, /^# publish of t\/foo, \d{4}-\d\d-\d\dT[\d:]+Z\n\$ git push fork t\/foo\n/);
    assert.match(failed, /! \[rejected\][^\n]*\n[^]*\[exit code 1\]\n$/);
    assert.ok(!failed.includes("gh.sh"), "no gh command after the push failed");
    assert.equal(await readPublishLog(ctx, "t", "foo"), failed);

    const draft = await readPr(ctx, "t", "foo");
    assert.deepEqual([draft?.confirmed, draft?.pushed], [null, null], "a publish with an error does not record the confirmation or a push");
    const tip = git(repoPath(ctx), "rev-parse", "refs/heads/t/foo");
    assert.notEqual(git(fork, "rev-parse", "refs/heads/t/foo"), tip, "the rejected push did not change the fork");

    // The person sets the tick box `Force push`: the push replaces the branch on the fork.
    const pr = await createOrUpdatePr(ctx, "t", "foo", { confirmed: true, force: true });
    assert.deepEqual([pr.number, pr.url], [42, "https://github.com/NixOS/nixpkgs/pull/42"]);
    assert.match(pr.confirmed ?? "", /^\d{4}-\d\d-\d\dT[\d:]+Z$/);
    assert.equal((await readPr(ctx, "t", "foo"))?.confirmed, pr.confirmed, "pr.yaml has the time of the confirmation");
    const log = (await readPublishLog(ctx, "t", "foo")) ?? "";
    const commands = log.split("\n").filter((l) => l.startsWith("$ ")).map((l) => l.replace(gh, "gh").replace(/body=@\S+/, "body=@<file>"));
    assert.deepEqual(commands, [
      "$ git push --force fork t/foo",
      "$ gh api -X POST repos/NixOS/nixpkgs/pulls -f base=master -f head=someone:t/foo -f 'title=foo: use cacert bundle instead of bundled CA file' -F body=@<file> --jq '{number, html_url, state}'",
      "$ gh api -X POST repos/NixOS/nixpkgs/issues/42/labels -f 'labels[]=1.severity: security' --jq '.[].name'",
      "$ gh api -X PATCH repos/NixOS/nixpkgs/pulls/42 -f 'title=foo: use cacert bundle instead of bundled CA file' -F body=@<file> --jq '{number, html_url, state}'",
    ]);
    assert.match(log, /\nTo file:\/\/[^\n]*\/someone\/nixpkgs\n \+ [0-9a-f]+\.\.\.[0-9a-f]+ +t\/foo -> t\/foo \(forced update\)\n/, "the output of git push");
    assert.ok(log.includes(`\n${pull}\na warning of gh\n`), "the stdout and the stderr of gh");
    assert.ok(log.endsWith("\n# the pull request is #42: https://github.com/NixOS/nixpkgs/pull/42\n"), log);
    const early = await readFile(seen, "utf8");
    assert.ok(log.startsWith(early) && early.includes(" t/foo -> t/foo (forced update)\n"), `publish.log gets each command while the request operates: ${early}`);
    assert.deepEqual([pr.pushed, git(fork, "rev-parse", "refs/heads/t/foo")], [tip, tip], "pr.yaml has the pushed commit, and the fork has it");
    assert.equal(await exists(worktreePath(ctx, campaign, "foo")), true, "the worktree stays after the publish");
  } finally {
    delete process.env["PATCHIX_GH_BIN"];
  }
});

test("a run without a commit and with the heading `## No small fix` is wontfix; with a change that is not committed, it is unverified", async () => {
  process.env["PATCHIX_TEST_NO_FIX"] = "1";
  try {
    const run = await startRun(ctx, "t", "baz");
    assert.deepEqual([run.status, run.error, run.head, run.commits, run.checks], ["wontfix", null, null, 0, []]);
    assert.notEqual(run.lint, null, "memelint examines the description");
    const state = await campaignState(ctx, "t");
    assert.deepEqual([state.branches.find((b) => b.key === "baz")?.state, state.tasks.find((t) => t.attr === "baz")?.state], ["wontfix", "todo"], "no check passed: the entry has no branch");
    await assert.rejects(makeDraft(ctx, "t", "baz"), (e: Error & { status?: number }) => e.status === 409 && e.message === "no run of the branch has a description.md");
    process.env["PATCHIX_TEST_NO_FIX"] = "dirty";
    const dirty = await startRun(ctx, "t", "baz");
    assert.deepEqual([dirty.status, dirty.error, dirty.checks], ["unverified", "the worktree has changes without a commit", []], "the work of the agent does not make a run failed");
  } finally {
    delete process.env["PATCHIX_TEST_NO_FIX"];
  }
});

test("a run with a check that does not pass is unverified; with a check that stops with an error, it is failed", async () => {
  // With `PATCHIX_TEST_CHECK`, the output of the check does not agree with its `pass` expression. With the value `error`, the check stops with code 1.
  process.env["PATCHIX_TEST_CHECK"] = "fail";
  try {
    const run = await startRun(ctx, "t", "qux");
    assert.deepEqual([run.status, run.error, run.commits, run.checks.map((c) => c.status)], ["unverified", null, 1, ["fail"]]);
    const states = async () => {
      const state = await campaignState(ctx, "t");
      return [state.branches.find((b) => b.key === "qux")?.state, state.tasks.find((t) => t.attr === "qux")?.branch];
    };
    assert.deepEqual(await states(), ["unverified", null], "the check refutes the fix: the entry has no branch");
    const pr = await makeDraft(ctx, "t", "qux");
    assert.equal(pr.title, "foo: use cacert bundle instead of bundled CA file", "a person can make a draft from an unverified run");
    process.env["PATCHIX_TEST_CHECK"] = "error";
    const error = await startRun(ctx, "t", "qux");
    assert.deepEqual([error.status, error.error, error.commits, error.checks.map((c) => c.status)], ["failed", "check harness of qux: error", 1, ["error"]]);
    assert.deepEqual(await states(), ["failed", null]);
    await assert.rejects(createOrUpdatePr(ctx, "t", "qux", { confirmed: true }), (e: Error & { status?: number }) => e.status === 409 && e.message === "the branch covers no entry of the task list");
    // A person links the entry to the branch.
    await updateTasks(ctx, "t", (file) => (file === null ? null : { ...file, tasks: file.tasks.map((t) => (t.attr === "qux" ? { ...t, branch: "qux" } : t)) }));
    await assert.rejects(createOrUpdatePr(ctx, "t", "qux", { confirmed: true }), (e: Error & { status?: number }) => e.status === 409 && e.message === "a check of the tip stopped with an error: harness of qux");
  } finally {
    delete process.env["PATCHIX_TEST_CHECK"];
  }
});

test("a commit that does not agree with the automation/AI policy does not change the status of the run", async () => {
  process.env["PATCHIX_TEST_NO_TRAILER"] = "1";
  try {
    const run = await startRun(ctx, "t", "quux");
    assert.deepEqual([run.status, run.error, run.commits, run.checks.map((c) => c.status)], ["ok", null, 1, ["pass"]]);
    const problems = ["no `Assisted-by: <tool> (<model>) with patchix` line", "a `Co-authored-by` line names an AI: Co-Authored-By: Claude <noreply@anthropic.com>"];
    assert.deepEqual(commitProblems((await branchGit(ctx, campaign, "quux")).commits), [{ sha: run.head, subject: "foo: use cacert bundle instead of bundled CA file", problems }]);
    await makeDraft(ctx, "t", "quux");
    await assert.rejects(createOrUpdatePr(ctx, "t", "quux", { confirmed: true }), (e: Error & { status?: number }) => {
      assert.deepEqual([e.status, e.message, publishLogOf(e)], [409, `the branch does not agree with the automation/AI policy of nixpkgs: commit ${run.head?.slice(0, 12)}: ${problems.join(", ")}`, null]);
      return true;
    });
  } finally {
    delete process.env["PATCHIX_TEST_NO_TRAILER"];
  }
});

test("a run of a task that has a job is refused", async () => {
  const id = "20260101-000000";
  const record = { id, key: "foo", attrs: [], tags: [], question: null, started: "2026-01-01T00:00:00Z", finished: null, model: "m", base: "", head: null, commits: 0, checks: [], lint: null };
  // A process with the words `run t foo` in its command line operates as the runner.
  const runner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)", "run", "t", "foo"], { stdio: "ignore" });
  await once(runner, "spawn");
  try {
    await writeRun(ctx, "t", { ...record, status: "running", pid: runner.pid ?? null, error: null });
    await assert.rejects(startRun(ctx, "t", "foo"), (e: Error & { status?: number }) => e.status === 409);
  } finally {
    runner.kill();
  }
  await writeRun(ctx, "t", { ...record, finished: "x", status: "failed", pid: null, error: "test" });
});

test("the abort signal stops a run, and the run keeps the base of the branch", async () => {
  process.env["PATCHIX_TEST_SLEEP"] = "1";
  try {
    const abort = new AbortController();
    const running = startRun(ctx, "t", "foo", abort.signal);
    abort.abort();
    const run = await running;
    assert.equal(run.status, "stopped");
    assert.equal(run.base, master);
    assert.equal(run.pid, null);
  } finally {
    delete process.env["PATCHIX_TEST_SLEEP"];
  }
});

test("a run with a question continues the conversation; the checks start only when the tip moved", async () => {
  const first = (await listRuns(ctx, "t", "foo")).find((r) => r.status === "ok" && r.checks.length > 0);
  assert.ok(first !== undefined);
  const wt = worktreePath(ctx, campaign, "foo");
  assert.equal(git(wt, "rev-parse", "HEAD"), first.head, "the tip of the branch is the head of the first run");
  /** As the server: the question waits in the branch directory, and the next run gets it. */
  const tipRunId = async () => {
    const git = await branchGit(ctx, campaign, "foo");
    return tipChecks(git.runs, git.tip, ["foo"])[0]?.run?.id;
  };
  const ask = async (question: string) => {
    await writeFile(questionFile(ctx, "t", "foo"), `${question}\n`);
    const run = await startRun(ctx, "t", "foo");
    const dir = runDir(ctx, "t", "foo", run.id);
    const read = (file: string) => readFile(join(dir, file), "utf8");
    assert.equal(await exists(questionFile(ctx, "t", "foo")), false, "the run took the question");
    assert.deepEqual([run.question, await read("question.md"), await read("reply.md")], [question, `${question}\n`, "The reply.\n"]);
    return { run, dir, read };
  };

  const asked = await ask("Why this change?");
  assert.deepEqual([asked.run.status, asked.run.error, asked.run.head, asked.run.checks, asked.run.lint], ["ok", null, first.head, [], null], "no checks: the tip did not move, and it has checks");
  assert.equal(await exists(join(asked.dir, "checks")), false, "the runner did not start the checks");
  assert.match(await asked.read("log.txt"), / -p <prompt\.md> --continue --model claude-opus-5-6 [^]*the tip of the branch did not move, and a previous run has its checks: no checks\n/);
  assert.equal(await tipRunId(), first.id, "the checks of the first run apply to the tip");
  const short = await asked.read("prompt.md");
  assert.match(short, /^# The task\n[^]*\n\n# The question\n[^]*\n\nWhy this change\?\n$/, "the conversation has the instructions of the campaign: the prompt starts with the task block");
  // The agent of a question writes `description.md` again when the change makes the description incorrect: the draft gets the newest description.
  await writeFile(join(asked.dir, "description.md"), "Part of #1.\n\nThe new description.\n");
  await makeDraft(ctx, "t", "foo");
  assert.deepEqual([await readDraft(ctx, "t", "foo"), (await readPr(ctx, "t", "foo"))?.number], ["Part of #1.\n\nThe new description.\n", 42], "the draft keeps the pull request number");

  const dirty = await ask("Change a file, but do not commit it.");
  assert.deepEqual([dirty.run.status, dirty.run.error, dirty.run.checks], ["unverified", "the worktree has changes without a commit", []]);
  await assert.rejects(createOrUpdatePr(ctx, "t", "foo", { confirmed: true }), (e: Error & { status?: number }) => e.status === 409 && e.message === "the worktree of foo has changes without a commit: the branch does not have them");
  git(wt, "checkout", "-q", "--", ".");

  process.env["PATCHIX_TEST_NO_CONVERSATION"] = "1";
  try {
    const amended = await ask("Amend the fix: add a line.");
    assert.deepEqual([amended.run.status, amended.run.error, amended.run.checks.map((c) => c.status)], ["ok", null, ["pass"]], "the tip moved: the runner starts the checks");
    assert.equal(amended.run.head, git(wt, "rev-parse", "HEAD"));
    assert.notEqual(amended.run.head, first.head);
    assert.equal(await tipRunId(), amended.run.id);
    assert.match(await amended.read("log.txt"), /claude --continue: exit code 1; again without --continue, with the full prompt\n/);
    const full = await amended.read("prompt.md");
    assert.match(full, /^# The test campaign\n\nFix the package\.\n\nWrite short sentences\.\n\n# The task\n[^]*\n\n# The question\n[^]*\n\nAmend the fix: add a line\.\n$/, "no conversation: the full prompt, then the question");
  } finally {
    delete process.env["PATCHIX_TEST_NO_CONVERSATION"];
  }

  // A person changes the commit in the worktree: no run has the checks of the new tip, thus the pull request waits for a run.
  git(wt, "commit", "-q", "--amend", "-m", "foo: a commit by hand", "-m", "Assisted-by: Claude Code (Claude Opus 5.5) with patchix");
  const hand = git(wt, "rev-parse", "HEAD");
  assert.equal(await tipRunId(), undefined);
  await assert.rejects(createOrUpdatePr(ctx, "t", "foo", { confirmed: true }), (e: Error & { status?: number }) => e.status === 409 && e.message === "the tip of the branch has no checks for foo");
  // A question that does not move this tip starts the checks: no previous run has them.
  const checked = await ask("Is the change correct?");
  assert.deepEqual([checked.run.status, checked.run.error, checked.run.head, checked.run.checks.map((c) => c.status)], ["ok", null, hand, ["pass"]], "the tip did not move, and it had no checks");
  assert.doesNotMatch(await checked.read("log.txt"), /did not move/);
  assert.equal(await tipRunId(), checked.run.id, "the question run has the checks of the tip");
});

test("a run that declares two attributes gets the checks of each, and the entries link to its branch when the checks pass", async () => {
  process.env["PATCHIX_TEST_ATTRS"] = "lib.a lib.b unknown.attr done";
  try {
    const run = await startRun(ctx, "t", "lib.a");
    assert.equal(run.status, "ok", run.error ?? "");
    assert.deepEqual(run.attrs, ["lib.a", "lib.b", "unknown.attr", "done"], "an attribute that is not in the task list stays in the list");
    assert.deepEqual(run.checks.map((c) => [c.attr, c.status]), [["lib.a", "pass"], ["lib.b", "pass"]]);
    const dir = runDir(ctx, "t", "lib.a", run.id);
    assert.match(await readFile(join(dir, "checks", "lib.b.harness.txt"), "utf8"), /^VERDICT lib\.b emudhra: FIXED /m, "the check of lib.b has {attr} = lib.b");
    assert.match(await readFile(join(dir, "log.txt"), "utf8"), /attrs\.txt: unknown\.attr is not an attribute of the task list: no checks\n[^]*attrs\.txt: done is done \(external\): no checks\n/);
    const state = await campaignState(ctx, "t");
    assert.deepEqual(state.tasks.filter((t) => t.attr.startsWith("lib.")).map((t) => [t.attr, t.branch, t.state]), [["lib.a", "lib.a", "ready"], ["lib.b", "lib.a", "ready"], ["lib.c", null, "todo"]]);
    assert.deepEqual(state.branches.find((b) => b.key === "lib.a")?.covers, ["lib.a", "lib.b"]);
  } finally {
    delete process.env["PATCHIX_TEST_ATTRS"];
  }
});

test("an attribute that the check refutes does not link, and an entry with a different branch does not change", async () => {
  process.env["PATCHIX_TEST_ATTRS"] = "lib.c lib.b";
  process.env["PATCHIX_TEST_REFUTE"] = "lib.c";
  try {
    const run = await startRun(ctx, "t", "lib.c");
    assert.deepEqual([run.status, run.checks.map((c) => [c.attr, c.status])], ["unverified", [["lib.c", "fail"], ["lib.b", "pass"]]]);
    assert.match(await readFile(join(runDir(ctx, "t", "lib.c", run.id), "log.txt"), "utf8"), /\] lib\.b: the entry links to the branch lib\.a; the link does not change\n/);
    assert.ok((await readFile(join(runDir(ctx, "t", "lib.c", run.id), "prompt.md"), "utf8")).includes("\n- lib.a (ready, branch lib.a)\n- lib.b (ready, branch lib.a)\n- lib.c (todo)\n"), "the task list gives the branch of an entry");
    const tasks = (await readTasks(ctx, "t"))?.tasks ?? [];
    assert.deepEqual(tasks.filter((t) => t.attr === "lib.b" || t.attr === "lib.c").map((t) => [t.attr, t.branch]), [["lib.b", "lib.a"], ["lib.c", null]]);
    assert.equal((await campaignState(ctx, "t")).branches.find((b) => b.key === "lib.c")?.state, "unverified", "the branch covers no entry");
  } finally {
    delete process.env["PATCHIX_TEST_ATTRS"];
    delete process.env["PATCHIX_TEST_REFUTE"];
  }
});

test("a free-text run makes the branch and the worktree from the base, and its text is the work", async () => {
  const text = "Add one setup hook for the lib packages.";
  await mkdir(branchDir(ctx, "t", "lib-hook"), { recursive: true });
  await writeFile(questionFile(ctx, "t", "lib-hook"), `${text}\n`);
  const run = await startRun(ctx, "t", "lib-hook");
  assert.deepEqual([run.status, run.error, run.question, run.base, run.attrs, run.checks], ["ok", null, text, master, [], []]);
  const wt = worktreePath(ctx, campaign, "lib-hook");
  assert.equal(git(wt, "rev-parse", "--abbrev-ref", "HEAD"), "t/lib-hook");
  assert.equal(git(wt, "rev-parse", "HEAD^"), master, "the branch starts at the base");
  const dir = runDir(ctx, "t", "lib-hook", run.id);
  const prompt = await readFile(join(dir, "prompt.md"), "utf8");
  assert.match(prompt, /^# The test campaign\n[^]*\n# The task\n[^]*\n- Branch: `t\/lib-hook`\n[^]*\n# The task list\n[^]*\n# The work\n\nNo issue entry has this work[^]*\n\nAdd one setup hook for the lib packages\.\n$/);
  assert.ok(!prompt.includes("- Attribute:"), "no issue entry");
  assert.ok(prompt.includes("one time for each attribute of `attrs.txt` as `{attr}`"));
  assert.match(await readFile(join(dir, "log.txt"), "utf8"), /no attribute of the task list to check: no checks\n/);
  const branch = (await campaignState(ctx, "t")).branches.find((b) => b.key === "lib-hook");
  assert.deepEqual([branch?.state, branch?.covers, branch?.head], ["unverified", [], run.head]);
});

test("the base update, the adopt and the source get a bounded number of commits", async () => {
  await writeFile(join(work, "README"), "three\n");
  git(work, "commit", "-q", "-am", "three");
  git(work, "push", "-q", join(tmp, "gh", "NixOS", "nixpkgs"), "master");
  const tip = git(work, "rev-parse", "HEAD");
  assert.equal(await updateBase(ctx, campaign), tip);
  assert.equal(git(repoPath(ctx), "rev-list", "--count", "master"), "1");

  git(work, "checkout", "-q", "-b", "t/bar");
  await writeFile(join(work, "README"), "bar\n");
  git(work, "commit", "-q", "-am", "bar: fix");
  git(work, "push", "-q", join(tmp, "gh", "someone", "nixpkgs"), "t/bar");
  assert.equal(await adopt(ctx, campaign, "bar"), git(work, "rev-parse", "HEAD"));
  assert.equal(git(repoPath(ctx), "rev-list", "--count", "t/bar"), "2", "an adopted branch has its tip and its parent, the base");
  await assert.rejects(adopt(ctx, campaign, "foo"), /has a worktree/);

  const source = await runSource(ctx, { ...campaign, source: "ls pkgs; echo new.attr from the source" }, []);
  assert.deepEqual([...(source ?? [])], [["foo", ""], ["new.attr", "from the source"]]);
  assert.equal(git(join(ctx.data, ".cache", "worktrees", "t", "_base"), "rev-parse", "HEAD"), tip);
});

test("a check-only run starts the checks of the entries of the branch without the agent; a branch without a commit is unverified", async () => {
  const cli = join(import.meta.dirname, "..", "src", "cli.ts");
  const fork = git(repoPath(ctx), "remote", "get-url", "fork");
  // The CLI uses `https://github.com`: thus it writes the SSH URL of the fork into the remote. This test writes the test URL again.
  const out = execFileSync(process.execPath, [cli, "--root", ctx.root, "--data", ctx.data, "run", "t", "lib.a", "--check"], { encoding: "utf8" });
  git(repoPath(ctx), "remote", "set-url", "fork", fork);
  const [run] = await listRuns(ctx, "t", "lib.a");
  assert.ok(run !== undefined);
  assert.match(out, new RegExp(`^lib\\.a: ok \\(run ${run.id}, 1 commits, lint -\\)$`, "m"));
  const tip = git(worktreePath(ctx, campaign, "lib.a"), "rev-parse", "HEAD");
  assert.deepEqual([run.status, run.error, run.tags, run.question, run.head, run.commits, run.lint], ["ok", null, ["check"], null, tip, 1, null]);
  assert.deepEqual(
    [run.attrs, run.checks.map((c) => [c.attr, c.name, c.status])],
    [["lib.a", "lib.b", "unknown.attr", "done"], [["lib.a", "harness", "pass"], ["lib.b", "harness", "pass"]]],
    "the entries of the branch, then the newest declaration; an attribute that is not in the task list and a done entry get no checks",
  );
  const dir = runDir(ctx, "t", "lib.a", run.id);
  for (const file of ["reply.md", "prompt.md", "description.md"]) assert.equal(await exists(join(dir, file)), false, `no ${file}`);
  assert.match(await readFile(join(dir, "checks", "lib.b.harness.txt"), "utf8"), /^VERDICT lib\.b emudhra: FIXED /m);
  assert.match(
    await readFile(join(dir, "log.txt"), "utf8"),
    /check-only run: the newest declaration is of the run (\d{8}-\d{6}): lib\.a, lib\.b, unknown\.attr, done\n[^]*\] the run \1: unknown\.attr is not an attribute of the task list: no checks\n[^]*\] the run \1: done is done \(external\): no checks\n[^]*check-only run: no agent; the checks of lib\.a, lib\.b\n/,
  );
  const git2 = await branchGit(ctx, campaign, "lib.a");
  assert.deepEqual(tipChecks(git2.runs, git2.tip, ["lib.a", "lib.b"]).map((t) => t.run?.id), [run.id, run.id], "the check-only run has the checks of the tip");

  // The entry `done` has no branch: the run makes the branch from the base, and the branch has no commit.
  const none = await startRun(ctx, "t", "done", undefined, "check");
  assert.deepEqual([none.status, none.error, none.tags, none.attrs, none.checks, none.head], ["unverified", "no commit", ["check"], ["done"], [], null]);
});

test("a check-only run starts the checks of the newest declaration, also for an entry that did not link", async () => {
  await updateTasks(ctx, "t", (file) => (file === null ? null : { ...file, tasks: [...file.tasks, ...parseIssueTasks("- [ ] **pair.a** — `/j`\n- [ ] **pair.b** — `/k`\n")] }));
  const links = async () => ((await readTasks(ctx, "t"))?.tasks ?? []).filter((t) => t.attr.startsWith("pair.")).map((t) => [t.attr, t.branch]);
  process.env["PATCHIX_TEST_ATTRS"] = "pair.a pair.b";
  process.env["PATCHIX_TEST_REFUTE"] = "pair.b";
  const first = await startRun(ctx, "t", "pair.a").finally(() => {
    delete process.env["PATCHIX_TEST_ATTRS"];
    delete process.env["PATCHIX_TEST_REFUTE"];
  });
  assert.deepEqual([first.status, first.attrs, first.checks.map((c) => [c.attr, c.status])], ["unverified", ["pair.a", "pair.b"], [["pair.a", "pass"], ["pair.b", "fail"]]]);
  assert.deepEqual(await links(), [["pair.a", "pair.a"], ["pair.b", null]], "only the entry with checks that pass links");
  // A check-only run of a previous version declared only the entries of the branch. It is newer than the declaration, but it is not a declaration.
  const old: Run = { ...first, id: await newId(join(branchDir(ctx, "t", "pair.a"), "runs")), attrs: ["pair.a"], tags: ["check"], status: "ok", checks: first.checks.filter((c) => c.attr === "pair.a"), error: null };
  await writeRun(ctx, "t", old);

  const run = await startRun(ctx, "t", "pair.a", undefined, "check");
  assert.deepEqual([run.status, run.error, run.head, run.attrs, run.checks.map((c) => [c.attr, c.status])], ["ok", null, first.head, ["pair.a", "pair.b"], [["pair.a", "pass"], ["pair.b", "pass"]]]);
  const log = await readFile(join(runDir(ctx, "t", "pair.a", run.id), "log.txt"), "utf8");
  assert.match(log, new RegExp(`check-only run: the newest declaration is of the run ${first.id}: pair\\.a, pair\\.b\\n[^]*check-only run: no agent; the checks of pair\\.a, pair\\.b\\n[^]*\\] pair\\.b: the entry links to this branch\\n`));
  assert.deepEqual(await links(), [["pair.a", "pair.a"], ["pair.b", "pair.a"]], "the entry links when its checks pass");
  const branch = (await campaignState(ctx, "t")).branches.find((b) => b.key === "pair.a");
  assert.deepEqual([branch?.covers, branch?.state], [["pair.a", "pair.b"], "ready"]);
});
