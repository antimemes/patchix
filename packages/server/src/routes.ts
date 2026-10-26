/**
 * The routes of `packages/common/src/api.ts`. The server starts only the fleets in zellij, and the fleets start the
 * runs. The server does not write `run.yaml` or `fleet.yaml`.
 */
import { join } from "node:path";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  CONFIRM_ERROR,
  DraftInputSchema,
  FreeRunInputSchema,
  ImportInputSchema,
  JobInputSchema,
  LinkInputSchema,
  PublishInputSchema,
  RunInputSchema,
  SettingsSchema,
  TaskStateSchema,
  taskState,
  type BranchDetail,
  type CampaignSummary,
  type CampaignView,
  type Label,
  type PublishError,
  type SettingsView,
  type SyncView,
  type TaskState,
  type Worktree,
} from "@patchix/common";
import * as fleet from "@patchix/fleet";
import { fail } from "@patchix/fleet";
import { hub, PING_MS } from "./events.ts";
import { web } from "./static.ts";

interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } };
}

/**
 * The JSON body as `T`. A request without a body gives `empty` to the schema, when the route has an `empty` value. An
 * incorrect body gives an HTTP 400 error with the messages of zod.
 */
async function body<T>(c: Context, schema: Schema<T>, empty?: unknown): Promise<T> {
  let value: unknown;
  try {
    const raw = await c.req.text();
    value = raw === "" && empty !== undefined ? empty : JSON.parse(raw);
  } catch {
    fail(400, "the body is not JSON");
  }
  const result = schema.safeParse(value);
  if (!result.success) fail(400, result.error.issues.map((i) => `${["body", ...i.path.map(String)].join(".")}: ${i.message}`).join("; "));
  return result.data;
}

/** The time that the server keeps the labels of a repository. */
const LABELS_MS = 60 * 60_000;

