/**
 * The fleet of a campaign: one process, `cli.ts fleet <campaign>`, that starts the runs of the queue. It operates in a
 * tab of the zellij session. Each 5 seconds, it reads the campaign, the settings and the queue. An entry of the queue is
 * the key of a branch. The `concurrency` of the settings is the maximum number of jobs of the campaign. Until the
 * campaign has that number of jobs, the fleet starts the run of the first entry without a job and removes the entry. When the queue is empty, the fleet stops. The
 * fleet does not operate the runs: each run has its tab.
 *
 * The server starts the fleet with `ensureFleet` when it adds an entry, when it starts, and each 30 seconds.
 * `fleet.yaml` has the `pid` of the fleet: thus a second fleet of the campaign stops at its start.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Campaign, Run } from "@patchix/common";
import { launch } from "./zellij.ts";
import {
  alive,
  branchDir,
  branchExists,
  dequeue,
  fleetAlive,
  fleetMarker,
  jobs,
  listCampaigns,
  listQueue,
  listRuns,
  message,
  newId,
  now,
  readCampaign,
  readFleet,
  readSettings,
  removeFleet,
  runId,
  serial,
  stateDir,
  takeQuestion,
  writeFleet,
  writeRun,
  type Ctx,
} from "./store.ts";

export interface FleetOptions {
  /** The time that the fleet waits after each `fleetTick`. The default is 5 seconds. */
  tickMs?: number;
  /** The time that the fleet waits for the `run.yaml` of a run that it started. The default is 30 seconds. */
  startMs?: number;
  /** Gets each line of the log. The default writes the line to `stdout` and to `state/<campaign>/fleet.log`. */
  log?: (line: string) => void | Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function logger(ctx: Ctx, c: string, opts: FleetOptions): (line: string) => Promise<void> {
  if (opts.log !== undefined) {
    const log = opts.log;
    return async (line) => log(line);
  }
  return async (line) => {
    const text = `[${now()}] ${line}`;
    console.log(text);
    await mkdir(stateDir(ctx, c), { recursive: true });
    await appendFile(join(stateDir(ctx, c), "fleet.log"), `${text}\n`);
  };
}

/**
 * Starts the run of the branch in a new tab and waits for its `run.yaml`. When the runner does not write a record in
 * `startMs`, the fleet writes a `failed` record with the model `model`. That record gets the question of the branch.
 * The fleet writes no other record of a run. Then it removes the entry of the queue.
 */
async function startOne(ctx: Ctx, campaign: Campaign, model: string, key: string, log: (line: string) => Promise<void>, startMs: number): Promise<void> {
  const c = campaign.name;
  const started = new Date();
  const since = runId(started);
  /** The newest run of the branch that started after the fleet opened the tab. */
  const record = async (): Promise<Run | null> => (await listRuns(ctx, c, key)).find((r) => r.id >= since) ?? null;
  await log(`${key}: start the run`);
  let error: string | null = null;
  try {
    if (!(await launch(ctx, `${c}/${key}`, ["run", c, key])).tab) await log(`${key}: warning: the tab ${c}/${key} is not in the zellij session; the run can operate without a tab`);
  } catch (e) {
    error = message(e);
  }
  let run: Run | null = null;
  for (let waited = 0; error === null && run === null && waited < startMs; waited += 250) {
    await sleep(250);
    run = await record();
  }
  if (run !== null) {
    await log(`${key}: the run ${run.id} started`);
  } else if ((await record()) === null) {
    const id = await newId(join(branchDir(ctx, c, key), "runs"));
    const question = await takeQuestion(ctx, c, key, id);
    const text = error === null ? "the run did not start" : `the run did not start: ${error}`;
    await writeRun(ctx, c, { id, key, attrs: [], tags: [], question, started: started.toISOString().replace(/\.\d+Z$/, "Z"), finished: now(), status: "failed", model, pid: null, base: "", head: null, commits: 0, checks: [], lint: null, error: text });
    await log(`${key}: ${text}; the fleet wrote the failed run ${id}`);
  }
  await dequeue(ctx, c, key);
  await log(`${key}: removed from the queue`);
}

/**
 * One step of the fleet. Gives `false` when the queue is empty. An entry of a branch that is not there is removed: see
 * `branchExists`.
 */
