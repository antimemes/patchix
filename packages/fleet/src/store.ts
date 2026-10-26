/** The files of the campaigns and of their state. See AGENTS.md for the layout. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendFile, link, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import {
  ATTR,
  branchState,
  CAMPAIGN_NAME,
  CampaignSchema,
  FleetSchema,
  ForkSchema,
  KEY,
  PrSchema,
  RUN_ID,
  RunSchema,
  SettingsSchema,
  TasksFileSchema,
  taskState,
  type BranchView,
  type Campaign,
  type Fleet,
  type Fork,
  type JobStatus,
  type JobsView,
  type Pr,
  type Run,
  type Settings,
  type Task,
  type TasksFile,
  type TaskView,
} from "@patchix/common";
import { branches as gitBranches, branchName, worktreePath } from "./git.ts";

/** The directories of patchix, and the URL that the GitHub repositories are in. */
export interface Ctx {
  /** The code and `campaigns/`. patchix does not write here: it can be a read-only directory. */
  root: string;
  /** `state/`, `.cache/`, `settings.yaml` and the `.env` file of the CLI. patchix writes its files here. */
  data: string;
  /** `https://github.com`. A test gives a `file://` URL. */
  github: string;
}

/**
 * The root is `dirs.root`, or `PATCHIX_ROOT`, or this repository: the first value that is set. The data directory
 * is `dirs.data`, or `PATCHIX_DATA`, or the root.
 */
export function context(dirs: { root?: string | undefined; data?: string | undefined } = {}): Ctx {
  const root = resolve(dirs.root || process.env["PATCHIX_ROOT"] || resolve(import.meta.dirname, "..", "..", ".."));
  return { root, data: resolve(dirs.data || process.env["PATCHIX_DATA"] || root), github: "https://github.com" };
}

/** An error with an HTTP status for the server. */
export function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The date and time as `YYYY-MM-DDTHH:MM:SSZ`. */
export function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/** The id of a run that starts at this time: `YYYYMMDD-HHMMSS` in UTC. */
export function runId(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

/**
 * Makes the directory of a new run in `parent` and gives its id, the time `start`. When a directory has the
 * id of this second, the id of the next second is used.
 */
export async function newId(parent: string, start = new Date()): Promise<string> {
  await mkdir(parent, { recursive: true });
  for (let i = 0; i < 10; i++) {
    const id = runId(new Date(start.getTime() + i * 1000));
    try {
      await mkdir(join(parent, id));
      return id;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  fail(409, `${parent} has a directory for each of the next 10 seconds`);
}

/** The words of the command line of the runner of a run and of the fleet. See `alive`. */
export const runMarker = (c: string, key: string) => `run ${c} ${key}`;
export const fleetMarker = (c: string) => `fleet ${c}`;

/** The command line of a process, with one space between the arguments. `null` when the process is not there. */
function commandLineOf(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((a) => a !== "").join(" ");
    } catch {
      return null;
    }
  }
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return ps.status === 0 ? ps.stdout.trim() : null;
}

/**
 * Gives `true` when the process `pid` operates and its command line contains the words of `marker`, for example
 * `run cacert foo`. A different process can get the id of a process that stopped. Its command line does not contain
 * these words: thus the server does not see a job that stopped as a live job.
 */
export function alive(pid: number, marker: string): boolean {
  const line = commandLineOf(pid);
  return line !== null && ` ${line.replace(/\s+/g, " ")} `.includes(` ${marker} `);
}

function check(value: string, re: RegExp, what: string): string {
  if (!re.test(value)) fail(400, `not ${what}: ${value}`);
  return value;
}

export const campaignDir = (ctx: Ctx, c: string) => join(ctx.root, "campaigns", check(c, CAMPAIGN_NAME, "a campaign name"));
export const stateDir = (ctx: Ctx, c: string) => join(ctx.data, "state", check(c, CAMPAIGN_NAME, "a campaign name"));
/** `state/<campaign>/branches/`: one directory for each branch, with its runs, its draft and its question. */
export const branchesDir = (ctx: Ctx, c: string) => join(stateDir(ctx, c), "branches");
export const branchDir = (ctx: Ctx, c: string, key: string) => join(branchesDir(ctx, c), check(key, KEY, "a branch key"));
export const runDir = (ctx: Ctx, c: string, key: string, id: string) => join(branchDir(ctx, c, key), "runs", check(id, RUN_ID, "a run id"));
/** `question.md` of the branch directory: the question of a person for the next run of the branch. See `queueRun`. */
export const questionFile = (ctx: Ctx, c: string, key: string) => join(branchDir(ctx, c, key), "question.md");

/** A name without the signs that a file name cannot have: each becomes `_`. */
const safe = (name: string) => name.replace(/[^\w.-]/g, "_");

/** The file of the output of a check for an attribute in a run directory: `checks/<attr>.<check>.txt`. */
export function checkFile(dir: string, attr: string, name: string): string {
  return join(dir, "checks", `${safe(attr)}.${safe(name)}.txt`);
}

/** The output of a check for an attribute. A run of a previous version has `checks/<check>.txt` for its one attribute. */
export async function readCheck(dir: string, attr: string, name: string): Promise<string | null> {
  return (await readText(checkFile(dir, attr, name))) ?? (await readText(join(dir, "checks", `${safe(name)}.txt`)));
}

export async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw e;
  }
}

