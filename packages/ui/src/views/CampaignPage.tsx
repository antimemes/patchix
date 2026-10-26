import { useEffect, useMemo, useState } from "react";
import type { BranchState, BranchView, Campaign, Diverged, TaskState, TaskView } from "@patchix/common";
import { tipChecks } from "@patchix/common/status";
import { Badge, STATE_TONE, StateChip } from "../components/Badge.tsx";
import { Button } from "../components/Button.tsx";
import { Checkbox } from "../components/Checkbox.tsx";
import { TextField } from "../components/Field.tsx";
import { FilterChips } from "../components/FilterChips.tsx";
import { Link } from "../components/Link.tsx";
import { Notice } from "../components/Notice.tsx";
import { Progress } from "../components/Progress.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { useToast } from "../components/Toast.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { useClient } from "../client.tsx";
import { STATES, ago, issueUrl, plural, syncLine, time } from "../format.ts";
import { useAction, useDebounced, useHashTab, useLoad, useSignals } from "../hooks.ts";
import { href, param, replaceParams } from "../router.ts";
import { JobsStrip, NO_JOBS } from "./JobsStrip.tsx";
import { RunControl } from "./RunControl.tsx";
import { ADOPT_HELP, AdoptButton, DivergedCommits, PrCell, RunBadges } from "./shared.tsx";
import "./views.css";

/** The key of `sessionStorage` that keeps the URL query of `campaign`: `state=ready,merged&q=text`. */
export const filtersKey = (campaign: string) => `patchix.filters.${campaign}`;

/**
 * The URL query. When the URL has no `state` and no `q`, the query that `sessionStorage` keeps for `campaign`.
 * Thus a link without a query, for example the link to the campaign on a task page, shows the same tasks.
 */
function readFilters(campaign: string): URLSearchParams {
  if (param("state") !== "" || param("q") !== "") return new URLSearchParams(window.location.search);
  try {
    return new URLSearchParams(window.sessionStorage.getItem(filtersKey(campaign)) ?? "");
  } catch {
    // An access to `sessionStorage` can cause an error. Then the page shows all tasks.
    return new URLSearchParams();
  }
}

/**
 * Keep the URL query in `sessionStorage`. An empty query removes the value.
 * Thus, when the person removes each selected state and the text, a link without a query also shows all tasks.
 */
function keepFilters(campaign: string, query: string): void {
  try {
    if (query === "") window.sessionStorage.removeItem(filtersKey(campaign));
    else window.sessionStorage.setItem(filtersKey(campaign), query);
  } catch {
    // Without `sessionStorage`, only the URL keeps the query.
  }
}

/** The states of the `state` parameter. A value that is not a state is ignored. */
function readStates(params: URLSearchParams): TaskState[] {
  const values = (params.get("state") ?? "").split(",");
  return STATES.filter((s) => values.includes(s));
}

export type CampaignTab = "tasks" | "branches";
/** The tabs of the page. The URL hash keeps the tab: `#tasks` or `#branches`. */
const TABS = ["tasks", "branches"] as const;
/** The states of a branch, in the sequence of `STATES`. */
const BRANCH_STATES = STATES.filter((s): s is BranchState => s !== "external");

/** The key of the run of an entry: its branch, or its attribute. The Queue button and the attribute link use it. */
const runKey = (t: TaskView) => t.branch ?? t.attr;

