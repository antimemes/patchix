/**
 * The git repository of patchix: `<data>/.cache/nixpkgs.git`. It is a bare clone with depth 1 of the issue repository
 * on the `base_branch`. The remote `origin` is the issue repository, the remote `fork` is the fork of the settings
 * (see `forkUrl` and `forkOf`).
 * The worktrees of the tasks come from it. Each argument goes to `git` as it is: no shell.
 *
 * Only two functions get commits through the network: `cloneBase` and `fetchRef`. Each adds `--depth=1`, or
 * `--depth=2` for a branch of a fork. The other operations go through `git()`, which lets only the commands of
 * `ALLOWED` operate, and no `--depth`, `--deepen` or `--unshallow`. `ls-remote` reads the refs of a remote and
 * gets no commits.
 * The repository has only a part of the commits: thus patchix does not use a merge-base, and it compares trees.
 */
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tipRun, type Campaign, type Commit, type CommitProblems, type Run, type Task } from "@patchix/common";
import { forkOf } from "./github.ts";
import { capture, type CaptureOptions, type Log } from "./proc.ts";
import { exists, fail, listRuns, readTasks, type Ctx } from "./store.ts";

const ALLOWED = new Set(["rev-parse", "rev-list", "log", "diff", "status", "branch", "worktree", "push", "show", "cat-file", "ls-files", "remote", "ls-remote", "config"]);
const REFUSED = /^--(depth|deepen|unshallow)/;
const NETWORK_MS = 60 * 60_000;

/** `codes`: the exit codes that are not an error. `log`: the log for a person, see `CaptureOptions`. */
export type GitOptions = Pick<CaptureOptions, "codes" | "log">;

export async function git(cwd: string, args: readonly string[], opts: GitOptions = {}): Promise<string> {
  const [command = "", sub] = args;
  if (!ALLOWED.has(command) || (command === "worktree" && sub === "prune") || args.some((a) => REFUSED.test(a))) {
    throw new Error(`patchix does not start git ${args.slice(0, 2).join(" ")}: only cloneBase and fetchRef use the network`);
  }
  return capture("git", [...args], { ...opts, cwd });
}

export const repoPath = (ctx: Ctx) => join(ctx.data, ".cache", "nixpkgs.git");
export const branchName = (campaign: Campaign, attr: string) => `${campaign.branch_prefix}${attr}`;
/** The branch of the task: `Task.branch`, or `<branch_prefix><attr>`. */
export const branchOf = (campaign: Campaign, task: Pick<Task, "attr" | "branch">) => task.branch ?? branchName(campaign, task.attr);

/** The branch of the task with this attribute. An attribute that is not in the task list gets `<branch_prefix><attr>`. */
export async function taskBranch(ctx: Ctx, campaign: Campaign, attr: string): Promise<string> {
  const task = (await readTasks(ctx, campaign.name))?.tasks.find((t) => t.attr === attr);
  return branchOf(campaign, task ?? { attr, branch: null });
}
export const worktreePath = (ctx: Ctx, campaign: Campaign, attr: string) => join(ctx.data, ".cache", "worktrees", campaign.name, attr);

/**
 * The URL of the fork of the GitHub user `fork`. On GitHub it is an SSH URL. GitHub does not accept an HTTPS push with
 * a token without the `workflow` scope when the commits change `.github/workflows`. The base commit can change them. A
 * test gives a `file://` URL in `ctx.github`.
 */
export function forkUrl(ctx: Ctx, campaign: Campaign, fork: string): string {
  const path = `${fork}/${campaign.issue.repo.split("/")[1] ?? ""}`;
  return ctx.github.startsWith("https://github.com") ? `ssh://git@github.com/${path}` : `${ctx.github}/${path}`;
}

/**
 * Sets the URL of `forkUrl` for the remote `fork` of the bare repository, when the remote has a different URL. Thus a
 * change of the fork in the settings changes the remote. Gives `false` when the repository is not there.
 */
export async function setForkRemote(ctx: Ctx, campaign: Campaign): Promise<boolean> {
  const path = repoPath(ctx);
  if (!(await exists(join(path, "HEAD")))) return false;
  const fork = forkUrl(ctx, campaign, await forkOf(ctx));
  // Many runs start at the same time, and a write locks the config file: thus only a different URL is written.
  if ((await git(path, ["remote", "get-url", "fork"])).trim() !== fork) await git(path, ["remote", "set-url", "fork", fork]);
  return true;
}

