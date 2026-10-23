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

export type RunTab = "diff" | "commits" | "checks" | "prompt" | "description";

export function RunsSection({ campaign, task }: { campaign: Campaign; task: TaskView }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [tab, setTab] = useState<RunTab>("diff");
  const run = task.runs.find((r) => r.id === chosen) ?? task.runs[0];
  return (
    <section className="panel" aria-label="Runs">
      <div className="panel-head">
        <h2>Runs</h2>
        <span className="muted small">{task.runs.length}</span>
      </div>
      {run === undefined ? (
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
                {task.runs.map((r) => (
                  <tr key={r.id} className={r.id === run.id ? "is-selected" : undefined}>
                    <td>
                      <Button size="sm" variant="ghost" aria-pressed={r.id === run.id} onClick={() => setChosen(r.id)}>
                        {r.id}
                      </Button>
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
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
          <RunView campaign={campaign} attr={task.attr} run={run} tab={tab} onTab={setTab} />
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
      {run.error !== null && <Notice tone="error">{run.error}</Notice>}
      {run.status === "unverified" && (
        <Notice tone="warning">
          The agent made a fix, but a check did not agree with its pass expression: the Checks tab gives the output. A person examines it and makes the decision. The Publish tab can make the pull request.
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
            content: <RemoteText label="Full diff" diff loadKey={`diff:${version}`} load={() => client.runFile(c, attr, run.id, "diff")} empty="No diff." />,
          },
          {
            value: "commits",
            label: "Commits",
            content: <CommitsView campaign={c} attr={attr} run={run} version={version} />,
          },
          {
            value: "checks",
            label: `Checks ${run.checks.length}/${campaign.checks.length}`,
            content: <ChecksView campaign={campaign} attr={attr} run={run} version={version} />,
          },
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
        ]}
      />
    </div>
  );
}

/**
 * The commits from the base to the head of the run, as `git show` gives them. Each commit has its short id, its full
 * message and its patch. The full message shows the last lines, for example `Assisted-by:`.
 */
function CommitsView({ campaign, attr, run, version }: { campaign: string; attr: string; run: Run; version: string }) {
  const client = useClient();
  const commits = useLoad(() => client.commits(campaign, attr, run.id), `commits:${version}`);
  if (commits.error !== null) return <Notice tone="error">{commits.error}</Notice>;
  if (commits.data === null) return <p className="small muted">Loading…</p>;
  if (commits.data.length === 0) return <p className="muted">{run.status === "running" ? "The run did not stop. Its commits show at its end." : "No commits."}</p>;
  return (
    <ul className="plain commits" aria-label={`Commits of run ${run.id}`}>
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