/** Writes a temporary file and then moves it to `path`. Thus a reader gets the file before the change or the file after the change. */
export async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/**
 * Makes the file `dir/name` with the text, and gives `true`. When the file is there, it does not change, and the
 * result is `false`. `link` makes the file with all its text in one operation, and it does not replace a file. The
 * temporary file starts with `.`: it is not a name of `ATTR`.
 */
async function createOnce(dir: string, name: string, text: string): Promise<boolean> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${name}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(tmp, text);
  try {
    await link(tmp, join(dir, name));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return false;
  } finally {
    await rm(tmp, { force: true });
  }
}

interface Schema<T> {
  parse(value: unknown): T;
}

async function readYaml<T>(path: string, schema: Schema<T>): Promise<T | null> {
  const text = await readText(path);
  if (text === null) return null;
  try {
    return schema.parse(parse(text) ?? {});
  } catch (e) {
    throw new Error(`${path}: ${message(e)}`, { cause: e });
  }
}

const writeYaml = (path: string, value: unknown) => writeAtomic(path, stringify(value, { lineWidth: 0 }));

/** The operations with the same key occur one after the other. */
const queues = new Map<string, Promise<unknown>>();

export function serial<T>(key: string, task: () => Promise<T>): Promise<T> {
  const result = (queues.get(key) ?? Promise.resolve()).then(task);
  const tail = result.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return result;
}

