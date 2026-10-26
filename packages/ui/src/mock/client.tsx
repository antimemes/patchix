/** A client without a server, for the stories. It keeps the data in memory and sends the events of the server. */
import { useState, type ReactNode } from "react";
import { branchState, taskState, tipChecks, tipProblem } from "@patchix/common/status";
import type { BranchDetail, BranchView, Campaign, CampaignSummary, CampaignView, CommitProblems, Diverged, JobStatus, JobsView, Label, SettingsView, Task, TaskView } from "@patchix/common";
import { ApiError, type Client, type Signal } from "../api.ts";
import { ClientProvider } from "../client.tsx";
import * as f from "./fixtures.ts";

export interface MockCampaign {
  campaign: Campaign;
  synced: string | null;
  /** The entries of the task list. The mock gives each its state: see `taskState`. */
  tasks: Task[];
  /** The branches. The mock gives each its state and its entries: see `branchState`. */
  branches?: BranchView[];
  jobs?: JobStatus[];
  /** The keys of the queue, the first entry first. */
  queue?: string[];
  /** The keys of `queue` that wait for a check-only run. */
  check?: string[];
  /** A fleet operates. The default: the queue has entries. */
  fleet?: boolean;
  /** The question of each branch for its next run. See `BranchDetail.question`. */
  questions?: Record<string, string>;
  drafts?: Record<string, string>;
  /** `publish.log` of each branch. */
  publishLogs?: Record<string, string>;
  /** The commits of each branch with a problem. See `BranchDetail.commit_problems`. */
  commitProblems?: Record<string, CommitProblems[]>;
  /**
   * The branches with a different commit on the branch of the fork, for example an imported branch that a person
   * changed. The fork rejects a push without `force`. See `PublishInput.force`.
   */
  rejected?: string[];
  /** The branches with a worktree with changes without a commit. See `BranchDetail.clean`. */
  dirty?: string[];
  /**
   * The commit of each branch on the fork, as `fork.yaml` of the server. The sync gives a branch with a different
   * `head` in `SyncResult.diverged`, and the branch page shows it. See `Diverged`.
   */
  forks?: Record<string, string>;
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
  tasks: Task[];
  branches: BranchView[];
  jobs: JobStatus[];
  queue: string[];
  check: Set<string>;
  fleet: boolean;
  questions: Map<string, string>;
  drafts: Map<string, string>;
  publishLogs: Map<string, string>;
  commitProblems: Map<string, CommitProblems[]>;
  rejected: Set<string>;
  dirty: Set<string>;
  forks: Map<string, string>;
  labels: Label[];
}

