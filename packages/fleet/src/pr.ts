/**
 * The draft of the pull request of a task (`pr.yaml` and `pr.md`) and the pull request on GitHub. The operations
 * on the draft of one task occur one after the other.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIRM_ERROR, tipProblem, type Campaign, type DraftInput, type LintResult, type Pr, type PublishInput } from "@patchix/common";
import { render, type Rendered } from "./render.ts";
import { addLabels, forkOf, prCreate, prEdit, prList, type ListedPr } from "./github.ts";
import { assistedModels, branchOf, branchState, branchTip, commitProblems, isClean, problemText, push, repoPath, revParse, setForkRemote, subject, taskBranch, worktreePath, type BranchState } from "./git.ts";
import { lintText } from "./lint.ts";
import { CaptureError, type Log } from "./proc.ts";
import { parseWords } from "./run.ts";
import {
  appendPublishLog,
  checkFile,
  exists,
  fail,
  listRuns,
  message,
  now,
  readCampaign,
  readDraft,
  readPr,
  readTasks,
  readText,
  runDir,
  serial,
  taskDirs,
  taskJob,
  writeDraft,
  writePr,
  writePublishLog,
  type Ctx,
} from "./store.ts";

const key = (c: string, attr: string) => `${c}/${attr}`;

/**
 * Makes the draft. `pr.md` is `description.md` of the newest run with a description that is not `wontfix` and not
 * `running`, and `words` is the `words.txt` of that run. The title is the first line of the commit message of the tip
 * of the branch. When the task has a pull request, the draft keeps its number and its labels. A new draft gets the
 * labels of the campaign.
 */
export function makeDraft(ctx: Ctx, c: string, attr: string): Promise<Pr> {
  return serial(key(c, attr), async () => {
    const campaign = await readCampaign(ctx, c);
    let dir = "";
    let description: string | null = null;
    for (const run of await listRuns(ctx, c, attr)) {
      if (run.status === "wontfix" || run.status === "running") continue;
      dir = runDir(ctx, c, attr, run.id);
      description = await readText(join(dir, "description.md"));
      if (description !== null) break;
    }
    if (description === null) fail(409, "no run of the task has a description.md");
    const tip = (await branchTip(ctx, campaign, attr)) ?? fail(409, `the repository of patchix has no branch of ${attr}`);
    const pr: Pr = {
      labels: campaign.labels, number: null, url: null, created: null, pushed: null, updated: null, state: "open", merged: null, confirmed: null,
      ...(await readPr(ctx, c, attr)),
      title: await subject(repoPath(ctx), tip),
      words: parseWords(await readText(join(dir, "words.txt"))),
    };
    await writeDraft(ctx, c, attr, description);
    await writePr(ctx, c, attr, pr);
    return pr;
  });
}

/**
 * Removes the local directories from the output of a check for the description. The worktree of the task becomes
 * `<worktree>`. Then `ctx.data` and `ctx.root` become `<patchix>`. The file of the check does not change.
 */
export function hidePaths(ctx: Ctx, worktree: string, output: string): string {
  return output.replaceAll(worktree, "<worktree>").replaceAll(ctx.data, "<patchix>").replaceAll(ctx.root, "<patchix>");
}

/** The description of the branch: the check output of the run with the checks of the tip, and the models of the commits. */
async function renderPr(ctx: Ctx, campaign: Campaign, attr: string, branch: BranchState, body: string, number: number | null): Promise<Rendered> {
  const worktree = worktreePath(ctx, campaign, attr);
  const checks = new Map<string, string>();
  const dir = branch.tipRun && runDir(ctx, campaign.name, attr, branch.tipRun.id);
  for (const check of campaign.checks) {
    const output = dir === undefined ? null : await readText(checkFile(dir, check.name));
    if (output !== null) checks.set(check.name, hidePaths(ctx, worktree, output));
  }
  return render({ body, campaign, attr, pr: number, checks, models: assistedModels(branch.commits) });
}

/**
 * The description as it goes to GitHub and the problems of its marks, or `null` when the task has no draft. `branch`
 * is the `branchState` of the task, when the caller has it.
 */
export async function renderDraft(ctx: Ctx, c: string, attr: string, branch?: BranchState): Promise<Rendered | null> {
  const pr = await readPr(ctx, c, attr);
  const body = await readDraft(ctx, c, attr);
  if (pr === null || body === null) return null;
  const campaign = await readCampaign(ctx, c);
  return renderPr(ctx, campaign, attr, branch ?? (await branchState(ctx, campaign, attr)), body, pr.number);
}

