/**
 * The runs and the asks with temporary repositories. Two bare repositories in a `file://` directory operate as
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
  askDir,
  cloneBase,
  commitProblems,
  createOrUpdatePr,
  draftFromRun,
  exists,
  publishLogOf,
  push,
  readCampaign,
  readDraft,
  readPr,
  readPublishLog,
  renderDraft,
  repoPath,
  runAsk,
  runCommits,
  runDir,
  runSource,
  startRun,
  taskDir,
  taskViews,
  updateBase,
  worktreePath,
  writePr,
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
 * directory. An ask: a reply on `stdout` and a change that is not committed. With `PATCHIX_TEST_NO_CONVERSATION`,
 * `--continue` gives an error. With `PATCHIX_TEST_NO_FIX`, a run makes no commit and writes a description with the
 * heading `## No small fix`; with the value `dirty`, it also changes a file. With `PATCHIX_TEST_NO_TRAILER`, the commit has
 * a `Co-Authored-By` line and no `Assisted-by` line.
 */
const CLAUDE = `#!/bin/sh
set -e
case "$*" in
*"# The question"*)
  case "$*" in *--continue*) if [ -n "$PATCHIX_TEST_NO_CONVERSATION" ]; then echo "No conversation found" >&2; exit 1; fi;; esac
  echo "The reply."
  echo 'reply = 1;' >> pkgs/foo/default.nix
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
  // The runs and the asks use the model of the settings.
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
  assert.match(await readFile(join(dir, "diff.patch"), "utf8"), /\+ca = "cacert";/);
  assert.ok(await exists(join(dir, "description.md")));
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

  const pr = await draftFromRun(ctx, "t", "foo", run.id);
  assert.equal(pr.title, "foo: use cacert bundle instead of bundled CA file");
  assert.deepEqual(pr.words, ["castore"]);
  assert.match((await readDraft(ctx, "t", "foo")) ?? "", /^Part of #1\./);
  const rendered = (await renderDraft(ctx, "t", "foo")) ?? "";
  assert.ok(!rendered.includes("{{"), rendered);
  assert.match(rendered, /harness foo --pr <this PR>/);
  const commits = await runCommits(ctx, "t", "foo", run.id);
  assert.deepEqual(
    commits.map(({ sha, subject, message }) => ({ sha, subject, message })),
    [{ sha: run.head, subject: "foo: use cacert bundle instead of bundled CA file", message: "foo: use cacert bundle instead of bundled CA file\n\nAssisted-by: Claude Code (Claude Opus 5.5) with patchix" }],
    "the message of a commit has its trailer line",
  );
  assert.match(commits[0]?.patch ?? "", /^diff --git a\/pkgs\/foo\/default.nix b\/pkgs\/foo\/default.nix\n[^]*\n\+ca = "cacert";\n$/, "the patch is the diff of the commit only");

  await push(ctx, "t/foo");
  const fork = join(tmp, "gh", "someone", "nixpkgs");
  assert.equal(git(fork, "rev-parse", "refs/heads/t/foo"), run.head);

  // A new commit replaces the head. The push replaces the branch of the fork only when the fork has the commit of the last push.
  const wt = worktreePath(ctx, campaign, "foo");
  git(wt, "commit", "-q", "--amend", "-m", "foo: use cacert bundle (2)");
  await assert.rejects(push(ctx, "t/foo"), /rejected/);
  await assert.rejects(push(ctx, "t/foo", master), /stale info/);
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
    // The branch of the fork has a different commit (see the first test), and the draft has no `pushed` commit. Thus `git push` gives an error.
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

    const head = git(fork, "rev-parse", "refs/heads/t/foo");
    const draft = await readPr(ctx, "t", "foo");
    assert.ok(draft !== null);
    assert.equal(draft.confirmed, null, "a publish with an error does not record the confirmation");
    await writePr(ctx, "t", "foo", { ...draft, pushed: head });
    const pr = await createOrUpdatePr(ctx, "t", "foo", { confirmed: true });
    assert.deepEqual([pr.number, pr.url], [42, "https://github.com/NixOS/nixpkgs/pull/42"]);
    assert.match(pr.confirmed ?? "", /^\d{4}-\d\d-\d\dT[\d:]+Z$/);
    assert.equal((await readPr(ctx, "t", "foo"))?.confirmed, pr.confirmed, "pr.yaml has the time of the confirmation");
    const log = (await readPublishLog(ctx, "t", "foo")) ?? "";
    const commands = log.split("\n").filter((l) => l.startsWith("$ ")).map((l) => l.replace(gh, "gh").replace(/body=@\S+/, "body=@<file>"));
    assert.deepEqual(commands, [
      `$ git push --force-with-lease=t/foo:${head} fork t/foo`,
      "$ gh api -X POST repos/NixOS/nixpkgs/pulls -f base=master -f head=someone:t/foo -f 'title=foo: use cacert bundle instead of bundled CA file' -F body=@<file> --jq '{number, html_url, state}'",
      "$ gh api -X POST repos/NixOS/nixpkgs/issues/42/labels -f 'labels[]=1.severity: security' --jq '.[].name'",
      "$ gh api -X PATCH repos/NixOS/nixpkgs/pulls/42 -f 'title=foo: use cacert bundle instead of bundled CA file' -F body=@<file> --jq '{number, html_url, state}'",
    ]);
    assert.match(log, /\nTo file:\/\/[^\n]*\/someone\/nixpkgs\n \+ [0-9a-f]+\.\.\.[0-9a-f]+ +t\/foo -> t\/foo \(forced update\)\n/, "the output of git push");
    assert.ok(log.includes(`\n${pull}\na warning of gh\n`), "the stdout and the stderr of gh");
    assert.ok(log.endsWith("\n# the pull request is #42: https://github.com/NixOS/nixpkgs/pull/42\n"), log);
    const early = await readFile(seen, "utf8");
    assert.ok(log.startsWith(early) && early.includes(" t/foo -> t/foo (forced update)\n"), `publish.log gets each command while the request operates: ${early}`);
    assert.equal(git(fork, "rev-parse", "refs/heads/t/foo"), pr.pushed);
    assert.equal(await exists(worktreePath(ctx, campaign, "foo")), true, "the worktree stays after the publish");
  } finally {
    delete process.env["PATCHIX_GH_BIN"];
  }
});

test("a run without a commit and with the heading `## No small fix` is wontfix; with a change that is not committed, it is failed", async () => {
  process.env["PATCHIX_TEST_NO_FIX"] = "1";
  try {
    const run = await startRun(ctx, "t", "baz");
    assert.deepEqual([run.status, run.error, run.head, run.commits, run.checks], ["wontfix", null, null, 0, []]);
    assert.notEqual(run.lint, null, "memelint examines the description");
    assert.equal((await taskViews(ctx, "t")).find((v) => v.attr === "baz")?.state, "wontfix");
    process.env["PATCHIX_TEST_NO_FIX"] = "dirty";
    const dirty = await startRun(ctx, "t", "baz");
    assert.deepEqual([dirty.status, dirty.error], ["failed", "no commit; the worktree has changes without a commit"]);
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
    const pr = await draftFromRun(ctx, "t", "qux", run.id);
    assert.equal(pr.run, run.id, "a person can make a draft from an unverified run");
    process.env["PATCHIX_TEST_CHECK"] = "error";
    const error = await startRun(ctx, "t", "qux");
    assert.deepEqual([error.status, error.error, error.commits, error.checks.map((c) => c.status)], ["failed", "check harness: error", 1, ["error"]]);
    assert.equal((await taskViews(ctx, "t")).find((v) => v.attr === "qux")?.state, "failed");
    await assert.rejects(createOrUpdatePr(ctx, "t", "qux", { confirmed: true }), (e: Error & { status?: number }) => e.status === 409 && /is not ok or unverified/.test(e.message));
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
    assert.deepEqual(await commitProblems(ctx, campaign, "quux", run.base, null), [{ sha: run.head, subject: "foo: use cacert bundle instead of bundled CA file", problems }]);
    await draftFromRun(ctx, "t", "quux", run.id);
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
  const record = { id, attr: "foo", tags: [], started: "2026-01-01T00:00:00Z", finished: null, model: "m", base: "", head: null, commits: 0, checks: [], lint: null };
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

test("an ask without a conversation starts claude again without --continue", async () => {
  const id = "20260102-000000";
  const dir = askDir(ctx, "t", "foo", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "question.md"), "Why this change?\n");
  process.env["PATCHIX_TEST_NO_CONVERSATION"] = "1";
  try {
    const ask = await runAsk(ctx, "t", "foo", id);
    assert.equal(ask.status, "ok", ask.error ?? "");
    assert.deepEqual([ask.question, ask.model, ask.pid], ["Why this change?", "claude-opus-5-6", null], "the runner writes ask.yaml");
    await assert.rejects(runAsk(ctx, "t", "foo", id), /not a new ask/);
    assert.deepEqual(ask.files, ["pkgs/foo/default.nix"]);
    assert.equal(await readFile(join(dir, "reply.md"), "utf8"), "The reply.\n");
    assert.match(await readFile(join(dir, "diff.patch"), "utf8"), /\+reply = 1;/);
    const log = await readFile(join(dir, "log.txt"), "utf8");
    assert.match(log, /again without --continue/);
    assert.ok(!log.includes("# The question"), "the log does not contain the prompt");
    const prompt = await readFile(join(dir, "prompt.md"), "utf8");
    assert.match(prompt, /# The question\n\nWhy this change\?\n/);
    assert.match(prompt, /# The instructions of the campaign\n[^]*Fix the package\.\n[^]*Write short sentences\.\n\n# The question/, "the ask has prompt.md of the campaign and style.md");
  } finally {
    delete process.env["PATCHIX_TEST_NO_CONVERSATION"];
  }
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
