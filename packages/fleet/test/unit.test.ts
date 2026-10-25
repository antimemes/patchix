import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tipProblem, tipRun, type Campaign, type CheckResult, type CommitProblems, type Pr, type Run, type Task } from "@patchix/common";
import { parseIssueTasks } from "../src/issue.ts";
import { checkCommand, passRegex } from "../src/checks.ts";
import { capture, CaptureError, childEnv, commandLine } from "../src/proc.ts";
import { aiCoauthor, assistedModels, branchState, commitProblems, forkUrl, git, messages, NO_ASSISTED, problemText, repoPath } from "../src/git.ts";
import { forkOf } from "../src/github.ts";
import { parseLint, withWords } from "../src/lint.ts";
import { refreshPrs, renderDraft } from "../src/pr.ts";
import { parseWords } from "../src/run.ts";
import {
  addQuestion,
  alive,
  checkFile,
  clearQueue,
  dequeue,
  enqueue,
  exists,
  jobs,
  listQueue,
  listRuns,
  queueDir,
  questionFile,
  readCampaign,
  readPr,
  readSettings,
  runDir,
  runId,
  takeQuestion,
  taskState,
  taskViews,
  tomlWords,
  writeDraft,
  writePr,
  writeRun,
  writeSettings,
  writeTasks,
  type Ctx,
} from "../src/store.ts";
import { mergeTasks, parseSource } from "../src/sync.ts";
import { cliLayout, kdlString, launch } from "../src/zellij.ts";

const task: Task = { attr: "foo", paths: [], notes: "", checked: false, pr: null, remark: null, in_issue: true, in_source: false, branch: null };
const run = (status: Run["status"], id = "20260101-000000", pid: number | null = null): Run => ({ id, attr: "foo", tags: [], question: null, started: "2026-01-01T00:00:00Z", finished: null, status, model: "m", pid, base: "", head: null, commits: 0, checks: [], lint: null, error: null });
const pr = (number: number | null, state: Pr["state"] = "open"): Pr => ({ title: "t", labels: [], words: [], number, url: null, created: null, pushed: null, updated: null, state, merged: null, confirmed: null });
/** The tip of the branch in the tests of `tipRun` and `taskState`. */
const TIP = "a1";
/** A run with the head `head` and one check with the status `check`. */
const checked = (status: Run["status"], check: CheckResult["status"] = "pass", id = "20260101-000000", head = TIP): Run => ({ ...run(status, id), head, checks: [{ name: "harness", status: check, code: 0, seconds: 1 }] });

test("tipRun gives the newest run with the checks of the tip, and tipProblem gives its problem", () => {
  const older = checked("ok", "pass", "20260101-000001");
  const newer = checked("unverified", "fail", "20260101-000002");
  const question = { ...run("ok", "20260101-000003"), head: TIP, question: "Why?" };
  const other = checked("ok", "pass", "20260101-000004", "b2");
  const runs = [other, question, newer, older];
  assert.equal(tipRun(runs, TIP), newer, "the newest run with the head of the tip and with checks");
  assert.equal(tipRun(runs, "b2"), other);
  assert.equal(tipRun(runs, "c3"), undefined, "a commit by hand: no run has the checks of the tip");
  assert.equal(tipRun(runs, null), undefined, "no branch");
  assert.equal(tipRun([checked("stopped", "pass", "20260101-000005"), older], TIP), older, "a stopped run can have a part of the checks only");
  assert.equal(tipProblem(undefined), "the tip of the branch has no checks");
  assert.equal(tipProblem(newer), null, "a check that is fail: the person makes the decision");
  assert.equal(tipProblem(checked("failed", "error")), "a check of the tip stopped with an error: harness");
});