/** memelint on `pr.md`, or `null` when the task has no draft. */
export async function lintDraft(ctx: Ctx, c: string, attr: string): Promise<LintResult | null> {
  const pr = await readPr(ctx, c, attr);
  const body = await readDraft(ctx, c, attr);
  if (pr === null || body === null) return null;
  return { findings: await lintText(ctx, c, body, "pr.md", pr.words) };
}

async function needPr(ctx: Ctx, c: string, attr: string): Promise<Pr> {
  return (await readPr(ctx, c, attr)) ?? fail(404, `the task ${attr} has no draft; make one first`);
}

export function putDraft(ctx: Ctx, c: string, attr: string, input: DraftInput): Promise<Pr> {
  return serial(key(c, attr), async () => {
    const pr: Pr = { ...(await needPr(ctx, c, attr)), title: input.title, labels: input.labels, words: [...new Set(input.words)] };
    await writeDraft(ctx, c, attr, input.description);
    await writePr(ctx, c, attr, pr);
    return pr;
  });
}

/**
 * Pushes the branch to the fork and makes the pull request, or writes its title and description again. Then it
 * adds the labels. A new pull request gets its description two times: the second time has its number. The worktree
 * stays: only `DELETE …/worktree` removes it. These conditions give an error: no draft, and a mark of the draft with
 * a problem (see `Rendered.problems`). A job of the task and a pull request that is `merged` or `closed` also give an
 * error. The branch gives more conditions: no commits after the base, or a tip without checks or with a check that is
 * `error` (see `branchState` and `tipProblem`). Also changes without a commit in the worktree, and a commit with a
 * problem (see `commitProblems`). memelint findings of the draft do not stop the pull request. The page shows them.
 *
 * After the conditions, each command and its output go into `publish.log` of the task, also after an error. The file
 * has only the commands of the newest request. It gets each line at the time of the line: thus the page can show the
 * file while the request operates (see `publishLog`). An error after the conditions has the text of the log: see
 * `publishLogOf`.
 *
 * `input` shows that the person set the tick box of the page: see `PublishInput`. When the request has no error, the
 * draft gets the time of the request in `confirmed`. With `input.force`, the push can replace the branch on the fork:
 * see `push`.
 */
export function createOrUpdatePr(ctx: Ctx, c: string, attr: string, input: PublishInput): Promise<Pr> {
  const confirmed = now();
  return serial(key(c, attr), async () => {
    if (input.confirmed !== true) fail(409, CONFIRM_ERROR);
    const campaign = await readCampaign(ctx, c);
    const pr = await needPr(ctx, c, attr);
    if (pr.number !== null && pr.state !== "open") fail(409, `the pull request #${pr.number} is ${pr.state}`);
    const body = (await readDraft(ctx, c, attr)) ?? fail(404, `the task ${attr} has no pr.md`);
    const branch = await branchState(ctx, campaign, attr);
    // The problems do not change with the number: the two descriptions of `publish` have the same marks.
    const marks = (await renderPr(ctx, campaign, attr, branch, body, pr.number)).problems;
    if (marks.length > 0) fail(409, `the marks of the draft have problems: ${marks.join("; ")}`);
    const job = await taskJob(ctx, c, attr);
    if (job !== null) fail(409, `the task ${attr} has a job that operates: the run ${job.id}`);
    if (branch.commits.length === 0) fail(409, `the branch of ${attr} has no commits after its base`);
    // A check that is `fail` is not a problem: the person examined its output, and the tick box of `input` shows it.
    const tip = tipProblem(branch.tipRun);
    if (tip !== null) fail(409, tip);
    const worktree = worktreePath(ctx, campaign, attr);
    if ((await exists(worktree)) && !(await isClean(worktree))) fail(409, `the worktree of ${attr} has changes without a commit: the branch does not have them`);
    const problems = commitProblems(branch.commits);
    if (problems.length > 0) fail(409, `the branch does not agree with the automation/AI policy of nixpkgs: ${problems.map(problemText).join("; ")}`);

    const log = await publishLog(ctx, c, attr, `# publish of ${c}/${attr}, ${now()}`);
    try {
      const done = await publish(ctx, campaign, attr, branch, pr, body, log, confirmed, input.force === true);
      log.push(`# the pull request is #${done.number}${done.url === null ? "" : `: ${done.url}`}`);
      return done;
    } catch (e) {
      // The log has the output of a command with an error. A different error goes into the log as one line.
      if (!(e instanceof CaptureError)) log.push(`error: ${message(e)}`);
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { publish_log: log.text() });
    } finally {
      await log.close();
    }
  });
}

/**
 * The log of `createOrUpdatePr` in `publish.log`. The first line replaces the file. Each `push` adds its lines to the
 * end of the file: thus the page can read the file while the request operates. `close` waits for these writes. Then
 * it writes all the lines again, also when a write gave an error.
 */
