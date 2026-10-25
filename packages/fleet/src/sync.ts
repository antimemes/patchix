/**
 * The sync makes the state of a campaign agree with GitHub, in four steps:
 * 1. The task list in `state/<campaign>/tasks.yaml`: the entries of the tracking issue and, when the campaign has a
 *    `source` command, its output.
 * 2. The state of the pull requests of the fork: see `refreshPrs`.
 * 3. The branches `<branch_prefix>*` of the fork: see `forkBranch`. Each branch gets its commits, a branch directory
 *    and a draft from its pull request, when the state does not have them. Then the entries without a branch get
 *    their links: see `linkBranches`.
 * 4. A check-only run in the queue for each branch of the fork without a pull request and without checks of the tip:
 *    see `queueChecks`.
 *
 * Only `fetchRef` gets commits, with a depth of 2 commits. A branch of the repository of patchix that the fork does not
 * have does not change. It can be work that a person did not push. The sync does not start the fleet: the server
 * starts it.
 */
import { ATTR, KEY, tipChecks, type Campaign, type SyncResult, type Task } from "@patchix/common";
import { parseIssueTasks } from "./issue.ts";
import { forkOf, issueBody, prList, type ListedPr } from "./github.ts";
import { adopt, baseWorktree, branchName, cloneBase, commitTime, forkUrl, remoteBranches, repoPath, revParse, takeBranch, type RemoteBranch } from "./git.ts";
import { importRun } from "./import.ts";
import { draftFromPr, refreshPrs } from "./pr.ts";
import { capture } from "./proc.ts";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { branchDir, branchKeys, campaignDir, checkAttrs, enqueue, exists, fail, jobs, listQueue, listRuns, message, now, readCampaign, readPr, updateTasks, type Ctx } from "./store.ts";

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

/** The result of `forkBranch`. `tip` is the commit of the branch in the repository of patchix, or `null` when the sync does not change the branch. */
export interface ForkStep {
  fetched: boolean;
  made: boolean;
  draft: boolean;
  tip: string | null;
}

/**
 * Step 3 of the sync for the branch `b` of the fork. The repository of patchix gets the branch with `takeBranch`. When
 * the branch has no directory, the sync makes the directory with one run with the tag `imported` (see `importRun`).
 * The `head` of the run is the tip, and its `base` is the parent. Its time is the time of the commit, and it declares
 * no attribute. When the branch has no draft, the newest open or merged pull request of `listed` gives the draft:
 * see `draftFromPr`. The `headRefName` of that pull request is the name of the branch.
 */
export async function forkBranch(ctx: Ctx, campaign: Campaign, b: RemoteBranch, listed: readonly ListedPr[], warnings: string[]): Promise<ForkStep> {
  const c = campaign.name;
  const taken = await takeBranch(ctx, campaign, "fork", b);
  if (taken === null) warnings.push(`the repository of patchix has the branch ${b.branch} with a different commit than the fork: the sync does not change it (the adopt command replaces it)`);
  let made = false;
  if (taken !== null && !(await exists(branchDir(ctx, c, b.key)))) {
    const repo = repoPath(ctx);
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
  return { fetched: taken?.fetched ?? false, made, draft, tip: taken?.tip ?? null };
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

  const result: SyncResult = { tasks: file?.tasks.length ?? 0, prs, listed: 0, fetched: 0, made: 0, drafts: 0, links, queued: 0, warnings };
  let remote: RemoteBranch[] = [];
  try {
    await cloneBase(ctx, campaign);
    remote = await remoteBranches(ctx, campaign, "fork");
  } catch (e) {
    warnings.push(`the branches of the fork: ${message(e)}`);
  }
  const taken: { key: string; tip: string }[] = [];
  for (const b of remote) {
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
  }
  // `refreshPrs` and the new drafts can give a branch the number of a pull request: see `linkBranches`.
  const linked = await linkBranches(ctx, c, new Set(remote.filter((b) => KEY.test(b.key)).map((b) => b.key)));
  result.links += linked.links;
  result.queued = await queueChecks(ctx, campaign, taken, listed, linked.tasks);
  return result;
}

/**
 * `adopt <campaign> <key>`: step 3 of the sync for one branch. The fetch replaces the branch of the repository of
 * patchix, also when it has a different commit: the person asks for it. The branch must have no worktree (see
 * `adopt`). When `gh pr list` gives an error, the branch gets no draft, and the error is a warning.
 */
export async function adoptBranch(ctx: Ctx, c: string, key: string): Promise<ForkStep & { links: number; warnings: string[] }> {
  if (!KEY.test(key)) fail(400, `not a branch key: ${key}`);
  const campaign = await readCampaign(ctx, c);
  const tip = await adopt(ctx, campaign, key);
  const warnings: string[] = [];
  const listed = await prList(campaign.issue.repo, await forkOf(ctx)).catch((e: unknown) => {
    warnings.push(`gh pr list: ${message(e)}; no draft from the pull request`);
    return [];
  });
  const step = await forkBranch(ctx, campaign, { branch: branchName(campaign, key), key, sha: tip }, listed, warnings);
  const { links } = await linkBranches(ctx, c, new Set([key]));
  return { ...step, fetched: true, links, warnings };
}
