/**
 * Reads the task list into `state/<campaign>/tasks.yaml`: the entries of the tracking issue and, when the campaign
 * has a `source` command, its output. Then it reads the state of the pull requests with `refreshPrs`. The sync does
 * not start `git fetch`. An entry without a branch can have the pull request number of a draft in its issue line.
 * Then it links to the branch of that draft: see `linkByPr`.
 */
import { ATTR, type Campaign, type Task } from "@patchix/common";
import { parseIssueTasks } from "./issue.ts";
import { issueBody } from "./github.ts";
import { baseWorktree } from "./git.ts";
import { refreshPrs } from "./pr.ts";
import { capture } from "./proc.ts";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { branchKeys, campaignDir, exists, now, readCampaign, readPr, updateTasks, type Ctx } from "./store.ts";

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

export interface SyncResult {
  tasks: number;
  /** The keys of the drafts that `refreshPrs` changed. */
  prs: string[];
  warnings: string[];
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
  const file = await updateTasks(ctx, c, (old) => ({ synced: now(), tasks: linkByPr(mergeTasks([...issue.values()], source, old?.tasks ?? []), numbers) }));
  const prs = await refreshPrs(ctx, campaign);
  // `refreshPrs` can give a draft the number of its pull request: then an entry with that number gets the link.
  if (prs.length > 0) {
    const after = await draftNumbers(ctx, c);
    await updateTasks(ctx, c, (old) => (old === null ? null : { ...old, tasks: linkByPr(old.tasks, after) }));
  }
  return { tasks: file?.tasks.length ?? 0, prs, warnings };
}