/**
 * Sets `core.untrackedCache` of the bare repository to `true`, when the repository is there. The worktrees use the
 * config of the bare repository. Without it, `git status` in a worktree of nixpkgs is slow, approximately 7 seconds:
 * it reads each directory to find new files. With it, the index of the worktree keeps the directories that did not
 * change.
 */
export async function cacheUntracked(repo: string): Promise<void> {
  if (!(await exists(join(repo, "HEAD")))) return;
  // A write locks the config file (see `setForkRemote`): thus only a different value is written.
  const value = (await git(repo, ["config", "--get", "core.untrackedCache"], { codes: [0, 1] })).trim();
  if (value !== "true") await git(repo, ["config", "core.untrackedCache", "true"]);
}

/**
 * Makes the bare repository when it is not there: a clone with depth 1 of the `base_branch`, and the remote `fork`.
 * When the repository is there, it corrects the URL of the remote `fork` (see `setForkRemote`).
 */
export async function cloneBase(ctx: Ctx, campaign: Campaign): Promise<string> {
  const path = repoPath(ctx);
  if (await setForkRemote(ctx, campaign)) return path;
  const fork = forkUrl(ctx, campaign, await forkOf(ctx));
  const tmp = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    const url = `${ctx.github}/${campaign.issue.repo}`;
    await capture("git", ["clone", "--bare", "--depth=1", "--single-branch", "--branch", campaign.base_branch, url, tmp], { timeoutMs: NETWORK_MS });
    await git(tmp, ["remote", "add", "fork", fork]);
    await cacheUntracked(tmp);
    await rename(tmp, path).catch(async (e: unknown) => {
      if (!(await exists(join(path, "HEAD")))) throw e;
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return path;
}

/**
 * Gets the newest commit of the branch `ref` of a remote into `refs/heads/<ref>`. Gives its commit. `from` is the
 * name of a remote (`origin`, `fork`) or a URL. The depth is 1 for the base. The depth is 2 for the branch of a fix:
 * then the parent of the tip is the base of the branch.
 */
export async function fetchRef(ctx: Ctx, from: string, ref: string, depth: 1 | 2): Promise<string> {
  if (from.startsWith("-")) fail(400, `not a remote: ${from}`);
  const repo = repoPath(ctx);
  await capture("git", ["fetch", `--depth=${depth}`, "--no-tags", "--quiet", from, `+refs/heads/${ref}:refs/heads/${ref}`], { cwd: repo, timeoutMs: NETWORK_MS });
  return (await revParse(repo, `refs/heads/${ref}`)) ?? fail(500, `the fetch of ${from} ${ref} gave no commit`);
}

/** Gets the newest commit of the `base_branch` from `origin`. The worktrees that are there do not change. */
export async function updateBase(ctx: Ctx, campaign: Campaign): Promise<string> {
  await cloneBase(ctx, campaign);
  return fetchRef(ctx, "origin", campaign.base_branch, 1);
}

/** Gets the branch of a task from the fork, to continue the work on it. The task must have no worktree. */
export async function adopt(ctx: Ctx, campaign: Campaign, attr: string): Promise<string> {
  if (await exists(worktreePath(ctx, campaign, attr))) fail(409, `the task ${attr} has a worktree; remove it first`);
  await cloneBase(ctx, campaign);
  return fetchRef(ctx, "fork", await taskBranch(ctx, campaign, attr), 2);
}

/** The commit of the ref, or `null` when the ref is not there. */
export async function revParse(cwd: string, ref: string): Promise<string | null> {
  return (await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { codes: [0, 1] })).trim() || null;
}

/** The commit of the `base_branch` in the bare repository. */
export async function baseTip(ctx: Ctx, campaign: Campaign): Promise<string> {
  const tip = await revParse(repoPath(ctx), `refs/heads/${campaign.base_branch}`);
  return tip ?? fail(500, `${repoPath(ctx)} has no branch ${campaign.base_branch}`);
}

/** The commit of each branch `<prefix>*` of the bare repository, by branch name. Without the repository, the map is empty. */
export async function branches(ctx: Ctx, prefix: string): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  if (!(await exists(join(repoPath(ctx), "HEAD")))) return refs;
  const out = await git(repoPath(ctx), ["branch", "--list", "--format=%(refname:short) %(objectname)", `${prefix}*`]);
  for (const line of out.split("\n")) {
    const [name = "", sha = ""] = line.split(" ");
    if (name.startsWith(prefix) && sha !== "") refs.set(name, sha);
  }
  return refs;
}

export interface Worktree {
  path: string;
  branch: string;
  /** The commit of the `base_branch` when this function made the branch. `null` when the branch was there. */
  base: string | null;
}