export function mockClient(options: MockOptions): Client {
  const states = new Map<string, State>();
  for (const m of options.campaigns) {
    const drafts = new Map(Object.entries(m.drafts ?? {}));
    for (const b of m.branches ?? []) if (b.pr_meta !== null && !drafts.has(b.key)) drafts.set(b.key, f.description(b.key));
    states.set(m.campaign.name, {
      campaign: m.campaign,
      synced: m.synced,
      tasks: m.tasks.map((t) => structuredClone(t)),
      branches: (m.branches ?? []).map((b) => structuredClone(b)),
      jobs: [...(m.jobs ?? [])],
      queue: [...(m.queue ?? [])],
      check: new Set(m.check ?? []),
      fleet: m.fleet ?? (m.queue ?? []).length > 0,
      questions: new Map(Object.entries(m.questions ?? {})),
      drafts,
      publishLogs: new Map(Object.entries(m.publishLogs ?? {})),
      commitProblems: new Map(Object.entries(m.commitProblems ?? {})),
      rejected: new Set(m.rejected ?? []),
      dirty: new Set(m.dirty ?? []),
      forks: new Map(Object.entries(m.forks ?? {})),
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
  const taskOf = (s: State, attr: string): Task => s.tasks.find((t) => t.attr === attr) ?? fail(404, `no task ${attr} in the campaign ${s.campaign.name}`);
  /** As the server: a branch with a directory, a link, the key of an entry. See `needBranch`. */
  const known = (s: State, key: string) => s.branches.some((b) => b.key === key) || s.tasks.some((t) => t.attr === key || t.branch === key);
  /** The branch of the key. A key of an entry or of a link without runs gets an empty branch. */
  const branchOf = (s: State, key: string): BranchView => {
    if (!known(s, key)) fail(404, `no branch ${key} in the campaign ${s.campaign.name}`);
    let b = s.branches.find((x) => x.key === key);
    if (b === undefined) {
      b = f.branch(key);
      s.branches.push(b);
    }
    return b;
  };

  const changed = (s: State, key: string | null) => emit({ type: "campaign", campaign: s.campaign.name, key });
  const jobsView = (s: State): JobsView => ({ jobs: s.jobs, queue: s.queue, check: s.queue.filter((k) => s.check.has(k)), fleet: s.fleet });
  const jobsChanged = (s: State) => emit({ type: "jobs", campaign: s.campaign.name, ...structuredClone(jobsView(s)) });

  /** As the server: the entries and the state of each branch, and the state of each entry. */
  function views(s: State): { tasks: TaskView[]; branches: BranchView[] } {
    const keys = [...new Set([...s.branches.map((b) => b.key), ...s.tasks.flatMap((t) => (t.branch === null ? [] : [t.branch]))])].sort();
    const branches = keys.map((key) => {
      const b = s.branches.find((x) => x.key === key) ?? f.branch(key);
      const covers = s.tasks.filter((t) => t.branch === key).map((t) => t.attr);
      return { ...b, covers, state: branchState(covers, b.runs, b.pr_meta, b.head) };
    });
    const byKey = new Map(branches.map((b) => [b.key, b]));
    return { tasks: s.tasks.map((t) => ({ ...t, state: taskState(t, t.branch === null ? undefined : byKey.get(t.branch)) })), branches };
  }
  const view = (s: State): CampaignView => ({ campaign: s.campaign, synced: s.synced, ...views(s) });
  /** The entries of the branch for the checks and the description. A branch without entries gets its key. */
  const entriesOf = (b: BranchView) => (b.covers.length > 0 ? b.covers : [b.key]);

  /** As the server: the local commit and the commit of the fork, when they are different. See `BranchDetail.diverged`. */
  function divergedOf(s: State, b: BranchView): Diverged | null {
    const fork = s.forks.get(b.key);
    return fork === undefined || b.head === null || fork === b.head ? null : { key: b.key, local: b.head, fork };
  }

  /** As the server: each read of the branch lints the draft and examines its marks. */
  function detail(s: State, key: string): BranchDetail {
    branchOf(s, key);
    const all = views(s);
    const b = all.branches.find((x) => x.key === key) ?? fail(404, `no branch ${key}`);
    const draft = b.pr_meta === null ? null : (s.drafts.get(key) ?? null);
    const rendered = draft === null || b.pr_meta === null ? null : f.fakeRender(draft, entriesOf(b), b.pr_meta.number);
    const lint = draft === null ? null : f.fakeLint(draft);
    const marks = draft === null ? [] : f.fakeMarkProblems(draft, s.campaign);
    return {
      campaign: s.campaign,
      branch: b,
      tasks: all.tasks.filter((t) => t.branch === key || t.attr === key),
      question: s.questions.get(key) ?? null,
      draft,
      rendered,
      mark_problems: marks,
      lint,
      campaign_words: f.CAMPAIGN_WORDS,
      publish_log: s.publishLogs.get(key) ?? null,
      commit_problems: s.commitProblems.get(key) ?? [],
      clean: !s.dirty.has(key),
      diverged: divergedOf(s, b),
    };
  }
  /** The commits of the branch: none without a tip or without a run with a base, as the server. */
  const commitsOf = (b: BranchView) => (b.head === null || !b.runs.some((r) => r.base !== "") ? [] : f.commits(b.key, b.head));

  /** As the runner: the run starts, and it gets the question of the branch. A check-only run has the tag `check` and no question. */
  function launch(s: State, key: string) {
    const b = branchOf(s, key);
    const check = s.check.delete(key);
    const run = check ? { ...f.runningRun(key, 0), tags: ["check"], question: null } : { ...f.runningRun(key, 0), question: s.questions.get(key) ?? null };
    if (!check) s.questions.delete(key);
    b.runs.unshift(run);
    s.jobs.push({ key, id: run.id, started: run.started });
  }

  /** As the fleet: it starts the runs of the queue while the number of jobs is less than the `concurrency` of the settings. */
  function fleetTick(s: State) {
    for (const key of [...s.queue]) {
      if (s.jobs.length >= settings.concurrency) break;
      if (s.jobs.some((j) => j.key === key)) continue;
      s.queue = s.queue.filter((x) => x !== key);
      launch(s, key);
      changed(s, key);
    }
    s.fleet = s.queue.length > 0;
    jobsChanged(s);
  }
  const later = (s: State) => setTimeout(() => fleetTick(s), options.fleetDelay ?? 1500);
  /** As `dequeue` of the server: it removes the entry and the question of the branch. */
  const remove = (s: State, key: string) => {
    s.queue = s.queue.filter((x) => x !== key);
    s.check.delete(key);
    s.questions.delete(key);
    changed(s, key);
  };
  /** As `queueRun` of the server: the branch goes into the queue, and a question waits for the next run of the branch. */
  function queueRun(s: State, key: string, text: string, check = false) {
    if (s.jobs.some((j) => j.key === key)) fail(409, `the branch ${key} has a job`);
    if (s.queue.includes(key)) fail(409, `the branch ${key} is in the queue`);
    const question = text.trim();
    if (question === "") s.questions.delete(key);
    else s.questions.set(key, question);
    s.queue.push(key);
    if (check) s.check.add(key);
    s.fleet = true;
    jobsChanged(s);
    changed(s, key);
    later(s);
    return jobsView(s);
  }

  return {
    campaigns: () =>
      answer("campaigns", (): CampaignSummary[] =>
        [...states.values()].map((s) => ({ name: s.campaign.name, title: s.campaign.title, issue: s.campaign.issue, synced: s.synced, counts: f.count(views(s).tasks), jobs: s.jobs.length, queued: s.queue.length })),
      ),
    campaign: (c) => answer("campaign", () => view(state(c))),
    // As the server: the numbers of the sync. The fork of the mock gets no new branch: each number of the fork is 0. The branches of `forks` with a different commit go into `diverged`.
    sync: (c) =>
      answer("sync", () => {
        const s = state(c);
        s.synced = new Date().toISOString();
        const diverged = views(s).branches.flatMap((b) => divergedOf(s, b) ?? []);
        return { ...view(s), result: { tasks: s.tasks.length, prs: [], listed: 0, fetched: 0, made: 0, drafts: 0, links: 0, queued: 0, diverged, warnings: [] } };
      }),
    refresh: (c) => answer("refresh", () => view(state(c))),
    fetchBase: (c) => answer("fetchBase", () => view(state(c))),
    labels: (c) => answer("labels", () => state(c).labels),
    branch: (c, key) => answer("branch", () => detail(state(c), key)),
    runFile: (c, key, id, file) =>
      answer("runFile", () => {
        const run = branchOf(state(c), key).runs.find((r) => r.id === id) ?? fail(404, `no run ${id}`);
        if (file === "prompt") return f.runPrompt(key);
        if (file === "attrs") return run.attrs.length === 0 ? fail(404, "the run has no such file") : run.attrs.map((a) => `${a}\n`).join("");
        if (file === "reply") return run.status === "running" ? fail(404, "the run has no such file") : run.question === null ? f.RUN_REPLY : f.REPLY;
        if (run.status === "wontfix") return file === "description" ? f.NO_FIX_DESCRIPTION : fail(404, "the run has no such file");
        // The agent writes the description of a run with a question only when the change makes the previous description incorrect.
        if (run.status === "running" || run.head === null || (file === "description" && run.question !== null && run.attrs.length > 0)) fail(404, "the run has no such file");
        return f.description(key);
      }),
    // As the server: the branch goes from the base of the newest run with a base to the tip. See `branchGit`.
    commits: (c, key) => answer("commits", () => commitsOf(branchOf(state(c), key))),
    diff: (c, key) => answer("diff", () => (commitsOf(branchOf(state(c), key)).length === 0 ? "" : f.diff(key))),
    checkOutput: (c, key, id, attr, check) =>
      answer("checkOutput", () => {
        const run = branchOf(state(c), key).runs.find((r) => r.id === id) ?? fail(404, `no run ${id}`);
        const result = run.checks.find((x) => x.attr === attr && x.name === check) ?? fail(404, "the run has no such file");
        if (check !== "harness") return f.BUILD_OUTPUT;
        return result.status === "error" ? f.harnessError(attr) : f.harnessOutput(attr, result.status === "pass");
      }),
    jobs: (c) => answer("jobs", () => jobsView(state(c))),
    queueRuns: (c, input) =>
      answer("queueRuns", () => {
        const s = state(c);
        for (const k of input.keys) branchOf(s, k);
        for (const k of input.keys) if (!s.jobs.some((j) => j.key === k) && !s.queue.includes(k)) s.queue.push(k);
        s.fleet ||= s.queue.length > 0;
        jobsChanged(s);
        later(s);
        return jobsView(s);
      }),
    clearQueue: (c) =>
      answer("clearQueue", () => {
        const s = state(c);
        for (const key of s.queue) remove(s, key);
        jobsChanged(s);
        later(s);
        return jobsView(s);
      }),
    stopJob: (c, key) =>
      answer("stopJob", () => {
        const s = state(c);
        if (s.queue.includes(key)) {
          remove(s, key);
          jobsChanged(s);
          return jobsView(s);
        }
        if (!s.jobs.some((j) => j.key === key)) fail(404, `the branch ${key} has no entry in the queue and no job`);
        s.jobs = s.jobs.filter((j) => j.key !== key);
        const run = branchOf(s, key).runs[0];
        if (run !== undefined && run.status === "running") {
          run.status = "stopped";
          run.finished = new Date().toISOString();
          run.error = "a person stopped the run";
        }
        jobsChanged(s);
        changed(s, key);
        if (s.queue.length > 0) later(s);
        return jobsView(s);
      }),
    startRun: (c, key, input) =>
      answer("startRun", () => {
        const s = state(c);
        branchOf(s, key);
        return queueRun(s, key, input.question ?? "");
      }),
    startCheck: (c, key) =>
      answer("startCheck", () => {
        const s = state(c);
        branchOf(s, key);
        return queueRun(s, key, "", true);
      }),
    startFreeRun: (c, input) =>
      answer("startFreeRun", () => {
        const s = state(c);
        const text = (input.question ?? "").trim();
        // As the server: for a key that is not there, the text is necessary. It goes into the new branch directory.
        if (!known(s, input.key)) {
          if (text === "") fail(400, `the branch ${input.key} is not there: a free-text run must have a text`);
          s.branches.push(f.branch(input.key));
        }
        return queueRun(s, input.key, text);
      }),
    linkEntry: (c, attr, key) =>
      answer("linkEntry", () => {
        const s = state(c);
        const t = taskOf(s, attr);
        if (key !== null) branchOf(s, key);
        t.branch = key;
        changed(s, null);
        return view(s);
      }),
    saveDraft: (c, key, input) =>
      answer("saveDraft", () => {
        const s = state(c);
        const b = branchOf(s, key);
        if (b.pr_meta === null) fail(404, `the branch ${key} has no draft; make one first`);
        else b.pr_meta = { ...b.pr_meta, title: input.title, labels: input.labels, words: input.words };
        s.drafts.set(key, input.description);
        changed(s, key);
        return detail(s, key);
      }),
    makeDraft: (c, key) =>
      answer("makeDraft", () => {
        const s = state(c);
        const b = branchOf(s, key);
        // As the server: the newest run with a description that is not `wontfix`. A run of the mock with a head has a description.
        if (!b.runs.some((r) => r.head !== null && r.status !== "wontfix" && r.status !== "running")) fail(409, "no run of the branch has a description.md");
        const fresh = f.prMeta(key);
        b.pr_meta = b.pr_meta === null ? fresh : { ...b.pr_meta, title: fresh.title, words: fresh.words };
        s.drafts.set(key, f.roughDescription(key));
        changed(s, key);
        return detail(s, key);
      }),
    // As the server: the log becomes longer in steps, and the request gives its result after the last step. See `createOrUpdatePr`.
    createPr: async (c, key, input) => {
      if (options.hang) return new Promise<BranchDetail>(() => undefined);
      await sleep(options.delay ?? 150);
      const failure = options.fail?.createPr;
      const failed = failure === undefined ? null : new ApiError(failure[0], failure[1], { error: failure[1], ...failure[2] });
      const failedLog = failure?.[2]?.["publish_log"];
      // An error without a log occurs before the first command.
      if (failed !== null && typeof failedLog !== "string") throw failed;
      // As the server: see `CONFIRM_ERROR` in `packages/common/src/api.ts`.
      if (input.confirmed !== true) fail(409, "confirm that you established confidence in this output");
      const s = state(c);
      const b = branchOf(s, key);
      const covers = views(s).branches.find((x) => x.key === key)?.covers ?? [];
      const meta = b.pr_meta ?? fail(404, `the branch ${key} has no draft; make one first`);
      if (meta.number !== null && meta.state !== "open") fail(409, `the pull request #${meta.number} is ${meta.state}`);
      const marks = f.fakeMarkProblems(s.drafts.get(key) ?? "", s.campaign);
      if (marks.length > 0) fail(409, `the marks of the draft have problems: ${marks.join("; ")}`);
      const job = s.jobs.find((j) => j.key === key);
      if (job !== undefined) fail(409, `the branch ${key} has a job that operates: the run ${job.id}`);
      if (commitsOf(b).length === 0) fail(409, `the branch ${key} has no commits after its base`);
      const tip = tipProblem(tipChecks(b.runs, b.head, covers));
      if (tip !== null) fail(409, tip);
      if (s.dirty.has(key)) fail(409, `the worktree of ${key} has changes without a commit: the branch does not have them`);
      const problems = s.commitProblems.get(key) ?? [];
      if (problems.length > 0) fail(409, `the branch does not agree with the automation/AI policy of nixpkgs: ${problems.map((p) => `commit ${p.sha.slice(0, 12)}: ${p.problems.join(", ")}`).join("; ")}`);
      const number = meta.number ?? 580201;
      const force = input.force === true;
      // As the server: without `force`, the fork rejects the push, and no `gh` command starts.
      const rejected = s.rejected.has(key) && !force;
      const log = typeof failedLog === "string" ? failedLog : rejected ? f.rejectedPublishLog(key) : f.publishLog(key, number, 0, force);
      for (const step of f.logSteps(log)) {
        s.publishLogs.set(key, step);
        changed(s, key);
        await sleep(LOG_STEP_MS);
      }
      if (failed !== null) throw failed;
      if (rejected) throw new ApiError(500, f.rejectedPushError(key), { error: f.rejectedPushError(key), publish_log: log });
      s.rejected.delete(key);
      const now = new Date().toISOString();
      b.pr_meta = { ...meta, number, url: `https://github.com/${s.campaign.issue.repo}/pull/${number}`, created: meta.created ?? now, updated: now, pushed: b.head, confirmed: now };
      changed(s, key);
      return structuredClone(detail(s, key));
    },
    publishLog: (c, key) => answer("publishLog", () => state(c).publishLogs.get(key) ?? fail(404, `the branch ${key} has no publish.log`)),
    makeWorktree: (c, key) =>
      answer("makeWorktree", () => {
        const s = state(c);
        const b = branchOf(s, key);
        if (s.jobs.some((j) => j.key === key)) fail(409, `a run of ${key} is in progress; its worktree goes away at its end`);
        b.worktree = f.worktreePath(key);
        b.head ??= f.HEAD;
        changed(s, key);
        return { path: b.worktree, branch: b.name };
      }),
    removeWorktree: (c, key) =>
      answer("removeWorktree", () => {
        const s = state(c);
        branchOf(s, key).worktree = null;
        changed(s, key);
        return detail(s, key);
      }),
    // As the server: the conditions of `adoptBranch`, then the commit of the fork replaces the local commit. A clean worktree stays, with the new commit.
    adopt: (c, key) =>
      answer("adopt", () => {
        const s = state(c);
        const b = branchOf(s, key);
        if (s.jobs.some((j) => j.key === key)) fail(409, `the branch ${key} has a job`);
        if (s.queue.includes(key)) fail(409, `the branch ${key} is in the queue`);
        if (b.worktree !== null && s.dirty.has(key)) fail(409, `the worktree of ${key} has changes without a commit: commit or remove them first`);
        b.head = s.forks.get(key) ?? fail(500, `the fork has no branch ${b.name}`);
        changed(s, key);
        return detail(s, key);
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