/** One line for each request: the method, the path, the status and the time. */
const log: MiddlewareHandler = async (c, next) => {
  const start = performance.now();
  await next();
  console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${Math.round(performance.now() - start)} ms`);
};

async function campaignView(ctx: fleet.Ctx, c: string): Promise<CampaignView> {
  const campaign = await fleet.readCampaign(ctx, c);
  return { campaign, synced: (await fleet.readTasks(ctx, c))?.synced ?? null, ...(await fleet.campaignState(ctx, c)) };
}

async function summaries(ctx: fleet.Ctx): Promise<CampaignSummary[]> {
  const out: CampaignSummary[] = [];
  for (const name of await fleet.listCampaigns(ctx)) {
    const view = await campaignView(ctx, name);
    const counts = Object.fromEntries(TaskStateSchema.options.map((s) => [s, 0])) as Record<TaskState, number>;
    for (const t of view.tasks) counts[t.state]++;
    const { jobs, queue } = await fleet.jobsView(ctx, name);
    out.push({ name, title: view.campaign.title, issue: view.campaign.issue, synced: view.synced, counts, jobs: jobs.length, queued: queue.length });
  }
  return out;
}

/**
 * The branch with its entries and its draft. memelint examines the draft each time: the time of memelint is less than
 * one second. `git log` examines the commits of the branch each time, and `git status` the worktree.
 */
async function detail(ctx: fleet.Ctx, c: string, key: string): Promise<BranchDetail> {
  const campaign = await fleet.readCampaign(ctx, c);
  await fleet.needBranch(ctx, campaign, key);
  // The entries of the branch, and the entry of the key. The states of the entries use only their branches.
  const entries = ((await fleet.readTasks(ctx, c))?.tasks ?? []).filter((t) => t.branch === key || t.attr === key);
  const keys = [...new Set([key, ...entries.flatMap((t) => (t.branch === null ? [] : [t.branch]))])];
  const views = new Map(await Promise.all(keys.map(async (k) => [k, await fleet.branchView(ctx, c, k)] as const)));
  const branch = views.get(key) ?? (await fleet.branchView(ctx, c, key));
  const lint = await fleet.lintDraft(ctx, c, key).catch((e: unknown) => {
    console.error(`lint ${c}/${key}: ${fleet.message(e)}`);
    return null;
  });
  // When `git` gives an error, the page shows the branch without its commits. The pull request route reads the branch again and gives the error.
  const git = await fleet.branchGit(ctx, campaign, key).catch((e: unknown): fleet.BranchGit => {
    console.error(`branch ${c}/${key}: ${fleet.message(e)}`);
    return { base: null, tip: null, commits: [], runs: branch.runs };
  });
  const rendered = await fleet.renderDraft(ctx, c, key, git);
  const fork = await fleet.readFork(ctx, c, key);
  return {
    campaign,
    branch,
    tasks: entries.map((t) => ({ ...t, state: taskState(t, t.branch === null ? undefined : views.get(t.branch)) })),
    question: (await fleet.readText(fleet.questionFile(ctx, c, key)))?.trim() ?? null,
    draft: await fleet.readDraft(ctx, c, key),
    rendered: rendered?.text ?? null,
    mark_problems: rendered?.problems ?? [],
    lint,
    campaign_words: await fleet.campaignWords(ctx, c),
    publish_log: await fleet.readPublishLog(ctx, c, key),
    commit_problems: fleet.commitProblems(git.commits),
    clean: branch.worktree === null || (await fleet.isClean(branch.worktree).catch(() => false)),
    diverged: fork === null || branch.head === null || fork.sha === branch.head ? null : { key, local: branch.head, fork: fork.sha },
  };
}

/** The JSON body of an error, with the status of the error. An error without a status is a 500 error, and the server log gets it. */
function errorResponse(c: Context, error: unknown, extra: Record<string, unknown> = {}): Response {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 600) return c.json({ error: fleet.message(error), ...extra }, status as ContentfulStatusCode);
  console.error(error);
  return c.json({ error: fleet.message(error) || String(error), ...extra }, 500);
}

/** A text file, as `text/plain`. */
async function text(c: Context, path: string): Promise<Response> {
  const content = await fleet.readText(path);
  if (content === null) fail(404, "no such file");
  return c.text(content);
}

/**
 * The settings, the fork that patchix uses and the state of `GH_TOKEN`. When the settings have no fork and `gh` gives
 * an error, `fork_effective` is `null` and the server log gets the error.
 */
async function settingsView(ctx: fleet.Ctx): Promise<SettingsView> {
  const settings = await fleet.readSettings(ctx);
  const fork =
    settings.fork ??
    (await fleet.ghLogin().catch((e: unknown) => {
      console.error(`gh api user: ${fleet.message(e)}`);
      return null;
    }));
  return { ...settings, fork_effective: fork, token: (process.env["GH_TOKEN"] ?? "") !== "", data: ctx.data };
}

/** Adds the branch to the queue for one run, with the question, and starts the fleet. See `queueRun`. */
async function queue(ctx: fleet.Ctx, c: string, key: string, question: string, mode: fleet.QueueMode = "run") {
  await fleet.queueRun(ctx, c, key, question, mode);
  await fleet.ensureFleet(ctx, c);
  return fleet.jobsView(ctx, c);
}

export function app(ctx: fleet.Ctx): Hono {
  const api = new Hono();
  const events = hub(ctx);
  api.use(log);
  const p = (c: Context) => ({ c: c.req.param("c") ?? "", key: c.req.param("key") ?? "", id: c.req.param("id") ?? "" });
  const run = (c: Context, file: string) => join(fleet.runDir(ctx, p(c).c, p(c).key, p(c).id), file);
  /** The labels of each repository and the time that `gh` gave them. */
  const labels = new Map<string, { at: number; list: Label[] }>();
  const branch = "/api/campaigns/:c/branches/:key";

  api.get("/api/campaigns", async (c) => c.json(await summaries(ctx)));
  api.get("/api/campaigns/:c", async (c) => c.json(await campaignView(ctx, p(c).c)));
  api.post("/api/campaigns/:c/sync", async (c) => {
    const result = await fleet.sync(ctx, p(c).c);
    const campaign = await fleet.readCampaign(ctx, p(c).c);
    for (const d of result.diverged) console.warn(`sync ${p(c).c}: ${fleet.divergedText(campaign, d)}`);
    for (const w of result.warnings) console.warn(`sync ${p(c).c}: ${w}`);
    // The sync adds check-only runs to the queue: the fleet starts them.
    if (result.queued > 0) await fleet.ensureFleet(ctx, p(c).c);
    return c.json({ ...(await campaignView(ctx, p(c).c)), result } satisfies SyncView);
  });

  api.post("/api/campaigns/:c/refresh", async (c) => {
    const changed = await fleet.refreshPrs(ctx, await fleet.readCampaign(ctx, p(c).c));
    console.log(`refresh ${p(c).c}: ${changed.length} drafts changed${changed.length === 0 ? "" : `: ${changed.join(" ")}`}`);
    return c.json(await campaignView(ctx, p(c).c));
  });

  api.post("/api/campaigns/:c/base", async (c) => {
    await fleet.updateBase(ctx, await fleet.readCampaign(ctx, p(c).c));
    return c.json(await campaignView(ctx, p(c).c));
  });

  api.post("/api/campaigns/:c/import", async (c) => {
    const { url, descriptions } = await body(c, ImportInputSchema);
    const result = await fleet.importBranches(ctx, p(c).c, url, descriptions);
    console.log(`import ${p(c).c}: ${result.imported.length} branches, unmatched: ${[...result.unmatched_branches, ...result.unmatched_files].join(" ") || "none"}`);
    return c.json(await campaignView(ctx, p(c).c));
  });

  api.get("/api/campaigns/:c/labels", async (c) => {
    const { repo } = (await fleet.readCampaign(ctx, p(c).c)).issue;
    const kept = labels.get(repo);
    if (kept !== undefined && Date.now() - kept.at < LABELS_MS) return c.json(kept.list);
    const list = await fleet.labelList(repo).catch((e: unknown) => fail(502, `gh label list: ${fleet.message(e)}`));
    labels.set(repo, { at: Date.now(), list });
    return c.json(list);
  });

  // The entries of the task list: the branch of an entry, and the link of an entry.
  api.get("/api/campaigns/:c/tasks/:attr", async (c) => {
    const name = p(c).c;
    await fleet.readCampaign(ctx, name);
    const task = await fleet.readTask(ctx, name, c.req.param("attr"));
    if (task.branch === null) fail(404, `no branch covers the entry ${task.attr}`);
    return c.json(await detail(ctx, name, task.branch));
  });
  api.put("/api/campaigns/:c/tasks/:attr/branch", async (c) => {
    const name = p(c).c;
    const campaign = await fleet.readCampaign(ctx, name);
    const attr = c.req.param("attr");
    const { key } = await body(c, LinkInputSchema);
    await fleet.readTask(ctx, name, attr);
    if (key !== null) await fleet.needBranch(ctx, campaign, key);
    await fleet.updateTasks(ctx, name, (file) => (file === null ? null : { ...file, tasks: file.tasks.map((t) => (t.attr === attr ? { ...t, branch: key } : t)) }));
    return c.json(await campaignView(ctx, name));
  });

  api.get(branch, async (c) => c.json(await detail(ctx, p(c).c, p(c).key)));
  api.get(`${branch}/runs/:id/log`, (c) => text(c, run(c, "log.txt")));
  api.get(`${branch}/runs/:id/prompt`, (c) => text(c, run(c, "prompt.md")));
  api.get(`${branch}/runs/:id/reply`, (c) => text(c, run(c, "reply.md")));
  api.get(`${branch}/runs/:id/description`, (c) => text(c, run(c, "description.md")));
  api.get(`${branch}/runs/:id/attrs`, (c) => text(c, run(c, "attrs.txt")));
  api.get(`${branch}/commits`, async (c) => c.json(await fleet.branchCommits(ctx, await fleet.readCampaign(ctx, p(c).c), p(c).key)));
  api.get(`${branch}/diff`, async (c) => c.text(await fleet.branchDiff(ctx, await fleet.readCampaign(ctx, p(c).c), p(c).key)));
  api.get(`${branch}/runs/:id/checks/:attr/:name`, async (c) => {
    const check = (await fleet.readCampaign(ctx, p(c).c)).checks.find((x) => x.name === c.req.param("name"));
    if (check === undefined) fail(404, `the campaign ${p(c).c} has no check ${c.req.param("name")}`);
    const output = await fleet.readCheck(fleet.runDir(ctx, p(c).c, p(c).key, p(c).id), c.req.param("attr"), check.name);
    if (output === null) fail(404, "no such file");
    return c.text(output);
  });

  api.get("/api/campaigns/:c/jobs", async (c) => {
    await fleet.readCampaign(ctx, p(c).c);
    return c.json(await fleet.jobsView(ctx, p(c).c));
  });
  // The runs start only from the queue: the fleet starts them.
  api.post("/api/campaigns/:c/jobs", async (c) => {
    const name = p(c).c;
    const campaign = await fleet.readCampaign(ctx, name);
    const keys = [...new Set((await body(c, JobInputSchema)).keys)];
    for (const key of keys) await fleet.needBranch(ctx, campaign, key);
    const busy = new Set((await fleet.jobs(ctx, name)).map((j) => j.key));
    // The times of the entries of one request are in the sequence of the request: thus the queue keeps that sequence.
    const start = Date.now();
    const free = keys.filter((k) => !busy.has(k));
    for (const [i, key] of free.entries()) await fleet.enqueue(ctx, name, key, new Date(start + i).toISOString());
    await fleet.ensureFleet(ctx, name);
    return c.json(await fleet.jobsView(ctx, name), 202);
  });
  api.delete("/api/campaigns/:c/jobs/:key", async (c) => {
    const { c: name, key } = p(c);
    await fleet.readCampaign(ctx, name);
    if (!(await fleet.dequeue(ctx, name, key))) {
      const job = await fleet.branchJob(ctx, name, key);
      if (job === null) fail(404, `the branch ${key} has no entry in the queue and no job`);
      if (job.pid !== null) process.kill(job.pid, "SIGTERM");
    }
    return c.json(await fleet.jobsView(ctx, name));
  });
  api.delete("/api/campaigns/:c/queue", async (c) => {
    await fleet.readCampaign(ctx, p(c).c);
    await fleet.clearQueue(ctx, p(c).c);
    return c.json(await fleet.jobsView(ctx, p(c).c));
  });

  // One run of one branch, with or without a question. The campaign page adds more branches with `POST .../jobs`.
  api.post(`${branch}/run`, async (c) => {
    const { question } = await body(c, RunInputSchema, {});
    const { c: name, key } = p(c);
    await fleet.needBranch(ctx, await fleet.readCampaign(ctx, name), key);
    return c.json(await queue(ctx, name, key, question), 202);
  });
  // A check-only run of one branch: the checks of the tip, without the agent.
  api.post(`${branch}/check`, async (c) => {
    const { c: name, key } = p(c);
    await fleet.needBranch(ctx, await fleet.readCampaign(ctx, name), key);
    return c.json(await queue(ctx, name, key, "", "check"), 202);
  });
  // A run on a key of the body. A key that is not there makes a new branch: its text is the work of the run.
  api.post("/api/campaigns/:c/run", async (c) => {
    const { key, question } = await body(c, FreeRunInputSchema);
    const name = p(c).c;
    const campaign = await fleet.readCampaign(ctx, name);
    if (!(await fleet.branchExists(ctx, campaign, key)) && question === "") fail(400, `the branch ${key} is not there: a free-text run must have a text`);
    return c.json(await queue(ctx, name, key, question), 202);
  });

  api.put(`${branch}/draft`, async (c) => {
    await fleet.putDraft(ctx, p(c).c, p(c).key, await body(c, DraftInputSchema));
    return c.json(await detail(ctx, p(c).c, p(c).key));
  });
  api.post(`${branch}/draft`, async (c) => {
    await fleet.makeDraft(ctx, p(c).c, p(c).key);
    return c.json(await detail(ctx, p(c).c, p(c).key), 201);
  });
  api.post(`${branch}/pr`, async (c) => {
    try {
      // The person must set the tick box of the page. No body, a body that is not JSON and a different body give 409, not 400.
      const input = PublishInputSchema.safeParse(await c.req.json().catch(() => null));
      if (!input.success) fail(409, CONFIRM_ERROR);
      await fleet.createOrUpdatePr(ctx, p(c).c, p(c).key, input.data);
    } catch (e) {
      return errorResponse(c, e, { publish_log: fleet.publishLogOf(e) } satisfies Omit<PublishError, "error">);
    }
    return c.json(await detail(ctx, p(c).c, p(c).key));
  });
  // The page reads the file again and again while `POST .../pr` operates.
  api.get(`${branch}/publish-log`, async (c) => {
    const log = await fleet.readPublishLog(ctx, p(c).c, p(c).key);
    if (log === null) fail(404, `the branch ${p(c).key} has no publish.log`);
    return c.text(log);
  });

  // The commit of the fork replaces the local branch: see `adoptBranch`. The Adopt button of the page asks the person first.
  api.post(`${branch}/adopt`, async (c) => {
    const { c: name, key } = p(c);
    await fleet.needBranch(ctx, await fleet.readCampaign(ctx, name), key);
    const result = await fleet.adoptBranch(ctx, name, key);
    for (const w of result.warnings) console.warn(`adopt ${name}/${key}: ${w}`);
    console.log(`adopt ${name}/${key}: ${result.tip ?? ""}${result.made ? ", run made" : ""}${result.draft ? ", draft made" : ""}`);
    return c.json(await detail(ctx, name, key));
  });

  api.post(`${branch}/worktree`, async (c) => {
    const campaign = await fleet.readCampaign(ctx, p(c).c);
    await fleet.needBranch(ctx, campaign, p(c).key);
    const wt = await fleet.addWorktree(ctx, campaign, p(c).key);
    return c.json({ path: wt.path, branch: wt.branch } satisfies Worktree);
  });
  api.delete(`${branch}/worktree`, async (c) => {
    const { c: name, key } = p(c);
    const path = fleet.worktreePath(ctx, await fleet.readCampaign(ctx, name), key);
    if (!(await fleet.exists(path))) fail(404, `the branch ${key} has no worktree`);
    if ((await fleet.branchJob(ctx, name, key)) !== null) fail(409, `a job of ${key} operates in the worktree`);
    if (!(await fleet.isClean(path))) fail(409, `the worktree ${path} has changes that are not committed`);
    await fleet.removeWorktree(ctx, path);
    return c.json(await detail(ctx, name, key));
  });

  api.get("/api/settings", async (c) => c.json(await settingsView(ctx)));
  api.put("/api/settings", async (c) => {
    await fleet.writeSettings(ctx, await body(c, SettingsSchema));
    return c.json(await settingsView(ctx));
  });

  api.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const off = events.connect((event) => void stream.writeSSE({ data: JSON.stringify(event) }).catch(() => undefined));
      const ping = setInterval(() => void stream.write(": ping\n\n").catch(() => undefined), PING_MS);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(ping);
      off();
    }),
  );

  api.all("/api/*", (c) => fail(404, `no route ${c.req.method} ${c.req.path}`));
  api.get("*", web(ctx.root));
  api.notFound((c) => c.json({ error: `no route ${c.req.method} ${c.req.path}` }, 404));
  api.onError((error, c) => errorResponse(c, error));
  return api;
}
