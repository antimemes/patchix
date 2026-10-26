/**
 * The sync makes the state of a campaign agree with GitHub, in four steps:
 * 1. The task list in `state/<campaign>/tasks.yaml`: the entries of the tracking issue and, when the campaign has a
 *    `source` command, its output.
 * 2. The state of the pull requests of the fork: see `refreshPrs`.
 * 3. The branches `<branch_prefix>*` of the fork: see `forkBranch`. Each branch gets its commits, a run and a draft
 *    from its pull request, when the state does not have them, and `fork.yaml`. Then the entries without a branch get
 *    their links: see `linkBranches`.
 * 4. A check-only run in the queue for each branch of the fork without a pull request and without checks of the tip:
 *    see `queueChecks`.
 *
 * Only `fetchRef` gets commits, with a depth of 2 commits. A branch of the repository of patchix that the fork does not
 * have does not change. It can be work that a person did not push. The sync also does not change a local branch with
 * a different commit than the fork: it is in `SyncResult.diverged`, and `adoptBranch` replaces it. The sync does not
 * start the fleet: the server starts it.
 */
import { ATTR, KEY, tipChecks, type Campaign, type Diverged, type SyncResult, type Task } from "@patchix/common";
import { parseIssueTasks } from "./issue.ts";
import { forkOf, issueBody, prList, type ListedPr } from "./github.ts";
import { addWorktree, adopt, baseWorktree, branchName, cloneBase, commitTime, forkUrl, isClean, remoteBranches, removeWorktree, repoPath, revParse, takeBranch, worktreePath, type RemoteBranch } from "./git.ts";
import { importRun } from "./import.ts";
import { draftFromPr, refreshPrs } from "./pr.ts";
import { capture } from "./proc.ts";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { branchJob, branchKeys, campaignDir, checkAttrs, enqueue, exists, fail, jobs, listQueue, listRuns, message, now, readCampaign, readPr, removeFork, updateTasks, writeFork, type Ctx } from "./store.ts";

/**
 * The task list of the issue body. A campaign with a `tasks.ts` file gives a different function, for an issue with a
 * different line format. Each attribute must be in the body: an attribute that is not there is removed with a warning.
 */
export async function extractTasks(ctx: Ctx, c: string, body: string, warnings: string[]): Promise<Task[]> {
  const custom = join(campaignDir(ctx, c), "tasks.ts");
  let tasks: Task[];
  if (await exists(custom)) {
    const mod = (await import(pathToFileURL(custom).href)) as { default?: unknown };
    if (typeof mod.default !== "function") throw new Error(`${custom} must export a default function from the issue body to the task list`);
    tasks = (mod.default as (body: string) => Task[])(body);
  } else {
    tasks = parseIssueTasks(body);
  }
  return tasks.filter((t) => {
    const ok = typeof t.attr === "string" && ATTR.test(t.attr) && body.includes(t.attr);
    if (!ok) warnings.push(`the task list gave an attribute that is not in the issue: ${String(t.attr).slice(0, 80)}`);
    return ok;
  });
}

/** The lines `<attr>[ <text>]` of the output of `source`, by attribute. A line that does not start with an attribute is a warning. */
export function parseSource(output: string, warnings: string[]): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const line of output.split("\n")) {
    const m = /^\s*(\S+)(?:\s+(.*))?$/.exec(line);
    if (m === null) continue;
    const [, attr = "", text = ""] = m;
    if (ATTR.test(attr)) attrs.set(attr, attrs.get(attr) ?? text.trim());
    else warnings.push(`the source gave a line that is not an attribute: ${line.slice(0, 80)}`);
  }
  return attrs;
}

/**
 * The union of the issue entries and the `source` attributes, by attribute. The issue entries come first. Each task
 * keeps the `branch` of the same attribute in `old`, the task list before the sync.
 */
