import type { JobsView } from "@patchix/common";
import { Badge } from "../components/Badge.tsx";
import { Button } from "../components/Button.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { Link } from "../components/Link.tsx";
import { Notice } from "../components/Notice.tsx";
import { Progress } from "../components/Progress.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { useClient } from "../client.tsx";
import { ago, time } from "../format.ts";
import { useAction, useInterval } from "../hooks.ts";
import { href } from "../router.ts";
import { useState } from "react";
import "./views.css";

/** The jobs view before the server gives it. */
export const NO_JOBS: JobsView = { jobs: [], queue: [], fleet: false };

export interface JobsStripProps {
  campaign: string;
  view: JobsView;
  concurrency?: number | undefined;
  onJobs: (view: JobsView) => void;
}

/** The jobs that operate, the queue and the state of the fleet of a campaign. */
export function JobsStrip({ campaign, view, concurrency, onJobs }: JobsStripProps) {
  const client = useClient();
  const { jobs, queue, fleet } = view;
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), jobs.length > 0 ? 10_000 : null);
  const stop = useAction(async (attr: string) => onJobs(await client.stopJob(campaign, attr)));
  const clear = useAction(async () => onJobs(await client.clearQueue(campaign)));
  return (
    <section className="jobs-strip" aria-label="Jobs">
      <div className="row">
        <h2 className="jobs-strip-title">
          Jobs <span className="muted small">{concurrency === undefined ? jobs.length : `${jobs.length} of ${concurrency}`}</span>
        </h2>
        <span className="spacer" />
        <Tooltip content={fleet ? "The fleet process starts the runs of the queue." : "No fleet process operates. The server starts one when the queue has entries."}>
          <Badge tone={fleet ? "green" : "muted"} render={<button type="button" />}>
            {fleet ? "fleet operates" : "no fleet"}
          </Badge>
        </Tooltip>
      </div>
      {stop.error !== null && <Notice tone="error">{stop.error}</Notice>}
      {clear.error !== null && <Notice tone="error">Clear queue: {clear.error}</Notice>}
      {jobs.length === 0 ? (
        <p className="muted small">No jobs operate.</p>
      ) : (
        <ul className="plain jobs-strip-list">
          {jobs.map((job) => (
            <li key={`${job.attr}:${job.id}`} className="job">
              <div className="row">
                <Link href={href.task(campaign, job.attr)} className="mono break">
                  {job.attr}
                </Link>
                <Badge tone={job.kind === "run" ? "blue" : "purple"}>{job.kind}</Badge>
                <span className="spacer" />
                <ConfirmDialog
                  trigger={
                    <Button size="sm" variant="danger" pending={stop.pending}>
                      Stop
                    </Button>
                  }
                  title={`Stop the ${job.kind} of ${job.attr}?`}
                  description="The agent stops. The worktree and the files of the job stay."
                  confirmLabel="Stop"
                  onConfirm={() => void stop.run(job.attr)}
                />
              </div>
              <p className="small muted">
                <span className="mono">{job.id}</span> · <span title={time(job.started)}>{ago(job.started, now)}</span> ·{" "}
                {job.kind === "run" ? "the agent or the checks operate" : "the agent writes the reply"}
              </p>
              <Progress value={null} label={`${job.kind} of ${job.attr}`} hideLabel />
            </li>
          ))}
        </ul>
      )}
      {queue.length > 0 && (
        <div className="stack" aria-label="Queue">
          <div className="row">
            <h3 className="jobs-strip-title">Waiting: {queue.length}</h3>
            <span className="spacer" />
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="danger" pending={clear.pending}>
                  Clear queue
                </Button>
              }
              title={`Remove the ${queue.length === 1 ? "task" : `${queue.length} tasks`} from the queue?`}
              description="The jobs that operate continue."
              confirmLabel="Clear queue"
              onConfirm={() => void clear.run()}
            />
          </div>
          <ol className="plain jobs-queue">
            {queue.map((attr) => (
              <li key={attr} className="jobs-queue-entry">
                <Link href={href.task(campaign, attr)} className="mono break small">
                  {attr}
                </Link>
                <Button size="sm" variant="ghost" aria-label={`Remove ${attr} from the queue`} title="Remove from the queue" pending={stop.pending} onClick={() => void stop.run(attr)}>
                  ×
                </Button>
              </li>
            ))}
          </ol>
          {!fleet && <p className="small muted">No fleet operates. The server starts the fleet in 30 seconds or less.</p>}
        </div>
      )}
    </section>
  );
}
