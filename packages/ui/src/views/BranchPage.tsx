import { useMemo } from "react";
import type { BranchDetail, BranchView, CampaignView, CommitProblems, TaskView } from "@patchix/common";
import { Badge, StateChip } from "../components/Badge.tsx";
import { Button } from "../components/Button.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { Link } from "../components/Link.tsx";
import { Notice } from "../components/Notice.tsx";
import { Picker } from "../components/Picker.tsx";
import { Progress } from "../components/Progress.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { useToast } from "../components/Toast.tsx";
import { useClient } from "../client.tsx";
import { pullUrl, short } from "../format.ts";
import { useAction, useDebounced, useHashTab, useLoad, useSignals } from "../hooks.ts";
import { href } from "../router.ts";
import { NO_JOBS } from "./JobsStrip.tsx";
import { PublishTab } from "./PublishTab.tsx";
import { RunControl } from "./RunControl.tsx";
import { BranchSection, RunsSection } from "./RunsSection.tsx";
import { PrCell } from "./shared.tsx";
import "./views.css";

export type PageTab = "work" | "publish";
/** The tabs of the page. The URL hash keeps the tab: `#work` or `#publish`. Thus a link to the page opens the same tab. */
const TABS = ["work", "publish"] as const;

/** The commits of the branch that do not agree with the `automation/AI policy` of nixpkgs. See `BranchDetail.commit_problems`. */
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

/**
 * The other branches of an entry of this branch: a branch of the entry, or a branch with a run that declares
 * it. The entries are the entries of this branch and the entries that its runs declare. Each line is one entry with
 * the keys of the other branches.
 */
export function otherBranches(key: string, branches: readonly BranchView[]): { attr: string; keys: string[] }[] {
  const own = branches.find((b) => b.key === key);
  const attrs = [...new Set([...(own?.covers ?? []), ...(own?.runs.flatMap((r) => r.attrs) ?? [])])];
  return attrs.flatMap((attr) => {
    const keys = branches.filter((b) => b.key !== key && (b.covers.includes(attr) || b.runs.some((r) => r.attrs.includes(attr)))).map((b) => b.key);
    return keys.length === 0 ? [] : [{ attr, keys }];
  });
}