async function publishLog(ctx: Ctx, c: string, attr: string, first: string) {
  const lines = [first];
  const text = () => `${lines.join("\n")}\n`;
  await writePublishLog(ctx, c, attr, text());
  let writes = Promise.resolve();
  return {
    push(...more: string[]) {
      lines.push(...more);
      const added = more.map((line) => `${line}\n`).join("");
      writes = writes.then(() => appendPublishLog(ctx, c, attr, added)).catch((e: unknown) => console.warn(`publish.log of ${c}/${attr}: ${message(e)}`));
    },
    text,
    async close() {
      await writes;
      await writePublishLog(ctx, c, attr, text());
    },
  };
}

/** The text of `publish.log` in an error of `createOrUpdatePr`, or `null` when no command started. */
export function publishLogOf(e: unknown): string | null {
  const log = (e as { publish_log?: unknown } | null)?.publish_log;
  return typeof log === "string" ? log : null;
}

/**
 * The commands of `createOrUpdatePr`, after its conditions. Each command and its output go into `log`. The draft gets
 * `confirmed` only at the end, when no command gave an error. `force`: see `push`.
 */
async function publish(ctx: Ctx, campaign: Campaign, attr: string, state: BranchState, draft: Pr, body: string, log: Log, confirmed: string, force: boolean): Promise<Pr & { number: number }> {
  const c = campaign.name;
  const branch = await taskBranch(ctx, campaign, attr);
  // The remote `fork` can have the URL of a previous fork of the settings.
  const fork = await forkOf(ctx);
  await setForkRemote(ctx, campaign);
  await push(ctx, branch, draft.pushed, log, force);
  let pr: Pr = { ...draft, pushed: await revParse(repoPath(ctx), `refs/heads/${branch}`) };
  await writePr(ctx, c, attr, pr);

  const repo = campaign.issue.repo;
  const dir = await mkdtemp(join(tmpdir(), "patchix-pr-"));
  try {
    const file = join(dir, "body.md");
    let number = pr.number;
    if (number === null) {
      await writeFile(file, (await renderPr(ctx, campaign, attr, state, body, null)).text);
      const made = await prCreate(repo, campaign.base_branch, `${fork}:${branch}`, pr.title, file, log);
      number = made.number;
      pr = { ...pr, number, url: made.url, created: now() };
      await writePr(ctx, c, attr, pr);
    }
    // Only a person with the `triage` permission on the repository can set labels. Without it, the pull request is made and has no labels.
    try {
      await addLabels(repo, number, pr.labels, log);
    } catch (e) {
      log.push(`the labels were not set: ${message(e)}`);
    }
    await writeFile(file, (await renderPr(ctx, campaign, attr, state, body, number)).text);
    await prEdit(repo, number, pr.title, file, log);
    const done = { ...pr, number, updated: now(), confirmed };
    await writePr(ctx, c, attr, done);
    return done;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const STATES = { OPEN: "open", MERGED: "merged", CLOSED: "closed" } as const satisfies Record<ListedPr["state"], Pr["state"]>;

/**
 * Reads the pull requests of the fork (see `forkOf`) with one `gh pr list`, or uses `listed`. Each draft of the
 * campaign with the number of a pull request of the list gets its `state`, `merged` and `url`. A draft without a
 * number gets the newest pull request of the branch of its task. A task without a draft does not get a draft. Gives
 * the attributes of the drafts that changed.
 */
export async function refreshPrs(ctx: Ctx, campaign: Campaign, listed?: readonly ListedPr[]): Promise<string[]> {
  const prs = listed ?? (await prList(campaign.issue.repo, await forkOf(ctx)));
  const byNumber = new Map(prs.map((p) => [p.number, p]));
  const byBranch = new Map<string, ListedPr>();
  for (const p of prs) if (!byBranch.has(p.headRefName)) byBranch.set(p.headRefName, p);
  const tasks = new Map(((await readTasks(ctx, campaign.name))?.tasks ?? []).map((t) => [t.attr, t]));
  const changed: string[] = [];
  for (const attr of await taskDirs(ctx, campaign.name)) {
    const write = await serial(key(campaign.name, attr), async () => {
      const pr = await readPr(ctx, campaign.name, attr);
      if (pr === null) return false;
      const found = pr.number === null ? byBranch.get(branchOf(campaign, tasks.get(attr) ?? { attr, branch: null })) : byNumber.get(pr.number);
      if (found === undefined) return false;
      const state = STATES[found.state];
      if (pr.number === found.number && pr.url === found.url && pr.state === state && pr.merged === found.mergedAt) return false;
      await writePr(ctx, campaign.name, attr, { ...pr, number: found.number, url: found.url, state, merged: found.mergedAt });
      return true;
    });
    if (write) changed.push(attr);
  }
  return changed;
}