test("taskState", () => {
  const ok = checked("ok");
  assert.equal(taskState(task, [], null, null), "todo");
  assert.equal(taskState(task, [run("running"), ok], null, TIP), "running");
  assert.equal(taskState(task, [ok, run("failed")], null, TIP), "ready");
  assert.equal(taskState(task, [ok], null, "b2"), "unverified", "a commit by hand: the tip has no checks");
  assert.equal(taskState(task, [ok], null, null), "unverified", "no branch");
  assert.equal(taskState(task, [{ ...run("ok"), head: TIP, question: "Why?" }, ok], null, TIP), "ready", "the checks of an earlier run of the tip");
  assert.equal(taskState(task, [{ ...run("ok"), head: TIP, question: "Why?" }, checked("failed", "error")], null, TIP), "failed", "a check of the tip stopped with an error");
  assert.equal(taskState(task, [{ ...run("unverified"), head: TIP, error: "the worktree has changes without a commit" }, ok], null, TIP), "ready", "the branch does not have these changes");
  assert.equal(taskState(task, [run("failed")], pr(null), TIP), "failed");
  assert.equal(taskState(task, [run("stopped"), ok], null, TIP), "failed");
  assert.equal(taskState(task, [run("wontfix"), run("failed")], null, null), "wontfix", "the agent found no small fix");
  assert.equal(taskState(task, [ok, run("wontfix")], null, TIP), "ready");
  assert.equal(taskState(task, [checked("unverified", "fail"), ok], null, TIP), "unverified", "a check did not pass: a person decides");
  assert.equal(taskState(task, [run("failed"), checked("unverified", "fail")], null, TIP), "failed");
  assert.equal(taskState(task, [run("unverified")], pr(7), TIP), "pr");
  assert.equal(taskState(task, [run("wontfix")], pr(7), TIP), "pr");
  assert.equal(taskState(task, [ok], pr(7), TIP), "pr");
  assert.equal(taskState(task, [run("running")], pr(7), TIP), "pr", "the pull request has priority");
  assert.equal(taskState({ ...task, pr: 9 }, [ok], null, TIP), "external");
  assert.equal(taskState({ ...task, checked: true }, [], null, null), "external");
  assert.equal(taskState({ ...task, pr: 9 }, [], pr(9), null), "pr");
  assert.equal(taskState({ ...task, checked: true }, [], pr(9), null), "pr", "the tick box does not hide an open pull request");
  assert.equal(taskState({ ...task, checked: true }, [], pr(9, "merged"), null), "merged");
  assert.equal(taskState({ ...task, checked: true }, [ok], pr(9, "closed"), TIP), "closed");
  assert.equal(taskState({ ...task, checked: true }, [ok], pr(null), TIP), "ready", "patchix has a draft: the task is not done elsewhere");
});