export function BranchPage({ campaign: c, branch: key }: { campaign: string; branch: string }) {
  const client = useClient();
  const [tab, setTab] = useHashTab<PageTab>(TABS);
  const detail = useLoad(() => client.branch(c, key), `branch:${c}/${key}`);
  // The task list for "Add entry", and the other branches of the entries.
  const view = useLoad(() => client.campaign(c), `campaign:${c}`);
  const jobs = useLoad(() => client.jobs(c), `jobs:${c}`);
  const reloadDetail = useDebounced(detail.reload, 300);
  const reloadView = useDebounced(view.reload, 300);
  useSignals((signal) => {
    if (signal.type === "reconnect") {
      detail.reload();
      view.reload();
      jobs.reload();
    } else if (signal.campaign !== c) {
      return;
    } else if (signal.type === "campaign") {
      if (signal.key === null || signal.key === key) reloadDetail();
      reloadView();
    } else {
      jobs.replace({ jobs: signal.jobs, queue: signal.queue, fleet: signal.fleet });
    }
  });
  const place = jobs.data?.queue.indexOf(key) ?? -1;

  if (detail.data === null) {
    return detail.error !== null ? <Notice tone="error">{detail.error}</Notice> : <Progress value={null} label="Loading the branch" />;
  }
  const { branch, campaign } = detail.data;
  const job = (jobs.data?.jobs ?? []).find((j) => j.key === key) ?? null;
  return (
    <div className="stack">
      <header className="task-title">
        <h1>{branch.key}</h1>
        <StateChip state={branch.state} />
        {place >= 0 && (
          <Badge tone="blue" dim>
            queued
          </Badge>
        )}
        {branch.pr_meta?.number != null && <PrCell meta={branch.pr_meta} repo={campaign.issue.repo} />}
      </header>
      <Entries
        detail={detail.data}
        view={view.data}
        onView={(next) => {
          view.replace(next);
          detail.reload();
        }}
      />
      {detail.error !== null && <Notice tone="error">{detail.error}</Notice>}
      {jobs.error !== null && <Notice tone="error">Jobs: {jobs.error}</Notice>}
      <Tabs<PageTab>
        label="Parts of the branch"
        value={tab}
        onValueChange={setTab}
        keepMounted
        items={[
          {
            value: "work",
            label: "Work",
            content: (
              <div className="stack-lg">
                <section className="panel" aria-label="Work">
                  <IssueEntries tasks={detail.data.tasks} branch={key} repo={campaign.issue.repo} hasSource={campaign.source !== undefined} />
                  <RunControl
                    campaign={c}
                    branch={key}
                    jobs={jobs.data ?? NO_JOBS}
                    onJobs={(next) => {
                      jobs.replace(next);
                      detail.reload();
                    }}
                  />
                  <WorktreeRow campaign={c} branch={branch} onDetail={detail.replace} onChanged={detail.reload} />
                </section>
                <CommitProblemsNotice problems={detail.data.commit_problems} />
                <BranchSection campaign={campaign} branch={branch} clean={detail.data.clean} />
                <RunsSection campaign={campaign} branch={branch} queued={place >= 0} question={detail.data.question} />
              </div>
            ),
          },
          {
            value: "publish",
            label: "Publish",
            content: <PublishTab key={`${c}/${key}`} detail={detail.data} jobRunning={job !== null} onDetail={detail.replace} />,
          },
        ]}
      />
    </div>
  );
}

interface EntriesProps {
  detail: BranchDetail;
  /** The campaign view: the task list and the branches. `null` until the page has it. */
  view: CampaignView | null;
  onView: (view: CampaignView) => void;
}

/**
 * The entries of the branch as chips. Each is a link to the row of the entry in the task table. Its button removes
 * the entry from the branch. "Add entry" links an entry of the task list to the branch. The line below gives
 * the other branches of an entry. See `otherBranches`.
 */
