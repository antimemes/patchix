import { useState } from "react";
import type { Campaign, Run, TaskView } from "@patchix/common";
import { tipRun } from "@patchix/common/status";
import { Badge, StatusBadge } from "../components/Badge.tsx";
import { Button } from "../components/Button.tsx";
import { CodeBlock } from "../components/CodeBlock.tsx";
import { Notice } from "../components/Notice.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { useClient } from "../client.tsx";
import { short, time } from "../format.ts";
import { useLoad } from "../hooks.ts";
import { AttachNotice, RemoteText, RunBadges, TagBadges } from "./shared.tsx";
import "./views.css";

export type BranchTab = "commits" | "diff" | "checks";
export type RunTab = "checks" | "prompt" | "description" | "reply";

/**
 * The branch of the task: the change that the pull request button pushes. The commits and the full diff go from the
 * base to the tip, and the checks are the checks of the tip (see `tipRun`). `clean`: see `TaskDetail.clean`.
 */
export function BranchSection({ campaign, task, clean }: { campaign: Campaign; task: TaskView; clean: boolean }) {
  const client = useClient();
  const [tab, setTab] = useState<BranchTab>("commits");
  const c = campaign.name;
  const checked = tipRun(task.runs, task.head);
  // A new tip and a new run can change the commits and the diff.
  const version = `${c}/${task.attr}/${task.head ?? "none"}/${task.runs.length}`;
  return (
    <section className="panel" aria-label="Branch">
      <div className="panel-head">
        <h2>Branch</h2>
        <span className="small mono muted break">{task.head === null ? task.branch_name : `${task.branch_name} at ${short(task.head)}`}</span>
      </div>
      {!clean && (
        <Notice tone="warning" aria-label="Changes without a commit">
          The worktree has changes without a commit. The branch does not have them, and the pull request button does not push them.
        </Notice>
      )}
      <Tabs<BranchTab>
        label="Parts of the branch"
        value={tab}
        onValueChange={setTab}
        items={[
          { value: "commits", label: "Commits", content: <CommitsView campaign={c} attr={task.attr} version={version} /> },
          { value: "diff", label: "Full diff", content: <RemoteText label="Diff of the branch" diff loadKey={`diff:${version}`} load={() => client.diff(c, task.attr)} empty="No commits after the base." /> },
          {
            value: "checks",
            label: `Checks of the tip ${checked?.checks.length ?? 0}/${campaign.checks.length}`,
            content:
              checked === undefined ? (
                <p className="muted">No run has the checks of the tip. Queue a run or ask a question: the runner starts the checks of the tip.</p>
              ) : (
                <div className="stack">
                  <p className="small muted">
                    The checks of the run <span className="mono">{checked.id}</span>.
                  </p>
                  <ChecksView campaign={campaign} attr={task.attr} run={checked} />
                </div>
              ),
          },
        ]}
      />
    </section>
  );
}

export interface RunsSectionProps {
  campaign: Campaign;
  task: TaskView;
  /** The task is in the queue: the list starts with the run that waits. */
  queued: boolean;
  /** The question for the run that waits. See `TaskDetail.question`. */
  question: string | null;
}

