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
import { RunsSection } from "./RunsSection.tsx";
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
  const toast = useToast();
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
  const start = useAction(async () => {
    jobs.replace(await client.queueRuns(c, { attrs: [attr] }));
    toast(`${attr} is in the queue`, "The fleet starts the run in a free job place.");
  });
  const stop = useAction(async () => {
    const queued = place >= 0;
    jobs.replace(await client.stopJob(c, attr));
    detail.reload();
    toast(queued ? `${attr} is not in the queue now` : `The job of ${attr} stops`);
  });

  if (detail.data === null) {
    return detail.error !== null ? <Notice tone="error">{detail.error}</Notice> : <Progress value={null} label="Loading the task" />;
  }
  const { task, campaign } = detail.data;
  const job = (jobs.data?.jobs ?? []).find((j) => j.attr === attr) ?? null;
  const busy = job !== null ? "A job of this task operates." : place >= 0 ? "The task is in the queue." : null;
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
                  <JobRow job={job} place={place} runs={task.runs.length} starting={start.pending} stopping={stop.pending} onRun={() => void start.run()} onStop={() => void stop.run()} />
                  {start.error !== null && <Notice tone="error">Queue: {start.error}</Notice>}
                  {stop.error !== null && <Notice tone="error">Stop: {stop.error}</Notice>}
                  <QuestionRow
                    campaign={c}
                    attr={attr}
                    busy={busy}
                    onJobs={(view) => {
                      jobs.replace(view);
                      detail.reload();
                    }}
                  />
                  <WorktreeRow campaign={c} task={task} onDetail={detail.replace} onChanged={detail.reload} />
                </section>
                <CommitProblemsNotice problems={detail.data.commit_problems} />
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

interface JobRowProps {
  job: JobStatus | null;
  /** The position of the run entry of the task in the queue, from 0. -1 when the queue does not have it. */
  place: number;
  runs: number;
  starting: boolean;
  stopping: boolean;
  onRun: () => void;
  onStop: () => void;
}

/** The Queue and Stop buttons, the job of the task when it has one, and its position in the queue. */
function JobRow({ job, place, runs, starting, stopping, onRun, onStop }: JobRowProps) {
  const reason = job !== null ? "A job of this task operates." : place >= 0 ? "The task is in the queue." : "Add the task to the queue. The fleet starts the run.";
  return (
    <div className="row">
      <Button variant="primary" onClick={onRun} disabled={job !== null || place >= 0} pending={starting} title={reason}>
        {runs === 0 ? "Queue" : "Queue again"}
      </Button>
      {job === null && place >= 0 && (
        <>
          <Button variant="danger" pending={stopping} onClick={onStop}>
            Remove from queue
          </Button>
          <span className="small muted">{place === 0 ? "The task is the first in the queue." : `The queue has ${place} ${place === 1 ? "entry" : "entries"} before this task.`}</span>
        </>
      )}
      {job !== null && (
        <>
          <ConfirmDialog
            trigger={
              <Button variant="danger" pending={stopping}>
                Stop
              </Button>
            }
            title={`Stop the run ${job.id}?`}
            description="The agent stops. The worktree and the files of the job stay."
            confirmLabel="Stop"
            onConfirm={onStop}
          />
          <span className="small muted">
            The run <span className="mono">{job.id}</span> operates. It started <span title={time(job.started)}>{ago(job.started)}</span>.
          </span>
        </>
      )}
    </div>
  );
}

const MAX_QUESTION = 4000;

interface QuestionRowProps {
  campaign: string;
  attr: string;
  /** The task has a job or an entry in the queue: the server rejects a question. */
  busy: string | null;
  onJobs: (view: JobsView) => void;
}

/** A question of a person for the agent. The task goes into the queue, and its next run continues the session of `claude` with the question. */
function QuestionRow({ campaign, attr, busy, onJobs }: QuestionRowProps) {
  const client = useClient();
  const toast = useToast();
  const [question, setQuestion] = useState("");
  const ask = useAction(async () => {
    onJobs(await client.ask(campaign, attr, { question: question.trim() }));
    setQuestion("");
    toast(`${attr} is in the queue`, "The next run of the task gets the question.");
  });
  const reason = busy ?? (question.length > MAX_QUESTION ? `The question has more than ${MAX_QUESTION} characters.` : null);
  return (
    <div className="stack" aria-label="Ask the agent">
      <TextArea label="Question" hideLabel rows={3} maxLength={MAX_QUESTION} value={question} onValueChange={setQuestion} placeholder="A question for the agent" />
      <div className="row">
        <Button disabled={reason !== null || question.trim() === ""} pending={ask.pending} onClick={() => void ask.run()} title="Add the task to the queue. The next run continues the session of the agent in the worktree, with the question.">
          Ask
        </Button>
        <span className="small muted">{reason ?? "The agent replies, and it changes the files only when the question tells it."}</span>
      </div>
      {ask.error !== null && <Notice tone="error">{ask.error}</Notice>}
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
