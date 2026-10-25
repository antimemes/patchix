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
  ImportInputSchema,
  JobInputSchema,
  PublishInputSchema,
  RunInputSchema,
  SettingsSchema,
  TaskStateSchema,
  type CampaignSummary,
  type CampaignView,
  type Label,
  type PublishError,
  type SettingsView,
  type TaskDetail,
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
  return { campaign, synced: (await fleet.readTasks(ctx, c))?.synced ?? null, tasks: await fleet.taskViews(ctx, c) };
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
 * The task with its draft. memelint examines the draft each time: the time of memelint is less than one second.
 * `git log` examines the commits of the branch each time, and `git status` the worktree.
 */
async function detail(ctx: fleet.Ctx, c: string, attr: string): Promise<TaskDetail> {
  const campaign = await fleet.readCampaign(ctx, c);
  const task = await fleet.taskView(ctx, c, attr);
  const lint = await fleet.lintDraft(ctx, c, attr).catch((e: unknown) => {
    console.error(`lint ${c}/${attr}: ${fleet.message(e)}`);
    return null;
  });
  // When `git` gives an error, the page shows the task without the branch. The pull request route reads the branch again and gives the error.
  const branch = await fleet.branchState(ctx, campaign, attr).catch((e: unknown): fleet.BranchState => {
    console.error(`branch ${c}/${attr}: ${fleet.message(e)}`);
    return { base: null, tip: null, commits: [], tipRun: undefined };
  });
  const rendered = await fleet.renderDraft(ctx, c, attr, branch);
  return {
    campaign,
    task,
    question: (await fleet.readText(fleet.questionFile(ctx, c, attr)))?.trim() ?? null,
    draft: await fleet.readDraft(ctx, c, attr),
    rendered: rendered?.text ?? null,
    mark_problems: rendered?.problems ?? [],
    lint,
    campaign_words: await fleet.campaignWords(ctx, c),
    publish_log: await fleet.readPublishLog(ctx, c, attr),
    commit_problems: fleet.commitProblems(branch.commits),
    clean: task.worktree === null || (await fleet.isClean(task.worktree).catch(() => false)),
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

export function app(ctx: fleet.Ctx): Hono {
  const api = new Hono();
  const events = hub(ctx);
  api.use(log);
  const p = (c: Context) => ({ c: c.req.param("c") ?? "", attr: c.req.param("attr") ?? "", id: c.req.param("id") ?? "" });
  const run = (c: Context, file: string) => join(fleet.runDir(ctx, p(c).c, p(c).attr, p(c).id), file);
  /** The labels of each repository and the time that `gh` gave them. */
  const labels = new Map<string, { at: number; list: Label[] }>();

  api.get("/api/campaigns", async (c) => c.json(await summaries(ctx)));
  api.get("/api/campaigns/:c", async (c) => c.json(await campaignView(ctx, p(c).c)));
  api.post("/api/campaigns/:c/sync", async (c) => {
    const result = await fleet.sync(ctx, p(c).c);
    for (const w of result.warnings) console.warn(`sync ${p(c).c}: ${w}`);
    return c.json(await campaignView(ctx, p(c).c));
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

  api.get("/api/campaigns/:c/tasks/:attr", async (c) => c.json(await detail(ctx, p(c).c, p(c).attr)));
  api.get("/api/campaigns/:c/tasks/:attr/runs/:id/log", (c) => text(c, run(c, "log.txt")));
  api.get("/api/campaigns/:c/tasks/:attr/runs/:id/prompt", (c) => text(c, run(c, "prompt.md")));
  api.get("/api/campaigns/:c/tasks/:attr/runs/:id/reply", (c) => text(c, run(c, "reply.md")));
  api.get("/api/campaigns/:c/tasks/:attr/runs/:id/description", (c) => text(c, run(c, "description.md")));
  api.get("/api/campaigns/:c/tasks/:attr/commits", async (c) => c.json(await fleet.branchCommits(ctx, await fleet.readCampaign(ctx, p(c).c), p(c).attr)));
  api.get("/api/campaigns/:c/tasks/:attr/diff", async (c) => c.text(await fleet.branchDiff(ctx, await fleet.readCampaign(ctx, p(c).c), p(c).attr)));
  api.get("/api/campaigns/:c/tasks/:attr/runs/:id/checks/:name", async (c) => {
    const check = (await fleet.readCampaign(ctx, p(c).c)).checks.find((x) => x.name === c.req.param("name"));
    if (check === undefined) fail(404, `the campaign ${p(c).c} has no check ${c.req.param("name")}`);
    return text(c, fleet.checkFile(fleet.runDir(ctx, p(c).c, p(c).attr, p(c).id), check.name));
  });

  api.get("/api/campaigns/:c/jobs", async (c) => {
    await fleet.readCampaign(ctx, p(c).c);
    return c.json(await fleet.jobsView(ctx, p(c).c));
  });
  // The runs start only from the queue: the fleet starts them.
  api.post("/api/campaigns/:c/jobs", async (c) => {
    const name = p(c).c;
    await fleet.readCampaign(ctx, name);
    const attrs = [...new Set((await body(c, JobInputSchema)).attrs)];
    for (const attr of attrs) await fleet.readTask(ctx, name, attr);
    const busy = new Set((await fleet.jobs(ctx, name)).map((j) => j.attr));
    // The times of the entries of one request are in the sequence of the request: thus the queue keeps that sequence.
    const start = Date.now();
    const free = attrs.filter((a) => !busy.has(a));
    for (const [i, attr] of free.entries()) await fleet.enqueue(ctx, name, attr, new Date(start + i).toISOString());
    await fleet.ensureFleet(ctx, name);
    return c.json(await fleet.jobsView(ctx, name), 202);
  });
  api.delete("/api/campaigns/:c/jobs/:attr", async (c) => {
    const { c: name, attr } = p(c);
    await fleet.readCampaign(ctx, name);
    if (!(await fleet.dequeue(ctx, name, attr))) {
      const job = await fleet.taskJob(ctx, name, attr);
      if (job === null) fail(404, `the task ${attr} has no entry in the queue and no job`);
      if (job.pid !== null) process.kill(job.pid, "SIGTERM");
    }
    return c.json(await fleet.jobsView(ctx, name));
  });
  api.delete("/api/campaigns/:c/queue", async (c) => {
    await fleet.readCampaign(ctx, p(c).c);
    await fleet.clearQueue(ctx, p(c).c);
    return c.json(await fleet.jobsView(ctx, p(c).c));
  });

  // One run of one task, with or without a question. The campaign page adds more tasks with `POST .../jobs`.
  api.post("/api/campaigns/:c/tasks/:attr/run", async (c) => {
    const { question } = await body(c, RunInputSchema, {});
    const { c: name, attr } = p(c);
    await fleet.readCampaign(ctx, name);
    await fleet.readTask(ctx, name, attr);
    await fleet.queueRun(ctx, name, attr, question);
    await fleet.ensureFleet(ctx, name);
    return c.json(await fleet.jobsView(ctx, name), 202);
  });

  api.put("/api/campaigns/:c/tasks/:attr/draft", async (c) => {
    await fleet.putDraft(ctx, p(c).c, p(c).attr, await body(c, DraftInputSchema));
    return c.json(await detail(ctx, p(c).c, p(c).attr));
  });
  api.post("/api/campaigns/:c/tasks/:attr/draft", async (c) => {
    await fleet.makeDraft(ctx, p(c).c, p(c).attr);
    return c.json(await detail(ctx, p(c).c, p(c).attr), 201);
  });
  api.post("/api/campaigns/:c/tasks/:attr/pr", async (c) => {
    try {
      // The person must set the tick box of the page. No body, a body that is not JSON and a different body give 409, not 400.
      const input = PublishInputSchema.safeParse(await c.req.json().catch(() => null));
      if (!input.success) fail(409, CONFIRM_ERROR);
      await fleet.createOrUpdatePr(ctx, p(c).c, p(c).attr, input.data);
    } catch (e) {
      return errorResponse(c, e, { publish_log: fleet.publishLogOf(e) } satisfies Omit<PublishError, "error">);
    }
    return c.json(await detail(ctx, p(c).c, p(c).attr));
  });
  // The page reads the file again and again while `POST .../pr` operates.
  api.get("/api/campaigns/:c/tasks/:attr/publish-log", async (c) => {
    const log = await fleet.readPublishLog(ctx, p(c).c, p(c).attr);
    if (log === null) fail(404, `the task ${p(c).attr} has no publish.log`);
    return c.text(log);
  });

  api.post("/api/campaigns/:c/tasks/:attr/worktree", async (c) => {
    const campaign = await fleet.readCampaign(ctx, p(c).c);
    await fleet.readTask(ctx, p(c).c, p(c).attr);
    const wt = await fleet.addWorktree(ctx, campaign, p(c).attr);
    return c.json({ path: wt.path, branch: wt.branch } satisfies Worktree);
  });
  api.delete("/api/campaigns/:c/tasks/:attr/worktree", async (c) => {
    const { c: name, attr } = p(c);
    const path = fleet.worktreePath(ctx, await fleet.readCampaign(ctx, name), attr);
    if (!(await fleet.exists(path))) fail(404, `the task ${attr} has no worktree`);
    if ((await fleet.taskJob(ctx, name, attr)) !== null) fail(409, `a job of ${attr} operates in the worktree`);
    if (!(await fleet.isClean(path))) fail(409, `the worktree ${path} has changes that are not committed`);
    await fleet.removeWorktree(ctx, path);
    return c.json(await detail(ctx, name, attr));
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