export function mergeTasks(issue: readonly Task[], source: ReadonlyMap<string, string> | null, old: readonly Task[] = []): Task[] {
  const branches = new Map(old.map((t) => [t.attr, t.branch]));
  const tasks: Task[] = issue.map((t) => ({ ...t, in_issue: true, in_source: source?.has(t.attr) ?? false }));
  const known = new Set(tasks.map((t) => t.attr));
  for (const [attr, text] of source ?? []) {
    if (!known.has(attr)) tasks.push({ attr, paths: [], notes: text, checked: false, pr: null, remark: null, in_issue: false, in_source: true, branch: null });
  }
  return tasks.map((t) => ({ ...t, branch: branches.get(t.attr) ?? t.branch ?? null }));
}

/** Starts the `source` command in the worktree `_base` of the campaign. Gives `null` when the campaign has no `source`. */
export async function runSource(ctx: Ctx, campaign: Campaign, warnings: string[]): Promise<Map<string, string> | null> {
  if (campaign.source === undefined) return null;
  const cwd = await baseWorktree(ctx, campaign);
  return parseSource(await capture("sh", ["-c", campaign.source], { cwd, timeoutMs: 30 * 60_000 }), warnings);
}

/** The keys of the branches with a draft, by the number of the pull request of the draft. */
export async function draftNumbers(ctx: Ctx, c: string): Promise<Map<number, string[]>> {
  const numbers = new Map<number, string[]>();
  for (const key of await branchKeys(ctx, c)) {
    const number = (await readPr(ctx, c, key))?.number;
    if (number !== null && number !== undefined) numbers.set(number, [...(numbers.get(number) ?? []), key]);
  }
  return numbers;
}

/**
 * The task list with the links of the pull request numbers. An entry without a branch can have the number of the pull
 * request of a draft. Then it links to the branch of that draft. When two branches have the number, the branch with the
 * key of the attribute is first, then the first key.
 */
export function linkByPr(tasks: readonly Task[], numbers: ReadonlyMap<number, readonly string[]>): Task[] {
  return tasks.map((t) => {
    const keys = t.branch === null && t.pr !== null ? (numbers.get(t.pr) ?? []) : [];
    return keys.length === 0 ? t : { ...t, branch: keys.includes(t.attr) ? t.attr : (keys[0] ?? null) };
  });
}

/** The number of entries of `after` with a branch that had no branch in `before`. */
function newLinks(before: readonly Task[], after: readonly Task[]): number {
  const old = new Map(before.map((t) => [t.attr, t.branch]));
  return after.filter((t) => t.branch !== null && (old.get(t.attr) ?? null) === null).length;
}

/**
 * The links of the branches `keys`: an entry without a branch links to the branch of its attribute, when `keys` has
 * the attribute. Then an entry without a branch links to the branch of the pull request number of its issue line (see
 * `linkByPr`). The change goes through `updateTasks`. Gives the new task list and the number of new links.
 */
export async function linkBranches(ctx: Ctx, c: string, keys: ReadonlySet<string>): Promise<{ tasks: Task[]; links: number }> {
  const numbers = await draftNumbers(ctx, c);
  let links = 0;
  const file = await updateTasks(ctx, c, (old) => {
    if (old === null) return null;
    const tasks = linkByPr(old.tasks.map((t) => (t.branch === null && keys.has(t.attr) ? { ...t, branch: t.attr } : t)), numbers);
    links = newLinks(old.tasks, tasks);
    return { ...old, tasks };
  });
  return { tasks: file?.tasks ?? [], links };
}

/**
 * The result of `forkBranch`. `tip` is the commit of the branch in the repository of patchix, or `null` when the sync
 * does not change the branch. Then `diverged` has the two commits.
 */
export interface ForkStep {
  fetched: boolean;
  made: boolean;
  draft: boolean;
  tip: string | null;
  diverged: Diverged | null;
}

/**
 * Step 3 of the sync for the branch `b` of the fork. The repository of patchix gets the branch with `takeBranch`. When
 * the branch has no run, the sync makes one run with the tag `imported` (see `importRun`). The `head` of the run is
 * the tip, and its `base` is the parent. Its time is the time of the commit, and it declares no attribute. When the
 * branch has no draft, the newest open or merged pull request of `listed` gives the draft: see `draftFromPr`. The
 * `headRefName` of that pull request is the name of the branch. At the end, `fork.yaml` gets the commit of the fork.
 * A branch with a different local commit does not change: see `takeBranch`. It gets only the draft and `fork.yaml`.
 */