test("git refuses the commands that can deepen the checkout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "patchix-git-"));
  try {
    execFileSync("git", ["init", "-q", dir]);
    await assert.rejects(git(dir, ["fetch", "upstream", "master"]), /does not start git fetch/);
    const refused = [["pull"], ["clone", "x"], ["submodule", "update"], ["merge-base", "a", "b"], ["worktree", "prune"], ["log", "--depth=1"], ["log", "--deepen=1"], ["rev-list", "--unshallow"], ["-C", dir, "fetch"]];
    for (const args of refused) {
      await assert.rejects(git(dir, args), /does not start git/, args.join(" "));
    }
    assert.equal((await git(dir, ["rev-parse", "--is-inside-work-tree"])).trim(), "true");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("commitProblems examines the Assisted-by line, and the Co-authored-by lines that name an AI", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "patchix-trailers-"));
  try {
    const ctx: Ctx = { root: tmp, data: join(tmp, "data"), github: "file:///nonexistent" };
    const campaign = { name: "t", branch_prefix: "t/" } as Campaign;
    const work = join(tmp, "work");
    const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: work, encoding: "utf8" }).trim();
    execFileSync("git", ["init", "-q", "-b", "t/foo", work]);
    g("commit", "-q", "--allow-empty", "-m", "base");
    const base = g("rev-parse", "HEAD");
    await writeRun(ctx, "t", { ...run("ok", "20260101-000001"), base });
    assert.deepEqual(await branchState(ctx, campaign, "foo"), { base, tip: null, commits: [], tipRun: undefined }, "no repository");
    const good = "Assisted-by: Claude Code (Claude Opus 5.5) with patchix";
    // For each commit: the first line of the message, the other lines and the problems.
    const cases: [string, string[], string[]][] = [
      ["good", ["The body.", good], []],
      ["missing", ["The body."], [NO_ASSISTED]],
      ["without patchix", ["Assisted-by: Claude Code (Claude Opus 5.5)"], [NO_ASSISTED]],
      ["without model", ["Assisted-by: Claude Code with patchix"], [NO_ASSISTED]],
      ["lower case assisted", ["assisted-by: Claude Code (Claude Opus 5.5) with patchix"], [NO_ASSISTED]],
      ["indented", [` ${good}`], [NO_ASSISTED]],
      ["person", [good, "Co-authored-by: A Person <a@example.com>"], []],
      ["person, lower case", [good, "co-authored-by: B <b@example.com>"], []],
      ["claude", [good, "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"], [aiCoauthor("Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>")]],
      ["both", ["Co-Authored-By: Claude <noreply@anthropic.com>"], [NO_ASSISTED, aiCoauthor("Co-Authored-By: Claude <noreply@anthropic.com>")]],
      ["upper case", [good, "CO-AUTHORED-BY: GitHub Copilot <copilot@github.com>"], [aiCoauthor("CO-AUTHORED-BY: GitHub Copilot <copilot@github.com>")]],
      ["lower case", [good, "co-authored-by: A <a@example.com>", "co-authored-by: GPT-5 <bot@openai.com>"], [aiCoauthor("co-authored-by: GPT-5 <bot@openai.com>")]],
    ];
    const expected: CommitProblems[] = [];
    for (const [subject, lines, problems] of cases) {
      g("commit", "-q", "--allow-empty", "-m", subject, ...lines.flatMap((l) => ["-m", l]));
      if (problems.length > 0) expected.unshift({ sha: g("rev-parse", "HEAD"), subject, problems });
    }
    execFileSync("git", ["clone", "-q", "--bare", work, repoPath(ctx)]);
    const tip = g("rev-parse", "HEAD");
    const commits = await messages(repoPath(ctx), base, tip);
    assert.deepEqual(commitProblems(commits), expected, "only the commits with a problem, the newest first");
    assert.deepEqual(assistedModels(commits), ["Claude Opus 5.5"], "the models of the Assisted-by lines");
    assert.deepEqual(await messages(repoPath(ctx), tip, tip), [], "no commit");
    // A run that did not start has no base: the base of the branch is the base of the newest run with a base.
    await writeRun(ctx, "t", run("failed", "20260101-000002"));
    assert.deepEqual(await branchState(ctx, campaign, "foo"), { base, tip, commits, tipRun: undefined }, "the branch of the task, and no run of the tip");
    assert.deepEqual((await branchState(ctx, campaign, "bar")).tip, null, "no branch");
    const both = expected.find((p) => p.subject === "both");
    assert.equal(both && problemText(both), `commit ${both?.sha.slice(0, 12)}: ${NO_ASSISTED}, ${aiCoauthor("Co-Authored-By: Claude <noreply@anthropic.com>")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("an error of capture has all the stdout and the stderr, and the log has the command and its output", async () => {
  const long = "x".repeat(5000);
  const log: string[] = [];
  const script = `echo ${long}; sleep 0.1; echo 'the error' >&2; exit 3`;
  await assert.rejects(capture("sh", ["-c", script], { log }), (e: unknown) => {
    assert.ok(e instanceof CaptureError);
    assert.deepEqual([e.code, e.stdout, e.stderr], [3, `${long}\n`, "the error\n"]);
    assert.ok(e.message.includes(long) && e.message.includes("the error"), "the message has all the output");
    return true;
  });
  assert.deepEqual(log, [`$ sh -c '${script.replaceAll("'", "'\\''")}'`, `${long}\nthe error`, "[exit code 3]"]);
  assert.equal(await capture("sh", ["-c", "echo out; echo err >&2"], { log }), "out\n", "the result is only the stdout");
  assert.equal(log.at(-1)?.split("\n").sort().join(" "), "err out");
  assert.equal(commandLine("gh", ["api", "-f", "title=a b", "labels[]=x"]), "gh api -f 'title=a b' 'labels[]=x'");
});

test("forkUrl gives an SSH URL for GitHub and the test URL for a test", () => {
  const campaign = { issue: { repo: "NixOS/nixpkgs", number: 1 } } as Campaign;
  assert.equal(forkUrl({ root: "/r", data: "/r", github: "https://github.com" }, campaign, "someone"), "ssh://git@github.com/someone/nixpkgs");
  assert.equal(forkUrl({ root: "/r", data: "/r", github: "file:///tmp/gh" }, campaign, "someone"), "file:///tmp/gh/someone/nixpkgs");
});

test("settings.yaml: the defaults without the file, the values of the file, and the write", async () => {
  const data = await mkdtemp(join(tmpdir(), "patchix-settings-"));
  const ctx: Ctx = { root: "/nonexistent", data, github: "file:///nonexistent" };
  try {
    assert.deepEqual(await readSettings(ctx), { fork: null, model: "claude-opus-5-5", concurrency: 2 }, "no file: the defaults");
    await writeFile(join(data, "settings.yaml"), "model: claude-fable-5-1\nold: 1\n");
    assert.deepEqual(await readSettings(ctx), { fork: null, model: "claude-fable-5-1", concurrency: 2 }, "a value that is not in the file gets its default");
    await writeFile(join(data, "settings.yaml"), "");
    assert.deepEqual(await readSettings(ctx), { fork: null, model: "claude-opus-5-5", concurrency: 2 }, "an empty file");
    await writeSettings(ctx, { fork: "someone", model: "claude-opus-5-5", concurrency: 3 });
    assert.equal(await readFile(join(data, "settings.yaml"), "utf8"), "fork: someone\nmodel: claude-opus-5-5\nconcurrency: 3\n");
    assert.deepEqual(await readSettings(ctx), { fork: "someone", model: "claude-opus-5-5", concurrency: 3 });
    await assert.rejects(writeSettings(ctx, { fork: "a/b", model: "m", concurrency: 1 }), /fork/, "a fork that is not a GitHub login");
    await assert.rejects(writeSettings(ctx, { fork: null, model: "m", concurrency: 0 }), /concurrency/);
    await writeFile(join(data, "settings.yaml"), "concurrency: many\n");
    await assert.rejects(readSettings(ctx), /settings\.yaml: [\s\S]*concurrency/, "an incorrect file gives an error with its path");
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("forkOf gives the fork of the settings, or the login of gh api user, and the process keeps the login", async () => {
  const data = await mkdtemp(join(tmpdir(), "patchix-fork-"));
  const ctx: Ctx = { root: "/nonexistent", data, github: "file:///nonexistent" };
  const calls = join(data, "gh.txt");
  const gh = join(data, "gh.sh");
  const bad = join(data, "gh-bad.sh");
  try {
    await writeFile(gh, `#!/bin/sh\necho "$*" >> ${calls}\necho someone\n`);
    await writeFile(bad, "#!/bin/sh\necho 'not logged in' >&2\nexit 1\n");
    await chmod(gh, 0o755);
    await chmod(bad, 0o755);
    process.env["PATCHIX_GH_BIN"] = gh;
    assert.equal(await forkOf(ctx), "someone", "no fork in the settings: the login of gh");
    assert.equal(await forkOf(ctx), "someone");
    assert.equal(await readFile(calls, "utf8"), "api user --jq .login\n", "one gh call: the process keeps the login");
    await writeSettings(ctx, { fork: "other", model: "m", concurrency: 1 });
    assert.equal(await forkOf(ctx), "other", "the fork of the settings comes first");
    await writeSettings(ctx, { fork: null, model: "m", concurrency: 1 });
    process.env["PATCHIX_GH_BIN"] = bad;
    await assert.rejects(forkOf(ctx), /^Error: no fork: set the fork on the settings page, or log in to gh \(.*not logged in/);
  } finally {
    delete process.env["PATCHIX_GH_BIN"];
    await rm(data, { recursive: true, force: true });
  }
});

