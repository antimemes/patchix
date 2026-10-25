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
import { CONFIRM_ERROR, type Campaign, type PublishInput } from "@patchix/common";
import { parseIssueTasks } from "../src/issue.ts";
import {
  adopt,
  branchCommits,
  branchDiff,
  branchState,
  cloneBase,
  commitProblems,
  createOrUpdatePr,
  exists,
  listRuns,
  makeDraft,
  publishLogOf,
  push,
  questionFile,
  readCampaign,
  readDraft,
  readPr,
  readPublishLog,
  renderDraft,
  repoPath,
  runDir,
  runSource,
  startRun,
  taskDir,
  taskViews,
  updateBase,
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
    command: "[ x$PATCHIX_TEST_CHECK != xerror ] && sh -c 'echo VERDICT {attr} emudhra: \${PATCHIX_TEST_CHECK:-FIXED} base={base}' && printenv NIX_CONFIG | grep -q github.com= && echo nix has the token"
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
 * `PATCHIX_TEST_NO_TRAILER`, the commit has a `Co-Authored-By` line and no `Assisted-by` line.
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
  await writeTasks(ctx, "t", { synced: "2026-01-01T00:00:00Z", tasks: parseIssueTasks("- [ ] **foo** — `/share/foo/ca.pem` · trusts AAA\n- [ ] **bar** — `/b`\n- [ ] **baz** — `/c`\n- [ ] **qux** — `/d`\n- [ ] **quux** — `/e`\n") });
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
  assert.match(await readFile(join(dir, "checks", "harness.txt"), "utf8"), new RegExp(`^VERDICT foo emudhra: FIXED base=${master}$`, "m"));
  const prompt = await readFile(join(dir, "prompt.md"), "utf8");
  assert.ok(prompt.includes(`Run directory, for \`description.md\` and \`words.txt\`: \`${dir}\``));
  assert.ok(prompt.includes("- Model: `claude-opus-5-6`"));
  const log = await readFile(join(dir, "log.txt"), "utf8");
  assert.ok(!log.includes("# The task"), "the log does not contain the prompt");
  assert.match(log, /^\[patchix [^\]]+\] .* -p <prompt\.md> --model claude-opus-5-6 /m);
  assert.ok(log.includes("nix has the token"), "claude gets the token in NIX_CONFIG");
  assert.ok((await readFile(join(dir, "checks", "harness.txt"), "utf8")).includes("nix has the token"), "the check gets the token in NIX_CONFIG");
  for (const f of ["log.txt", "prompt.md", "run.yaml", "checks/harness.txt"]) assert.ok(!(await readFile(join(dir, f), "utf8")).includes(TOKEN), `${f} does not contain the token`);

  const repo = repoPath(ctx);
  assert.equal(git(repo, "rev-parse", "--is-shallow-repository"), "true");
  assert.equal(git(repo, "rev-list", "--count", "master"), "1", "the clone has depth 1");
  assert.equal(git(repo, "remote", "get-url", "fork"), `${ctx.github}/someone/nixpkgs`);
  git(repo, "remote", "set-url", "fork", "https://github.com/someone/nixpkgs");
  await cloneBase(ctx, campaign);
  assert.equal(git(repo, "remote", "get-url", "fork"), `${ctx.github}/someone/nixpkgs`, "cloneBase corrects the URL of the fork of a repository that is there");

  const [view] = await taskViews(ctx, "t");
  assert.equal(view?.state, "ready");
  assert.equal(view?.head, run.head);
  assert.equal(view?.branch_name, "t/foo");
  assert.equal(view?.worktree, worktreePath(ctx, campaign, "foo"), "the worktree stays");

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
*"POST repos/NixOS/nixpkgs/pulls "*) cp '${join(taskDir(ctx, "t", "foo"), "publish.log")}' '${seen}'; echo '${pull}'; echo "a warning of gh" >&2;;
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
    assert.equal((await taskViews(ctx, "t")).find((v) => v.attr === "baz")?.state, "wontfix");
    await assert.rejects(makeDraft(ctx, "t", "baz"), (e: Error & { status?: number }) => e.status === 409 && e.message === "no run of the task has a description.md");
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
    assert.equal((await taskViews(ctx, "t")).find((v) => v.attr === "qux")?.state, "unverified");
    const pr = await makeDraft(ctx, "t", "qux");
    assert.equal(pr.title, "foo: use cacert bundle instead of bundled CA file", "a person can make a draft from an unverified run");
    process.env["PATCHIX_TEST_CHECK"] = "error";
    const error = await startRun(ctx, "t", "qux");
    assert.deepEqual([error.status, error.error, error.commits, error.checks.map((c) => c.status)], ["failed", "check harness: error", 1, ["error"]]);
    assert.equal((await taskViews(ctx, "t")).find((v) => v.attr === "qux")?.state, "failed");
    await assert.rejects(createOrUpdatePr(ctx, "t", "qux", { confirmed: true }), (e: Error & { status?: number }) => e.status === 409 && e.message === "a check of the tip stopped with an error: harness");
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
    assert.deepEqual(commitProblems((await branchState(ctx, campaign, "quux")).commits), [{ sha: run.head, subject: "foo: use cacert bundle instead of bundled CA file", problems }]);
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
  const record = { id, attr: "foo", tags: [], question: null, started: "2026-01-01T00:00:00Z", finished: null, model: "m", base: "", head: null, commits: 0, checks: [], lint: null };
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
  /** As the server: the question waits in the task directory, and the next run gets it. */
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
  assert.equal((await branchState(ctx, campaign, "foo")).tipRun?.id, first.id, "the checks of the first run apply to the tip");
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
    assert.equal((await branchState(ctx, campaign, "foo")).tipRun?.id, amended.run.id);
    assert.match(await amended.read("log.txt"), /claude --continue: exit code 1; again without --continue, with the full prompt\n/);
    const full = await amended.read("prompt.md");
    assert.match(full, /^# The test campaign\n\nFix the package\.\n\nWrite short sentences\.\n\n# The task\n[^]*\n\n# The question\n[^]*\n\nAmend the fix: add a line\.\n$/, "no conversation: the full prompt, then the question");
  } finally {
    delete process.env["PATCHIX_TEST_NO_CONVERSATION"];
  }

  // A person changes the commit in the worktree: no run has the checks of the new tip, thus the pull request waits for a run.
  git(wt, "commit", "-q", "--amend", "-m", "foo: a commit by hand", "-m", "Assisted-by: Claude Code (Claude Opus 5.5) with patchix");
  const hand = git(wt, "rev-parse", "HEAD");
  assert.equal((await branchState(ctx, campaign, "foo")).tipRun, undefined);
  await assert.rejects(createOrUpdatePr(ctx, "t", "foo", { confirmed: true }), (e: Error & { status?: number }) => e.status === 409 && e.message === "the tip of the branch has no checks");
  // A question that does not move this tip starts the checks: no previous run has them.
  const checked = await ask("Is the change correct?");
  assert.deepEqual([checked.run.status, checked.run.error, checked.run.head, checked.run.checks.map((c) => c.status)], ["ok", null, hand, ["pass"]], "the tip did not move, and it had no checks");
  assert.doesNotMatch(await checked.read("log.txt"), /did not move/);
  assert.equal((await branchState(ctx, campaign, "foo")).tipRun?.id, checked.run.id, "the question run has the checks of the tip");
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
