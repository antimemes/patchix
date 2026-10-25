import { useCallback, useEffect, useState } from "react";
import type { CommitProblems, JobStatus, JobsView, TaskDetail, TaskView } from "@patchix/common";
import { Badge, StateChip } from "../components/Badge.tsx";
import { Button } from "../components/Button.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { TextArea } from "../components/Field.tsx";
import { Link } from "../components/Link.tsx";
import { Notice } from "../components/Notice.tsx";
import { Progress } from "../components/Progress.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { useToast } from "../components/Toast.tsx";
import { useClient } from "../client.tsx";
import { ago, pullUrl, short, time } from "../format.ts";
import { useAction, useDebounced, useLoad, useSignals } from "../hooks.ts";
import { PublishTab } from "./PublishTab.tsx";
import { BranchSection, RunsSection } from "./RunsSection.tsx";
import { PrCell } from "./shared.tsx";
import "./views.css";

export type PageTab = "work" | "publish";

function readTab(): PageTab {
  return window.location.hash === "#publish" ? "publish" : "work";
}

/** The tab of the task page. The URL hash keeps it: `#work` or `#publish`. Thus a link to the page opens the same tab. */
function useTab(): [PageTab, (tab: PageTab) => void] {
  const [tab, setTab] = useState<PageTab>(readTab);
  useEffect(() => {
    const onHash = () => setTab(readTab());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const choose = useCallback((next: PageTab) => {
    setTab(next);
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, "", `${pathname}${search}#${next}`);
  }, []);
  return [tab, choose];
}

/** The commits of the branch that do not agree with the `automation/AI policy` of nixpkgs. See `TaskDetail.commit_problems`. */
function CommitProblemsNotice({ problems }: { problems: CommitProblems[] }) {
  if (problems.length === 0) return null;
  return (
    <Notice tone="warning" aria-label="Commit problems">
      <p>The branch does not agree with the automation/AI policy of nixpkgs. The pull request button stays disabled. Amend the commit in the worktree, then reload.</p>
      <ul className="reasons">
        {problems.map((p) => (
          <li key={p.sha}>
            commit <span className="mono">{short(p.sha)}</span>: {p.problems.join(", ")}
          </li>
        ))}
      </ul>
    </Notice>
  );
}

export function TaskPage({ campaign: c, attr }: { campaign: string; attr: string }) {
  const client = useClient();
  const [tab, setTab] = useTab();
  const detail = useLoad(() => client.task(c, attr), `task:${c}/${attr}`);
  const jobs = useLoad(() => client.jobs(c), `jobs:${c}`);
  const reload = useDebounced(detail.reload, 300);
  useSignals((signal) => {
    if (signal.type === "reconnect") {
      detail.reload();
      jobs.reload();
    } else if (signal.campaign !== c) {
      return;
    } else if (signal.type === "campaign") {
      if (signal.attr === null || signal.attr === attr) reload();
    } else {
      jobs.replace({ jobs: signal.jobs, queue: signal.queue, fleet: signal.fleet });
    }
  });
  const place = jobs.data?.queue.indexOf(attr) ?? -1;

  if (detail.data === null) {
    return detail.error !== null ? <Notice tone="error">{detail.error}</Notice> : <Progress value={null} label="Loading the task" />;
  }
  const { task, campaign } = detail.data;
  const job = (jobs.data?.jobs ?? []).find((j) => j.attr === attr) ?? null;
  return (
    <div className="stack">
      <header className="task-title">
        <h1>{task.attr}</h1>
        <StateChip state={task.state} />
        {place >= 0 && (
          <Badge tone="blue" dim>
            queued
          </Badge>
        )}
        {(task.pr_meta?.number != null || task.pr !== null || task.remark !== null) && <PrCell task={task} repo={campaign.issue.repo} />}
      </header>
      {detail.error !== null && <Notice tone="error">{detail.error}</Notice>}
      {jobs.error !== null && <Notice tone="error">Jobs: {jobs.error}</Notice>}
      <Tabs<PageTab>
        label="Parts of the task"
        value={tab}
        onValueChange={setTab}
        keepMounted
        items={[
          {
            value: "work",
            label: "Work",
            content: (
              <div className="stack-lg">
                <section className="panel" aria-label="Task">
                  <IssueEntry task={task} repo={campaign.issue.repo} hasSource={campaign.source !== undefined} />
                  <RunRow
                    campaign={c}
                    attr={attr}
                    job={job}
                    place={place}
                    onJobs={(view) => {
                      jobs.replace(view);
                      detail.reload();
                    }}
                  />
                  <WorktreeRow campaign={c} task={task} onDetail={detail.replace} onChanged={detail.reload} />
                </section>
                <CommitProblemsNotice problems={detail.data.commit_problems} />
                <BranchSection campaign={campaign} task={task} clean={detail.data.clean} />
                <RunsSection campaign={campaign} task={task} queued={place >= 0} question={detail.data.question} />
              </div>
            ),
          },
          {
            value: "publish",
            label: "Publish",
            content: <PublishTab key={`${c}/${attr}`} detail={detail.data} jobRunning={job !== null} onDetail={detail.replace} />,
          },
        ]}
      />
    </div>
  );
}

/** The entry of the task in the tracking issue, and the branch of the task. */
function IssueEntry({ task, repo, hasSource }: { task: TaskView; repo: string; hasSource: boolean }) {
  return (
    <dl className="meta" aria-label="Issue entry">
      <dt>Attribute</dt>
      <dd className="mono">{task.attr}</dd>
      <dt>Tick box</dt>
      <dd>{task.checked ? <Badge tone="green">set</Badge> : <Badge tone="muted">not set</Badge>}</dd>
      <dt>Pull request</dt>
      <dd>{task.pr === null ? <span className="muted">none</span> : <Link href={pullUrl(repo, task.pr)}>#{task.pr}</Link>}</dd>
      <dt>Remark</dt>
      <dd>{task.remark ?? <span className="muted">none</span>}</dd>
      <dt>Notes</dt>
      <dd>{task.notes === "" ? <span className="muted">none</span> : task.notes}</dd>
      <dt>Paths</dt>
      <dd>
        {task.paths.length === 0 ? (
          <span className="muted">none</span>
        ) : (
          <ul className="paths">
            {task.paths.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </dd>
      <dt>Sources</dt>
      <dd className="row">
        <Badge tone={task.in_issue ? "blue" : "amber"}>{task.in_issue ? "in the issue" : "not in the issue"}</Badge>
        {hasSource && <Badge tone={task.in_source ? "blue" : "amber"}>{task.in_source ? "in the source command" : "not in the source command"}</Badge>}
      </dd>
      <dt>Branch</dt>
      <dd>
        <span className="mono break">{task.branch_name}</span>{" "}
        {task.head === null ? <span className="muted">(not in the repository)</span> : <span className="mono muted">at {short(task.head)}</span>}
      </dd>
    </dl>
  );
}

/** The longest question: see `RunInput`. */
const MAX_QUESTION = 4000;
/** The text below the Run button when a click adds the task to the queue. */
const RUN_HINT = "The task goes into the queue. With a question, the next run continues the session of the agent.";

interface RunRowProps {
  campaign: string;
  attr: string;
  job: JobStatus | null;
  /** The position of the run entry of the task in the queue, from 0. -1 when the queue does not have it. */
  place: number;
  onJobs: (view: JobsView) => void;
}

/**
 * The question for the agent and the Run button. Also the Stop button, the job of the task and its position in the
 * queue. Without a question, the run is a usual run. With a question, the next run continues the session of `claude`
 * in the worktree with the question. The server rejects a run for a task with a job or with an entry.
 */
function RunRow({ campaign, attr, job, place, onJobs }: RunRowProps) {
  const client = useClient();
  const toast = useToast();
  const [question, setQuestion] = useState("");
  const start = useAction(async () => {
    const text = question.trim();
    onJobs(await client.startRun(campaign, attr, { question: text }));
    setQuestion("");
    toast(`${attr} is in the queue`, text === "" ? "The fleet starts the run in a free job place." : "The next run of the task gets the question.");
  });
  const stop = useAction(async () => {
    const queued = place >= 0;
    onJobs(await client.stopJob(campaign, attr));
    toast(queued ? `${attr} is not in the queue now` : `The job of ${attr} stops`);
  });
  const reason =
    job !== null ? "A job of this task operates." : place >= 0 ? "The task is in the queue." : question.length > MAX_QUESTION ? `The question has more than ${MAX_QUESTION} characters.` : null;
  return (
    <div className="stack" aria-label="Next run">
      <TextArea label="Question" hideLabel rows={3} maxLength={MAX_QUESTION} value={question} onValueChange={setQuestion} placeholder="A question for the agent (optional)" />
      <div className="row">
        <Button variant="primary" disabled={reason !== null} pending={start.pending} onClick={() => void start.run()}>
          Run
        </Button>
        {job === null && place >= 0 && (
          <>
            <Button variant="danger" pending={stop.pending} onClick={() => void stop.run()}>
              Remove from queue
            </Button>
            <span className="small muted">{place === 0 ? "The task is the first in the queue." : `The queue has ${place} ${place === 1 ? "entry" : "entries"} before this task.`}</span>
          </>
        )}
        {job !== null && (
          <>
            <ConfirmDialog
              trigger={
                <Button variant="danger" pending={stop.pending}>
                  Stop
                </Button>
              }
              title={`Stop the run ${job.id}?`}
              description="The agent stops. The worktree and the files of the job stay."
              confirmLabel="Stop"
              onConfirm={() => void stop.run()}
            />
            <span className="small muted">
              The run <span className="mono">{job.id}</span> operates. It started <span title={time(job.started)}>{ago(job.started)}</span>.
            </span>
          </>
        )}
      </div>
      <span className="small muted">{reason ?? RUN_HINT}</span>
      {start.error !== null && <Notice tone="error">Run: {start.error}</Notice>}
      {stop.error !== null && <Notice tone="error">Stop: {stop.error}</Notice>}
    </div>
  );
}

interface WorktreeRowProps {
  campaign: string;
  task: TaskView;
  onDetail: (detail: TaskDetail) => void;
  onChanged: () => void;
}

function WorktreeRow({ campaign, task, onDetail, onChanged }: WorktreeRowProps) {
  const client = useClient();
  const toast = useToast();
  const make = useAction(async () => {
    const worktree = await client.makeWorktree(campaign, task.attr);
    onChanged();
    toast("Worktree made", worktree.path);
  });
  const remove = useAction(async () => {
    onDetail(await client.removeWorktree(campaign, task.attr));
    toast("Worktree removed");
  });
  return (
    <div className="stack" aria-label="Worktree">
      <div className="row">
        <span className="small muted">Worktree</span>
        {task.worktree === null ? <span className="small muted">none</span> : <span className="small mono break">{task.worktree}</span>}
        {task.worktree === null ? (
          <Button size="sm" pending={make.pending} onClick={() => void make.run()}>
            Make worktree
          </Button>
        ) : (
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="danger" pending={remove.pending}>
                Remove worktree
              </Button>
            }
            title="Remove the worktree?"
            description="The branch stays. The server does not remove a worktree with changes that are not committed."
            confirmLabel="Remove"
            onConfirm={() => void remove.run()}
          />
        )}
      </div>
      {make.error !== null && <Notice tone="error">{make.error}</Notice>}
      {remove.error !== null && <Notice tone="error">{remove.error}</Notice>}
    </div>
  );
}