test("a campaign.yaml of an older version loads without fork, model and concurrency, with one warning", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "patchix-legacy-"));
  const ctx: Ctx = { root, data: root, github: "file:///nonexistent" };
  const warn = t.mock.method(console, "warn", () => undefined);
  try {
    await mkdir(join(root, "campaigns", "t"), { recursive: true });
    const file = join(root, "campaigns", "t", "campaign.yaml");
    await writeFile(file, "name: t\ntitle: Test\nissue: { repo: NixOS/nixpkgs, number: 1 }\nfork: someone\nbranch_prefix: t/\nmodel: m\nconcurrency: 2\n");
    const campaign = await readCampaign(ctx, "t");
    assert.deepEqual(["fork" in campaign, "model" in campaign, "concurrency" in campaign, campaign.branch_prefix], [false, false, false, "t/"]);
    await readCampaign(ctx, "t");
    assert.deepEqual(
      warn.mock.calls.map((c) => c.arguments[0]),
      [`warning: ${file}: patchix does not use the keys fork, model, concurrency. The settings page gives the fork, the model and the concurrency.`],
      "one warning for the file",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseLint keeps the errors of the file", () => {
  const output = [
    "/tmp/x/text.md:3:23: error: 'vendored' is not in the STE dictionary; if it is a technical name, add it to memelint.toml [STE 1.6]",
    "/tmp/x/text.md:5:1: error: sentence has 31 words; the STE limit for descriptive text is 25 [STE 6.3]",
    "/tmp/x/other.md:1:1: error: not this file",
    "1 files, 2 comments, 2 errors, 0 warnings (ASD-STE100 issue 9)",
  ].join("\n");
  assert.deepEqual(parseLint(output, "/tmp/x/text.md", "pr.md"), [
    { file: "pr.md", line: 3, message: "'vendored' is not in the STE dictionary; if it is a technical name, add it to memelint.toml [STE 1.6]" },
    { file: "pr.md", line: 5, message: "sentence has 31 words; the STE limit for descriptive text is 25 [STE 6.3]" },
  ]);
  assert.deepEqual(parseLint("", "/tmp/x/text.md", "pr.md"), []);
});

test("tomlWords and withWords", () => {
  const toml = 'check = true\nwords = [\n  # a comment, with "quotes"\n  "a", "b c", \'d\'\n]\n';
  assert.deepEqual(tomlWords(toml)?.words, ["a", "b c", "d"]);
  assert.deepEqual(tomlWords(withWords(toml, ["e"]))?.words, ["a", "b c", "d", "e"]);
  assert.deepEqual(tomlWords(withWords('words = ["a",]\n', ["e"]))?.words, ["a", "e"]);
  assert.deepEqual(tomlWords(withWords("check = true\n", ["e"]))?.words, ["e"]);
  assert.equal(withWords(toml, []), toml);
});

test("runId, parseWords and passRegex", () => {
  assert.equal(runId(new Date("2026-10-23T21:05:09.123Z")), "20261023-210509");
  assert.deepEqual(parseWords("JRE\n\n# comment\n JRE \nPEM\n"), ["JRE", "PEM"]);
  const re = passRegex("^VERDICT {attr} emudhra: FIXED", { attr: "python3Packages.foo", base: "b", after: "a" });
  assert.ok(re.test("x\nVERDICT python3Packages.foo emudhra: FIXED\n"));
  assert.ok(!re.test("VERDICT python3PackagesXfoo emudhra: FIXED"));
  const values = { attr: "lzbench", base: "b", after: "a" };
  assert.equal(checkCommand("brotli-check {attr} --base {base}", values), "brotli-check lzbench --base b");
});