export async function fleetTick(ctx: Ctx, c: string, opts: FleetOptions = {}): Promise<boolean> {
  const log = logger(ctx, c, opts);
  const campaign = await readCampaign(ctx, c);
  const queue = await listQueue(ctx, c);
  if (queue.length === 0) return false;
  const live = await jobs(ctx, c);
  const busy = new Set(live.map((j) => j.key));
  const settings = await readSettings(ctx);
  let free = settings.concurrency - live.length;
  for (const key of queue) {
    if (free <= 0) break;
    if (busy.has(key)) continue;
    if (!(await branchExists(ctx, campaign, key))) {
      await dequeue(ctx, c, key);
      await log(`${key}: no branch ${key}; removed from the queue`);
      continue;
    }
    await startOne(ctx, campaign, settings.model, key, log, opts.startMs ?? 30_000);
    busy.add(key);
    free--;
  }
  return true;
}

/** `fleet.yaml` names a live fleet that is not this process. */
async function other(ctx: Ctx, c: string): Promise<number | null> {
  const fleet = await readFleet(ctx, c);
  return fleet !== null && fleet.pid !== process.pid && alive(fleet.pid, fleetMarker(c)) ? fleet.pid : null;
}

/**
 * `cli.ts fleet <campaign>`: when a different fleet of the campaign operates, it writes one line and gives 0. If not,
 * it writes its `pid` into `fleet.yaml` and does the steps of `fleetTick` until the queue is empty. Then it removes
 * `fleet.yaml` and gives 0. Before it stops, it reads the queue again: an entry that the server added before the
 * removal gets its run.
 */
export async function runFleet(ctx: Ctx, c: string, opts: FleetOptions = {}): Promise<number> {
  const log = logger(ctx, c, opts);
  await readCampaign(ctx, c);
  const first = await other(ctx, c);
  if (first !== null) {
    console.log(`the fleet ${first} of ${c} operates; this process stops`);
    return 0;
  }
  await writeFleet(ctx, c, { pid: process.pid, started: now() });
  await log(`the fleet ${process.pid} starts`);
  for (;;) {
    const pid = await other(ctx, c);
    if (pid !== null) {
      await log(`the fleet ${pid} operates; the fleet ${process.pid} stops`);
      return 0;
    }
    if ((await readFleet(ctx, c))?.pid !== process.pid) await writeFleet(ctx, c, { pid: process.pid, started: now() });
    try {
      if (!(await fleetTick(ctx, c, opts))) {
        await removeFleet(ctx, c);
        if ((await listQueue(ctx, c)).length === 0) {
          await log(`the queue is empty; the fleet ${process.pid} stops`);
          return 0;
        }
        continue;
      }
    } catch (e) {
      await log(`error: ${message(e)}`);
    }
    await sleep(opts.tickMs ?? 5000);
  }
}

/**
 * Starts the fleet of the campaign in a zellij tab, when the queue has entries and no fleet operates. Then it waits
 * for the `fleet.yaml` of the new fleet, for a maximum of `waitMs`. Gives `true` when a fleet operates. For one
 * campaign, the operations of this function occur one after the other: thus two requests do not start two fleets.
 */
export function ensureFleet(ctx: Ctx, c: string, waitMs = 5000): Promise<boolean> {
  return serial(`fleet:${c}`, async () => {
    if (await fleetAlive(ctx, c)) return true;
    if ((await listQueue(ctx, c)).length === 0) return false;
    if (!(await launch(ctx, `${c} fleet`, ["fleet", c], true)).tab) console.warn(`warning: the tab ${c} fleet is not in the zellij session; the fleet can operate without a tab`);
    for (let waited = 0; waited < waitMs; waited += 100) {
      await sleep(100);
      if (await fleetAlive(ctx, c)) return true;
    }
    return false;
  });
}

/** `ensureFleet` for each campaign with entries in its queue. An error goes to `onError`. */
export async function ensureFleets(ctx: Ctx, onError: (c: string, e: unknown) => void): Promise<void> {
  for (const c of await listCampaigns(ctx)) {
    if ((await listQueue(ctx, c)).length > 0) await ensureFleet(ctx, c).catch((e: unknown) => onError(c, e));
  }
}
