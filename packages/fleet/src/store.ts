/** The files of the campaigns and of their state. See CLAUDE.md for the layout. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendFile, link, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import {
  ATTR,
  AskSchema,
  CAMPAIGN_NAME,
  CampaignSchema,
  FleetSchema,
  PrSchema,
  RUN_ID,
  RunSchema,
  SettingsSchema,
  TasksFileSchema,
  type Ask,
  type Campaign,
  type Fleet,
  type JobStatus,
  type JobsView,
  type Pr,
  type Run,
  type Settings,
  type Task,
  type TasksFile,
  type TaskState,
  type TaskView,
} from "@patchix/common";
import { branches, branchOf, worktreePath } from "./git.ts";

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

/** The id of a run or an ask that starts at this time: `YYYYMMDD-HHMMSS` in UTC. */
export function runId(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

/** The time of a run id or an ask id, as `YYYY-MM-DDTHH:MM:SSZ`. */
export function idTime(id: string): string {
  return `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(9, 11)}:${id.slice(11, 13)}:${id.slice(13, 15)}Z`;
}

/**
 * Makes the directory of a new run or ask in `parent` and gives its id, the time `start`. When a directory has the
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

/** The words of the command line of the runner of a run, of an ask and of the fleet. See `alive`. */
export const runMarker = (c: string, attr: string) => `run ${c} ${attr}`;
export const askMarker = (c: string, attr: string) => `ask ${c} ${attr}`;
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
export const taskDir = (ctx: Ctx, c: string, attr: string) => join(stateDir(ctx, c), "tasks", check(attr, ATTR, "an attribute"));
export const runDir = (ctx: Ctx, c: string, attr: string, id: string) => join(taskDir(ctx, c, attr), "runs", check(id, RUN_ID, "a run id"));
export const askDir = (ctx: Ctx, c: string, attr: string, id: string) => join(taskDir(ctx, c, attr), "asks", check(id, RUN_ID, "an ask id"));

/** The file of the output of a check in a run directory. A sign that is not permitted in a file name becomes `_`. */
export function checkFile(dir: string, name: string): string {
  return join(dir, "checks", `${name.replace(/[^\w.-]/g, "_")}.txt`);
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

export async function readTasks(ctx: Ctx, c: string): Promise<TasksFile | null> {
  return readYaml(join(stateDir(ctx, c), "tasks.yaml"), TasksFileSchema);
}

export async function writeTasks(ctx: Ctx, c: string, file: TasksFile): Promise<void> {
  await writeYaml(join(stateDir(ctx, c), "tasks.yaml"), TasksFileSchema.parse(file));
}

export async function readTask(ctx: Ctx, c: string, attr: string): Promise<Task> {
  const task = (await readTasks(ctx, c))?.tasks.find((t) => t.attr === attr);
  return task ?? fail(404, `no task ${attr} in the campaign ${c}`);
}

/** An ask without `ask.yaml` after this time did not start. */
const START_MS = 2 * 60_000;

/**
 * A `running` record without a live runner did not finish: this function gives it as `stopped`. It does not write
 * the file: only the runner writes its record.
 */
function liveRecord<T extends Run | Ask>(record: T, marker: string): T {
  if (record.status !== "running" || (record.pid !== null && alive(record.pid, marker))) return record;
  return { ...record, status: "stopped", error: "the process stopped" };
}

/** The ids of the run directories or the ask directories of a task, the newest first. */
async function ids(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [])).filter((id) => RUN_ID.test(id)).sort().reverse();
}

/** The runs of a task, the newest first. */
export async function listRuns(ctx: Ctx, c: string, attr: string): Promise<Run[]> {
  const out: Run[] = [];
  for (const id of await ids(join(taskDir(ctx, c, attr), "runs"))) {
    const run = await readYaml(join(runDir(ctx, c, attr, id), "run.yaml"), RunSchema);
    if (run !== null) out.push(liveRecord(run, runMarker(c, attr)));
  }
  return out;
}

export async function readRun(ctx: Ctx, c: string, attr: string, id: string): Promise<Run> {
  return (await readYaml(join(runDir(ctx, c, attr, id), "run.yaml"), RunSchema)) ?? fail(404, `no run ${id} of ${attr}`);
}

/**
 * The ask `id`: `ask.yaml`, or the record of an ask that starts when the directory has only `question.md`. See
 * `AskSchema`. `null` when the directory has no `ask.yaml` and no `question.md`.
 */
