/** A client without a server, for the stories. It keeps the data in memory and sends the events of the server. */
import { useState, type ReactNode } from "react";
import { tipProblem, tipRun } from "@patchix/common/status";
import type { Campaign, CampaignSummary, CampaignView, CommitProblems, JobStatus, JobsView, Label, SettingsView, TaskDetail, TaskView } from "@patchix/common";
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
  /** The question of each task for its next run. See `TaskDetail.question`. */
  questions?: Record<string, string>;
  drafts?: Record<string, string>;
  /** `publish.log` of each task. */
  publishLogs?: Record<string, string>;
  /** The commits of the branch of each task with a problem. See `TaskDetail.commit_problems`. */
  commitProblems?: Record<string, CommitProblems[]>;
  /**
   * The tasks with a different commit on the branch of the fork, for example an imported branch that a person changed.
   * The fork rejects a push without `force`. See `PublishInput.force`.
   */
  rejected?: string[];
  /** The tasks with a worktree with changes without a commit. See `TaskDetail.clean`. */
  dirty?: string[];
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
  /** The time before the mock fleet starts the jobs of the queue. The default is 1.5 seconds. */
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
  questions: Map<string, string>;
  drafts: Map<string, string>;
  publishLogs: Map<string, string>;
  commitProblems: Map<string, CommitProblems[]>;
  rejected: Set<string>;
  dirty: Set<string>;
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
      questions: new Map(Object.entries(m.questions ?? {})),
      drafts,
      publishLogs: new Map(Object.entries(m.publishLogs ?? {})),
      commitProblems: new Map(Object.entries(m.commitProblems ?? {})),
      rejected: new Set(m.rejected ?? []),
      dirty: new Set(m.dirty ?? []),
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

  /** As the server: each read of the task lints the draft and examines its marks. */
  function detail(s: State, attr: string): TaskDetail {
    const t = taskOf(s, attr);
    const draft = t.pr_meta === null ? null : (s.drafts.get(attr) ?? null);
    const rendered = draft === null || t.pr_meta === null ? null : f.fakeRender(draft, attr, t.pr_meta.number);
    const lint = draft === null ? null : f.fakeLint(draft);
    const marks = draft === null ? [] : f.fakeMarkProblems(draft, s.campaign);
    return { campaign: s.campaign, task: t, question: s.questions.get(attr) ?? null, draft, rendered, mark_problems: marks, lint, campaign_words: f.CAMPAIGN_WORDS, publish_log: s.publishLogs.get(attr) ?? null, commit_problems: s.commitProblems.get(attr) ?? [], clean: !s.dirty.has(attr) };
  }
  const view = (s: State): CampaignView => ({ campaign: s.campaign, synced: s.synced, tasks: s.tasks });
  /** The commits of the branch of the task: none without a tip or without a run with a base, as the server. */
  const branchOf = (t: TaskView) => (t.head === null || !t.runs.some((r) => r.base !== "") ? [] : f.commits(t.attr, t.head));

  /** As the runner: the run starts, and it gets the question of the task. */
  function launch(s: State, attr: string) {
    const t = taskOf(s, attr);
    const run = { ...f.runningRun(attr, 0), question: s.questions.get(attr) ?? null };
    s.questions.delete(attr);
    t.runs.unshift(run);
    t.state = "running";
    s.jobs.push({ attr, id: run.id, started: run.started });
  }

  /** As the fleet: it starts the runs of the queue while the number of jobs is less than the `concurrency` of the settings. */
  function fleetTick(s: State) {
    for (const attr of [...s.queue]) {
      if (s.jobs.length >= settings.concurrency) break;
      if (s.jobs.some((j) => j.attr === attr)) continue;
      s.queue = s.queue.filter((x) => x !== attr);
      launch(s, attr);
      changed(s, attr);
    }
    s.fleet = s.queue.length > 0;
    jobsChanged(s);
  }
  const later = (s: State) => setTimeout(() => fleetTick(s), options.fleetDelay ?? 1500);
  /** As `dequeue` of the server: it removes the entry and the question of the task. */
  const remove = (s: State, attr: string) => {
    s.queue = s.queue.filter((x) => x !== attr);
    s.questions.delete(attr);
    changed(s, attr);
  };

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
        if (file === "reply") return run.status === "running" ? fail(404, "the run has no such file") : run.question === null ? f.RUN_REPLY : f.REPLY;
        if (run.status === "wontfix") return file === "description" ? f.NO_FIX_DESCRIPTION : fail(404, "the run has no such file");
        // The agent writes the description of a run with a question only when the change makes the previous description incorrect.
        if (run.status === "running" || run.head === null || (file === "description" && run.question !== null)) fail(404, "the run has no such file");
        return f.description(attr);
      }),
    // As the server: the branch goes from the base of the newest run with a base to the tip. See `branchState`.
    commits: (c, attr) => answer("commits", () => branchOf(taskOf(state(c), attr))),
    diff: (c, attr) => answer("diff", () => (branchOf(taskOf(state(c), attr)).length === 0 ? "" : f.diff(attr))),
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
        for (const attr of s.queue) remove(s, attr);
        jobsChanged(s);
        later(s);
        return jobsView(s);
      }),
    stopJob: (c, attr) =>
      answer("stopJob", () => {
        const s = state(c);
        if (s.queue.includes(attr)) {
          remove(s, attr);
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
    startRun: (c, attr, input) =>
      answer("startRun", () => {
        const s = state(c);
        taskOf(s, attr);
        // As the server: the task goes into the queue, and a question waits for the next run of the task.
        if (s.jobs.some((j) => j.attr === attr)) fail(409, `the task ${attr} has a job`);
        if (s.queue.includes(attr)) fail(409, `the task ${attr} is in the queue`);
        const question = (input.question ?? "").trim();
        if (question === "") s.questions.delete(attr);
        else s.questions.set(attr, question);
        s.queue.push(attr);
        s.fleet = true;
        jobsChanged(s);
        changed(s, attr);
        later(s);
        return jobsView(s);
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
    makeDraft: (c, attr) =>
      answer("makeDraft", () => {
        const s = state(c);
        const t = taskOf(s, attr);
        // As the server: the newest run with a description that is not `wontfix`. A run of the mock with a head has a description.
        if (!t.runs.some((r) => r.head !== null && r.status !== "wontfix" && r.status !== "running")) fail(409, "no run of the task has a description.md");
        const fresh = f.prMeta(attr);
        t.pr_meta = t.pr_meta === null ? fresh : { ...t.pr_meta, title: fresh.title, words: fresh.words };
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
      const marks = f.fakeMarkProblems(s.drafts.get(attr) ?? "", s.campaign);
      if (marks.length > 0) fail(409, `the marks of the draft have problems: ${marks.join("; ")}`);
      const job = s.jobs.find((j) => j.attr === attr);
      if (job !== undefined) fail(409, `the task ${attr} has a job that operates: the run ${job.id}`);
      if (branchOf(t).length === 0) fail(409, `the branch of ${attr} has no commits after its base`);
      const tip = tipProblem(tipRun(t.runs, t.head));
      if (tip !== null) fail(409, tip);
      if (s.dirty.has(attr)) fail(409, `the worktree of ${attr} has changes without a commit: the branch does not have them`);
      const problems = s.commitProblems.get(attr) ?? [];
      if (problems.length > 0) fail(409, `the branch does not agree with the automation/AI policy of nixpkgs: ${problems.map((p) => `commit ${p.sha.slice(0, 12)}: ${p.problems.join(", ")}`).join("; ")}`);
      const number = meta.number ?? 580201;
      const force = input.force === true;
      // As the server: without `force`, the fork rejects the push, and no `gh` command starts.
      const rejected = s.rejected.has(attr) && !force;
      const log = typeof failedLog === "string" ? failedLog : rejected ? f.rejectedPublishLog(attr) : f.publishLog(attr, number, 0, force);
      for (const step of f.logSteps(log)) {
        s.publishLogs.set(attr, step);
        changed(s, attr);
        await sleep(LOG_STEP_MS);
      }
      if (failed !== null) throw failed;
      if (rejected) throw new ApiError(500, f.rejectedPushError(attr), { error: f.rejectedPushError(attr), publish_log: log });
      s.rejected.delete(attr);
      const now = new Date().toISOString();
      t.pr_meta = { ...meta, number, url: `https://github.com/${s.campaign.issue.repo}/pull/${number}`, created: meta.created ?? now, updated: now, pushed: t.head, confirmed: now };
      t.state = "pr";
      changed(s, attr);
      return structuredClone(detail(s, attr));
    },
    publishLog: (c, attr) => answer("publishLog", () => state(c).publishLogs.get(attr) ?? fail(404, `the task ${attr} has no publish.log`)),
    makeWorktree: (c, attr) =>
      answer("makeWorktree", () => {
        const s = state(c);
        const t = taskOf(s, attr);
        if (s.jobs.some((j) => j.attr === attr)) fail(409, `a run of ${attr} is in progress; its worktree goes away at its end`);
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
