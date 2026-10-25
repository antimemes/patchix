/** The files of the campaigns and of their state. See CLAUDE.md for the layout. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendFile, link, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import {
  ATTR,
  CAMPAIGN_NAME,
  CampaignSchema,
  FleetSchema,
  PrSchema,
  RUN_ID,
  RunSchema,
  SettingsSchema,
  TasksFileSchema,
  tipProblem,
  tipRun,
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
export const runMarker = (c: string, attr: string) => `run ${c} ${attr}`;
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
/** `question.md` of the task directory: the question of a person for the next run of the task. See `queueRun`. */
export const questionFile = (ctx: Ctx, c: string, attr: string) => join(taskDir(ctx, c, attr), "question.md");

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

/**
 * A `running` record without a live runner did not finish: this function gives it as `stopped`. It does not write
 * the file: only the runner writes its record.
 */
function liveRecord(run: Run, marker: string): Run {
  if (run.status !== "running" || (run.pid !== null && alive(run.pid, marker))) return run;
  return { ...run, status: "stopped", error: "the process stopped" };
}

/** The runs of a task, the newest first. */
export async function listRuns(ctx: Ctx, c: string, attr: string): Promise<Run[]> {
  const out: Run[] = [];
  const ids = (await readdir(join(taskDir(ctx, c, attr), "runs")).catch(() => [])).filter((id) => RUN_ID.test(id));
  for (const id of ids.sort().reverse()) {
    const run = await readYaml(join(runDir(ctx, c, attr, id), "run.yaml"), RunSchema);
    if (run !== null) out.push(liveRecord(run, runMarker(c, attr)));
  }
  return out;
}

export async function readRun(ctx: Ctx, c: string, attr: string, id: string): Promise<Run> {
  return (await readYaml(join(runDir(ctx, c, attr, id), "run.yaml"), RunSchema)) ?? fail(404, `no run ${id} of ${attr}`);
}

export async function writeRun(ctx: Ctx, c: string, run: Run): Promise<void> {
  await writeYaml(join(runDir(ctx, c, run.attr, run.id), "run.yaml"), RunSchema.parse(run));
}

/** The job of a task: its run that is `running`, or `null`. */
export async function taskJob(ctx: Ctx, c: string, attr: string): Promise<(JobStatus & { pid: number | null }) | null> {
  const run = (await listRuns(ctx, c, attr)).find((r) => r.status === "running");
  return run === undefined ? null : { attr, id: run.id, started: run.started, pid: run.pid };
}

/** The attributes of the task directories of the campaign, also of a task that the task list does not have. */
export async function taskDirs(ctx: Ctx, c: string): Promise<string[]> {
  return (await readdir(join(stateDir(ctx, c), "tasks")).catch(() => [])).filter((a) => ATTR.test(a)).sort();
}

/** The runs of the campaign that operate at this time. */
export async function jobs(ctx: Ctx, c: string): Promise<JobStatus[]> {
  const out: JobStatus[] = [];
  for (const attr of await taskDirs(ctx, c)) {
    const job = await taskJob(ctx, c, attr);
    if (job !== null) out.push({ attr: job.attr, id: job.id, started: job.started });
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

/**
 * Removes the task from the queue, and also its question: see `queueRun`. Gives `false` when the queue did not
 * have the task.
 */
export async function dequeue(ctx: Ctx, c: string, attr: string): Promise<boolean> {
  try {
    await unlink(join(queueDir(ctx, c), check(attr, ATTR, "an attribute")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  await rm(questionFile(ctx, c, attr), { force: true });
  return true;
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

/**
 * Adds the task to the queue for one run. With a question, it first writes the question into `question.md` of the task
 * directory: the next run of the task gets it. Without a question (an empty string), it removes a `question.md` without
 * an entry, if there is one: the run is a usual run. A task with a job or with an entry gives an error with status 409.
 * Thus one question waits for each task, and a question does not change the run that operates.
 */
export function queueRun(ctx: Ctx, c: string, attr: string, question = ""): Promise<void> {
  return serial(`queue:${c}`, async () => {
    if ((await taskJob(ctx, c, attr)) !== null) fail(409, `the task ${attr} has a job`);
    if ((await listQueue(ctx, c)).includes(attr)) fail(409, `the task ${attr} is in the queue`);
    const text = question.trim();
    if (text === "") await rm(questionFile(ctx, c, attr), { force: true });
    else await writeAtomic(questionFile(ctx, c, attr), `${text}\n`);
    await enqueue(ctx, c, attr);
  });
}

/**
 * Moves the question of the task into the directory of the run `id`, and gives its text. `null` when the task has no
 * question. The runner does this when the run starts, and the fleet does it for a run that did not start.
 */
export async function takeQuestion(ctx: Ctx, c: string, attr: string, id: string): Promise<string | null> {
  const to = join(runDir(ctx, c, attr, id), "question.md");
  try {
    await rename(questionFile(ctx, c, attr), to);
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
 * The state of a task. See `TaskStateSchema`. The runs are the newest first, and `tip` is the commit of the branch. The
 * pull request of the draft is first, then the issue entry when patchix has no draft, then the newest run. When the
 * newest run is `ok` or `unverified`, the checks of the tip give the state: see `tipRun`.
 */
export function taskState(task: Task, runs: readonly Run[], pr: Pr | null, tip: string | null): TaskState {
  if (pr !== null && pr.number !== null) return pr.state === "open" ? "pr" : pr.state;
  if (pr === null && (task.checked || task.pr !== null)) return "external";
  const status = runs[0]?.status;
  if (status === undefined) return "todo";
  if (status === "running" || status === "wontfix") return status;
  if (status === "failed" || status === "stopped") return "failed";
  const checked = tipRun(runs, tip);
  if (checked === undefined) return "unverified";
  if (tipProblem(checked) !== null) return "failed";
  return checked.checks.every((c) => c.status === "pass") ? "ready" : "unverified";
}

async function view(ctx: Ctx, campaign: Campaign, task: Task, refs: ReadonlyMap<string, string>): Promise<TaskView> {
  const runs = await listRuns(ctx, campaign.name, task.attr);
  const pr = await readPr(ctx, campaign.name, task.attr);
  const worktree = worktreePath(ctx, campaign, task.attr);
  const branch = branchOf(campaign, task);
  const head = refs.get(branch) ?? null;
  return {
    ...task,
    state: taskState(task, runs, pr, head),
    branch_name: branch,
    head,
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