test("the KDL layout of a tab", () => {
  assert.equal(kdlString('a "b" \\c'), '"a \\"b\\" \\\\c"');
  assert.throws(() => kdlString("a\nb"), /control sign/);
  const path = kdlString(process.env["PATH"] ?? "");
  assert.equal(
    cliLayout({ root: "/home/r/patchix", data: "/home/r/data" }, ["run", "cacert", "python3Packages.foo"]),
    `layout {\n  pane command=${kdlString(process.execPath)} {\n    args "packages/fleet/src/cli.ts" "--root" "/home/r/patchix" "--data" "/home/r/data" "--path" ${path} "run" "cacert" "python3Packages.foo"\n    cwd "/home/r/patchix"\n    close_on_exit false\n  }\n}\n`,
  );
  assert.match(cliLayout({ root: "/r", data: "/d" }, ["fleet", "cacert"], true), /"--path" .* "fleet" "cacert"\n    cwd "\/r"\n    close_on_exit true\n/);
});

test("launch gives tab: false when zellij does not show the tab, and does not open the tab again", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchix-launch-"));
  const calls = join(root, "zellij.txt");
  const zellij = join(root, "zellij.sh");
  // The test zellij records the subcommand, lists the session and shows only the tab `t/a`.
  await writeFile(zellij, `#!/bin/sh\nprintf '%s\\n' "\${4:-$1}" >> ${calls}\n[ "$1" = list-sessions ] && echo 'patchix [Created 1s ago]'\n[ "$4" = query-tab-names ] && printf 'Tab #1\\nt/a\\n'\nexit 0\n`);
  await chmod(zellij, 0o755);
  process.env["PATCHIX_ZELLIJ_BIN"] = zellij;
  try {
    const ctx: Ctx = { root, data: root, github: "file:///nonexistent" };
    assert.deepEqual(await launch(ctx, "t/a", ["run", "t", "a"]), { tab: true });
    assert.deepEqual(await launch(ctx, "t/b", ["run", "t", "b"]), { tab: false });
    assert.deepEqual(
      (await readFile(calls, "utf8")).trim().split("\n"),
      ["list-sessions", "new-tab", "query-tab-names", "list-sessions", "new-tab", "query-tab-names", "query-tab-names", "query-tab-names"],
      "one new-tab for each launch, and 3 queries when the tab is not there",
    );
  } finally {
    delete process.env["PATCHIX_ZELLIJ_BIN"];
    await rm(root, { recursive: true, force: true });
  }
});

/** A process with the words of `marker` in its command line, as a runner or a fleet. */
async function markerProcess(marker: string) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)", ...marker.split(" ")], { stdio: "ignore" });
  await once(child, "spawn");
  return child;
}

test("alive: the process operates and its command line contains the marker", async () => {
  const child = await markerProcess("patchix-test run t foo.bar");
  try {
    const pid = child.pid ?? 0;
    assert.equal(alive(pid, "run t foo.bar"), true);
    assert.equal(alive(pid, "run t foo"), false, "the marker has complete words");
    assert.equal(alive(pid, "run t"), true);
    assert.equal(alive(pid, "fleet t foo.bar"), false);
    assert.equal(alive(process.pid, "run t foo.bar"), false, "a live process without the marker");
    assert.equal(alive(spawnSync("true").pid, "true"), false, "a process that stopped");
    assert.equal(alive(0, "run"), false);
  } finally {
    child.kill();
  }
  await once(child, "exit");
  assert.equal(alive(child.pid ?? 0, "run t foo.bar"), false);
});

