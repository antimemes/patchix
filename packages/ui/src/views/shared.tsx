import type { Run, TaskView } from "@patchix/common";
import { ApiError } from "../api.ts";
import { Badge, StatusBadge } from "../components/Badge.tsx";
import { CodeBlock } from "../components/CodeBlock.tsx";
import { Link } from "../components/Link.tsx";
import { Notice } from "../components/Notice.tsx";
import { pullUrl } from "../format.ts";
import { useLoad } from "../hooks.ts";

export function PrCell({ task, repo }: { task: TaskView; repo: string }) {
  const meta = task.pr_meta;
  if (meta !== null && meta.number !== null) {
    return (
      <Link href={meta.url ?? pullUrl(repo, meta.number)} title="The pull request of patchix">
        #{meta.number}
      </Link>
    );
  }
  if (task.pr !== null) {
    return (
      <span className="row">
        <Link href={pullUrl(repo, task.pr)}>#{task.pr}</Link>
        {task.remark !== null && <span className="muted small">{task.remark}</span>}
      </span>
    );
  }
  if (task.remark !== null) return <span className="muted small">{task.remark}</span>;
  return <span className="muted">—</span>;
}

export function RunBadges({ run, status = true }: { run: Run; status?: boolean }) {
  return (
    <span className="task-checks">
      {status && <StatusBadge status={run.status} />}
      <TagBadges tags={run.tags} />
      {run.checks.map((c) => (
        <StatusBadge key={c.name} status={c.status} title={`${c.name}: ${c.status}`}>
          {c.name}
        </StatusBadge>
      ))}
      {run.lint !== null && <Badge tone={run.lint > 0 ? "amber" : "green"}>lint {run.lint}</Badge>}
    </span>
  );
}

/** The tags of a run. The page shows each tag and does not examine its value. */
export function TagBadges({ tags }: { tags: readonly string[] }) {
  return tags.map((tag) => (
    <Badge key={tag} title="A tag of the run">
      {tag}
    </Badge>
  ));
}

export interface RemoteTextProps {
  label: string;
  load: () => Promise<string>;
  loadKey: string;
  diff?: boolean | undefined;
  wrap?: boolean | undefined;
  empty?: string | undefined;
  maxHeight?: string | undefined;
}

export function RemoteText({ label, load, loadKey, diff, wrap, empty, maxHeight }: RemoteTextProps) {
  const text = useLoad(async () => {
    try {
      return await load();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return "";
      throw error;
    }
  }, loadKey);
  return (
    <CodeBlock
      label={label}
      text={text.data}
      loading={text.loading}
      error={text.data === null ? text.error : null}
      diff={diff}
      wrap={wrap}
      empty={empty}
      maxHeight={maxHeight}
    />
  );
}

/** `claude -p` writes its output when it stops. While a job operates, this text gives the zellij tab of the job. */
export function AttachNotice({ tab }: { tab: string }) {
  return (
    <Notice tone="info">
      Claude prints its answer when it stops. To watch it work, attach: <code>zellij attach patchix</code>, tab <code>{tab}</code>
    </Notice>
  );
}
