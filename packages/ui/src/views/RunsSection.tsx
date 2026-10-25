import { useState } from "react";
import type { Campaign, Run, TaskView } from "@patchix/common";
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

export type RunTab = "diff" | "commits" | "checks" | "prompt" | "description" | "reply";

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
  const [tab, setTab] = useState<RunTab>("diff");
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
          {run !== undefined && <RunView campaign={campaign} attr={task.attr} run={run} checksRun={task.runs.find((r) => r.id === run.checks_of) ?? run} tab={tab} onTab={setTab} />}
        </>
      )}
    </section>
  );
}

interface RunViewProps {
  campaign: Campaign;
  attr: string;
  run: Run;
  /** The run with the checks that apply: `run`, or the run of `checks_of`. See `RunSchema.checks_of`. */
  checksRun: Run;
  tab: RunTab;
  onTab: (tab: RunTab) => void;
}

export function RunView({ campaign, attr, run, checksRun, tab, onTab }: RunViewProps) {
  const client = useClient();
  const c = campaign.name;
  const running = run.status === "running";
  const version = (r: Run) => `${c}/${attr}/${r.id}/${r.finished ?? "running"}`;
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
          {
            value: "diff",
            label: "Full diff",
            content: <RemoteText label="Full diff" diff loadKey={`diff:${version(run)}`} load={() => client.runFile(c, attr, run.id, "diff")} empty="No diff." />,
          },
          {
            value: "commits",
            label: "Commits",
            content: <CommitsView campaign={c} attr={attr} run={run} version={version(run)} />,
          },
          {
            value: "checks",
            label: `Checks ${checksRun.checks.length}/${campaign.checks.length}`,
            content: (
              <div className="stack">
                {checksRun !== run && <Notice aria-label="Checks of a previous run">The checks of run {checksRun.id} apply: the branch did not change.</Notice>}
                <ChecksView campaign={campaign} attr={attr} run={checksRun} version={version(checksRun)} />
              </div>
            ),
          },
          {
            value: "prompt",
            label: "Prompt",
            content: <RemoteText label="Prompt" wrap loadKey={`prompt:${version(run)}`} load={() => client.runFile(c, attr, run.id, "prompt")} empty="No prompt." />,
          },
          {
            value: "description",
            label: (
              <>
                Description
                {run.lint !== null && run.lint > 0 && <Badge tone="amber">{run.lint}</Badge>}
              </>
            ),
            content: <RemoteText label="Description" wrap loadKey={`description:${version(run)}`} load={() => client.runFile(c, attr, run.id, "description")} empty="No description." />,
          },
          {
            value: "reply",
            label: "Reply",
            content: <RemoteText label="Reply" wrap loadKey={`reply:${version(run)}`} load={() => client.runFile(c, attr, run.id, "reply")} empty="No reply." />,
          },
        ]}
      />
    </div>
  );
}

/**
 * The commits from the base to the head of the run, as `git show` gives them. Each commit has its short id, its full
 * message and its patch. The full message shows the last lines, for example `Assisted-by:`. For the newest run, the
 * list ends at the tip of the branch. When the branch changed after the run, a line above the list tells it. See
 * `RunCommits`.
 */
function CommitsView({ campaign, attr, run, version }: { campaign: string; attr: string; run: Run; version: string }) {
  const client = useClient();
  const commits = useLoad(() => client.commits(campaign, attr, run.id), `commits:${version}`);
  if (commits.error !== null) return <Notice tone="error">{commits.error}</Notice>;
  if (commits.data === null) return <p className="small muted">Loading…</p>;
  const { commits: list, moved } = commits.data;
  return (
    <div className="stack">
      {moved && <Notice aria-label="Branch moved">The branch moved after this run: the list shows the branch.</Notice>}
      {list.length === 0 ? (
        <p className="muted">{run.status === "running" ? "The run did not stop. Its commits show at its end." : "No commits."}</p>
      ) : (
        <ul className="plain commits" aria-label={`Commits of run ${run.id}`}>
          {list.map((commit) => (
            <li key={commit.sha} className="commit">
              <span className="mono muted small" title={commit.sha}>
                commit {short(commit.sha)}
              </span>
              <pre className="commit-message">{commit.message}</pre>
              <CodeBlock label={`Patch of commit ${short(commit.sha)}`} text={commit.patch} diff empty="No changes." />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ChecksView({ campaign, attr, run, version }: { campaign: Campaign; attr: string; run: Run; version: string }) {
  const client = useClient();
  const names = [...new Set([...run.checks.map((c) => c.name), ...campaign.checks.map((c) => c.name)])];
  if (names.length === 0) return <p className="muted">The campaign has no checks.</p>;
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