test("the queue is a directory: one file for each entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchix-queue-"));
  const ctx: Ctx = { root, data: root, github: "file:///nonexistent" };
  try {
    assert.deepEqual(await listQueue(ctx, "t"), [], "no directory");
    await enqueue(ctx, "t", "b", "2026-01-01T00:00:00.001Z");
    await enqueue(ctx, "t", "c", "2026-01-01T00:00:00.000Z");
    await enqueue(ctx, "t", "a", "2026-01-01T00:00:00.001Z");
    assert.deepEqual(await listQueue(ctx, "t"), ["c", "a", "b"], "the oldest first, then the name");
    await enqueue(ctx, "t", "c", "2026-01-02T00:00:00.000Z");
    assert.deepEqual(await listQueue(ctx, "t"), ["c", "a", "b"], "a second enqueue does not change the entry");
    assert.equal(await readFile(join(queueDir(ctx, "t"), "c"), "utf8"), "2026-01-01T00:00:00.000Z\n");
    await writeFile(join(queueDir(ctx, "t"), ".x.1.tmp"), "2025-01-01T00:00:00.000Z\n");
    assert.deepEqual(await listQueue(ctx, "t"), ["c", "a", "b"], "a temporary file is not an entry");
    await assert.rejects(enqueue(ctx, "t", "../x"), /not an attribute/);
    assert.equal(await dequeue(ctx, "t", "a"), true);
    assert.equal(await dequeue(ctx, "t", "a"), false, "a second dequeue does nothing");
    assert.deepEqual(await listQueue(ctx, "t"), ["c", "b"]);
    await clearQueue(ctx, "t");
    assert.deepEqual(await listQueue(ctx, "t"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the task list is the union of the issue and the source", () => {
  const warnings: string[] = [];
  const source = parseSource("foo  bundles a copy\nnew.attr\n\n!bad line\nfoo again\n", warnings);
  assert.deepEqual([...source], [["foo", "bundles a copy"], ["new.attr", ""]]);
  assert.equal(warnings.length, 1);
  const issue = parseIssueTasks("- [ ] **foo** — `/a`\n- [x] **bar** — `/b`\n");
  assert.deepEqual(
    mergeTasks(issue, source).map((t) => [t.attr, t.in_issue, t.in_source, t.notes, t.paths]),
    [
      ["foo", true, true, "", ["/a"]],
      ["bar", true, false, "", ["/b"]],
      ["new.attr", false, true, "", []],
    ],
  );
  assert.deepEqual(mergeTasks(issue, null).map((t) => [t.in_issue, t.in_source]), [[true, false], [true, false]]);
});

test("a running record without a live runner is read as stopped, and the file does not change", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchix-store-"));
  const ctx: Ctx = { root, data: root, github: "file:///nonexistent" };
  const runner = await markerProcess("cli.ts --root /r run t bar");
  try {
    await writeRun(ctx, "t", run("running", "20260101-000001", spawnSync("true").pid ?? null));
    await writeRun(ctx, "t", { ...run("running", "20260101-000002", runner.pid ?? null), attr: "bar" });
    await writeRun(ctx, "t", { ...run("running", "20260101-000003", process.pid), attr: "baz" });
    const [stopped] = await listRuns(ctx, "t", "foo");
    assert.deepEqual([stopped?.status, stopped?.error], ["stopped", "the process stopped"]);
    assert.match(await readFile(join(runDir(ctx, "t", "foo", "20260101-000001"), "run.yaml"), "utf8"), /status: running/, "the server does not write run.yaml");
    assert.equal((await listRuns(ctx, "t", "baz"))[0]?.status, "stopped", "a live pid without the marker: an other process got the pid");
    assert.deepEqual(await jobs(ctx, "t"), [{ attr: "bar", id: "20260101-000002", started: "2026-01-01T00:00:00Z" }]);
  } finally {
    runner.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("the question of a person waits in the task directory until a run takes it, and it goes away with the entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchix-question-"));
  const ctx: Ctx = { root, data: root, github: "file:///nonexistent" };
  const runner = await markerProcess("run t foo");
  try {
    await addQuestion(ctx, "t", "foo", " Why? \n");
    assert.equal(await readFile(questionFile(ctx, "t", "foo"), "utf8"), "Why?\n");
    assert.deepEqual(await listQueue(ctx, "t"), ["foo"], "the question adds the task to the queue");
    await assert.rejects(addQuestion(ctx, "t", "foo", "Again?"), (e: Error & { status?: number }) => e.status === 409 && e.message === "the task foo is in the queue");
    assert.equal(await readFile(questionFile(ctx, "t", "foo"), "utf8"), "Why?\n", "the second question does not replace the first");
    assert.equal(await dequeue(ctx, "t", "foo"), true);
    assert.equal(await exists(questionFile(ctx, "t", "foo")), false, "the question goes away with the entry");

    await addQuestion(ctx, "t", "foo", "Is the symlink enough?");
    const id = "20260101-000001";
    await mkdir(runDir(ctx, "t", "foo", id), { recursive: true });
    assert.equal(await takeQuestion(ctx, "t", "foo", id), "Is the symlink enough?");
    assert.equal(await readFile(join(runDir(ctx, "t", "foo", id), "question.md"), "utf8"), "Is the symlink enough?\n", "the run directory gets question.md");
    assert.equal(await takeQuestion(ctx, "t", "foo", id), null, "no question");
    await dequeue(ctx, "t", "foo");

    await writeRun(ctx, "t", { ...run("running", id, runner.pid ?? null), question: "Is the symlink enough?" });
    await assert.rejects(addQuestion(ctx, "t", "foo", "Why?"), (e: Error & { status?: number }) => e.status === 409 && e.message === "the task foo has a job");
    assert.deepEqual([await listQueue(ctx, "t"), await exists(questionFile(ctx, "t", "foo"))], [[], false]);
  } finally {
    runner.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("the files of an older version load: the kind and the checks_of of a run, and the review, the run and the confirmation of a draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchix-old-"));
  const ctx: Ctx = { root, data: root, github: "file:///nonexistent" };
  try {
    const id = "20260101-000000";
    const run = ["id: 20260101-000000", "attr: foo", "kind: import", "started: 2026-01-01T00:00:00Z", "finished: 2026-01-01T00:00:00Z", "status: ok"];
    run.push("model: m", "pid: null", "base: a", "head: b", "commits: 1", "checks: []", "checks_of: 20251231-000000", "lint: null", "error: null");
    await mkdir(runDir(ctx, "t", "foo", id), { recursive: true });
    await writeFile(join(runDir(ctx, "t", "foo", id), "run.yaml"), `${run.join("\n")}\n`);
    await writeFile(join(runDir(ctx, "t", "foo", id), "diff.patch"), "an old diff\n");
    const [loaded] = await listRuns(ctx, "t", "foo");
    assert.deepEqual([loaded?.tags, loaded?.status, "kind" in (loaded ?? {}), loaded?.question, "checks_of" in (loaded ?? {})], [[], "ok", false, null, false]);

    const review = "review:\n  by: someone\n  at: 2026-01-01T00:00:00Z\n  examined: [diff]\n  note: I read the diff.\n";
    await writeFile(join(root, "state", "t", "tasks", "foo", "pr.yaml"), `title: t\nlabels: []\nrun: ${id}\nwords: []\n${review}number: null\nurl: null\ncreated: null\npushed: null\nupdated: null\n`);
    const pr = await readPr(ctx, "t", "foo");
    assert.deepEqual([pr?.title, pr?.state, pr?.confirmed, "review" in (pr ?? {}), "run" in (pr ?? {})], ["t", "open", null, false, false]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refreshPrs writes the state of the pull requests of the fork into the drafts", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchix-refresh-"));
  const ctx: Ctx = { root, data: root, github: "file:///nonexistent" };
  const calls = join(root, "gh.txt");
  const gh = join(root, "gh.sh");
  const listed = [
    { number: 12, state: "CLOSED", mergedAt: null, url: "u12", headRefName: "t/shared" },
    { number: 11, state: "OPEN", mergedAt: null, url: "u11", headRefName: "t/shared" },
    { number: 10, state: "OPEN", mergedAt: null, url: "u10", headRefName: "t/qux" },
    { number: 8, state: "OPEN", mergedAt: null, url: "u8", headRefName: "t/bar" },
    { number: 7, state: "MERGED", mergedAt: "2026-10-23T12:08:25Z", url: "u7", headRefName: "t/old-name" },
  ];
  try {
    await mkdir(join(root, "campaigns", "t"), { recursive: true });
    await writeFile(join(root, "campaigns", "t", "campaign.yaml"), "name: t\ntitle: Test\nissue: { repo: NixOS/nixpkgs, number: 1 }\nbranch_prefix: t/\n");
    await writeFile(join(root, "settings.yaml"), "fork: someone\n");
    await writeFile(join(root, "list.json"), JSON.stringify(listed));
    await writeFile(gh, `#!/bin/sh\nprintf '%s ' "$@" >> ${calls}\necho >> ${calls}\ncat ${join(root, "list.json")}\n`);
    await chmod(gh, 0o755);
    process.env["PATCHIX_GH_BIN"] = gh;
    const tasks = parseIssueTasks("- [x] **foo** — `/a`\n- [ ] **bar** — `/b`\n- [ ] **baz** — `/c`\n- [ ] **qux** — `/d`\n- [ ] **sh.a** — `/e`\n");
    await writeTasks(ctx, "t", { synced: "2026-01-01T00:00:00Z", tasks: tasks.map((t) => (t.attr === "sh.a" ? { ...t, branch: "t/shared" } : t)) });
    await writePr(ctx, "t", "foo", { ...pr(7), url: "old" });
    await writePr(ctx, "t", "bar", pr(null));
    await writePr(ctx, "t", "baz", pr(9));
    await writePr(ctx, "t", "sh.a", pr(null));
    await writeRun(ctx, "t", { ...run("ok"), attr: "qux" });
    const campaign = await readCampaign(ctx, "t");

    assert.deepEqual(await refreshPrs(ctx, campaign), ["bar", "foo", "sh.a"]);
    assert.equal((await readFile(calls, "utf8")).trim(), "pr list --repo NixOS/nixpkgs --author someone --state all --limit 300 --json number,state,mergedAt,url,headRefName");
    const fields = async (attr: string) => {
      const p = await readPr(ctx, "t", attr);
      return p === null ? null : [p.number, p.state, p.merged, p.url];
    };
    assert.deepEqual(await fields("foo"), [7, "merged", "2026-10-23T12:08:25Z", "u7"], "the number gives the pull request, also with a different branch");
    assert.deepEqual(await fields("bar"), [8, "open", null, "u8"], "the draft gets the pull request of its branch");
    assert.deepEqual(await fields("baz"), [9, "open", null, null], "a number that is not in the list does not change");
    assert.deepEqual(await fields("sh.a"), [12, "closed", null, "u12"], "the newest pull request of the branch of the task");
    assert.equal(await readPr(ctx, "t", "qux"), null, "a task without a draft gets no draft");
    // The root has no repository: the run of `qux` is not the run of a tip.
    assert.deepEqual((await taskViews(ctx, "t")).map((v) => [v.attr, v.state]), [["foo", "merged"], ["bar", "pr"], ["baz", "pr"], ["qux", "unverified"], ["sh.a", "closed"]]);
    assert.deepEqual(await refreshPrs(ctx, campaign), [], "a second refresh changes nothing");
    assert.deepEqual(await refreshPrs(ctx, campaign, []), [], "a given list: no gh");
    assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 2);
  } finally {
    delete process.env["PATCHIX_GH_BIN"];
    await rm(root, { recursive: true, force: true });
  }
});

