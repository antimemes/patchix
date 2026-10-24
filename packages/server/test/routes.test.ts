/**
 * The routes on a temporary root. No route of this test pushes, uses GitHub or makes a worktree: the root has no git
 * repository, thus `git push` cannot start. A test script operates as `zellij`: it records its arguments, gives
 * the names of the tabs and does not start a process. For the tab of a fleet, it writes `fleet.yaml` with
 * `PATCHIX_TEST_FLEET_PID`. Other test scripts operate as `gh` for the `labels` and the `refresh` routes. A runner
 * or a fleet of a test is a process with the words `run t <attr>`, `ask t <attr>` or `fleet t` in its command line:
 * see `alive`.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AskSchema, CampaignSummarySchema, CONFIRM_ERROR, CampaignViewSchema, CommitSchema, JobsViewSchema, LabelSchema, PublishErrorSchema, SettingsViewSchema, TaskDetailSchema, type Run } from "@patchix/common";
import { parseIssueTasks } from "@patchix/fleet";
import { askDir, checkFile, exists, readAsk, runDir, writeAsk, writeDraft, writePr, writeRun, writeTasks, type Ctx } from "@patchix/fleet";
import type { Hono } from "hono";
import { changeOf } from "../src/events.ts";
import { app } from "../src/routes.ts";

let tmp = "";
let ctx: Ctx;
let api: Hono;
let calls = "";
const RUN = "20260101-000000";
const run = (attr: string, id: string, status: Run["status"], pid: number | null): Run => ({ id, attr, tags: [], started: "2026-01-01T00:00:00Z", finished: null, status, model: "claude-opus-5-5", pid, base: "b", head: "h", commits: 1, checks: [], lint: 0, error: null });

/** A process with the words of `marker` in its command line. */
async function marker(words: string) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)", ...words.split(" ")], { stdio: "ignore" });
  await once(child, "spawn");
  return child;
}

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "patchix-server-"));
  ctx = { root: join(tmp, "root"), data: join(tmp, "data"), github: "file:///nonexistent" };
  await mkdir(join(ctx.root, "campaigns", "t"), { recursive: true });
  await writeFile(
    join(ctx.root, "campaigns", "t", "campaign.yaml"),
    "name: t\ntitle: Test\nissue: { repo: NixOS/nixpkgs, number: 1 }\nbranch_prefix: t/\nchecks:\n  - { name: harness, command: 'true', pass: OK }\n",
  );
  await mkdir(ctx.data, { recursive: true });
  await writeFile(join(ctx.data, "settings.yaml"), "fork: someone\nconcurrency: 2\n");
  await writeFile(join(ctx.root, "campaigns", "t", "memelint.toml"), 'check = true\nprofile = "strict"\nwords = ["patchix"]\n');
  await writeTasks(ctx, "t", { synced: "2026-01-01T00:00:00Z", tasks: parseIssueTasks("- [ ] **foo** — `/a`\n- [x] **bar** — `/b`\n- [ ] **baz** — `/c`\n- [ ] **qux** — `/d`\n") });
  await writeRun(ctx, "t", { ...run("foo", RUN, "ok", null), finished: "f" });
  await writeFile(join(runDir(ctx, "t", "foo", RUN), "log.txt"), "the log\n");
  await writeFile(join(runDir(ctx, "t", "foo", RUN), "prompt.md"), "the prompt\n");
  await writeFile(join(runDir(ctx, "t", "foo", RUN), "description.md"), "the description\n");
  await mkdir(join(runDir(ctx, "t", "foo", RUN), "checks"));
  await writeFile(checkFile(runDir(ctx, "t", "foo", RUN), "harness"), "OK\n");
  await writeDraft(ctx, "t", "foo", "Part of #1.\n\n{{disclosure}}\n\n{{check:harness}}\n");
  await writePr(ctx, "t", "foo", { title: "foo: fix", labels: [], run: RUN, words: [], number: null, url: null, created: null, pushed: null, updated: null, state: "open", merged: null, confirmed: null });
  calls = join(tmp, "zellij.txt");
  const zellij = join(tmp, "zellij.sh");
  const fleet = `[ "$6" = "t fleet" ] && printf 'pid: %s\\nstarted: x\\n' "$PATCHIX_TEST_FLEET_PID" > ${join(ctx.data, "state", "t", "fleet.yaml")}\n`;
  await writeFile(zellij, `#!/bin/sh\n[ "$4" = query-tab-names ] && printf 'Tab #1\\nt fleet\\nt/foo/ask\\n' && exit 0\nfor a in "$@"; do printf '%s\\n' "$a" >> ${calls}; done\necho --- >> ${calls}\n${fleet}exit 0\n`);
  await chmod(zellij, 0o755);
  process.env["PATCHIX_ZELLIJ_BIN"] = zellij;
  api = app(ctx);
});

