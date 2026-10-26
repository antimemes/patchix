/**
 * `POST .../branches/:key/adopt` with temporary repositories. Two bare repositories in a `file://` directory operate
 * as GitHub: `NixOS/nixpkgs` and the fork `someone/nixpkgs`. The repository of patchix has the branch `t/foo` with one
 * commit, and then the fork gets a different commit of `t/foo`: the two commits are different. A test script operates
 * as `gh`: the fork has no pull request.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BranchDetailSchema, type Run } from "@patchix/common";
import { cloneBase, dequeue, enqueue, fetchRef, readCampaign, readFork, runDir, writeFork, writeRun, type Ctx } from "@patchix/fleet";
import type { Hono } from "hono";
import { app } from "../src/routes.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();
const ASSISTED = "Assisted-by: Claude Code (Claude Opus 5.5) with patchix";
const RUN = "20260101-000000";

let tmp = "";
let ctx: Ctx;
let api: Hono;
let work = "";
let fork = "";
let repo = "";
let base = "";
/** The commit of `t/foo` in the repository of patchix before the adopt. */
let local = "";

/** Makes a different commit of `t/foo` on the fork, and gives it. */
function amendOnFork(message: string): string {
  git(work, "checkout", "-q", "t/foo");
  git(work, "commit", "-q", "--amend", "-m", message, "-m", ASSISTED);
  git(work, "push", "-q", "--force", fork, "t/foo");
  git(work, "checkout", "-q", "master");
  return git(fork, "rev-parse", "t/foo");
}

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "patchix-adopt-"));
  const upstream = join(tmp, "gh", "NixOS", "nixpkgs");
  fork = join(tmp, "gh", "someone", "nixpkgs");
  work = join(tmp, "work");
  const root = join(tmp, "root");
  git(tmp, "init", "-q", "--bare", "-b", "master", upstream);
  git(tmp, "init", "-q", "--bare", "-b", "master", fork);
  git(tmp, "init", "-q", "-b", "master", work);
  await writeFile(join(work, "a.nix"), "{ }\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "base");
  base = git(work, "rev-parse", "HEAD");
  git(work, "push", "-q", upstream, "master");
  git(work, "push", "-q", fork, "master");
  git(work, "checkout", "-q", "-b", "t/foo");
  await writeFile(join(work, "a.nix"), '{ ca = "cacert"; }\n');
  git(work, "commit", "-q", "-am", "foo: fix", "-m", ASSISTED);
  git(work, "push", "-q", fork, "t/foo");
  git(work, "checkout", "-q", "master");

  await mkdir(join(root, "campaigns", "t"), { recursive: true });
  await writeFile(join(root, "campaigns", "t", "campaign.yaml"), "name: t\ntitle: Test\nissue: { repo: NixOS/nixpkgs, number: 1 }\nbranch_prefix: t/\n");
  ctx = { root, data: join(tmp, "data"), github: `file://${join(tmp, "gh")}` };
  await mkdir(ctx.data, { recursive: true });
  await writeFile(join(ctx.data, "settings.yaml"), "fork: someone\n");
  const gh = join(tmp, "gh.sh");
  await writeFile(gh, `#!/bin/sh\ncase "$*" in\n"pr list "*) echo '[]';;\n*) echo "unknown: $*" >&2; exit 1;;\nesac\n`);
  await chmod(gh, 0o755);
  process.env["PATCHIX_GH_BIN"] = gh;

  // The state after a sync: the branch, its run and `fork.yaml`. Then the fork gets a different commit, and a second sync writes it into `fork.yaml`.
  await cloneBase(ctx, await readCampaign(ctx, "t"));
  repo = join(ctx.data, ".cache", "nixpkgs.git");
  local = await fetchRef(ctx, "fork", "t/foo", 2);
  const run: Run = { id: RUN, key: "foo", attrs: [], tags: ["imported"], question: null, started: "2026-01-01T00:00:00Z", finished: "2026-01-01T00:00:00Z", status: "ok", model: "m", pid: null, base, head: local, commits: 1, checks: [], lint: null, error: null };
  await writeRun(ctx, "t", run);
  await writeFork(ctx, "t", "foo", amendOnFork("foo: fix on the fork"));
  api = app(ctx);
});

after(async () => {
  delete process.env["PATCHIX_GH_BIN"];
  await rm(tmp, { recursive: true, force: true });
});

const json = async (path: string, init?: RequestInit) => {
  const res = await api.request(path, init);
  return { status: res.status, body: (await res.json()) as unknown };
};
const adopt = (key = "foo") => json(`/api/campaigns/t/branches/${key}/adopt`, { method: "POST" });
const detail = async () => BranchDetailSchema.parse((await json("/api/campaigns/t/branches/foo")).body);

test("adopt: the conditions, and the commit of the fork replaces the local branch and the clean worktree", async () => {
  const remote = git(fork, "rev-parse", "t/foo");
  assert.deepEqual((await detail()).diverged, { key: "foo", local, fork: remote }, "the branch page gets the two commits");
  assert.equal((await adopt("nope")).status, 404);

  // A job of the branch uses the branch and its worktree.
  const runner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)", "run", "t", "foo"], { stdio: "ignore" });
  await once(runner, "spawn");
  try {
    await writeRun(ctx, "t", { ...(await detail()).branch.runs[0]!, id: "20260101-000001", status: "running", pid: runner.pid ?? null, finished: null });
    assert.deepEqual(await adopt(), { status: 409, body: { error: "the branch foo has a job" } });
  } finally {
    runner.kill();
    await rm(runDir(ctx, "t", "foo", "20260101-000001"), { recursive: true });
  }
  assert.equal(await enqueue(ctx, "t", "foo"), true);
  assert.deepEqual(await adopt(), { status: 409, body: { error: "the branch foo is in the queue" } });
  await dequeue(ctx, "t", "foo");

  // A worktree with changes without a commit: the adopt does not remove it.
  assert.equal((await json("/api/campaigns/t/branches/foo/worktree", { method: "POST" })).status, 200);
  const worktree = join(ctx.data, ".cache", "worktrees", "t", "foo");
  await writeFile(join(worktree, "a.nix"), "{ }\n");
  assert.deepEqual(await adopt(), { status: 409, body: { error: "the worktree of foo has changes without a commit: commit or remove them first" } });
  assert.equal(git(repo, "rev-parse", "t/foo"), local, "the branch does not change");
  git(worktree, "checkout", "-q", "--", ".");

  // A clean worktree: the server removes it, fetches the commit of the fork and makes the worktree again.
  const adopted = await adopt();
  assert.equal(adopted.status, 200);
  const after = BranchDetailSchema.parse(adopted.body);
  assert.deepEqual([after.branch.head, after.diverged, after.branch.worktree, after.clean], [remote, null, worktree, true]);
  assert.equal(git(worktree, "rev-parse", "HEAD"), remote, "the worktree has the commit of the fork");
  assert.equal(git(repo, "rev-parse", "t/foo"), remote);
  assert.equal((await readFork(ctx, "t", "foo"))?.sha, remote);
  assert.deepEqual(after.branch.runs.map((r) => r.id), [RUN], "the branch has a run: the adopt makes no run");

  // Without a worktree, the adopt replaces the tip and makes no worktree.
  assert.equal((await json("/api/campaigns/t/branches/foo/worktree", { method: "DELETE" })).status, 200);
  const newer = amendOnFork("foo: fix again on the fork");
  const again = BranchDetailSchema.parse((await adopt()).body);
  assert.deepEqual([again.branch.head, again.diverged, again.branch.worktree], [newer, null, null]);
});