export async function forkBranch(ctx: Ctx, campaign: Campaign, b: RemoteBranch, listed: readonly ListedPr[], warnings: string[]): Promise<ForkStep> {
  const c = campaign.name;
  const repo = repoPath(ctx);
  const taken = await takeBranch(ctx, campaign, "fork", b);
  const local = taken === null ? await revParse(repo, `refs/heads/${b.branch}`) : null;
  let made = false;
  // A run gives the base of the branch. `fork.yaml` can make the directory of a branch without a run: thus the condition is the run, not the directory.
  if (taken !== null && (await listRuns(ctx, c, b.key)).length === 0) {
    const parent = await revParse(repo, `${taken.tip}^`);
    if (parent === null) {
      warnings.push(`the repository of patchix has no parent of the tip of ${b.branch}: no run`);
    } else {
      const url = forkUrl(ctx, campaign, await forkOf(ctx));
      await importRun(ctx, campaign, { branch: b.branch, key: b.key, tip: taken.tip, base: parent, attrs: [] }, url, null, await commitTime(repo, taken.tip));
      made = true;
    }
  }
  const pr = listed.find((p) => p.headRefName === b.branch && p.state !== "CLOSED");
  const draft = pr !== undefined && (await draftFromPr(ctx, c, b.key, pr, b.sha));
  await writeFork(ctx, c, b.key, b.sha);
  return { fetched: taken?.fetched ?? false, made, draft, tip: taken?.tip ?? null, diverged: local === null ? null : { key: b.key, local, fork: b.sha } };
}

/** The text of a branch of `SyncResult.diverged`, for the CLI and the log of the server. */
export function divergedText(campaign: Campaign, d: Diverged): string {
  const branch = branchName(campaign, d.key);
  return `the repository of patchix has the branch ${branch} at ${d.local.slice(0, 12)}, and the fork at ${d.fork.slice(0, 12)}: the sync does not change it (adopt ${campaign.name} ${d.key}: replace the local branch with the commit of the fork)`;
}

/**
 * Step 4 of the sync. A branch of `branches` can get a check-only run in the queue. The conditions are: no pull
 * request in `listed`, no draft with a number, no job and no entry in the queue. Also, the branch has attributes (see
 * `checkAttrs`), and none of them has checks of the tip (see `tipChecks`). Gives the number of new entries of the
 * queue.
 */
async function queueChecks(ctx: Ctx, campaign: Campaign, branches: readonly { key: string; tip: string }[], listed: readonly ListedPr[], tasks: readonly Task[]): Promise<number> {
  const c = campaign.name;
  const busy = new Set([...(await jobs(ctx, c)).map((j) => j.key), ...(await listQueue(ctx, c))]);
  const start = Date.now();
  let queued = 0;
  for (const { key, tip } of branches) {
    if (busy.has(key) || listed.some((p) => p.headRefName === branchName(campaign, key)) || ((await readPr(ctx, c, key))?.number ?? null) !== null) continue;
    const attrs = checkAttrs(tasks, key);
    if (attrs.length === 0 || tipChecks(await listRuns(ctx, c, key), tip, attrs).some((t) => t.checks.length > 0)) continue;
    // The times of the entries are in the sequence of the branches: thus the queue keeps that sequence.
    if (await enqueue(ctx, c, key, new Date(start + queued).toISOString(), "check")) queued++;
  }
  return queued;
}

/**
 * The four steps of the sync: see the top of this file. The repository of patchix or `git ls-remote` of the fork can
 * give an error. Then the sync does not do steps 3 and 4, and the error is a warning.
 */