after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const json = async (path: string, init?: RequestInit) => {
  const res = await api.request(path, init);
  return { status: res.status, body: (await res.json()) as unknown };
};
const send = (method: string, body: unknown, headers: Record<string, string> = {}) => ({ method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
/** The body of `POST .../pr`: the person set the tick box. */
const confirm = send("POST", { confirmed: true });

test("the campaigns and their tasks", async () => {
  const list = CampaignSummarySchema.array().parse((await json("/api/campaigns")).body);
  assert.deepEqual(list[0]?.counts, { external: 1, pr: 0, merged: 0, closed: 0, ready: 1, unverified: 0, running: 0, failed: 0, wontfix: 0, todo: 2 });
  assert.deepEqual([list[0]?.jobs, list[0]?.queued], [0, 0]);
  const view = CampaignViewSchema.parse((await json("/api/campaigns/t")).body);
  assert.deepEqual(view.tasks.slice(0, 2).map((t) => [t.attr, t.state, t.head, t.branch_name, t.worktree, t.in_issue]), [
    ["foo", "ready", null, "t/foo", null, true],
    ["bar", "external", null, "t/bar", null, true],
  ]);
  assert.equal((await json("/api/campaigns/Bad")).status, 400);
  assert.equal((await json("/api/campaigns/zzz")).status, 404);
  assert.equal((await json("/api/campaigns/t/tasks/nope")).status, 404);
  assert.deepEqual((await json("/api/nothing")).body, { error: "no route GET /api/nothing" });
  assert.equal((await json("/api/campaigns/t/import", send("POST", { url: "ext::sh -c x" }))).status, 400, "only https:// and file:// URLs");
  assert.equal((await json("/api/campaigns/t/import", send("POST", { url: "file:///x", descriptions: "" }))).status, 400);
});

test("the text files of a run", async () => {
  const log = await api.request(`/api/campaigns/t/tasks/foo/runs/${RUN}/log`);
  assert.match(log.headers.get("Content-Type") ?? "", /^text\/plain/);
  assert.equal(await log.text(), "the log\n");
  assert.equal(await (await api.request(`/api/campaigns/t/tasks/foo/runs/${RUN}/prompt`)).text(), "the prompt\n");
  assert.equal(await (await api.request(`/api/campaigns/t/tasks/foo/runs/${RUN}/description`)).text(), "the description\n");
  assert.equal(await (await api.request(`/api/campaigns/t/tasks/foo/runs/${RUN}/checks/harness`)).text(), "OK\n");
  assert.equal((await api.request(`/api/campaigns/t/tasks/foo/runs/${RUN}/checks/other`)).status, 404);
  assert.equal((await api.request(`/api/campaigns/t/tasks/foo/runs/${RUN}/diff`)).status, 404);
  assert.equal((await api.request(`/api/campaigns/t/tasks/foo/runs/bad/log`)).status, 400);
  // The run has the commits `b` and `h`, and the root has no repository.
  assert.match(((await json(`/api/campaigns/t/tasks/foo/runs/${RUN}/commits`)) as { status: number; body: { error: string } }).body.error, /does not have the commit b of the run/);
  await writeRun(ctx, "t", { ...run("bar", "20260101-000009", "failed", null), head: null, finished: "f" });
  assert.deepEqual(CommitSchema.array().parse((await json("/api/campaigns/t/tasks/bar/runs/20260101-000009/commits")).body), [], "a run without a head");
});

test("the draft, the lint and the conditions of the pull request", async () => {
  const first = TaskDetailSchema.parse((await json("/api/campaigns/t/tasks/foo")).body);
  assert.equal(first.campaign.name, "t");
  assert.deepEqual(first.asks, []);
  assert.match(first.rendered ?? "", /Claude Code used Claude Opus 5\.5\. This pull request description[^\n]*I established confidence in this output: by manual review/);
  assert.deepEqual(first.campaign_words, ["patchix"]);
  assert.deepEqual(first.lint?.findings, []);
  assert.equal(first.publish_log, null);
  assert.equal((await json("/api/campaigns/t/tasks/foo/review", send("PUT", { note: "x" }))).status, 404, "no review route");
  assert.equal((await json("/api/campaigns/t/tasks/foo/lint", { method: "POST" })).status, 404, "no lint route: the GET and the PUT of the draft lint");

  // When the person did not set the tick box, no command starts.
  const unconfirmed = { status: 409, body: { error: CONFIRM_ERROR, publish_log: null } };
  assert.deepEqual(await json("/api/campaigns/t/tasks/foo/pr", { method: "POST" }), unconfirmed, "no body");
  assert.deepEqual(await json("/api/campaigns/t/tasks/foo/pr", send("POST", { confirmed: false })), unconfirmed);
  assert.deepEqual(await json("/api/campaigns/t/tasks/foo/pr", send("POST", { confirmed: "true" })), unconfirmed);
  assert.equal(TaskDetailSchema.parse((await json("/api/campaigns/t/tasks/foo")).body).publish_log, null);
  assert.equal((await json("/api/campaigns/t/tasks/foo/publish-log")).status, 404, "no publish.log");

  // The conditions agree, thus `createOrUpdatePr` starts `git push`. It cannot start: the root has no repository.
  const failed = await json("/api/campaigns/t/tasks/foo/pr", confirm);
  assert.equal(failed.status, 500);
  const error = PublishErrorSchema.parse(failed.body);
  assert.match(error.publish_log ?? "", /^# publish of t\/foo, [^\n]+\n\$ git push fork t\/foo\n\[cannot start git: [^\n]+\]\nerror: cannot start git: [^\n]+\n$/);
  const logged = TaskDetailSchema.parse((await json("/api/campaigns/t/tasks/foo")).body);
  assert.equal(logged.publish_log, error.publish_log, "publish.log");
  assert.equal(await (await api.request("/api/campaigns/t/tasks/foo/publish-log")).text(), error.publish_log, "the route of publish.log");
  assert.equal(logged.task.pr_meta?.confirmed, null, "a publish with an error does not record the confirmation");

  // A newest run that is `unverified` also starts `git push`: the person examined it. A newest run that is `failed` does not.
  await writeRun(ctx, "t", { ...run("foo", "20260101-000010", "unverified", null), finished: "f" });
  assert.equal(TaskDetailSchema.parse((await json("/api/campaigns/t/tasks/foo")).body).task.state, "unverified");
  const unverified = await json("/api/campaigns/t/tasks/foo/pr", confirm);
  assert.equal(unverified.status, 500);
  assert.match(PublishErrorSchema.parse(unverified.body).publish_log ?? "", /\n\$ git push fork t\/foo\n/);
  await writeRun(ctx, "t", { ...run("foo", "20260101-000011", "failed", null), finished: "f" });
  assert.deepEqual(await json("/api/campaigns/t/tasks/foo/pr", confirm), { status: 409, body: { error: "the newest run of foo is not ok or unverified", publish_log: null } });
  for (const id of ["20260101-000010", "20260101-000011"]) await rm(runDir(ctx, "t", "foo", id), { recursive: true });

  // An ask that operates is a job of the task: the pull request waits. The test does not start the push.
  const ask = { id: "20260101-000005", attr: "foo", question: "Why?", started: "2026-01-01T00:00:00Z", finished: null, model: "m", files: [], error: null };
  const runner = await marker("ask t foo 20260101-000005");
  await writeAsk(ctx, "t", { ...ask, status: "running", pid: runner.pid ?? null });
  assert.deepEqual(await json("/api/campaigns/t/tasks/foo/pr", confirm), { status: 409, body: { error: "the task foo has a job that operates: the ask 20260101-000005", publish_log: null } });
  await writeAsk(ctx, "t", { ...ask, status: "ok", finished: "f", pid: null });
  runner.kill();

  assert.equal((await json("/api/campaigns/t/tasks/foo/draft", send("PUT", { title: "" }))).status, 400);
  const draft = { title: "foo: new title", labels: ["x"], description: "Part of #1. It is a bad sentense.\n", words: ["foo"] };
  const saved = TaskDetailSchema.parse((await json("/api/campaigns/t/tasks/foo/draft", send("PUT", draft))).body);
  assert.equal(saved.task.pr_meta?.title, "foo: new title");
  assert.ok(saved.lint?.findings.some((f) => f.file === "pr.md" && f.line === 1), "the PUT lints the new draft");
  assert.deepEqual(TaskDetailSchema.parse((await json("/api/campaigns/t/tasks/foo")).body).lint, saved.lint, "the GET lints the draft");
  assert.deepEqual(await json("/api/campaigns/t/tasks/foo/pr", confirm), { status: 409, body: { error: `the draft has ${saved.lint?.findings.length} memelint findings`, publish_log: null } });
  assert.equal((await json("/api/campaigns/t/tasks/bar/draft", send("PUT", draft))).status, 404, "no draft");
  assert.equal((await json("/api/campaigns/t/tasks/foo/worktree", { method: "DELETE" })).status, 404, "no worktree");
});

test("the server adds the tasks to the queue and starts the fleet in zellij", async () => {
  const jobsView = async (init?: RequestInit, path = "/api/campaigns/t/jobs") => {
    const res = await json(path, init);
    return { status: res.status, view: JobsViewSchema.parse(res.body) };
  };
  assert.deepEqual((await jobsView()).view, { jobs: [], queue: [], fleet: false });
  assert.equal((await json("/api/campaigns/t/jobs", send("POST", { attrs: [] }))).status, 400);
  assert.equal((await json("/api/campaigns/t/jobs", { method: "POST", body: "nope" })).status, 400);
  assert.equal((await json("/api/campaigns/t/jobs", send("POST", { attrs: ["nope"] }))).status, 404);
  assert.equal((await json("/api/campaigns/zzz/jobs", send("POST", { attrs: ["foo"] }))).status, 404);

  // The task `baz` has a live run: the queue does not get it.
  const runner = await marker("run t baz");
  const fleet = await marker("fleet t");
  process.env["PATCHIX_TEST_FLEET_PID"] = String(fleet.pid);
  try {
    await writeRun(ctx, "t", run("baz", "20260101-000001", "running", runner.pid ?? null));
    const added = await jobsView(send("POST", { attrs: ["qux", "baz", "foo"] }));
    assert.equal(added.status, 202);
    assert.deepEqual(added.view, { jobs: [{ attr: "baz", kind: "run", id: "20260101-000001", started: "2026-01-01T00:00:00Z" }], queue: ["qux", "foo"], fleet: true }, "the queue keeps the sequence of the request");
    const args = (await readFile(calls, "utf8")).split("---\n");
    // The test zellij lists no session: the server makes it, then opens the tab of the fleet.
    assert.deepEqual(args[0]?.trim().split("\n"), ["list-sessions", "--no-formatting"]);
    assert.deepEqual(args[1]?.trim().split("\n"), ["attach", "--create-background", "patchix"]);
    assert.deepEqual(args[2]?.trim().split("\n").slice(0, 6), ["-s", "patchix", "action", "new-tab", "--name", "t fleet"]);
    const layout = args[2]?.slice(args[2].indexOf("layout {")) ?? "";
    assert.ok(layout.startsWith(`layout {\n  pane command=${JSON.stringify(process.execPath)} {\n`), layout);
    assert.match(layout, /\n    args "packages\/fleet\/src\/cli.ts" "--root" ".*\/root" "--data" ".*\/data" "--path" "[^"]*" "fleet" "t"\n    cwd ".*\/root"\n    close_on_exit true\n  \}\n\}/);
    assert.equal(args.length, 4, "one tab");

    // The fleet operates: a second request adds no tab, and an entry that is there keeps its position.
    assert.deepEqual((await jobsView(send("POST", { attrs: ["foo", "bar"] }))).view.queue, ["qux", "foo", "bar"]);
    assert.equal((await readFile(calls, "utf8")).split("---\n").length, 4, "no second fleet");
    const [summary] = CampaignSummarySchema.array().parse((await json("/api/campaigns")).body);
    assert.deepEqual([summary?.jobs, summary?.queued], [1, 3]);

    assert.deepEqual((await jobsView({ method: "DELETE" }, "/api/campaigns/t/jobs/qux")).view.queue, ["foo", "bar"], "the delete of a queued task removes its entry");
    assert.equal((await json("/api/campaigns/t/jobs/qux", { method: "DELETE" })).status, 404, "no entry and no job");
    assert.deepEqual((await jobsView({ method: "DELETE" }, "/api/campaigns/t/queue")).view, { jobs: added.view.jobs, queue: [], fleet: true });
    assert.equal((await json("/api/campaigns/zzz/queue", { method: "DELETE" })).status, 404);
  } finally {
    delete process.env["PATCHIX_TEST_FLEET_PID"];
    runner.kill();
    fleet.kill();
  }
  await writeRun(ctx, "t", { ...run("baz", "20260101-000001", "failed", null), finished: "f" });
});

test("stop sends SIGTERM to the runner", async () => {
  const child = await marker("run t qux");
  await writeRun(ctx, "t", run("qux", "20260101-000003", "running", child.pid ?? null));
  const exit = once(child, "exit");
  assert.equal((await json("/api/campaigns/t/jobs/qux", { method: "DELETE" })).status, 200);
  assert.deepEqual((await exit)[1], "SIGTERM");
  assert.equal((await json("/api/campaigns/t/jobs/qux", { method: "DELETE" })).status, 404, "the record is read as stopped");
  assert.match(await readFile(join(runDir(ctx, "t", "qux", "20260101-000003"), "run.yaml"), "utf8"), /status: running/, "the server does not write run.yaml");
});

test("an ask writes the question and starts the runner in zellij", async () => {
  assert.equal((await json("/api/campaigns/t/tasks/foo/ask", send("POST", { question: " " }))).status, 400, "no question");
  const res = await json("/api/campaigns/t/tasks/foo/ask", send("POST", { question: "Why?" }));
  assert.equal(res.status, 201);
  const ask = AskSchema.parse(res.body);
  assert.equal(ask.question, "Why?");
  assert.deepEqual([ask.status, ask.pid], ["running", null], "the ask starts");
  assert.equal(await readFile(join(askDir(ctx, "t", "foo", ask.id), "question.md"), "utf8"), "Why?\n");
  assert.equal(await exists(join(askDir(ctx, "t", "foo", ask.id), "ask.yaml")), false, "the server does not write ask.yaml");
  assert.equal((await readAsk(ctx, "t", "foo", ask.id)).status, "running");
  assert.match(await readFile(calls, "utf8"), /"ask" "t" "foo" "\d{8}-\d{6}"/);
  const detail = TaskDetailSchema.parse((await json("/api/campaigns/t/tasks/foo")).body);
  assert.equal(detail.asks[0]?.id, ask.id);
  assert.equal((await json("/api/campaigns/t/tasks/foo/ask", send("POST", { question: "Again?" }))).status, 409, "the ask is a job");
  assert.equal((await api.request(`/api/campaigns/t/tasks/foo/asks/${ask.id}/reply`)).status, 404);
  assert.equal((await api.request(`/api/campaigns/t/tasks/foo/asks/${ask.id}/prompt`)).status, 404, "the runner did not start");
  await writeFile(join(askDir(ctx, "t", "foo", ask.id), "prompt.md"), "the prompt of the ask\n");
  assert.equal(await (await api.request(`/api/campaigns/t/tasks/foo/asks/${ask.id}/prompt`)).text(), "the prompt of the ask\n");
});

test("the settings: GET gives the file and the fork, PUT writes the file, and an ask obeys the concurrency", async () => {
  const gh = join(tmp, "gh-user.sh");
  await writeFile(gh, "#!/bin/sh\n[ \"$*\" = 'api user --jq .login' ] && echo octocat\n");
  await chmod(gh, 0o755);
  process.env["PATCHIX_GH_BIN"] = gh;
  const token = process.env["GH_TOKEN"];
  try {
    process.env["GH_TOKEN"] = "secret-test-token";
    const first = await json("/api/settings");
    assert.deepEqual(SettingsViewSchema.parse(first.body), { fork: "someone", model: "claude-opus-5-5", concurrency: 2, fork_effective: "someone", token: true, data: ctx.data });
    assert.ok(!JSON.stringify(first.body).includes("secret-test-token"), "the server does not give the token");

    const put = await json("/api/settings", send("PUT", { fork: null, model: "claude-fable-5-1", concurrency: 1 }));
    assert.equal(put.status, 200);
    assert.deepEqual(SettingsViewSchema.parse(put.body), { fork: null, model: "claude-fable-5-1", concurrency: 1, fork_effective: "octocat", token: true, data: ctx.data }, "no fork: the login of gh");
    assert.equal(await readFile(join(ctx.data, "settings.yaml"), "utf8"), "fork: null\nmodel: claude-fable-5-1\nconcurrency: 1\n");
    delete process.env["GH_TOKEN"];
    assert.equal(SettingsViewSchema.parse((await json("/api/settings")).body).token, false);

    // The ask of the test before operates: with a `concurrency` of 1, the campaign has no free position.
    assert.deepEqual(await json("/api/campaigns/t/tasks/baz/ask", send("POST", { question: "Why?" })), { status: 409, body: { error: "the campaign has 1 jobs that operate, its limit" } });

    assert.equal((await json("/api/settings", send("PUT", { fork: "a/b" }))).status, 400, "not a GitHub login");
    assert.equal((await json("/api/settings", send("PUT", { concurrency: 0 }))).status, 400);
    assert.equal((await json("/api/settings", { method: "PUT", body: "nope" })).status, 400);
    assert.deepEqual(SettingsViewSchema.parse((await json("/api/settings", send("PUT", { fork: "someone" }))).body), { fork: "someone", model: "claude-opus-5-5", concurrency: 2, fork_effective: "someone", token: false, data: ctx.data }, "a value that is not in the body gets its default");
  } finally {
    if (token === undefined) delete process.env["GH_TOKEN"];
    else process.env["GH_TOKEN"] = token;
    delete process.env["PATCHIX_GH_BIN"];
  }
});

test("changeOf", () => {
  assert.deepEqual(changeOf("cacert/tasks.yaml"), { campaign: "cacert", attr: null, view: true, job: false });
  assert.deepEqual(changeOf("cacert/tasks/python3Packages.foo/runs/20260101-000000/log.txt"), { campaign: "cacert", attr: "python3Packages.foo", view: true, job: false });
  assert.deepEqual(changeOf("cacert/tasks/foo/asks/20260101-000000/ask.yaml"), { campaign: "cacert", attr: "foo", view: true, job: true });
  assert.deepEqual(changeOf("cacert/tasks/foo/asks/20260101-000000/question.md"), { campaign: "cacert", attr: "foo", view: true, job: true });
  assert.deepEqual(changeOf("cacert/queue/python3Packages.foo"), { campaign: "cacert", attr: null, view: false, job: true });
  assert.deepEqual(changeOf("cacert/fleet.yaml"), { campaign: "cacert", attr: null, view: false, job: true });
  assert.equal(changeOf("cacert/fleet.log"), null);
  assert.equal(changeOf("cacert/tasks/foo/pr.yaml.1.abc.tmp"), null);
  assert.equal(changeOf("cacert/queue/.foo.1.abc.tmp"), null);
});

test("the labels come from gh label list, and the server keeps them for one hour", async () => {
  const gh = join(tmp, "gh-labels.sh");
  const count = join(tmp, "gh-labels.txt");
  const list = [{ name: "1.severity: security", color: "ee0701", description: "" }, { name: "6.topic: python", color: "fef2c0", description: "Python is a language" }];
  await writeFile(gh, `#!/bin/sh\necho "$*" >> ${count}\necho '${JSON.stringify(list)}'\n`);
  await chmod(gh, 0o755);
  process.env["PATCHIX_GH_BIN"] = gh;
  try {
    assert.deepEqual(LabelSchema.array().parse((await json("/api/campaigns/t/labels")).body), list);
    assert.deepEqual((await json("/api/campaigns/t/labels")).body, list);
    assert.equal(await readFile(count, "utf8"), "label list --repo NixOS/nixpkgs --limit 1000 --json name,color,description\n", "one gh call");
    assert.equal((await json("/api/campaigns/zzz/labels")).status, 404);
  } finally {
    delete process.env["PATCHIX_GH_BIN"];
  }
});

test("an error of gh label list is an error of the route", async () => {
  const gh = join(tmp, "gh-fail.sh");
  await writeFile(gh, "#!/bin/sh\necho 'no token' >&2\nexit 1\n");
  await chmod(gh, 0o755);
  process.env["PATCHIX_GH_BIN"] = gh;
  try {
    const res = await app(ctx).request("/api/campaigns/t/labels");
    assert.equal(res.status, 502);
    assert.match(((await res.json()) as { error: string }).error, /^gh label list: .*no token/);
  } finally {
    delete process.env["PATCHIX_GH_BIN"];
  }
});

test("the refresh writes the state of the pull request of the branch into the draft", async () => {
  const gh = join(tmp, "gh.sh");
  await writeFile(gh, `#!/bin/sh\necho '[{"number":5,"state":"MERGED","mergedAt":"2026-10-23T12:00:00Z","url":"https://github.com/NixOS/nixpkgs/pull/5","headRefName":"t/foo"}]'\n`);
  await chmod(gh, 0o755);
  process.env["PATCHIX_GH_BIN"] = gh;
  try {
    const view = CampaignViewSchema.parse((await json("/api/campaigns/t/refresh", { method: "POST" })).body);
    const foo = view.tasks.find((t) => t.attr === "foo");
    assert.deepEqual([foo?.state, foo?.pr_meta?.number, foo?.pr_meta?.state, foo?.pr_meta?.merged], ["merged", 5, "merged", "2026-10-23T12:00:00Z"]);
    assert.deepEqual(await json("/api/campaigns/t/tasks/foo/pr", confirm), { status: 409, body: { error: "the pull request #5 is merged", publish_log: null } });
  } finally {
    delete process.env["PATCHIX_GH_BIN"];
  }
});