/**
 * Makes the worktree of a task on the branch of the task (see `taskBranch`), or gives the worktree that is there.
 * When the repository has the branch, the worktree uses it. If not, a new branch starts at the commit of the `base_branch`.
 */
export async function addWorktree(ctx: Ctx, campaign: Campaign, attr: string): Promise<Worktree> {
  const repo = await cloneBase(ctx, campaign);
  const path = worktreePath(ctx, campaign, attr);
  const branch = await taskBranch(ctx, campaign, attr);
  if (await exists(join(path, ".git"))) return { path, branch, base: null };
  await mkdir(dirname(path), { recursive: true });
  if ((await revParse(repo, `refs/heads/${branch}`)) !== null) {
    await git(repo, ["worktree", "add", "--quiet", path, branch]);
    return { path, branch, base: null };
  }
  const base = await baseTip(ctx, campaign);
  await git(repo, ["worktree", "add", "--quiet", "-b", branch, path, base]);
  return { path, branch, base };
}

/** The worktree `_base` of the campaign, at the commit of the `base_branch`. The `source` command operates in it. */
export async function baseWorktree(ctx: Ctx, campaign: Campaign): Promise<string> {
  const repo = await cloneBase(ctx, campaign);
  const path = join(ctx.data, ".cache", "worktrees", campaign.name, "_base");
  const tip = await baseTip(ctx, campaign);
  if (await exists(join(path, ".git"))) {
    if ((await revParse(path, "HEAD")) === tip) return path;
    await git(repo, ["worktree", "remove", "--force", path]);
  }
  await mkdir(dirname(path), { recursive: true });
  await git(repo, ["worktree", "add", "--quiet", "--detach", path, tip]);
  return path;
}

/** Removes the worktree. The branch stays. When the worktree has changes that are not committed, `git` gives an error. */
export async function removeWorktree(ctx: Ctx, path: string): Promise<void> {
  await git(repoPath(ctx), ["worktree", "remove", path]);
}

/** The diff of two trees, or of one tree and the files of the worktree. It does not use the parents of the commits. */
export function diff(cwd: string, from: string, to?: string): Promise<string> {
  return git(cwd, ["diff", "--no-color", "--no-ext-diff", from, ...(to === undefined ? [] : [to])]);
}

/** The files that are different from `ref`, and the new files that `git` does not know. */
export async function changedFiles(cwd: string, ref: string): Promise<string[]> {
  const changed = await git(cwd, ["diff", "--name-only", ref]);
  return [...new Set([...changed.split("\n"), ...(await untracked(cwd))].filter((f) => f !== ""))];
}

export async function untracked(cwd: string): Promise<string[]> {
  return (await git(cwd, ["ls-files", "--others", "--exclude-standard"])).split("\n").filter((f) => f !== "");
}

/**
 * Gives `true` when the worktree has no change that is not committed and no new file. `git status` uses the cache of
 * `cacheUntracked`, and `ls-files --others` does not. The new files are in the output also when the config of a
 * person has `status.showUntrackedFiles=no`.
 */
export async function isClean(cwd: string): Promise<boolean> {
  return (await git(cwd, ["status", "--porcelain", "--untracked-files=normal"])).trim() === "";
}

/** The first line of the commit message. */
export async function subject(cwd: string, ref: string): Promise<string> {
  return (await git(cwd, ["log", "-1", "--format=%s", ref])).trim();
}

/** A commit of `messages`: a `Commit` without its patch. */
export type Message = Omit<Commit, "patch">;

/** The commits of `to` that `from` does not have, the newest first, with the full message. It uses one `git log`. */
export async function messages(cwd: string, from: string, to: string): Promise<Message[]> {
  // With `-z`, a NUL byte also follows each commit: thus the output is a list of fields, three for each commit.
  const fields = (await git(cwd, ["log", "-z", "--format=%H%x00%s%x00%B", "--end-of-options", `${from}..${to}`])).split("\0");
  const out: Message[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [sha = "", subject = "", message = ""] = fields.slice(i, i + 3);
    out.push({ sha, subject, message: message.trimEnd() });
  }
  return out;
}

/** The commit of the branch of the task, or `null` when the repository or the branch is not there. */
export async function branchTip(ctx: Ctx, campaign: Campaign, attr: string): Promise<string | null> {
  const repo = repoPath(ctx);
  return (await exists(join(repo, "HEAD"))) ? revParse(repo, `refs/heads/${await taskBranch(ctx, campaign, attr)}`) : null;
}