async function loadAsk(ctx: Ctx, c: string, attr: string, id: string): Promise<Ask | null> {
  const dir = askDir(ctx, c, attr, id);
  const record = await readYaml(join(dir, "ask.yaml"), AskSchema);
  if (record !== null) return liveRecord(record, askMarker(c, attr));
  const question = await readText(join(dir, "question.md"));
  if (question === null) return null;
  const started = idTime(id);
  const late = Date.now() - Date.parse(started) > START_MS;
  const model = (await readSettings(ctx).catch(() => null))?.model ?? "";
  const status = late ? "failed" : "running";
  return { id, attr, question: question.trim(), started, finished: null, status, model, pid: null, files: [], error: late ? "the ask did not start" : null };
}

/** The asks of a task, the newest first. */
export async function listAsks(ctx: Ctx, c: string, attr: string): Promise<Ask[]> {
  const out: Ask[] = [];
  for (const id of await ids(join(taskDir(ctx, c, attr), "asks"))) {
    const ask = await loadAsk(ctx, c, attr, id);
    if (ask !== null) out.push(ask);
  }
  return out;
}

export async function writeRun(ctx: Ctx, c: string, run: Run): Promise<void> {
  await writeYaml(join(runDir(ctx, c, run.attr, run.id), "run.yaml"), RunSchema.parse(run));
}

/** The ask `id`, also an ask that starts. See `loadAsk`. */
export async function readAsk(ctx: Ctx, c: string, attr: string, id: string): Promise<Ask> {
  return (await loadAsk(ctx, c, attr, id)) ?? fail(404, `no ask ${id} of ${attr}`);
}

export async function writeAsk(ctx: Ctx, c: string, ask: Ask): Promise<void> {
  await writeYaml(join(askDir(ctx, c, ask.attr, ask.id), "ask.yaml"), AskSchema.parse(ask));
}

/** The job of a task: its run or ask that is `running`, or `null`. An ask that starts is a job with no `pid`. */
export async function taskJob(ctx: Ctx, c: string, attr: string): Promise<(JobStatus & { pid: number | null }) | null> {
  const run = (await listRuns(ctx, c, attr)).find((r) => r.status === "running");
  if (run !== undefined) return { attr, kind: "run", id: run.id, started: run.started, pid: run.pid };
  const ask = (await listAsks(ctx, c, attr)).find((a) => a.status === "running");
  return ask === undefined ? null : { attr, kind: "ask", id: ask.id, started: ask.started, pid: ask.pid };
}

/** The attributes of the task directories of the campaign, also of a task that the task list does not have. */
export async function taskDirs(ctx: Ctx, c: string): Promise<string[]> {
  return (await readdir(join(stateDir(ctx, c), "tasks")).catch(() => [])).filter((a) => ATTR.test(a)).sort();
}

/** The runs and asks of the campaign that operate at this time. */
export async function jobs(ctx: Ctx, c: string): Promise<JobStatus[]> {
  const out: JobStatus[] = [];
  for (const attr of await taskDirs(ctx, c)) {
    const job = await taskJob(ctx, c, attr);
    if (job !== null) out.push({ attr: job.attr, kind: job.kind, id: job.id, started: job.started });
  }
  return out;
}

/**
 * `state/<campaign>/queue/`: one file for each task that waits for a run. The name of the file is the attribute.
 * Its text is the time of the entry. The server adds and removes entries; the fleet removes them. No code writes a
 * file of the queue that is there: thus two processes cannot write the same file.
 */
export const queueDir = (ctx: Ctx, c: string) => join(stateDir(ctx, c), "queue");

/**
 * Adds the task to the queue with the time `time`. An entry that is there does not change: it keeps its position.
 * `link` makes the entry with all its text in one operation, and it does not replace a file.
 */
