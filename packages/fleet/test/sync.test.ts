/**
 * The sync with temporary repositories. Two bare repositories in a `file://` directory operate as GitHub:
 * `NixOS/nixpkgs` (the issue repository) and `someone/nixpkgs` (the fork). The fork has two branches of the campaign:
 * `t/foo` with an open pull request, and `t/bar` without a pull request. A test script operates as `gh`: it gives the
 * issue body and the list of the pull requests.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { adoptBranch, campaignState, listRuns, queueEntries, readDraft, readPr, readTasks, repoPath, runId, sync, writeSettings, type Ctx } from "../src/index.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();

const CAMPAIGN = `name: t
title: Test
issue: { repo: NixOS/nixpkgs, number: 1 }
branch_prefix: t/
checks:
  - { name: harness, command: "echo VERDICT {attr}: FIXED", pass: "^VERDICT {attr}: FIXED" }
`;

/** The entry `qux` has the number of the pull request of `t/foo` in its issue line. */
const ISSUE = "- [ ] **foo** — `/a`\n- [ ] **bar** — `/b`\n- [ ] **qux** — `/c` — #577\n- [ ] **baz** — `/d`\n";
/** A description of a person on GitHub, with the line ends of the GitHub editor. */
const BODY = "Part of #1.\r\n\r\nThe text of a person, without marks.\r\n";