export async function sync(ctx: Ctx, c: string): Promise<SyncResult> {
  const campaign = await readCampaign(ctx, c);
  const issue = new Map<string, Task>();
  const warnings: string[] = [];
  const body = await issueBody(campaign.issue.repo, campaign.issue.number);
  for (const task of await extractTasks(ctx, c, body, warnings)) {
    if (issue.has(task.attr)) warnings.push(`the issue has ${task.attr} two times; the first entry is used`);
    else issue.set(task.attr, task);
  }
  const source = await runSource(ctx, campaign, warnings);
  const numbers = await draftNumbers(ctx, c);
  let links = 0;
  const file = await updateTasks(ctx, c, (old) => {
    const tasks = linkByPr(mergeTasks([...issue.values()], source, old?.tasks ?? []), numbers);
    links = newLinks(old?.tasks ?? [], tasks);
    return { synced: now(), tasks };
  });

  const listed = await prList(campaign.issue.repo, await forkOf(ctx));
  const prs = await refreshPrs(ctx, campaign, listed);

  const result: SyncResult = { tasks: file?.tasks.length ?? 0, prs, listed: 0, fetched: 0, made: 0, drafts: 0, links, queued: 0, diverged: [], warnings };
  let remote: RemoteBranch[] | null = null;
  try {
    await cloneBase(ctx, campaign);
    remote = await remoteBranches(ctx, campaign, "fork");
  } catch (e) {
    warnings.push(`the branches of the fork: ${message(e)}`);
  }
  const taken: { key: string; tip: string }[] = [];
  for (const b of remote ?? []) {
    result.listed++;
    if (!KEY.test(b.key)) {
      warnings.push(`the branch ${b.branch} of the fork: the name after the prefix is not a key`);
      continue;
    }
    const step = await forkBranch(ctx, campaign, b, listed, warnings);
    result.fetched += Number(step.fetched);
    result.made += Number(step.made);
    result.drafts += Number(step.draft);
    if (step.tip !== null) taken.push({ key: b.key, tip: step.tip });
    if (step.diverged !== null) result.diverged.push(step.diverged);
  }
  const keys = new Set((remote ?? []).filter((b) => KEY.test(b.key)).map((b) => b.key));
  // These branches are not on the fork: their `fork.yaml` has a commit that the fork does not have.
  if (remote !== null) for (const key of await branchKeys(ctx, c)) if (!keys.has(key)) await removeFork(ctx, c, key);
  // `refreshPrs` and the new drafts can give a branch the number of a pull request: see `linkBranches`.
  const linked = await linkBranches(ctx, c, keys);
  result.links += linked.links;
  result.queued = await queueChecks(ctx, campaign, taken, listed, linked.tasks);
  return result;
}

/**
 * `adopt <campaign> <key>` and `POST .../adopt`: step 3 of the sync for one branch. The fetch replaces the branch of
 * the repository of patchix, also when it has a different commit: the person asks for it. A branch with a job or with
 * an entry in the queue gives an error with status 409: the job uses the branch. A worktree with changes without a
 * commit also gives 409. A clean worktree is removed before the fetch, because `git` does not change a branch of a
 * worktree (see `adopt`). Then it is made again from the new commit. When `gh pr list` gives an error, the branch
 * gets no draft, and the error is a warning.
 */
export async function adoptBranch(ctx: Ctx, c: string, key: string): Promise<ForkStep & { links: number; warnings: string[] }> {
  if (!KEY.test(key)) fail(400, `not a branch key: ${key}`);
  const campaign = await readCampaign(ctx, c);
  if ((await branchJob(ctx, c, key)) !== null) fail(409, `the branch ${key} has a job`);
  if ((await listQueue(ctx, c)).includes(key)) fail(409, `the branch ${key} is in the queue`);
  const worktree = worktreePath(ctx, campaign, key);
  const remake = await exists(worktree);
  if (remake) {
    if (!(await isClean(worktree))) fail(409, `the worktree of ${key} has changes without a commit: commit or remove them first`);
    await removeWorktree(ctx, worktree);
  }
  let tip: string;
  try {
    tip = await adopt(ctx, campaign, key);
  } finally {
    // After an error of the fetch, the worktree comes back with the commit that the branch had before.
    if (remake) await addWorktree(ctx, campaign, key);
  }
  const warnings: string[] = [];
  const listed = await prList(campaign.issue.repo, await forkOf(ctx)).catch((e: unknown) => {
    warnings.push(`gh pr list: ${message(e)}; no draft from the pull request`);
    return [];
  });
  const step = await forkBranch(ctx, campaign, { branch: branchName(campaign, key), key, sha: tip }, listed, warnings);
  const { links } = await linkBranches(ctx, c, new Set([key]));
  return { ...step, fetched: true, links, warnings };
}