function Entries({ detail, view, onView }: EntriesProps) {
  const client = useClient();
  const toast = useToast();
  const { campaign, branch } = detail;
  const c = campaign.name;
  const link = useAction(async (attr: string, key: string | null) => {
    onView(await client.linkEntry(c, attr, key));
    toast(key === null ? `${attr} is not an entry of ${branch.key} now` : `${attr} is an entry of ${branch.key}`, key === null ? undefined : "Start a run to get the checks of the entry.");
  });
  const options = useMemo(
    () => (view?.tasks ?? []).filter((t) => t.branch !== branch.key).map((t) => ({ value: t.attr, hint: t.branch === null ? t.state : `${t.state}, branch ${t.branch}` })),
    [view, branch.key],
  );
  const others = view === null ? [] : otherBranches(branch.key, view.branches);
  return (
    <section className="stack" aria-label="Entries of the branch">
      <div className="row">
        <span className="small muted">Entries</span>
        <div className="entry-chips" role="list" aria-label="Entries">
          {branch.covers.length === 0 && <span className="small muted">The branch covers no entry.</span>}
          {branch.covers.map((attr) => (
            <span key={attr} className="entry-chip" role="listitem">
              <Link href={href.entry(c, attr)} className="mono">
                {attr}
              </Link>
              <ConfirmDialog
                trigger={
                  <Button size="sm" variant="ghost" aria-label={`Remove ${attr} from the branch`} title="Remove from the branch" pending={link.pending}>
                    ×
                  </Button>
                }
                title={`Remove ${attr} from the branch?`}
                description="The entry has no branch after this. The runs and the checks of the branch stay."
                confirmLabel="Remove"
                onConfirm={() => void link.run(attr, null)}
              />
            </span>
          ))}
        </div>
        <Picker label="Add entry" hideLabel options={options} onPick={(attr) => void link.run(attr, branch.key)} placeholder="Add entry" disabled={view === null || link.pending} />
      </div>
      {others.length > 0 && (
        <Notice tone="warning" aria-label="Other branches">
          <p>Other branches that cover these entries:</p>
          <ul className="reasons">
            {others.map((o) => (
              <li key={o.attr}>
                <span className="mono">{o.attr}</span>:{" "}
                {o.keys.map((k, i) => (
                  <span key={k}>
                    {i > 0 && ", "}
                    <Link href={href.branch(c, k)} className="mono">
                      {k}
                    </Link>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {link.error !== null && <Notice tone="error">{link.error}</Notice>}
    </section>
  );
}

/** The issue entries of the branch: the entries that link to it, and the entry of its key. */
function IssueEntries({ tasks, branch, repo, hasSource }: { tasks: TaskView[]; branch: string; repo: string; hasSource: boolean }) {
  if (tasks.length === 0) return <p className="small muted">No issue entry: a free-text run made the branch. The runs give the work.</p>;
  return (
    <div className="table-wrap">
      <table className="table" aria-label="Issue entries">
        <thead>
          <tr>
            <th>Attribute</th>
            <th>State</th>
            <th>Tick box</th>
            <th>Pull request</th>
            <th>Notes</th>
            <th>Paths</th>
            <th>Sources</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.attr}>
              <td>
                <div className="row">
                  <span className="mono">{t.attr}</span>
                  {t.branch !== branch && (
                    <Badge tone="muted" title="The key of the branch is this attribute: the runs get this entry. The entry does not link to the branch.">
                      {t.branch === null ? "not an entry of this branch" : `entry of ${t.branch}`}
                    </Badge>
                  )}
                </div>
              </td>
              <td>
                <StateChip state={t.state} />
              </td>
              <td>{t.checked ? <Badge tone="green">set</Badge> : <Badge tone="muted">not set</Badge>}</td>
              <td className="pr-cell">
                {t.pr === null ? <span className="muted">none</span> : <Link href={pullUrl(repo, t.pr)}>#{t.pr}</Link>}
                {t.remark !== null && <div className="small muted">{t.remark}</div>}
              </td>
              <td>
                <div className="task-notes">{t.notes === "" ? <span className="muted">none</span> : t.notes}</div>
              </td>
              <td>
                {t.paths.length === 0 ? (
                  <span className="muted">none</span>
                ) : (
                  <ul className="paths">
                    {t.paths.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                )}
              </td>
              <td>
                <div className="row">
                  <Badge tone={t.in_issue ? "blue" : "amber"}>{t.in_issue ? "in the issue" : "not in the issue"}</Badge>
                  {hasSource && <Badge tone={t.in_source ? "blue" : "amber"}>{t.in_source ? "in the source command" : "not in the source command"}</Badge>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface WorktreeRowProps {
  campaign: string;
  branch: BranchView;
  onDetail: (detail: BranchDetail) => void;
  onChanged: () => void;
}

function WorktreeRow({ campaign, branch, onDetail, onChanged }: WorktreeRowProps) {
  const client = useClient();
  const toast = useToast();
  const make = useAction(async () => {
    const worktree = await client.makeWorktree(campaign, branch.key);
    onChanged();
    toast("Worktree made", worktree.path);
  });
  const remove = useAction(async () => {
    onDetail(await client.removeWorktree(campaign, branch.key));
    toast("Worktree removed");
  });
  return (
    <div className="stack" aria-label="Worktree">
      <div className="row">
        <span className="small muted">Worktree</span>
        {branch.worktree === null ? <span className="small muted">none</span> : <span className="small mono break">{branch.worktree}</span>}
        {branch.worktree === null ? (
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