export async function listCampaigns(ctx: Ctx): Promise<string[]> {
  const entries = await readdir(join(ctx.root, "campaigns"), { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const e of entries) {
    if (e.isDirectory() && CAMPAIGN_NAME.test(e.name) && (await exists(join(ctx.root, "campaigns", e.name, "campaign.yaml")))) names.push(e.name);
  }
  return names.sort();
}

/** The files and the keys of the warnings of `campaignSchema`: each process writes each warning one time. */
const warned = new Set<string>();

/**
 * `CampaignSchema` for the file `path`. zod removes the keys that are not in the schema. For such keys, for example
 * `fork` in a file of a previous version, this schema writes one warning with the file and the keys.
 */
function campaignSchema(path: string): Schema<Campaign> {
  return {
    parse(value) {
      const extra = typeof value === "object" && value !== null ? Object.keys(value).filter((k) => !(k in CampaignSchema.shape)) : [];
      const key = `${path}: ${extra.join(", ")}`;
      if (extra.length > 0 && !warned.has(key)) {
        warned.add(key);
        console.warn(`warning: ${path}: patchix does not use the keys ${extra.join(", ")}. The settings page gives the fork, the model and the concurrency.`);
      }
      return CampaignSchema.parse(value);
    },
  };
}

export async function readCampaign(ctx: Ctx, c: string): Promise<Campaign> {
  const path = join(campaignDir(ctx, c), "campaign.yaml");
  return (await readYaml(path, campaignSchema(path))) ?? fail(404, `no campaign ${c}`);
}

const settingsFile = (ctx: Ctx) => join(ctx.data, "settings.yaml");

/** `settings.yaml` of the data directory. Without the file, each value is the default. See `SettingsSchema`. */
export async function readSettings(ctx: Ctx): Promise<Settings> {
  return (await readYaml(settingsFile(ctx), SettingsSchema)) ?? SettingsSchema.parse({});
}

/** Only the server writes `settings.yaml`, from the settings page. */
export function writeSettings(ctx: Ctx, settings: Settings): Promise<void> {
  return serial("settings", () => writeYaml(settingsFile(ctx), SettingsSchema.parse(settings)));
}

const tasksFile = (ctx: Ctx, c: string) => join(stateDir(ctx, c), "tasks.yaml");

/**
 * `state/<campaign>/links/`: the links that a runner found after checks with the result `pass`. The name of a file is the
 * attribute of an entry, and its text is the key of the branch. The runner adds a file (see `requestLink`), and does
 * not write `tasks.yaml`. `readTasks` applies a link to an entry without a branch. The writers of `tasks.yaml` (the
 * server and the sync) put the links into the file and remove the link files: see `updateTasks`.
 */
export const linksDir = (ctx: Ctx, c: string) => join(stateDir(ctx, c), "links");

/** The link files, by attribute. */
async function readLinks(ctx: Ctx, c: string): Promise<Map<string, string>> {
  const dir = linksDir(ctx, c);
  const links = new Map<string, string>();
  for (const attr of (await readdir(dir).catch(() => [])).filter((a) => ATTR.test(a))) {
    const key = ((await readText(join(dir, attr))) ?? "").trim();
    if (KEY.test(key)) links.set(attr, key);
  }
  return links;
}

/** The task list with the links: a link applies to an entry without a branch only. */
function withLinks(file: TasksFile, links: ReadonlyMap<string, string>): TasksFile {
  if (links.size === 0) return file;
  return { ...file, tasks: file.tasks.map((t) => (t.branch === null && links.has(t.attr) ? { ...t, branch: links.get(t.attr) ?? null } : t)) };
}

/** `tasks.yaml`, with the links of `links/`. */
export async function readTasks(ctx: Ctx, c: string): Promise<TasksFile | null> {
  const file = await readYaml(tasksFile(ctx, c), TasksFileSchema);
  return file === null ? null : withLinks(file, await readLinks(ctx, c));
}

/** Writes `tasks.yaml` as it is. Use `updateTasks`: it also puts the links into the file. */
export async function writeTasks(ctx: Ctx, c: string, file: TasksFile): Promise<void> {
  await writeYaml(tasksFile(ctx, c), TasksFileSchema.parse(file));
}

/**
 * Changes `tasks.yaml`: `change` gets the task list with the links (see `readTasks`) and gives the new list, or
 * `null` for no change. Then this function writes the file and removes the link files that it read. The changes of
 * one process occur one after the other.
 */
export function updateTasks(ctx: Ctx, c: string, change: (file: TasksFile | null) => TasksFile | null | Promise<TasksFile | null>): Promise<TasksFile | null> {
  return serial(`tasks:${c}`, async () => {
    const links = await readLinks(ctx, c);
    const file = await readYaml(tasksFile(ctx, c), TasksFileSchema);
    const next = await change(file === null ? null : withLinks(file, links));
    if (next === null) return null;
    await writeTasks(ctx, c, next);
    for (const attr of links.keys()) await rm(join(linksDir(ctx, c), attr), { force: true });
    return next;
  });
}

/**
 * The runner adds the link of the entry `attr` to the branch `key`. A link that is there does not change: the first
 * link applies. Gives `false` when there was a link.
 */
export async function requestLink(ctx: Ctx, c: string, attr: string, key: string): Promise<boolean> {
  return createOnce(linksDir(ctx, c), check(attr, ATTR, "an attribute"), `${check(key, KEY, "a branch key")}\n`);
}

export async function readTask(ctx: Ctx, c: string, attr: string): Promise<Task> {
  const task = (await readTasks(ctx, c))?.tasks.find((t) => t.attr === attr);
  return task ?? fail(404, `no task ${attr} in the campaign ${c}`);
}

/**
 * A `running` record without a live runner did not finish: this function gives it as `stopped`. It does not write
 * the file: only the runner writes its record.
 */
function liveRecord(run: Run, marker: string): Run {
  if (run.status !== "running" || (run.pid !== null && alive(run.pid, marker))) return run;
  return { ...run, status: "stopped", error: "the process stopped" };
}

/** The runs of a branch, the newest first. The key of each run is the key of its directory. */
export async function listRuns(ctx: Ctx, c: string, key: string): Promise<Run[]> {
  const out: Run[] = [];
  const ids = (await readdir(join(branchDir(ctx, c, key), "runs")).catch(() => [])).filter((id) => RUN_ID.test(id));
  for (const id of ids.sort().reverse()) {
    const run = await readYaml(join(runDir(ctx, c, key, id), "run.yaml"), RunSchema);
    if (run !== null) out.push(liveRecord({ ...run, key }, runMarker(c, key)));
  }
  return out;
}

export async function readRun(ctx: Ctx, c: string, key: string, id: string): Promise<Run> {
  const run = (await readYaml(join(runDir(ctx, c, key, id), "run.yaml"), RunSchema)) ?? fail(404, `no run ${id} of ${key}`);
  return { ...run, key };
}

export async function writeRun(ctx: Ctx, c: string, run: Run): Promise<void> {
  await writeYaml(join(runDir(ctx, c, run.key, run.id), "run.yaml"), RunSchema.parse(run));
}

/** The job of a branch: its run that is `running`, or `null`. */
export async function branchJob(ctx: Ctx, c: string, key: string): Promise<(JobStatus & { pid: number | null }) | null> {
  const run = (await listRuns(ctx, c, key)).find((r) => r.status === "running");
  return run === undefined ? null : { key, id: run.id, started: run.started, pid: run.pid };
}

/** The keys of the branch directories of the campaign. */
export async function branchKeys(ctx: Ctx, c: string): Promise<string[]> {
  return (await readdir(branchesDir(ctx, c)).catch(() => [])).filter((k) => KEY.test(k)).sort();
}

/** The runs of the campaign that operate at this time. */
export async function jobs(ctx: Ctx, c: string): Promise<JobStatus[]> {
  const out: JobStatus[] = [];
  for (const key of await branchKeys(ctx, c)) {
    const job = await branchJob(ctx, c, key);
    if (job !== null) out.push({ key: job.key, id: job.id, started: job.started });
  }
  return out;
}

/**
 * `state/<campaign>/queue/`: one file for each branch that waits for a run. The name of the file is the key. Its
 * first line is the time of the entry. The entry of a check-only run has a second line, `check`: see `QueueMode`. The
 * server and the sync add and remove entries; the fleet removes them. No code writes a file of the queue that is
 * there: thus two processes cannot write the same file.
 */
export const queueDir = (ctx: Ctx, c: string) => join(stateDir(ctx, c), "queue");

/**
 * The run of an entry of the queue. `run`: a usual run, with the agent. `check`: a check-only run, without the agent
 * (see `startRun`).
 */
export type QueueMode = "run" | "check";

export interface QueueEntry {
  key: string;
  time: string;
  mode: QueueMode;
}

/**
 * Adds the branch to the queue with the time `time`. An entry that is there does not change: it keeps its position
 * and its mode. Gives `false` when the queue had the branch.
 */
export async function enqueue(ctx: Ctx, c: string, key: string, time = new Date().toISOString(), mode: QueueMode = "run"): Promise<boolean> {
  return createOnce(queueDir(ctx, c), check(key, KEY, "a branch key"), mode === "check" ? `${time}\ncheck\n` : `${time}\n`);
}

/**
 * Removes the branch from the queue, and also its question: see `queueRun`. Gives `false` when the queue did not
 * have the branch.
 */
export async function dequeue(ctx: Ctx, c: string, key: string): Promise<boolean> {
  try {
    await unlink(join(queueDir(ctx, c), check(key, KEY, "a branch key")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  await rm(questionFile(ctx, c, key), { force: true });
  return true;
}

/** The entries of the queue, in the sequence of their times. Entries with the same time are in the sequence of their names. */
export async function queueEntries(ctx: Ctx, c: string): Promise<QueueEntry[]> {
  const dir = queueDir(ctx, c);
  const entries: QueueEntry[] = [];
  for (const key of (await readdir(dir).catch(() => [])).filter((a) => KEY.test(a))) {
    const text = await readText(join(dir, key));
    if (text === null) continue;
    const [time = "", mode = ""] = text.split("\n").map((line) => line.trim());
    entries.push({ key, time, mode: mode === "check" ? "check" : "run" });
  }
  entries.sort((a, b) => (a.time === b.time ? (a.key < b.key ? -1 : 1) : a.time < b.time ? -1 : 1));
  return entries;
}

/** The keys of `queueEntries`. */
export async function listQueue(ctx: Ctx, c: string): Promise<string[]> {
  return (await queueEntries(ctx, c)).map((e) => e.key);
}

/** Removes each entry of the queue. */
export async function clearQueue(ctx: Ctx, c: string): Promise<void> {
  for (const key of await listQueue(ctx, c)) await dequeue(ctx, c, key);
}

/**
 * Adds the branch to the queue for one run. With a question, it first writes the question into `question.md` of the
 * branch directory: the next run of the branch gets it. Without a question (an empty string), it removes a
 * `question.md` without an entry, if there is one: the run is a usual run. A branch with a job or with an entry gives
 * an error with status 409. Thus one question waits for each branch, and a question does not change the run that
 * operates. With the mode `check`, the entry is a check-only run: it has no question.
 */
export function queueRun(ctx: Ctx, c: string, key: string, question = "", mode: QueueMode = "run"): Promise<void> {
  return serial(`queue:${c}`, async () => {
    if ((await branchJob(ctx, c, key)) !== null) fail(409, `the branch ${key} has a job`);
    if ((await listQueue(ctx, c)).includes(key)) fail(409, `the branch ${key} is in the queue`);
    const text = question.trim();
    if (mode === "check" && text !== "") fail(400, "a check-only run has no question");
    if (text === "") await rm(questionFile(ctx, c, key), { force: true });
    else await writeAtomic(questionFile(ctx, c, key), `${text}\n`);
    await enqueue(ctx, c, key, undefined, mode);
  });
}

/**
 * Moves the question of the branch into the directory of the run `id`, and gives its text. `null` when the branch has
 * no question. The runner does this when the run starts, and the fleet does it for a run that did not start.
 */
export async function takeQuestion(ctx: Ctx, c: string, key: string, id: string): Promise<string | null> {
  const to = join(runDir(ctx, c, key, id), "question.md");
  try {
    await rename(questionFile(ctx, c, key), to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  return ((await readText(to)) ?? "").trim();
}

const fleetFile = (ctx: Ctx, c: string) => join(stateDir(ctx, c), "fleet.yaml");

/** `fleet.yaml`, or `null` when there is no file or the file is not correct. */
export async function readFleet(ctx: Ctx, c: string): Promise<Fleet | null> {
  return readYaml(fleetFile(ctx, c), FleetSchema).catch(() => null);
}

/** Only the fleet writes `fleet.yaml`. */
export async function writeFleet(ctx: Ctx, c: string, fleet: Fleet): Promise<void> {
  await writeYaml(fleetFile(ctx, c), FleetSchema.parse(fleet));
}

export async function removeFleet(ctx: Ctx, c: string): Promise<void> {
  await rm(fleetFile(ctx, c), { force: true });
}

/** The process of `fleet.yaml` operates, and it is a fleet of this campaign. */
export async function fleetAlive(ctx: Ctx, c: string): Promise<boolean> {
  const fleet = await readFleet(ctx, c);
  return fleet !== null && alive(fleet.pid, fleetMarker(c));
}

export async function jobsView(ctx: Ctx, c: string): Promise<JobsView> {
  const queue = await queueEntries(ctx, c);
  return { jobs: await jobs(ctx, c), queue: queue.map((e) => e.key), check: queue.filter((e) => e.mode === "check").map((e) => e.key), fleet: await fleetAlive(ctx, c) };
}

const prFile = (ctx: Ctx, c: string, key: string) => join(branchDir(ctx, c, key), "pr.yaml");
const draftFile = (ctx: Ctx, c: string, key: string) => join(branchDir(ctx, c, key), "pr.md");

export async function readPr(ctx: Ctx, c: string, key: string): Promise<Pr | null> {
  return readYaml(prFile(ctx, c, key), PrSchema);
}

export async function writePr(ctx: Ctx, c: string, key: string, pr: Pr): Promise<void> {
  await writeYaml(prFile(ctx, c, key), PrSchema.parse(pr));
}

/** `pr.md`, or `null` when the branch has no draft. */
export async function readDraft(ctx: Ctx, c: string, key: string): Promise<string | null> {
  return readText(draftFile(ctx, c, key));
}

export async function writeDraft(ctx: Ctx, c: string, key: string, text: string): Promise<void> {
  await writeAtomic(draftFile(ctx, c, key), text);
}

const forkFile = (ctx: Ctx, c: string, key: string) => join(branchDir(ctx, c, key), "fork.yaml");

/**
 * `fork.yaml`: the commit of the branch on the fork (see `ForkSchema`). `null` when there is no file or the file is
 * not correct: the next sync writes it again.
 */
export async function readFork(ctx: Ctx, c: string, key: string): Promise<Fork | null> {
  return readYaml(forkFile(ctx, c, key), ForkSchema).catch(() => null);
}

/** The sync, the `adopt` command and the push of a pull request write `fork.yaml`, with the time of the write. */
export async function writeFork(ctx: Ctx, c: string, key: string, sha: string): Promise<void> {
  await writeYaml(forkFile(ctx, c, key), ForkSchema.parse({ sha, time: now() }));
}

/** The sync removes `fork.yaml` of a branch that the fork does not have. */
export async function removeFork(ctx: Ctx, c: string, key: string): Promise<void> {
  await rm(forkFile(ctx, c, key), { force: true });
}

const publishLogFile = (ctx: Ctx, c: string, key: string) => join(branchDir(ctx, c, key), "publish.log");

/** `publish.log`: the commands of the newest `createOrUpdatePr` and their output. `null` when there is no file. */
export async function readPublishLog(ctx: Ctx, c: string, key: string): Promise<string | null> {
  return readText(publishLogFile(ctx, c, key));
}

export async function writePublishLog(ctx: Ctx, c: string, key: string, text: string): Promise<void> {
  await writeAtomic(publishLogFile(ctx, c, key), text);
}

/** Adds the text to the end of `publish.log`. */
export async function appendPublishLog(ctx: Ctx, c: string, key: string, text: string): Promise<void> {
  await appendFile(publishLogFile(ctx, c, key), text);
}

/**
 * The strings of the first `words = [...]` array of a TOML text, and the position of its `]`. A TOML parser is
 * not necessary: the array has only strings and lines that start with `#`.
 */
export function tomlWords(text: string): { words: string[]; end: number; comma: boolean } | null {
  const start = /^words\s*=\s*\[/m.exec(text);
  if (start === null) return null;
  const words: string[] = [];
  let comma = true;
  for (let i = start.index + start[0].length; i < text.length; i++) {
    const ch = text[i];
    if (ch === "]") return { words, end: i, comma };
    if (ch === "#") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += ch === '"' && text[j] === "\\" ? 2 : 1;
      const raw = text.slice(i, j + 1);
      words.push(ch === '"' ? (JSON.parse(raw) as string) : raw.slice(1, -1));
      comma = false;
      i = j;
    } else if (ch === ",") {
      comma = true;
    }
  }
  return null;
}

/** The `words` of `campaigns/<name>/memelint.toml`. */
export async function campaignWords(ctx: Ctx, c: string): Promise<string[]> {
  const text = await readText(join(campaignDir(ctx, c), "memelint.toml"));
  return text === null ? [] : (tomlWords(text)?.words ?? []);
}

/** The attributes of the entries that link to the branch `key`, in the sequence of the task list. */
export const coversOf = (tasks: readonly Task[], key: string) => tasks.filter((t) => t.branch === key).map((t) => t.attr);

/**
 * The entries of the branch `key` for a check-only run: the entries that link to the branch (see `coversOf`). A
 * branch without entries gets its key, when the key is an attribute of the task list. A check-only run also declares
 * the newest declaration of the branch: see `startRun`.
 */
export function checkAttrs(tasks: readonly Task[], key: string): string[] {
  const covers = coversOf(tasks, key);
  return covers.length > 0 || !tasks.some((t) => t.attr === key) ? covers : [key];
}

async function viewOf(ctx: Ctx, campaign: Campaign, key: string, covers: string[], refs: ReadonlyMap<string, string>): Promise<BranchView> {
  const runs = await listRuns(ctx, campaign.name, key);
  const pr = await readPr(ctx, campaign.name, key);
  const worktree = worktreePath(ctx, campaign, key);
  const name = branchName(campaign, key);
  const head = refs.get(name) ?? null;
  return { key, name, state: branchState(covers, runs, pr, head), head, runs, pr_meta: pr, worktree: (await exists(worktree)) ? worktree : null, covers };
}

/**
 * The entries of the task list and the branches of the campaign. The branches are the branch directories and the keys
 * of the links, by key. The state of an entry is the state of its branch: see `taskState`.
 */
export async function campaignState(ctx: Ctx, c: string): Promise<{ tasks: TaskView[]; branches: BranchView[] }> {
  const campaign = await readCampaign(ctx, c);
  const tasks = (await readTasks(ctx, c))?.tasks ?? [];
  const refs = await gitBranches(ctx, campaign.branch_prefix);
  const keys = [...new Set([...(await branchKeys(ctx, c)), ...tasks.flatMap((t) => (t.branch === null ? [] : [t.branch]))])].sort();
  const branches = await Promise.all(keys.map((key) => viewOf(ctx, campaign, key, coversOf(tasks, key), refs)));
  const byKey = new Map(branches.map((b) => [b.key, b]));
  return { tasks: tasks.map((t) => ({ ...t, state: taskState(t, t.branch === null ? undefined : byKey.get(t.branch)) })), branches };
}

/**
 * Gives `true` when the branch `key` is there. A branch is there when it has a directory or an entry links to it. Its
 * key can also be an attribute of the task list, or the repository of patchix has it.
 */
export async function branchExists(ctx: Ctx, campaign: Campaign, key: string): Promise<boolean> {
  if (await exists(branchDir(ctx, campaign.name, key))) return true;
  const tasks = (await readTasks(ctx, campaign.name))?.tasks ?? [];
  if (tasks.some((t) => t.attr === key || t.branch === key)) return true;
  return (await gitBranches(ctx, branchName(campaign, key))).has(branchName(campaign, key));
}

/** Gives an error with status 404 when the branch `key` is not there: see `branchExists`. */
export async function needBranch(ctx: Ctx, campaign: Campaign, key: string): Promise<void> {
  if (!(await branchExists(ctx, campaign, key))) fail(404, `no branch ${key} in the campaign ${campaign.name}`);
}

/** The branch `key` with its runs, its draft and the entries that link to it. */
export async function branchView(ctx: Ctx, c: string, key: string): Promise<BranchView> {
  const campaign = await readCampaign(ctx, c);
  const tasks = (await readTasks(ctx, c))?.tasks ?? [];
  return viewOf(ctx, campaign, key, coversOf(tasks, key), await gitBranches(ctx, branchName(campaign, key)));
}
