/** A client without a server, for the stories. It keeps the data in memory and sends the events of the server. */
import { useState, type ReactNode } from "react";
import { publishable } from "@patchix/common/status";
import type { Ask, Campaign, CampaignSummary, CampaignView, JobStatus, JobsView, Label, SettingsView, TaskDetail, TaskView } from "@patchix/common";
import { ApiError, type Client, type Signal } from "../api.ts";
import { ClientProvider } from "../client.tsx";
import * as f from "./fixtures.ts";

export interface MockCampaign {
  campaign: Campaign;
  synced: string | null;
  tasks: TaskView[];
  jobs?: JobStatus[];
  /** The attributes of the queue, the first entry first. */
  queue?: string[];
  /** A fleet operates. The default: the queue has entries. */
  fleet?: boolean;
  asks?: Record<string, Ask[]>;
  drafts?: Record<string, string>;
  /** `publish.log` of each task. */
  publishLogs?: Record<string, string>;
  /** The labels of the issue repository. The default is `LABELS`. */
  labels?: Label[];
}

export interface MockOptions {
  campaigns: MockCampaign[];
  /** The settings of the server. The default is `SETTINGS`. */
  settings?: SettingsView;
  /** The status, the message and the other fields of the error body of a method. */
  fail?: Partial<Record<keyof Client, readonly [number, string, Record<string, unknown>?]>>;
  delay?: number;
  hang?: boolean;
  /** The time before the mock fleet starts the runs of the queue. The default is 1.5 seconds. */
  fleetDelay?: number;
}

/** The time between two steps of the log of `createPr`. The log has 6 steps: the request operates for approximately 2 seconds. */
const LOG_STEP_MS = 350;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface State {
  campaign: Campaign;
  synced: string | null;
  tasks: TaskView[];
  jobs: JobStatus[];
  queue: string[];
  fleet: boolean;
  asks: Map<string, Ask[]>;
  drafts: Map<string, string>;
  publishLogs: Map<string, string>;
  labels: Label[];
}