export async function enqueue(ctx: Ctx, c: string, attr: string, time = new Date().toISOString()): Promise<void> {
  const dir = queueDir(ctx, c);
  const entry = join(dir, check(attr, ATTR, "an attribute"));
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${attr}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(tmp, `${time}\n`);
  try {
    await link(tmp, entry);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Removes the task from the queue. Gives `false` when the queue did not have it. */
export async function dequeue(ctx: Ctx, c: string, attr: string): Promise<boolean> {
  try {
    await unlink(join(queueDir(ctx, c), check(attr, ATTR, "an attribute")));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** The attributes of the queue, in the sequence of the times of the entries. Entries with the same time are in the sequence of their names. */
export async function listQueue(ctx: Ctx, c: string): Promise<string[]> {
  const dir = queueDir(ctx, c);
  const entries: { attr: string; time: string }[] = [];
  for (const attr of (await readdir(dir).catch(() => [])).filter((a) => ATTR.test(a))) {
    const time = await readText(join(dir, attr));
    if (time !== null) entries.push({ attr, time: time.trim() });
  }
  entries.sort((a, b) => (a.time === b.time ? (a.attr < b.attr ? -1 : 1) : a.time < b.time ? -1 : 1));
  return entries.map((e) => e.attr);
}

/** Removes each entry of the queue. */
export async function clearQueue(ctx: Ctx, c: string): Promise<void> {
  for (const attr of await listQueue(ctx, c)) await dequeue(ctx, c, attr);
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
  return { jobs: await jobs(ctx, c), queue: await listQueue(ctx, c), fleet: await fleetAlive(ctx, c) };
}

const prFile = (ctx: Ctx, c: string, attr: string) => join(taskDir(ctx, c, attr), "pr.yaml");
const draftFile = (ctx: Ctx, c: string, attr: string) => join(taskDir(ctx, c, attr), "pr.md");

export async function readPr(ctx: Ctx, c: string, attr: string): Promise<Pr | null> {
  return readYaml(prFile(ctx, c, attr), PrSchema);
}

export async function writePr(ctx: Ctx, c: string, attr: string, pr: Pr): Promise<void> {
  await writeYaml(prFile(ctx, c, attr), PrSchema.parse(pr));
}

/** `pr.md`, or `null` when the task has no draft. */
export async function readDraft(ctx: Ctx, c: string, attr: string): Promise<string | null> {
  return readText(draftFile(ctx, c, attr));
}

export async function writeDraft(ctx: Ctx, c: string, attr: string, text: string): Promise<void> {
  await writeAtomic(draftFile(ctx, c, attr), text);
}

const publishLogFile = (ctx: Ctx, c: string, attr: string) => join(taskDir(ctx, c, attr), "publish.log");

/** `publish.log`: the commands of the newest `createOrUpdatePr` and their output. `null` when there is no file. */
export async function readPublishLog(ctx: Ctx, c: string, attr: string): Promise<string | null> {
  return readText(publishLogFile(ctx, c, attr));
}

export async function writePublishLog(ctx: Ctx, c: string, attr: string, text: string): Promise<void> {
  await writeAtomic(publishLogFile(ctx, c, attr), text);
}

/** Adds the text to the end of `publish.log`. */
export async function appendPublishLog(ctx: Ctx, c: string, attr: string, text: string): Promise<void> {
  await appendFile(publishLogFile(ctx, c, attr), text);
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

/**
 * The state of a task. See `TaskStateSchema`. The runs are the newest first. The pull request of the draft is first,
 * then the issue entry when patchix has no draft, then the newest run.
 */
export function taskState(task: Task, runs: readonly Run[], pr: Pr | null): TaskState {
  if (pr !== null && pr.number !== null) return pr.state === "open" ? "pr" : pr.state;
  if (pr === null && (task.checked || task.pr !== null)) return "external";
  switch (runs[0]?.status) {
    case "running":
      return "running";
    case "ok":
      return "ready";
    case "unverified":
      return "unverified";
    case "wontfix":
      return "wontfix";
    case "failed":
    case "stopped":
      return "failed";
    default:
      return "todo";
  }
}

async function view(ctx: Ctx, campaign: Campaign, task: Task, refs: ReadonlyMap<string, string>): Promise<TaskView> {
  const runs = await listRuns(ctx, campaign.name, task.attr);
  const pr = await readPr(ctx, campaign.name, task.attr);
  const worktree = worktreePath(ctx, campaign, task.attr);
  const branch = branchOf(campaign, task);
  return {
    ...task,
    state: taskState(task, runs, pr),
    branch_name: branch,
    head: refs.get(branch) ?? null,
    runs,
    pr_meta: pr,
    worktree: (await exists(worktree)) ? worktree : null,
  };
}

const campaignBranches = (ctx: Ctx, campaign: Campaign) => branches(ctx, campaign.branch_prefix);

export async function taskViews(ctx: Ctx, c: string): Promise<TaskView[]> {
  const campaign = await readCampaign(ctx, c);
  const tasks = (await readTasks(ctx, c))?.tasks ?? [];
  const refs = await campaignBranches(ctx, campaign);
  return Promise.all(tasks.map((t) => view(ctx, campaign, t, refs)));
}

export async function taskView(ctx: Ctx, c: string, attr: string): Promise<TaskView> {
  const campaign = await readCampaign(ctx, c);
  const task = await readTask(ctx, c, attr);
  return view(ctx, campaign, task, await campaignBranches(ctx, campaign));
}