export function RunsSection({ campaign, task, queued, question }: RunsSectionProps) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [tab, setTab] = useState<RunTab>("checks");
  const run = task.runs.find((r) => r.id === chosen) ?? task.runs[0];
  return (
    <section className="panel" aria-label="Runs">
      <div className="panel-head">
        <h2>Runs</h2>
        <span className="muted small">{task.runs.length}</span>
      </div>
      {run === undefined && !queued ? (
        <p className="muted">No runs. The Run button starts the agent.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table run-list">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Status</th>
                  <th>Model</th>
                  <th className="num">Commits</th>
                  <th>Checks</th>
                </tr>
              </thead>
              <tbody>
                {queued && (
                  <tr>
                    <td className="small muted">next</td>
                    <td>
                      <StatusBadge status="queued" />
                    </td>
                    <td colSpan={3} className="small">
                      {question === null ? <span className="muted">The run waits in the queue.</span> : <span className="run-question">{question}</span>}
                    </td>
                  </tr>
                )}
                {task.runs.map((r) => (
                  <tr key={r.id} className={r.id === run?.id ? "is-selected" : undefined}>
                    <td>
                      <Button size="sm" variant="ghost" aria-pressed={r.id === run?.id} onClick={() => setChosen(r.id)}>
                        {r.id}
                      </Button>
                    </td>
                    <td className="nowrap">
                      <StatusBadge status={r.status} />
                      {r.error !== null && (
                        <span className="small muted run-error" title={r.error}>
                          {r.error}
                        </span>
                      )}
                    </td>
                    <td className="small mono">{r.model}</td>
                    <td className="num">{r.commits}</td>
                    <td>
                      <RunBadges run={r} status={false} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {run !== undefined && <RunView campaign={campaign} attr={task.attr} run={run} tab={tab} onTab={setTab} />}
        </>
      )}
    </section>
  );
}

interface RunViewProps {
  campaign: Campaign;
  attr: string;
  run: Run;
  tab: RunTab;
  onTab: (tab: RunTab) => void;
}

/** One run: its question, its status, its checks and its files. The Branch section gives the change of the pull request. */
export function RunView({ campaign, attr, run, tab, onTab }: RunViewProps) {
  const client = useClient();
  const c = campaign.name;
  const running = run.status === "running";
  const version = `${c}/${attr}/${run.id}/${run.finished ?? "running"}`;
  return (
    <div className="stack">
      <div className="row">
        <h3 className="mono">{run.id}</h3>
        <StatusBadge status={run.status} />
        <TagBadges tags={run.tags} />
        <span className="small muted">
          {time(run.started)} to {run.finished === null ? "now" : time(run.finished)}
        </span>
        <span className="small muted">
          <span className="mono">{short(run.base)}</span> to <span className="mono">{run.head === null ? "no commit" : short(run.head)}</span>
        </span>
      </div>
      {run.question !== null && (
        <p className="run-question" aria-label={`Question of run ${run.id}`}>
          {run.question}
        </p>
      )}
      {run.error !== null && run.status !== "unverified" && <Notice tone="error">{run.error}</Notice>}
      {run.status === "unverified" && (
        <Notice tone="warning">
          {run.error === null ? "The agent made a fix, but a check did not agree with its pass expression: the Checks tab gives the output." : `The work of the agent has a problem: ${run.error}.`} A person examines it and makes the decision. The Publish tab can make the pull request.
        </Notice>
      )}
      {run.status === "wontfix" && (
        <Notice tone="warning">The agent found no small fix: the Description tab tells why. A person must change the entry of the issue.</Notice>
      )}
      {running && <AttachNotice tab={`${c}/${attr}`} />}
      <Tabs<RunTab>
        label={`Files of run ${run.id}`}
        value={tab}
        onValueChange={onTab}
        items={[
          { value: "checks", label: `Checks ${run.checks.length}/${campaign.checks.length}`, content: <ChecksView campaign={campaign} attr={attr} run={run} /> },
          {
            value: "prompt",
            label: "Prompt",
            content: <RemoteText label="Prompt" wrap loadKey={`prompt:${version}`} load={() => client.runFile(c, attr, run.id, "prompt")} empty="No prompt." />,
          },
          {
            value: "description",
            label: (
              <>
                Description
                {run.lint !== null && run.lint > 0 && <Badge tone="amber">{run.lint}</Badge>}
              </>
            ),
            content: <RemoteText label="Description" wrap loadKey={`description:${version}`} load={() => client.runFile(c, attr, run.id, "description")} empty="No description." />,
          },
          {
            value: "reply",
            label: "Reply",
            content: <RemoteText label="Reply" wrap loadKey={`reply:${version}`} load={() => client.runFile(c, attr, run.id, "reply")} empty="No reply." />,
          },
        ]}
      />
    </div>
  );
}

/**
 * The commits of the branch from the base to the tip, as `git show` gives them. Each commit has its short id, its full
 * message and its patch. The full message shows the last lines, for example `Assisted-by:`.
 */
function CommitsView({ campaign, attr, version }: { campaign: string; attr: string; version: string }) {
  const client = useClient();
  const commits = useLoad(() => client.commits(campaign, attr), `commits:${version}`);
  if (commits.error !== null) return <Notice tone="error">{commits.error}</Notice>;
  if (commits.data === null) return <p className="small muted">Loading…</p>;
  if (commits.data.length === 0) return <p className="muted">No commits after the base.</p>;
  return (
    <ul className="plain commits" aria-label="Commits of the branch">
      {commits.data.map((commit) => (
        <li key={commit.sha} className="commit">
          <span className="mono muted small" title={commit.sha}>
            commit {short(commit.sha)}
          </span>
          <pre className="commit-message">{commit.message}</pre>
          <CodeBlock label={`Patch of commit ${short(commit.sha)}`} text={commit.patch} diff empty="No changes." />
        </li>
      ))}
    </ul>
  );
}

/** The checks of one run and their output. A run with a question that did not move the tip of the branch has no checks. */
function ChecksView({ campaign, attr, run }: { campaign: Campaign; attr: string; run: Run }) {
  const client = useClient();
  const version = `${campaign.name}/${attr}/${run.id}/${run.finished ?? "running"}`;
  const names = [...new Set([...run.checks.map((c) => c.name), ...campaign.checks.map((c) => c.name)])];
  if (names.length === 0) return <p className="muted">The campaign has no checks.</p>;
  if (run.checks.length === 0 && run.status !== "running") {
    return <p className="muted">{run.question !== null && run.error === null ? "No checks: the run did not move the tip of the branch. The Branch section gives the checks of the tip." : "No checks: the runner did not start them."}</p>;
  }
  return (
    <ul className="plain stack">
      {names.map((name) => {
        const result = run.checks.find((c) => c.name === name);
        return (
          <li key={name} className="stack">
            <div className="row">
              <strong className="mono">{name}</strong>
              {result === undefined ? (
                <Badge tone="muted">{run.status === "running" ? "waiting" : "not started"}</Badge>
              ) : (
                <>
                  <StatusBadge status={result.status} />
                  <span className="small muted">
                    exit code {result.code ?? "none"} · {Math.round(result.seconds)} s
                  </span>
                </>
              )}
            </div>
            {result !== undefined && (
              <RemoteText label={`Output of ${name}`} loadKey={`check:${name}:${version}`} load={() => client.checkOutput(campaign.name, attr, run.id, name)} empty="No output." maxHeight="20rem" />
            )}
          </li>
        );
      })}
    </ul>
  );
}