export function mockClient(options: MockOptions): Client {
  const states = new Map<string, State>();
  for (const m of options.campaigns) {
    const drafts = new Map(Object.entries(m.drafts ?? {}));
    for (const t of m.tasks) if (t.pr_meta !== null && !drafts.has(t.attr)) drafts.set(t.attr, f.description(t.attr));
    states.set(m.campaign.name, {
      campaign: m.campaign,
      synced: m.synced,
      tasks: m.tasks.map((t) => structuredClone(t)),
      jobs: [...(m.jobs ?? [])],
      queue: [...(m.queue ?? [])],
      fleet: m.fleet ?? (m.queue ?? []).length > 0,
      asks: new Map(Object.entries(m.asks ?? {})),
      drafts,
      publishLogs: new Map(Object.entries(m.publishLogs ?? {})),
      labels: m.labels ?? f.LABELS,
    });
  }
  let settings: SettingsView = options.settings ?? f.SETTINGS;
  /** The gh login of the mock: the fork when the settings have no fork. */
  const login = settings.fork === null ? settings.fork_effective : "someone";
  const listeners = new Set<(signal: Signal) => void>();
  const emit = (signal: Signal) => setTimeout(() => listeners.forEach((l) => l(signal)), 0);

  async function answer<T>(method: keyof Client, fn: () => T): Promise<T> {
    if (options.hang) return new Promise<T>(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, options.delay ?? 150));
    const failure = options.fail?.[method];
    if (failure !== undefined) throw new ApiError(failure[0], failure[1], { error: failure[1], ...failure[2] });
    return structuredClone(fn());
  }
  const fail = (status: number, message: string): never => {
    throw new ApiError(status, message);
  };
  const state = (c: string): State => states.get(c) ?? fail(404, `no campaign ${c}`);
  const taskOf = (s: State, attr: string): TaskView => s.tasks.find((t) => t.attr === attr) ?? fail(404, `the campaign ${s.campaign.name} has no task ${attr}`);

  const changed = (s: State, attr: string | null) => emit({ type: "campaign", campaign: s.campaign.name, attr });
  const jobsView = (s: State): JobsView => ({ jobs: s.jobs, queue: s.queue, fleet: s.fleet });
  const jobsChanged = (s: State) => emit({ type: "jobs", campaign: s.campaign.name, ...structuredClone(jobsView(s)) });

  /** As the server: each read of the task lints the draft. */
  function detail(s: State, attr: string): TaskDetail {
    const t = taskOf(s, attr);
    const draft = t.pr_meta === null ? null : (s.drafts.get(attr) ?? null);
    const rendered = draft === null || t.pr_meta === null ? null : f.fakeRender(draft, attr, t.pr_meta.number);
    const lint = draft === null ? null : f.fakeLint(draft);
    return { campaign: s.campaign, task: t, asks: s.asks.get(attr) ?? [], draft, rendered, lint, campaign_words: f.CAMPAIGN_WORDS, publish_log: s.publishLogs.get(attr) ?? null };
  }
  const view = (s: State): CampaignView => ({ campaign: s.campaign, synced: s.synced, tasks: s.tasks });

  function startRun(s: State, attr: string) {
    const t = taskOf(s, attr);
    const run = f.runningRun(attr, 0);
    t.runs.unshift(run);
    t.state = "running";
    s.jobs.push({ attr, kind: "run", id: run.id, started: run.started });
  }

  /** As the fleet: it starts the runs of the queue while the number of jobs is less than the `concurrency` of the settings. */
  function fleetTick(s: State) {
    for (const attr of [...s.queue]) {
      if (s.jobs.length >= settings.concurrency) break;
      if (s.jobs.some((j) => j.attr === attr)) continue;
      s.queue = s.queue.filter((a) => a !== attr);
      startRun(s, attr);
      changed(s, attr);
    }
    s.fleet = s.queue.length > 0;
    jobsChanged(s);
  }
  const later = (s: State) => setTimeout(() => fleetTick(s), options.fleetDelay ?? 1500);

  return {
    campaigns: () =>
      answer("campaigns", (): CampaignSummary[] =>
        [...states.values()].map((s) => ({ name: s.campaign.name, title: s.campaign.title, issue: s.campaign.issue, synced: s.synced, counts: f.count(s.tasks), jobs: s.jobs.length, queued: s.queue.length })),
      ),
    campaign: (c) => answer("campaign", () => view(state(c))),
    sync: (c) =>
      answer("sync", () => {
        const s = state(c);
        s.synced = new Date().toISOString();
        return view(s);
      }),
    refresh: (c) => answer("refresh", () => view(state(c))),
    fetchBase: (c) => answer("fetchBase", () => view(state(c))),
    labels: (c) => answer("labels", () => state(c).labels),
    task: (c, attr) => answer("task", () => detail(state(c), attr)),
    runFile: (c, attr, id, file) =>
      answer("runFile", () => {
        const t = taskOf(state(c), attr);
        const run = t.runs.find((r) => r.id === id) ?? fail(404, `no run ${id}`);
        if (file === "prompt") return f.runPrompt(attr);
        if (run.status === "wontfix") return file === "description" ? f.NO_FIX_DESCRIPTION : fail(404, "the run has no such file");
        if (run.status === "running" || run.head === null) fail(404, "the run has no such file");
        return file === "diff" ? f.diff(attr) : f.description(attr);
      }),
    commits: (c, attr, id) =>
      answer("commits", () => {
        const run = taskOf(state(c), attr).runs.find((r) => r.id === id) ?? fail(404, `no run ${id}`);
        return run.head === null ? [] : f.commits(attr);
      }),
    checkOutput: (c, attr, id, check) =>
      answer("checkOutput", () => {
        const run = taskOf(state(c), attr).runs.find((r) => r.id === id) ?? fail(404, `no run ${id}`);
        const result = run.checks.find((x) => x.name === check) ?? fail(404, "the run has no such file");
        if (check !== "harness") return f.BUILD_OUTPUT;
        return result.status === "error" ? f.harnessError(attr) : f.harnessOutput(attr, result.status === "pass");
      }),
    jobs: (c) => answer("jobs", () => jobsView(state(c))),
    queueRuns: (c, input) =>
      answer("queueRuns", () => {
        const s = state(c);
        for (const a of input.attrs) taskOf(s, a);
        for (const a of input.attrs) if (!s.jobs.some((j) => j.attr === a) && !s.queue.includes(a)) s.queue.push(a);
        s.fleet ||= s.queue.length > 0;
        jobsChanged(s);
        later(s);
        return jobsView(s);
      }),
    clearQueue: (c) =>
      answer("clearQueue", () => {
        const s = state(c);
        s.queue = [];
        jobsChanged(s);
        later(s);
        return jobsView(s);
      }),
    stopJob: (c, attr) =>
      answer("stopJob", () => {
        const s = state(c);
        if (s.queue.includes(attr)) {
          s.queue = s.queue.filter((a) => a !== attr);
          jobsChanged(s);
          return jobsView(s);
        }
        if (!s.jobs.some((j) => j.attr === attr)) fail(404, `the task ${attr} has no entry in the queue and no job`);
        s.jobs = s.jobs.filter((j) => j.attr !== attr);
        const t = taskOf(s, attr);
        const run = t.runs[0];
        if (run !== undefined && run.status === "running") {
          run.status = "stopped";
          run.finished = new Date().toISOString();
          run.error = "a person stopped the run";
          t.state = "failed";
        }
        jobsChanged(s);
        changed(s, attr);
        if (s.queue.length > 0) later(s);
        return jobsView(s);
      }),
    ask: (c, attr, input) =>
      answer("ask", () => {
        const s = state(c);
        const t = taskOf(s, attr);
        const created = f.ask(attr, 0, { question: input.question, status: "running", finished: null, pid: 51234 });
        s.asks.set(attr, [created, ...(s.asks.get(attr) ?? [])]);
        s.jobs.push({ attr, kind: "ask", id: created.id, started: created.started });
        t.worktree ??= f.worktreePath(attr);
        jobsChanged(s);
        changed(s, attr);
        setTimeout(() => {
          created.status = "ok";
          created.finished = new Date().toISOString();
          created.pid = null;
          created.files = ["pkgs/development/python-modules/wassima/default.nix"];
          s.jobs = s.jobs.filter((j) => j.id !== created.id);
          jobsChanged(s);
          changed(s, attr);
          if (s.queue.length > 0) later(s);
        }, 4000);
        return created;
      }),
    askFile: (c, attr, id, file) =>
      answer("askFile", () => {
        const a = state(c).asks.get(attr)?.find((x) => x.id === id) ?? fail(404, `no ask ${id}`);
        if (file === "prompt") return f.askPrompt(attr, a.question);
        return file === "reply" ? f.REPLY : f.ASK_DIFF;
      }),
    saveDraft: (c, attr, input) =>
      answer("saveDraft", () => {
        const s = state(c);
        const t = taskOf(s, attr);
        if (t.pr_meta === null) fail(404, `the task ${attr} has no draft`);
        else t.pr_meta = { ...t.pr_meta, title: input.title, labels: input.labels, words: input.words };
        s.drafts.set(attr, input.description);
        changed(s, attr);
        return detail(s, attr);
      }),
    draftFromRun: (c, attr, input) =>
      answer("draftFromRun", () => {
        const s = state(c);
        const t = taskOf(s, attr);
        const run = t.runs.find((r) => r.id === input.run) ?? fail(404, `no run ${input.run}`);
        if (!publishable(run)) fail(400, `the run ${run.id} is ${run.status}, not ok or unverified`);
        const old = t.pr_meta;
        t.pr_meta = f.prMeta(attr, run.id, old === null ? {} : { number: old.number, url: old.url, created: old.created, pushed: old.pushed, updated: old.updated, state: old.state, merged: old.merged, confirmed: old.confirmed });
        s.drafts.set(attr, f.roughDescription(attr));
        changed(s, attr);
        return detail(s, attr);
      }),
    // As the server: the log becomes longer in steps, and the request gives its result after the last step. See `createOrUpdatePr`.
    createPr: async (c, attr, input) => {
      if (options.hang) return new Promise<TaskDetail>(() => undefined);
      await sleep(options.delay ?? 150);
      const failure = options.fail?.createPr;
      const failed = failure === undefined ? null : new ApiError(failure[0], failure[1], { error: failure[1], ...failure[2] });
      const failedLog = failure?.[2]?.["publish_log"];
      // An error without a log occurs before the first command.
      if (failed !== null && typeof failedLog !== "string") throw failed;
      // As the server: see `CONFIRM_ERROR` in `packages/common/src/api.ts`.
      if (input.confirmed !== true) fail(409, "confirm that you established confidence in this output");
      const s = state(c);
      const t = taskOf(s, attr);
      const meta = t.pr_meta ?? fail(400, `the task ${attr} has no draft`);
      if (meta.number !== null && meta.state !== "open") fail(409, `the pull request #${meta.number} is ${meta.state}`);
      const job = s.jobs.find((j) => j.attr === attr);
      if (job !== undefined) fail(409, `the task ${attr} has a job that operates: the ${job.kind} ${job.id}`);
      const findings = f.fakeLint(s.drafts.get(attr) ?? "").findings.length;
      if (findings > 0) fail(409, `the draft has ${findings} memelint findings`);
      const run = t.runs[0];
      if (!publishable(run)) fail(409, `the newest run of ${attr} is not ok or unverified`);
      const number = meta.number ?? 580201;
      for (const step of f.logSteps(typeof failedLog === "string" ? failedLog : f.publishLog(attr, number))) {
        s.publishLogs.set(attr, step);
        changed(s, attr);
        await sleep(LOG_STEP_MS);
      }
      if (failed !== null) throw failed;
      const now = new Date().toISOString();
      t.pr_meta = { ...meta, number, url: `https://github.com/${s.campaign.issue.repo}/pull/${number}`, created: meta.created ?? now, updated: now, pushed: run?.head ?? null, confirmed: now };
      t.state = "pr";
      t.worktree = null;
      changed(s, attr);
      return structuredClone(detail(s, attr));
    },
    publishLog: (c, attr) => answer("publishLog", () => state(c).publishLogs.get(attr) ?? fail(404, `the task ${attr} has no publish.log`)),
    makeWorktree: (c, attr) =>
      answer("makeWorktree", () => {
        const s = state(c);
        const t = taskOf(s, attr);
        if (s.jobs.some((j) => j.attr === attr && j.kind === "run")) fail(409, `a run of ${attr} is in progress; its worktree goes away at its end`);
        t.worktree = f.worktreePath(attr);
        t.head ??= f.HEAD;
        changed(s, attr);
        return { path: t.worktree, branch: t.branch_name };
      }),
    removeWorktree: (c, attr) =>
      answer("removeWorktree", () => {
        const s = state(c);
        taskOf(s, attr).worktree = null;
        changed(s, attr);
        return detail(s, attr);
      }),
    settings: () => answer("settings", () => settings),
    saveSettings: (input) =>
      answer("saveSettings", () => {
        if (!Number.isInteger(input.concurrency) || input.concurrency < 1) fail(400, "body.concurrency: Too small: expected number to be >=1");
        settings = { ...settings, ...input, fork_effective: input.fork ?? login };
        return settings;
      }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function MockProvider({ seed, children }: { seed: () => MockOptions; children: ReactNode }) {
  const [client] = useState(() => mockClient(seed()));
  return <ClientProvider client={client}>{children}</ClientProvider>;
}

/** Each story gets a new mock client with the data of `seed`. */
export function withMock(seed: () => MockOptions) {
  return (Story: () => ReactNode) => <MockProvider seed={seed}>{Story()}</MockProvider>;
}