test("renderDraft hides the local directories in the output of a check", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "patchix-hide-"));
  const ctx: Ctx = { root: join(tmp, "root"), data: join(tmp, "data"), github: "file:///nonexistent" };
  try {
    await mkdir(join(ctx.root, "campaigns", "t"), { recursive: true });
    await writeFile(join(ctx.root, "campaigns", "t", "campaign.yaml"), "name: t\ntitle: Test\nissue: { repo: NixOS/nixpkgs, number: 1 }\nbranch_prefix: t/\nchecks:\n  - { name: harness, command: x, pass: y }\n");
    await writeRun(ctx, "t", run("ok"));
    await writePr(ctx, "t", "foo", pr(null));
    await writeDraft(ctx, "t", "foo", "{{check:harness}}\n");
    const file = checkFile(runDir(ctx, "t", "foo", run("ok").id), "harness");
    const output = `after: worktree ${join(ctx.data, ".cache", "worktrees", "t", "foo")}\nlog: ${ctx.data}/state/t/x.txt\ncode: ${ctx.root}/packages\n`;
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, output);

    // The run has the checks of the tip of the branch: see `branchState`.
    const tipRun = { ...run("ok"), head: "h", checks: [{ name: "harness", status: "pass" as const, code: 0, seconds: 1 }] };
    const rendered = (await renderDraft(ctx, "t", "foo", { base: "b", tip: "h", commits: [], tipRun }))?.text ?? "";
    assert.ok(rendered.includes("after: worktree <worktree>\nlog: <patchix>/state/t/x.txt\ncode: <patchix>/packages\n"), rendered);
    assert.ok(!rendered.includes(tmp), "the description has no local path");
    assert.equal(await readFile(file, "utf8"), output, "the stored output does not change");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("childEnv gives the GitHub token to nix in NIX_CONFIG", () => {
  const line = "access-tokens = github.com=t0ken";
  assert.equal(childEnv({ PATH: "/bin" })["NIX_CONFIG"], undefined, "without GH_TOKEN, NIX_CONFIG is not set");
  assert.equal(childEnv({ GH_TOKEN: "" })["NIX_CONFIG"], undefined);
  assert.equal(childEnv({ GH_TOKEN: "", NIX_CONFIG: "a = 1" })["NIX_CONFIG"], "a = 1");
  assert.deepEqual(childEnv({ PATH: "/bin", GH_TOKEN: "t0ken" }), { PATH: "/bin", GH_TOKEN: "t0ken", NIX_CONFIG: line });
  assert.equal(childEnv({ GH_TOKEN: "t0ken", NIX_CONFIG: "a = 1" })["NIX_CONFIG"], `a = 1\n${line}`, "the line goes after the lines that are there");
  assert.equal(childEnv({ GH_TOKEN: "t0ken", NIX_CONFIG: "a = 1\nb = 2\n" })["NIX_CONFIG"], `a = 1\nb = 2\n${line}`);
  const env = { GH_TOKEN: "t0ken", NIX_CONFIG: "a = 1" };
  childEnv(env);
  assert.equal(env.NIX_CONFIG, "a = 1", "the environment of patchix does not change");
});

test("childEnv removes a TMPDIR that is not a directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "patchix-tmpdir-"));
  try {
    const gone = join(dir, "gone");
    const file = join(dir, "file");
    await writeFile(file, "");
    const env = { PATH: "/bin", TMPDIR: gone };
    assert.deepEqual(childEnv(env), { PATH: "/bin" }, "a TMPDIR that does not exist is removed");
    assert.equal(env.TMPDIR, gone, "the environment of patchix does not change");
    assert.equal("TMPDIR" in childEnv({ TMPDIR: file }), false, "a TMPDIR that is a file is removed");
    assert.equal(childEnv({ TMPDIR: dir })["TMPDIR"], dir, "a TMPDIR that is a directory stays");
    assert.equal("TMPDIR" in childEnv({ PATH: "/bin" }), false, "a TMPDIR that is not set stays not set");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
