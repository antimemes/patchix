#!/usr/bin/env node
/**
 * `node packages/fleet/src/cli.ts <command>`:
 * - `sync <campaign>` makes the state agree with GitHub: see `sync`. It reads the task list of the tracking issue and
 *   of the `source` command, and the state of the pull requests of the fork. It also reads the branches of the fork,
 *   with their directories, drafts and links. It adds a check-only run to the queue for each branch of the fork
 *   without a pull request and without checks of the tip. The CLI does not start the fleet: the server starts it in
 *   30 seconds or less, or `fleet <campaign>` starts it.
 * - `refresh <campaign>` reads only the state of the pull requests of the fork: step 2 of the sync. See `refreshPrs`.
 * - `run <campaign> <key> [--check]` does one run of the branch `<branch_prefix><key>` and writes its status. The key
 *   of a run on an entry is its attribute. With `--check`, the run is a check-only run: no agent, only the checks of
 *   the tip (see `startRun`). The command line must contain `run <campaign> <key>`: the server and the fleet look for
 *   these words. See `alive`.
 * - `fleet <campaign>` starts the runs of the queue of the campaign, and stops when the queue is empty. See `runFleet`.
 * - `worktree <campaign> <key>` makes the worktree of the branch and writes its path.
 * - `base <campaign>` gets the newest commit of the `base_branch` with depth 1.
 * - `adopt <campaign> <key>` gets the branch from the fork with depth 2, and replaces the branch of the repository of
 *   patchix. Then it makes the run, `fork.yaml`, the draft and the links as the sync does: step 3 of the sync for one
 *   branch. A clean worktree of the branch is made again from the new commit. See `adoptBranch`.
 * - `draft <campaign> <key>` makes the draft of the pull request of the branch: see `makeDraft`.
 * - `import <campaign> <git-url> [--descriptions <dir>]` gets the branches `<branch_prefix>*` of a different checkout
 *   with depth 2, and makes a run with the tag `imported` for each branch with entries. See `importBranches`.
 *
 * `--root <dir>` and `--data <dir>` give the root and the data directory. They come before `PATCHIX_ROOT` and
 * `PATCHIX_DATA`. See `context`. `--path <PATH>` gives the `PATH` of the process: a zellij tab gets the `PATH` of
 * the server with it. The CLI reads `<data>/.env`. The `fork`, the `model` and the `concurrency` come from
 * `<data>/settings.yaml`: see `readSettings` and `forkOf`. The CLI does not write that file.
 *
 * For `run`, `SIGTERM` and `SIGINT` stop the agent and the checks, and the run gets the status `stopped`. These
 * signals stop the other commands without more steps.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { addWorktree, updateBase } from "./git.ts";
import { importBranches } from "./import.ts";
import { runFleet } from "./fleet.ts";
import { makeDraft, refreshPrs, renderDraft } from "./pr.ts";
import { startRun } from "./run.ts";
import { context, message, readCampaign } from "./store.ts";
import { adoptBranch, divergedText, sync } from "./sync.ts";

const USAGE = "usage: cli.ts sync|refresh|base|fleet <campaign> | run <campaign> <key> [--check] | worktree|adopt|draft <campaign> <key> | import <campaign> <git-url> [--descriptions <dir>]";
const options = { descriptions: { type: "string" }, check: { type: "boolean" }, root: { type: "string" }, data: { type: "string" }, path: { type: "string" } } as const;
const { positionals, values } = parseArgs({ allowPositionals: true, options });
if (values.path) process.env["PATH"] = values.path;
const [command, campaign, ...rest] = positionals;
const ctx = context({ root: values.root, data: values.data });
const env = join(ctx.data, ".env");
if (existsSync(env)) process.loadEnvFile(env);
// The agent and the checks are in different process groups: thus this process stops them after a signal.
const abort = new AbortController();
if (command === "run") for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => abort.abort());

async function main(): Promise<number> {
  if (campaign === undefined || (values.check === true && command !== "run")) throw new Error(USAGE);
  const [key] = rest;
  if (command === "sync" && rest.length === 0) {
    const r = await sync(ctx, campaign);
    const definition = await readCampaign(ctx, campaign);
    for (const d of r.diverged) console.warn(`warning: ${divergedText(definition, d)}`);
    for (const w of r.warnings) console.warn(`warning: ${w}`);
    console.log(`${campaign}: ${r.tasks} tasks; the refresh changed ${r.prs.length} drafts${r.prs.length === 0 ? "" : `: ${r.prs.join(", ")}`}`);
    console.log(`${campaign}: ${r.listed} branches of the fork, ${r.fetched} fetched, ${r.made} imported runs made, ${r.drafts} drafts made, ${r.links} links made, ${r.queued} check-only runs queued`);
    if (r.queued > 0) console.log(`the server starts the fleet in 30 seconds or less; without the server, start it with: fleet ${campaign}`);
    return 0;
  }
  if (command === "refresh" && rest.length === 0) {
    const changed = await refreshPrs(ctx, await readCampaign(ctx, campaign));
    console.log(`${campaign}: the refresh changed ${changed.length} drafts${changed.length === 0 ? "" : `: ${changed.join(", ")}`}`);
    return 0;
  }
  if (command === "run" && key !== undefined && rest.length === 1) {
    const run = await startRun(ctx, campaign, key, abort.signal, values.check === true ? "check" : "run");
    console.log(`${key}: ${run.status} (run ${run.id}, ${run.commits} commits, lint ${run.lint ?? "-"})${run.error === null ? "" : `: ${run.error}`}`);
    return run.status === "ok" || run.status === "unverified" || run.status === "wontfix" ? 0 : 1;
  }
  if (command === "fleet" && rest.length === 0) {
    return runFleet(ctx, campaign);
  }
  if (command === "base" && rest.length === 0) {
    console.log(await updateBase(ctx, await readCampaign(ctx, campaign)));
    return 0;
  }
  if (command === "adopt" && key !== undefined && rest.length === 1) {
    const r = await adoptBranch(ctx, campaign, key);
    for (const w of r.warnings) console.warn(`warning: ${w}`);
    console.log(`${r.tip ?? ""}\n${key}: ${r.made ? "imported run made" : "the branch had a run"}, ${r.draft ? "draft made" : "no new draft"}, ${r.links} links made`);
    return 0;
  }
  if (command === "worktree" && key !== undefined && rest.length === 1) {
    console.log((await addWorktree(ctx, await readCampaign(ctx, campaign), key)).path);
    return 0;
  }
  if (command === "draft" && key !== undefined && rest.length === 1) {
    const pr = await makeDraft(ctx, campaign, key);
    const rendered = await renderDraft(ctx, campaign, key);
    console.log(`${pr.title}\n\n${rendered?.text ?? ""}`);
    for (const problem of rendered?.problems ?? []) console.error(`warning: ${problem}`);
    return 0;
  }
  if (command === "import" && key !== undefined && rest.length === 1) {
    const url = key;
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