/** The branch of a task: see `branchState`. */
export interface BranchState {
  /** The commit before the fix: the `base` of the newest run with a base (see `startRun`). `null` when no run has one. */
  base: string | null;
  /** The commit of the branch: see `branchTip`. */
  tip: string | null;
  /** The commits from `base` to `tip`, the newest first. Empty without a base or a tip. */
  commits: Message[];
  /** The newest run with the checks of the tip: see `tipRun`. */
  tipRun: Run | undefined;
}

/**
 * The branch of a task in the repository of patchix, with its base, its commits and the run with the checks of its
 * tip. The pull request reads the branch, not a run: a person can change the branch after a run.
 */
export async function branchState(ctx: Ctx, campaign: Campaign, attr: string): Promise<BranchState> {
  const runs = await listRuns(ctx, campaign.name, attr);
  const base = runs.find((r) => r.base !== "")?.base ?? null;
  const tip = await branchTip(ctx, campaign, attr);
  // A repository that a person made again does not have the base of a previous branch.
  const commits = base === null || tip === null || (await revParse(repoPath(ctx), base)) === null ? [] : await messages(repoPath(ctx), base, tip);
  return { base, tip, commits, tipRun: tipRun(runs, tip) };
}

/** The commits of the branch of a task, each with its patch as `git show` gives it. See `branchState`. */
export async function branchCommits(ctx: Ctx, campaign: Campaign, attr: string): Promise<Commit[]> {
  const { commits } = await branchState(ctx, campaign, attr);
  return Promise.all(commits.map(async (c) => ({ ...c, patch: await git(repoPath(ctx), ["show", "--format=", "--no-color", "--no-ext-diff", c.sha]) })));
}

/** `git diff <base> <tip>` of the branch of a task: the change of its pull request. Empty without commits. */
export async function branchDiff(ctx: Ctx, campaign: Campaign, attr: string): Promise<string> {
  const { base, tip, commits } = await branchState(ctx, campaign, attr);
  return base === null || tip === null || commits.length === 0 ? "" : diff(repoPath(ctx), base, tip);
}

/** The line of the `automation/AI policy` of nixpkgs: `Assisted-by: <tool> (<model>) with patchix`. */
const ASSISTED = /^Assisted-by: .+ \((.+)\) with patchix$/gm;
const COAUTHORED = /^Co-authored-by:/i;
/** The names of an AI in the value of a `Co-authored-by` line. A line that names a person has no problem. */
const AI = /claude|anthropic|copilot|gpt|openai|gemini|noreply@anthropic\.com/i;
export const NO_ASSISTED = "no `Assisted-by: <tool> (<model>) with patchix` line";
export const aiCoauthor = (line: string) => `a \`Co-authored-by\` line names an AI: ${line}`;

/**
 * The commits with a problem. Each commit must have an `Assisted-by: <tool> (<model>) with patchix` line. A line that
 * agrees with `/^Co-authored-by:/i` must not name an AI (see `AI`).
 */
export function commitProblems(commits: readonly Message[]): CommitProblems[] {
  return commits.flatMap(({ sha, subject, message }) => {
    const ai = message.split("\n").filter((line) => COAUTHORED.test(line) && AI.test(line.slice("Co-authored-by:".length)));
    const problems = [...(message.match(ASSISTED) === null ? [NO_ASSISTED] : []), ...ai.map((line) => aiCoauthor(line.trimEnd()))];
    return problems.length > 0 ? [{ sha, subject, problems }] : [];
  });
}

/** The models of the `Assisted-by` lines of the commits, for the AI disclosure. */
export function assistedModels(commits: readonly Message[]): string[] {
  return [...new Set(commits.flatMap((c) => [...c.message.matchAll(ASSISTED)].map((m) => m[1] ?? "")))];
}

/** The text of one commit of `commitProblems`: `commit <short sha>: <problems>`. */
export const problemText = (p: CommitProblems) => `commit ${p.sha.slice(0, 12)}: ${p.problems.join(", ")}`;

/**
 * Pushes the branch to the fork with SSH. `expected` is the commit of the last push of patchix. When it is set, the
 * push can replace the branch of the fork, but only when the fork has that commit. When it is `null`, the push must
 * add commits to the branch of the fork. With `force`, `git push --force` replaces the branch
 * of the fork: the person agreed to it, also when `expected` is set. The output of `git` goes
 * into `log`.
 */
export async function push(ctx: Ctx, branch: string, expected: string | null = null, log?: Log, force = false): Promise<void> {
  const replace = force ? ["--force"] : expected !== null ? [`--force-with-lease=${branch}:${expected}`] : [];
  await git(repoPath(ctx), ["push", ...replace, "fork", branch], { log });
}
