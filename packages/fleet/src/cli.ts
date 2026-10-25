#!/usr/bin/env node
/**
 * `node packages/fleet/src/cli.ts <command>`:
 * - `sync <campaign>` reads the task list of the tracking issue and of the `source` command, and the state of the
 *   pull requests of the fork.
 * - `refresh <campaign>` reads only the state of the pull requests of the fork. See `refreshPrs`.
 * - `run <campaign> <attr>` does one run of the task and writes its status. The command line must contain
 *   `run <campaign> <attr>`: the server and the fleet look for these words. See `alive`.
 * - `ask <campaign> <attr> <id>` gives the question of the ask to the agent. The server writes `question.md` first.
 * - `fleet <campaign>` starts the runs of the queue of the campaign, and stops when the queue is empty. See `runFleet`.
 * - `worktree <campaign> <attr>` makes the worktree of the task and writes its path.
 * - `base <campaign>` gets the newest commit of the `base_branch` with depth 1.
 * - `adopt <campaign> <attr>` gets the branch of the task from the fork with depth 1.
 * - `draft <campaign> <attr> [run]` makes the draft of the pull request from a run (default: the newest `ok` run).
 * - `import <campaign> <git-url> [--descriptions <dir>]` gets the branches `<branch_prefix>*` of a different checkout
 *   with depth 2, and makes a run with the tag `imported` for each task of a branch. See `importBranches`.
 *
 * `--root <dir>` and `--data <dir>` give the root and the data directory. They come before `PATCHIX_ROOT` and
 * `PATCHIX_DATA`. See `context`. `--path <PATH>` gives the `PATH` of the process: a zellij tab gets the `PATH` of
 * the server with it. The CLI reads `<data>/.env`. The `fork`, the `model` and the `concurrency` come from
 * `<data>/settings.yaml`: see `readSettings` and `forkOf`. The CLI does not write that file.
 *
 * For `run` and `ask`, `SIGTERM` and `SIGINT` stop the agent and the checks, and the run or the ask gets the status
 * `stopped`. These signals stop the other commands without more steps.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { publishable } from "@patchix/common";
import { runAsk } from "./ask.ts";
import { addWorktree, adopt, updateBase } from "./git.ts";
import { importBranches } from "./import.ts";
import { runFleet } from "./fleet.ts";
import { draftFromRun, refreshPrs, renderDraft } from "./pr.ts";
import { startRun } from "./run.ts";
import { context, listRuns, message, readCampaign } from "./store.ts";
import { sync } from "./sync.ts";

const USAGE = "usage: cli.ts sync|refresh|base|fleet <campaign> | run|worktree|adopt <campaign> <attr> | ask <campaign> <attr> <id> | draft <campaign> <attr> [run] | import <campaign> <git-url> [--descriptions <dir>]";
const options = { descriptions: { type: "string" }, root: { type: "string" }, data: { type: "string" }, path: { type: "string" } } as const;
const { positionals, values } = parseArgs({ allowPositionals: true, options });
if (values.path) process.env["PATH"] = values.path;
const [command, campaign, ...rest] = positionals;
const ctx = context({ root: values.root, data: values.data });
const env = join(ctx.data, ".env");
if (existsSync(env)) process.loadEnvFile(env);
// The agent and the checks are in different process groups: thus this process stops them after a signal.
const abort = new AbortController();
if (command === "run" || command === "ask") for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => abort.abort());

async function main(): Promise<number> {
  if (campaign === undefined) throw new Error(USAGE);
  const [attr, id] = rest;
  if (command === "sync" && rest.length === 0) {
    const result = await sync(ctx, campaign);
    for (const w of result.warnings) console.warn(`warning: ${w}`);
    console.log(`${campaign}: ${result.tasks} tasks; the refresh changed ${result.prs.length} drafts${result.prs.length === 0 ? "" : `: ${result.prs.join(", ")}`}`);
    return 0;
  }
  if (command === "refresh" && rest.length === 0) {
    const changed = await refreshPrs(ctx, await readCampaign(ctx, campaign));
    console.log(`${campaign}: the refresh changed ${changed.length} drafts${changed.length === 0 ? "" : `: ${changed.join(", ")}`}`);
    return 0;
  }
  if (command === "run" && attr !== undefined && rest.length === 1) {
    const run = await startRun(ctx, campaign, attr, abort.signal);
    console.log(`${attr}: ${run.status} (run ${run.id}, ${run.commits} commits, lint ${run.lint ?? "-"})${run.error === null ? "" : `: ${run.error}`}`);
    return run.status === "ok" || run.status === "unverified" || run.status === "wontfix" ? 0 : 1;
  }
  if (command === "fleet" && rest.length === 0) {
    return runFleet(ctx, campaign);
  }
  if (command === "ask" && attr !== undefined && id !== undefined && rest.length === 2) {
    const ask = await runAsk(ctx, campaign, attr, id, abort.signal);
    console.log(`${attr}: ask ${ask.id} ${ask.status}${ask.error === null ? "" : `: ${ask.error}`}`);
    return ask.status === "ok" ? 0 : 1;
  }
  if (command === "base" && rest.length === 0) {
    console.log(await updateBase(ctx, await readCampaign(ctx, campaign)));
    return 0;
  }
  if (command === "adopt" && attr !== undefined && rest.length === 1) {
    console.log(await adopt(ctx, await readCampaign(ctx, campaign), attr));
    return 0;
  }
  if (command === "worktree" && attr !== undefined && rest.length === 1) {
    console.log((await addWorktree(ctx, await readCampaign(ctx, campaign), attr)).path);
    return 0;
  }
  if (command === "draft" && attr !== undefined && rest.length <= 2) {
    const run = id ?? (await listRuns(ctx, campaign, attr)).find((r) => publishable(r))?.id;
    if (run === undefined) throw new Error(`${attr} has no ok or unverified run; give the run id`);
    const pr = await draftFromRun(ctx, campaign, attr, run);
    const rendered = await renderDraft(ctx, campaign, attr);
    console.log(`${pr.title}\n\n${rendered?.text ?? ""}`);
    for (const problem of rendered?.problems ?? []) console.error(`warning: ${problem}`);
    return 0;
  }
  if (command === "import" && attr !== undefined && rest.length === 1) {
    const url = attr;
    const result = await importBranches(ctx, campaign, url, values.descriptions);
    for (const i of result.imported) console.log(`imported ${i.branch}: ${i.attrs.join(", ")} (run ${i.run})`);
    for (const b of result.unmatched_branches) console.log(`unmatched branch ${b}`);
    for (const f of result.unmatched_files) console.log(`unmatched file ${f}`);
    console.log(`${campaign}: ${result.imported.length} branches imported, ${result.unmatched_branches.length} unmatched branches, ${result.unmatched_files.length} unmatched files`);
    return 0;
  }
  throw new Error(USAGE);
}

try {
  process.exitCode = await main();
} catch (e) {
  console.error(message(e));
  process.exitCode = 1;
}