let tmp = "";
let ctx: Ctx;
let work = "";
let fork = "";
let master = "";

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "patchix-sync-"));
  const upstream = join(tmp, "gh", "NixOS", "nixpkgs");
  fork = join(tmp, "gh", "someone", "nixpkgs");
  work = join(tmp, "work");
  const root = join(tmp, "patchix");
  git(tmp, "init", "-q", "--bare", "-b", "master", upstream);
  git(tmp, "init", "-q", "--bare", "-b", "master", fork);
  git(tmp, "init", "-q", "-b", "master", work);
  await writeFile(join(work, "a.nix"), "{ }\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "one");
  await writeFile(join(work, "README"), "two\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "two");
  master = git(work, "rev-parse", "HEAD");
  git(work, "push", "-q", upstream, "master");
  git(work, "push", "-q", fork, "master");
  for (const key of ["foo", "bar"]) {
    git(work, "checkout", "-q", "-b", `t/${key}`, master);
    await writeFile(join(work, "a.nix"), `{ ${key} = 1; }\n`);
    git(work, "commit", "-q", "-am", `${key}: use cacert bundle`, "-m", "Assisted-by: Claude Code (Claude Opus 5.5) with patchix");
    git(work, "push", "-q", fork, `t/${key}`);
  }
  git(work, "checkout", "-q", "master");

  await mkdir(join(root, "campaigns", "t"), { recursive: true });
  await writeFile(join(root, "campaigns", "t", "campaign.yaml"), CAMPAIGN);
  ctx = { root, data: join(tmp, "data"), github: `file://${join(tmp, "gh")}` };
  await writeSettings(ctx, { fork: "someone", model: "claude-opus-5-5", concurrency: 2 });

  const listed = [
    { number: 577, state: "OPEN", mergedAt: null, url: "https://github.com/NixOS/nixpkgs/pull/577", headRefName: "t/foo", title: "foo: use cacert bundle", body: BODY, labels: [{ name: "1.severity: security" }], createdAt: "2026-10-20T10:00:00Z", updatedAt: "2026-10-21T11:00:00Z" },
    { number: 12, state: "CLOSED", mergedAt: null, url: "u12", headRefName: "t/foo", title: "foo: a closed pull request", body: "", labels: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
  ];
  await writeFile(join(tmp, "issue.json"), JSON.stringify({ body: ISSUE }));
  await writeFile(join(tmp, "list.json"), JSON.stringify(listed));
  const gh = join(tmp, "gh.sh");
  await writeFile(gh, `#!/bin/sh\ncase "$*" in\n"api repos/NixOS/nixpkgs/issues/1") cat ${join(tmp, "issue.json")};;\n"pr list "*) cat ${join(tmp, "list.json")};;\n*) echo "unknown: $*" >&2; exit 1;;\nesac\n`);
  await chmod(gh, 0o755);
  process.env["PATCHIX_GH_BIN"] = gh;
});

after(async () => {
  delete process.env["PATCHIX_GH_BIN"];
  await rm(tmp, { recursive: true, force: true });
});

test("the sync gets the branches of the fork, makes their directories, drafts and links, and queues a check-only run", async () => {
  const result = await sync(ctx, "t");
  assert.deepEqual(result, { tasks: 4, prs: [], listed: 2, fetched: 2, made: 2, drafts: 1, links: 3, queued: 1, warnings: [] });

  const repo = repoPath(ctx);
  const tips = { foo: git(fork, "rev-parse", "t/foo"), bar: git(fork, "rev-parse", "t/bar") };
  assert.deepEqual([git(repo, "rev-parse", "t/foo"), git(repo, "rev-parse", "t/bar")], [tips.foo, tips.bar], "the repository of patchix has the branches");
  assert.equal(git(repo, "rev-list", "--count", "t/foo"), "2", "the tip and its parent");
  for (const key of ["foo", "bar"] as const) {
    const runs = await listRuns(ctx, "t", key);
    const time = new Date(Number(git(fork, "log", "-1", "--format=%ct", `t/${key}`)) * 1000);
    assert.deepEqual(
      runs.map((r) => [r.id, r.tags, r.attrs, r.checks, r.status, r.base, r.head, r.commits, r.started, r.finished]),
      [[runId(time), ["imported"], [], [], "ok", master, tips[key], 1, time.toISOString().replace(/\.\d+Z$/, "Z"), time.toISOString().replace(/\.\d+Z$/, "Z")]],
      `${key}: one run with the time of the commit`,
    );
  }

  const pr = await readPr(ctx, "t", "foo");
  assert.deepEqual(pr, {
    title: "foo: use cacert bundle",
    labels: ["1.severity: security"],
    words: [],
    number: 577,
    url: "https://github.com/NixOS/nixpkgs/pull/577",
    created: "2026-10-20T10:00:00Z",
    pushed: tips.foo,
    updated: "2026-10-21T11:00:00Z",
    state: "open",
    merged: null,
    confirmed: "2026-10-20T10:00:00Z",
  });
  assert.equal(await readDraft(ctx, "t", "foo"), BODY, "pr.md is the description of the pull request as it is");
  assert.equal(await readPr(ctx, "t", "bar"), null, "no pull request: no draft");

  assert.deepEqual((await readTasks(ctx, "t"))?.tasks.map((t) => [t.attr, t.branch]), [["foo", "foo"], ["bar", "bar"], ["qux", "foo"], ["baz", null]], "the key of the branch, and the pull request number of the issue line");
  const queue = await queueEntries(ctx, "t");
  assert.deepEqual(queue.map((e) => [e.key, e.mode]), [["bar", "check"]], "the branch without a pull request and without checks of the tip");
  assert.match(await readFile(join(ctx.data, "state", "t", "queue", "bar"), "utf8"), /^\d{4}-[^\n]+Z\ncheck\n$/);
  const state = await campaignState(ctx, "t");
  assert.deepEqual(state.tasks.map((t) => [t.attr, t.state]), [["foo", "pr"], ["bar", "unverified"], ["qux", "pr"], ["baz", "todo"]]);

  // A second sync does not change the state and adds no entry to the queue. A branch that only the repository of patchix has does not change.
  git(repo, "branch", "t/local", master);
  const runs = await listRuns(ctx, "t", "foo");
  const again = await sync(ctx, "t");
  assert.deepEqual(again, { tasks: 4, prs: [], listed: 2, fetched: 0, made: 0, drafts: 0, links: 0, queued: 0, warnings: [] });
  assert.deepEqual(await listRuns(ctx, "t", "foo"), runs);
  assert.deepEqual(await readPr(ctx, "t", "foo"), pr);
  assert.deepEqual(await queueEntries(ctx, "t"), queue);
  assert.equal(git(repo, "rev-parse", "t/local"), master);

  // The fork gets a different commit of `t/bar`: the branch of the repository of patchix can have work, and the sync does not change it.
  git(work, "checkout", "-q", "t/bar");
  git(work, "commit", "-q", "--amend", "-m", "bar: a different commit");
  git(work, "push", "-q", "--force", fork, "t/bar");
  git(work, "checkout", "-q", "master");
  const changed = await sync(ctx, "t");
  assert.deepEqual([changed.fetched, changed.made, changed.queued], [0, 0, 0]);
  assert.deepEqual(changed.warnings, ["the repository of patchix has the branch t/bar with a different commit than the fork: the sync does not change it (the adopt command replaces it)"]);
  assert.equal(git(repo, "rev-parse", "t/bar"), tips.bar);

  // The adopt command is step 3 for one branch: the person asks for the commit of the fork, and the fetch replaces the branch.
  const adopted = await adoptBranch(ctx, "t", "bar");
  assert.deepEqual(adopted, { fetched: true, made: false, draft: false, tip: git(fork, "rev-parse", "t/bar"), links: 0, warnings: [] });
  assert.equal(git(repo, "rev-parse", "t/bar"), git(fork, "rev-parse", "t/bar"));
});
