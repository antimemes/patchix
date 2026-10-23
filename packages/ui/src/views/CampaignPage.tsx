import { useMemo, useState } from "react";
import type { Campaign, TaskState, TaskView } from "@patchix/common";
import { Badge, STATE_TONE, StateChip } from "../components/Badge.tsx";
import { Button } from "../components/Button.tsx";
import { Checkbox } from "../components/Checkbox.tsx";
import { TextField } from "../components/Field.tsx";
import { FilterChips } from "../components/FilterChips.tsx";
import { Link } from "../components/Link.tsx";
import { Notice } from "../components/Notice.tsx";
import { Popover } from "../components/Popover.tsx";
import { Progress } from "../components/Progress.tsx";
import { useToast } from "../components/Toast.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { useClient } from "../client.tsx";
import { STATES, issueUrl, plural, time } from "../format.ts";
import { useAction, useDebounced, useLoad, useSignals } from "../hooks.ts";
import { href } from "../router.ts";
import { JobsStrip, NO_JOBS } from "./JobsStrip.tsx";
import { PrCell, RunBadges } from "./shared.tsx";
import "./views.css";

export function CampaignPage({ campaign: name }: { campaign: string }) {
  const client = useClient();
  const toast = useToast();
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
      jobs.replace({ jobs: signal.jobs, queue: signal.queue, fleet: signal.fleet });
    }
  });

  const [states, setStates] = useState<TaskState[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const sync = useAction(async () => {
    view.replace(await client.sync(name));
    toast("The task list is read again");
  });
  const refresh = useAction(async () => {
    view.replace(await client.refresh(name));
    toast("The state of the pull requests is read again");
  });
  const base = useAction(async () => {
    view.replace(await client.fetchBase(name));
    toast(`The newest commit of ${view.data?.campaign.base_branch ?? "the base branch"} is fetched`);
  });
  const start = useAction(async (attrs: string[]) => {
    jobs.replace(await client.queueRuns(name, { attrs }));
    setSelected(new Set());
    toast(attrs.length === 1 ? `${attrs[0]} is in the queue` : `${attrs.length} tasks are in the queue`, "The fleet starts the runs in the free job places.");
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
  const { campaign, synced } = view.data;
  const fork = settings.data === null ? "…" : (settings.data.fork_effective ?? "no fork");
  const all = view.data.tasks;
  const needle = query.trim().toLowerCase();
  const visible = all.filter((t) => (states.length === 0 || states.includes(t.state)) && (needle === "" || t.attr.toLowerCase().includes(needle)));
  const chosen = visible.filter((t) => selected.has(t.attr)).map((t) => t.attr);
  const allChosen = visible.length > 0 && chosen.length === visible.length;
  const busy = new Set((jobs.data?.jobs ?? []).map((j) => j.attr));
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
          {plural(all.length, "task")} · synced {time(synced)} · fork {fork} · {plural(campaign.checks.length, "check")}
        </span>
      </div>

      <div className="toolbar">
        <Button onClick={() => void sync.run()} pending={sync.pending} title="Read the task list of the issue again, then the state of the pull requests.">
          Sync
        </Button>
        <Button onClick={() => void refresh.run()} pending={refresh.pending} title={`Read the state of the pull requests of ${fork} on GitHub again: open, merged or closed.`}>
          Refresh
        </Button>
        <Button onClick={() => void base.run()} pending={base.pending} title={`Fetch the newest commit of ${campaign.base_branch}. The worktrees do not change.`}>
          Fetch base
        </Button>
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
        <Button variant="primary" disabled={chosen.length === 0} pending={start.pending} onClick={() => void start.run(chosen)} title="Add the tasks to the queue. A task with a job is not added.">
          Queue selected{chosen.length > 0 ? ` (${chosen.length})` : ""}
        </Button>
      </div>
      {sync.error !== null && <Notice tone="error">Sync: {sync.error}</Notice>}
      {refresh.error !== null && <Notice tone="error">Refresh: {refresh.error}</Notice>}
      {base.error !== null && <Notice tone="error">Fetch base: {base.error}</Notice>}
      {start.error !== null && <Notice tone="error">Queue: {start.error}</Notice>}
      {jobs.error !== null && <Notice tone="error">Jobs: {jobs.error}</Notice>}

      <JobsStrip campaign={name} view={jobs.data ?? NO_JOBS} concurrency={settings.data?.concurrency} onJobs={jobs.replace} />

      {view.error !== null && <Notice tone="error">{view.error}</Notice>}
      {all.length === 0 ? (
        <Notice>No tasks. Sync reads the task list of the issue.</Notice>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="check">
                  <span className="sr-only">Selected</span>
                </th>
                <th>Attribute</th>
                <th>Notes</th>
                <th className="num">Paths</th>
                {campaign.source !== undefined && <th>Source</th>}
                <th>State</th>
                <th>PR</th>
                <th className="num">Runs</th>
                <th>Newest run</th>
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
                  selected={selected.has(t.attr)}
                  onSelect={(on) => toggle(t.attr, on)}
                  busy={busy.has(t.attr)}
                  queued={queued.has(t.attr)}
                  starting={start.pending}
                  onRun={() => void start.run([t.attr])}
                />
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={11} className="muted">
                    No task agrees with the filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface TaskRowProps {
  campaign: Campaign;
  task: TaskView;
  selected: boolean;
  onSelect: (on: boolean) => void;
  busy: boolean;
  queued: boolean;
  starting: boolean;
  onRun: () => void;
}

function TaskRow({ campaign, task, selected, onSelect, busy, queued, starting, onRun }: TaskRowProps) {
  const run = task.runs[0];
  return (
    <tr className={selected ? "is-selected" : undefined}>
      <td className="check">
        <Checkbox checked={selected} onCheckedChange={onSelect} aria-label={`Select ${task.attr}`} />
      </td>
      <td>
        <Link href={href.task(campaign.name, task.attr)} className="mono">
          {task.attr}
        </Link>
      </td>
      <td>
        <div className="task-notes">{task.notes}</div>
      </td>
      <td className="num">
        {task.paths.length === 0 ? (
          <span className="muted">0</span>
        ) : (
          <Popover
            title={`Paths of ${task.attr}`}
            trigger={
              <Button size="sm" variant="ghost">
                {task.paths.length}
              </Button>
            }
          >
            <ul className="paths">
              {task.paths.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Popover>
        )}
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
        <PrCell task={task} repo={campaign.issue.repo} />
      </td>
      <td className="num">{task.runs.length}</td>
      <td className="run-cell">
        {run === undefined ? (
          <span className="muted">—</span>
        ) : (
          <RunBadges run={run} />
        )}
      </td>
      <td>
        {task.worktree !== null && (
          <Tooltip content={task.worktree}>
            <Badge tone="grey" render={<button type="button" />}>
              worktree
            </Badge>
          </Tooltip>
        )}
      </td>
      <td>
        <Button size="sm" onClick={onRun} disabled={busy || queued || starting} title={busy ? "A job of this task operates." : queued ? "The task is in the queue." : "Add the task to the queue."}>
          Queue
        </Button>
      </td>
    </tr>
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

