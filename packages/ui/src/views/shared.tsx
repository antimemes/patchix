import type { Pr, Run, Task } from "@patchix/common";
import { ApiError } from "../api.ts";
import { Badge, StatusBadge } from "../components/Badge.tsx";
import { CodeBlock } from "../components/CodeBlock.tsx";
import { Link } from "../components/Link.tsx";
import { Notice } from "../components/Notice.tsx";
import { pullUrl } from "../format.ts";
import { useLoad } from "../hooks.ts";

/** The pull request of the draft of the branch. If not, the pull request and the remark of the issue entry. */
export function PrCell({ meta, task, repo }: { meta: Pr | null; task?: Pick<Task, "pr" | "remark"> | undefined; repo: string }) {
  if (meta !== null && meta.number !== null) {
    return (
      <Link href={meta.url ?? pullUrl(repo, meta.number)} title="The pull request of patchix">
        #{meta.number}
      </Link>
    );
  }
  if (task === undefined) return <span className="muted">—</span>;
  if (task.pr !== null) {
    return (
      <span className="row">
        <Link href={pullUrl(repo, task.pr)}>#{task.pr}</Link>
        {task.remark !== null && <Remark text={task.remark} />}
      </span>
    );
  }
  if (task.remark !== null) return <Remark text={task.remark} />;
  return <span className="muted">—</span>;
}

/** The remark of the issue entry. The table cuts a long remark. The title has the full text. */
function Remark({ text }: { text: string }) {
  return (
    <span className="pr-remark" title={text}>
      <span className="muted small">{text}</span>
    </span>
  );
}

/** The status, the tags and the lint of a run, and the checks: of the run, or `checks`, for example the checks of the tip. */
export function RunBadges({ run, checks = run.checks, status = true }: { run: Run; checks?: Run["checks"]; status?: boolean }) {
  return (
    <span className="task-checks">
      {status && <StatusBadge status={run.status} />}
      <TagBadges tags={run.tags} />
      {checks.map((c) => (
        <StatusBadge key={`${c.attr}/${c.name}`} status={c.status} title={`${c.name} of ${c.attr}: ${c.status}`}>
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