export function CampaignPage({ campaign: name }: { campaign: string }) {
  const client = useClient();
  const toast = useToast();
  const [tab, setTab] = useHashTab<CampaignTab>(TABS);
  const view = useLoad(() => client.campaign(name), `campaign:${name}`);
  const jobs = useLoad(() => client.jobs(name), `jobs:${name}`);
  // The fork and the `concurrency` come from the settings of this person and this host, not from the campaign.
  const settings = useLoad(() => client.settings(), "settings");
  const reloadView = useDebounced(view.reload, 300);
  useSignals((signal) => {
    if (signal.type === "reconnect") {
      view.reload();
      jobs.reload();
    } else if (signal.campaign !== name) {
      return;
    } else if (signal.type === "campaign") {
      reloadView();
    } else {
      jobs.replace({ jobs: signal.jobs, queue: signal.queue, check: signal.check, fleet: signal.fleet });
    }
  });

  // The URL query keeps the selected states and the attribute text: `?state=ready,merged&q=text`. Thus Back from a branch page shows the same entries, and a person can send the link.
  // `sessionStorage` also keeps the query of each campaign, for a link without a query.
  const [initial] = useState(() => readFilters(name));
  const [states, setStates] = useState<TaskState[]>(() => readStates(initial));
  const [query, setQuery] = useState(() => initial.get("q") ?? "");
  useEffect(() => {
    replaceParams({ state: states.join(","), q: query });
    keepFilters(name, window.location.search.slice(1));
  }, [name, states, query]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** The warnings of the newest sync of this page. */
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  /** The `SyncResult.diverged` of the newest sync of this page. The Adopt button removes a branch from the list. */
  const [diverged, setDiverged] = useState<readonly Diverged[]>([]);

  const sync = useAction(async () => {
    const { result, ...next } = await client.sync(name);
    view.replace(next);
    setWarnings(result.warnings);
    setDiverged(result.diverged);
    if (result.queued > 0) jobs.reload();
    toast("The state agrees with GitHub", syncLine(result));
  });
  const refresh = useAction(async () => {
    view.replace(await client.refresh(name));
    toast("The state of the pull requests is read again");
  });
  const base = useAction(async () => {
    view.replace(await client.fetchBase(name));
    toast(`The newest commit of ${view.data?.campaign.base_branch ?? "the base branch"} is fetched`);
  });
  const start = useAction(async (keys: string[]) => {
    jobs.replace(await client.queueRuns(name, { keys }));
    setSelected(new Set());
    toast(keys.length === 1 ? `${keys[0]} is in the queue` : `${keys.length} branches are in the queue`, "The fleet starts the runs in the free job places.");
  });

  const tasks = view.data?.tasks;
  const counts = useMemo(() => {
    const c = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<TaskState, number>;
    for (const t of tasks ?? []) c[t.state]++;
    return c;
  }, [tasks]);

  if (view.data === null) {
    return view.error !== null ? <Notice tone="error">{view.error}</Notice> : <Progress value={null} label="Loading the campaign" />;
  }
  const { campaign, synced, branches } = view.data;
  const fork = settings.data === null ? "…" : (settings.data.fork_effective ?? "no fork");
  const all = view.data.tasks;
  const byKey = new Map(branches.map((b) => [b.key, b]));
  const known = new Set([...branches.map((b) => b.key), ...all.map((t) => t.attr)]);
  const needle = query.trim().toLowerCase();
  const visible = all.filter((t) => (states.length === 0 || states.includes(t.state)) && (needle === "" || t.attr.toLowerCase().includes(needle)));
  const chosen = visible.filter((t) => selected.has(t.attr));
  const allChosen = visible.length > 0 && chosen.length === visible.length;
  const busy = new Set((jobs.data?.jobs ?? []).map((j) => j.key));
  const queued = new Set(jobs.data?.queue ?? []);

  const toggle = (attr: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(attr);
    else next.delete(attr);
    setSelected(next);
  };
  const toggleAll = (on: boolean) => {
    const next = new Set(selected);
    for (const t of visible) {
      if (on) next.add(t.attr);
      else next.delete(t.attr);
    }
    setSelected(next);
  };

  return (
    <section className="stack">
      <div className="campaign-head">
        <h1>{campaign.title}</h1>
        <Link href={issueUrl(campaign.issue.repo, campaign.issue.number)}>
          {campaign.issue.repo}#{campaign.issue.number}
        </Link>
        <span className="small muted">
          {plural(all.length, "task")} · {plural(branches.length, "branch", "branches")} · synced {time(synced)} · fork {fork} · {plural(campaign.checks.length, "check")}
        </span>
      </div>

      <section className="panel" aria-label="Run">
        <h2>Run</h2>
        <RunControl campaign={name} branch={null} known={known} jobs={jobs.data ?? NO_JOBS} onJobs={jobs.replace} />
      </section>

      <div className="toolbar">
        <Button
          onClick={() => void sync.run()}
          pending={sync.pending}
          title="Read the task list of the issue again, the state of the pull requests and the branches of the fork. A branch of the fork without checks of the tip gets a check-only run."
        >
          Sync
        </Button>
        <Button onClick={() => void refresh.run()} pending={refresh.pending} title={`Read the state of the pull requests of ${fork} on GitHub again: open, merged or closed.`}>
          Refresh
        </Button>
        <Button onClick={() => void base.run()} pending={base.pending} title={`Fetch the newest commit of ${campaign.base_branch}. The worktrees do not change.`}>
          Fetch base
        </Button>
      </div>
      {sync.error !== null && <Notice tone="error">Sync: {sync.error}</Notice>}
      {warnings.length > 0 && (
        <Notice tone="warning" aria-label="Sync warnings">
          <p>The sync gave warnings:</p>
          <ul className="reasons">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}
      {diverged.length > 0 && (
        <Notice tone="warning" aria-label="Diverged branches">
          <p>The repository of patchix has a different commit than the fork for these branches. The sync does not change them. {ADOPT_HELP}</p>
          <ul className="reasons">
            {diverged.map((d) => (
              <li key={d.key}>
                <div className="row">
                  <Link href={href.branch(name, d.key)} className="mono">
                    {d.key}
                  </Link>
                  <DivergedCommits diverged={d} />
                  <AdoptButton
                    campaign={name}
                    diverged={d}
                    onAdopted={() => {
                      setDiverged((list) => list.filter((x) => x.key !== d.key));
                      view.reload();
                    }}
                  />
                  <Link href={`${href.branch(name, d.key)}#publish`} title="The local commit is newer: push it to the fork from the Publish tab of the branch.">
                    Publish tab
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {refresh.error !== null && <Notice tone="error">Refresh: {refresh.error}</Notice>}
      {base.error !== null && <Notice tone="error">Fetch base: {base.error}</Notice>}
      {start.error !== null && <Notice tone="error">Queue: {start.error}</Notice>}
      {jobs.error !== null && <Notice tone="error">Jobs: {jobs.error}</Notice>}

      <JobsStrip campaign={name} view={jobs.data ?? NO_JOBS} concurrency={settings.data?.concurrency} onJobs={jobs.replace} />

      {view.error !== null && <Notice tone="error">{view.error}</Notice>}
      <Tabs<CampaignTab>
        label="Parts of the campaign"
        value={tab}
        onValueChange={setTab}
        items={[
          {
            value: "tasks",
            label: `Tasks ${all.length}`,
            content:
              all.length === 0 ? (
                <Notice>No tasks. Sync reads the task list of the issue.</Notice>
              ) : (
                <div className="stack">
                  <div className="toolbar">
                    <FilterChips<TaskState>
                      label="Filter by state"
                      options={STATES.map((s) => ({ value: s, label: s, count: counts[s], tone: STATE_TONE[s] }))}
                      value={states}
                      onValueChange={setStates}
                    />
                    <TextField label="Filter by attribute" hideLabel placeholder="Filter attributes" value={query} onValueChange={setQuery} className="campaign-filter" />
                  </div>
                  <div className="toolbar">
                    <Checkbox
                      checked={allChosen}
                      indeterminate={chosen.length > 0 && !allChosen}
                      onCheckedChange={toggleAll}
                      disabled={visible.length === 0}
                      label={`Select the ${plural(visible.length, "shown task")}`}
                    />
                    <Button
                      variant="primary"
                      disabled={chosen.length === 0}
                      pending={start.pending}
                      onClick={() => void start.run([...new Set(chosen.map(runKey))])}
                      title="Add the branch of each task to the queue: its branch, or the key of its attribute. A branch with a job is not added."
                    >
                      Queue selected{chosen.length > 0 ? ` (${chosen.length})` : ""}
                    </Button>
                  </div>
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th className="check">
                            <span className="sr-only">Selected</span>
                          </th>
                          <th>Attribute</th>
                          <th>Notes</th>
                          {campaign.source !== undefined && <th>Source</th>}
                          <th>State</th>
                          <th>Branch</th>
                          <th>PR</th>
                          <th className="num">Runs</th>
                          <th>Newest run, checks of the tip</th>
                          <th>Last run</th>
                          <th>Worktree</th>
                          <th>
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {visible.map((t) => (
                          <TaskRow
                            key={t.attr}
                            campaign={campaign}
                            task={t}
                            branch={t.branch === null ? undefined : byKey.get(t.branch)}
                            selected={selected.has(t.attr)}
                            onSelect={(on) => toggle(t.attr, on)}
                            busy={busy.has(runKey(t))}
                            queued={queued.has(runKey(t))}
                            starting={start.pending}
                            onRun={() => void start.run([runKey(t)])}
                          />
                        ))}
                        {visible.length === 0 && (
                          <tr>
                            <td colSpan={12} className="muted">
                              No task agrees with the filter.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              ),
          },
          {
            value: "branches",
            label: `Branches ${branches.length}`,
            content: <BranchesTable campaign={campaign} branches={branches} busy={busy} queued={queued} starting={start.pending} onRun={(key) => void start.run([key])} />,
          },
        ]}
      />
    </section>
  );
}

interface TaskRowProps {
  campaign: Campaign;
  task: TaskView;
  /** The branch of `Task.branch`, or `undefined` when the entry has no branch. */
  branch: BranchView | undefined;
  selected: boolean;
  onSelect: (on: boolean) => void;
  busy: boolean;
  queued: boolean;
  starting: boolean;
  onRun: () => void;
}

function TaskRow({ campaign, task, branch, selected, onSelect, busy, queued, starting, onRun }: TaskRowProps) {
  const run = branch?.runs[0];
  return (
    <tr className={selected ? "is-selected" : undefined}>
      <td className="check">
        <Checkbox checked={selected} onCheckedChange={onSelect} aria-label={`Select ${task.attr}`} />
      </td>
      <td>
        <Link href={href.branch(campaign.name, runKey(task))} className="mono">
          {task.attr}
        </Link>
      </td>
      <td>
        <div className="task-notes">{task.notes}</div>
      </td>
      {campaign.source !== undefined && (
        <td>
          <SourceFlags task={task} />
        </td>
      )}
      <td>
        <div className="row">
          <StateChip state={task.state} />
          {queued && (
            <Badge tone="blue" dim>
              queued
            </Badge>
          )}
        </div>
      </td>
      <td>
        {task.branch === null ? (
          <span className="muted">—</span>
        ) : (
          <Link href={href.branch(campaign.name, task.branch)} className="mono small">
            {task.branch}
          </Link>
        )}
      </td>
      <td className="pr-cell">
        <PrCell meta={branch?.pr_meta ?? null} task={task} repo={campaign.issue.repo} />
      </td>
      <td className="num">{branch?.runs.length ?? 0}</td>
      <td className="run-cell">
        {/* The checks of the tip for this entry: see `tipChecks`. */}
        {run === undefined || branch === undefined ? <span className="muted">—</span> : <RunBadges run={run} checks={tipChecks(branch.runs, branch.head, [task.attr])[0]?.checks ?? []} />}
      </td>
      <td className="nowrap">
        {/* The time since the start of the newest run. The title has the full ISO time. */}
        {run === undefined ? (
          <span className="muted">—</span>
        ) : (
          <span className="small" title={run.started}>
            {ago(run.started)}
          </span>
        )}
      </td>
      <td>
        <WorktreeBadge path={branch?.worktree ?? null} />
      </td>
      <td>
        <Button size="sm" onClick={onRun} disabled={busy || queued || starting} title={busy ? "A job of this branch operates." : queued ? "The branch is in the queue." : `Add the branch ${runKey(task)} to the queue.`}>
          Queue
        </Button>
      </td>
    </tr>
  );
}

function WorktreeBadge({ path }: { path: string | null }) {
  if (path === null) return null;
  return (
    <Tooltip content={path}>
      <Badge tone="grey" render={<button type="button" />}>
        worktree
      </Badge>
    </Tooltip>
  );
}

interface BranchesTableProps {
  campaign: Campaign;
  branches: readonly BranchView[];
  busy: ReadonlySet<string>;
  queued: ReadonlySet<string>;
  starting: boolean;
  onRun: (key: string) => void;
}

/** Each branch of the campaign with its entries, its newest run, its state and its pull request. A branch without entries is also in the list. */
function BranchesTable({ campaign, branches, busy, queued, starting, onRun }: BranchesTableProps) {
  const [states, setStates] = useState<BranchState[]>([]);
  const counts = Object.fromEntries(BRANCH_STATES.map((s) => [s, branches.filter((b) => b.state === s).length])) as Record<BranchState, number>;
  const visible = branches.filter((b) => states.length === 0 || states.includes(b.state));
  if (branches.length === 0) return <Notice>No branches. A run makes the branch of its key.</Notice>;
  return (
    <div className="stack">
      <div className="toolbar">
        <FilterChips<BranchState>
          label="Filter branches by state"
          options={BRANCH_STATES.map((s) => ({ value: s, label: s, count: counts[s], tone: STATE_TONE[s] }))}
          value={states}
          onValueChange={setStates}
        />
      </div>
      <div className="table-wrap">
        <table className="table" aria-label="Branches">
          <thead>
            <tr>
              <th>Branch</th>
              <th>Entries</th>
              <th>State</th>
              <th>PR</th>
              <th className="num">Runs</th>
              <th>Newest run</th>
              <th>Last run</th>
              <th>Worktree</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((b) => {
              const run = b.runs[0];
              return (
                <tr key={b.key}>
                  <td>
                    <Link href={href.branch(campaign.name, b.key)} className="mono">
                      {b.key}
                    </Link>
                  </td>
                  <td>
                    <div className="entry-chips">
                      {b.covers.length === 0 ? (
                        <span className="small muted">no entry</span>
                      ) : (
                        b.covers.map((attr) => (
                          <span key={attr} className="entry-chip is-plain">
                            <Link href={href.entry(campaign.name, attr)} className="mono">
                              {attr}
                            </Link>
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                  <td>
                    <div className="row">
                      <StateChip state={b.state} />
                      {queued.has(b.key) && (
                        <Badge tone="blue" dim>
                          queued
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="pr-cell">
                    <PrCell meta={b.pr_meta} repo={campaign.issue.repo} />
                  </td>
                  <td className="num">{b.runs.length}</td>
                  <td className="run-cell">{run === undefined ? <span className="muted">—</span> : <RunBadges run={run} />}</td>
                  <td className="nowrap">
                    {run === undefined ? (
                      <span className="muted">—</span>
                    ) : (
                      <span className="small" title={run.started}>
                        {ago(run.started)}
                      </span>
                    )}
                  </td>
                  <td>
                    <WorktreeBadge path={b.worktree} />
                  </td>
                  <td>
                    <Button size="sm" onClick={() => onRun(b.key)} disabled={busy.has(b.key) || queued.has(b.key) || starting} title={busy.has(b.key) ? "A job of this branch operates." : queued.has(b.key) ? "The branch is in the queue." : "Add the branch to the queue."}>
                      Queue
                    </Button>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={9} className="muted">
                  No branch agrees with the filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SourceFlags({ task }: { task: TaskView }) {
  if (task.in_source && !task.in_issue) {
    return (
      <Tooltip content="The source command gives this attribute, but the issue has no entry for it.">
        <Badge tone="amber" render={<button type="button" />}>
          not in issue
        </Badge>
      </Tooltip>
    );
  }
  if (task.in_issue && !task.in_source) {
    return (
      <Tooltip content="The issue has an entry for this attribute, but the source command does not give it.">
        <Badge tone="amber" render={<button type="button" />}>
          not in source
        </Badge>
      </Tooltip>
    );
  }
  return <span className="muted small">both</span>;
}
